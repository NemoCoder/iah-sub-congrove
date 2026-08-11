//! 活动提醒的投递循环（PRD F2/F3，设计见 `docs/TECH-DESIGN-M1-remind.md`）。
//!
//! ══════ 为什么这个模块和别的都不一样 ══════
//!
//! 此前本仓所有写操作都由**请求**驱动：有人点了按钮，才有事发生。提醒不是 ——
//! ★没有任何请求，到点就得发出去★。而平台两条硬约束把「简单做法」全否掉了：
//!
//!   · **集群无 PVC，pod 随时重启**（rebuild / restart / promote / 驱逐）。
//!     内存里的 `sleep_until` 定时器一重启全丢，而且★丢得无声无息★ ——
//!     没有任何地方会报错，只是那些会没人收到提醒。
//!   · **副本数不是契约**。今天是 1，但那是部署参数。两个副本各跑一份循环 = 每人收两遍。
//!
//! 所以：**状态落 PG，去重由数据库保证**，而不是靠「我记得我发过」。
//! 去重的判据是 `FOR UPDATE SKIP LOCKED` 的**行锁**，不是 `reminded_at IS NULL` 这个**列值** ——
//! 后者是「读时判断」，两个副本会同时读到 NULL、同时认为该自己发。
//!
//! ══════ 四条判据（缺一条就发错） ══════
//!
//! 见下面 SQL 里逐条的注释。最容易被想歪的一条记在这里：
//! ★「补录不发提醒」不需要单独一条判据★ —— 补录按定义是「录一件已经发生过的事」，
//! `starts_at` 必然在过去，而「已经开始的不补发」那条已经把它们全排除了。
//! （初稿写的是「靠 notified_at 跳过」，核代码后发现理由不成立，已订正；
//!   `notified_at` 那条仍然留着，但理由是另一个：**没被通知过的人不该收到提醒**。）

use crate::state::AppState;

type Ts = chrono::DateTime<chrono::Utc>;

/// 个人默认也没设时的兜底（PRD F3 + 2026-08-11 liaoruili 拍板）。
///
/// ⚠★这个常量改变了一条无声的系统行为★：没有偏好行的人本来一条提醒都收不到
/// （功能上线等于没上线），现在他们默认会收到。所以设置页必须写明「默认 15 分钟、可以关」。
/// ★只有这一处写死★ —— 与 `user_quota` 那个「config.rs 与 SQL 两处同步」的已知重复不同。
const DEFAULT_REMIND_MIN: i32 = 15;

/// 扫描间隔。
/// ★30 秒不是随手定的★：提醒的精度需求是分钟级（「提前 15 分钟」误差 30 秒无感），
/// 而每次扫描是一条走部分索引的 SQL。更密只是徒增查询；
/// 而 60 秒会让「提前 5 分钟」这一档的相对误差到 20%。
const TICK_SEC: u64 = 30;

/// 把分钟数说成人话。
///
/// ⚠★2026-08-12 liaoruili 收到真站内信时当场看出来的★：原来是直接 `{mins} 分钟`，
/// 于是「提前 1 天」那一档发出去的是「**将于 1440 分钟后开始**」——
/// 数字本身没错，但没有人会去心算 1440 分钟是多久。
/// ★存储用分钟是对的（一个单位、好比较、好 COALESCE），但**呈现**不该跟着存储走。★
/// 这正是 CODE-QUALITY 里「易错值」那条的另一面：不只是别把秒当毫秒，
/// 还包括别把内部表示直接端给人看。
fn 人话时长(mins: i32) -> String {
    // ⚠★必须带 `m >= N` 这一半★:只写 `m % 1440 == 0` 的话 0 也满足 ——
    //   于是 `人话时长(0)` 说「0 天」。现在走不到(SQL 的 `COALESCE(...) > 0` 挡着),
    //   但判据和文案是两处代码,★指望另一处永远替自己兜底,是一种很脆的写法★。
    match mins {
        m if m >= 1440 && m % 1440 == 0 => format!("{} 天", m / 1440),
        m if m >= 60 && m % 60 == 0 => format!("{} 小时", m / 60),
        m => format!("{} 分钟", m),
    }
}

/// 后台循环。挂法与 `media_ai::run` 一致（`lib.rs` 里 `tokio::spawn`）。
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(TICK_SEC));
    loop {
        tick.tick().await;
        if let Err(e) = once(&state).await {
            // ★只 warn 不退出★：一次扫描失败（连接抖动、锁等待）不该让提醒功能从此消失，
            // 而这正是「循环里 `?` 直接返回」最常见的死法 —— 进程还活着，循环已经没了。
            tracing::warn!(error = %e, "提醒扫描失败,下轮再试");
        }
    }
}

/// 扫一轮：把到点该发的取出来、发站内信、标记已发。★整轮在一个事务里★。
async fn once(state: &AppState) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;

    // ⚠ `FOR UPDATE SKIP LOCKED` 必须落在 activity_participants 上（`OF p`）——
    //   不写 `OF p` 的话 PG 会尝试锁住 JOIN 进来的每一张表，
    //   而 `user_prefs` 是 LEFT JOIN、锁不了，直接报错。
    let due: Vec<(i64, String, String, Ts, i32)> = sqlx::query_as(
        "SELECT p.activity_id, p.username, m.title, m.starts_at,
                COALESCE(m.remind_minutes, u.default_remind_minutes, $1)
         FROM activity_participants p
         JOIN activities m ON m.id = p.activity_id
         LEFT JOIN user_prefs u ON u.username = p.username
         WHERE p.reminded_at IS NULL
           -- 旁听者不收:他是自己凑过来听的(D9,与 notify::notify_targets 同源)
           AND p.kind <> 'observer'
           -- 拒绝了的人不必再提醒
           AND p.status <> 'declined'
           -- 取消的活动不提醒
           AND m.status = 'active'
           -- ★没被通知过的人不该收到提醒★:他自始至终不知道有这场会,
           -- 突然收到「你的会 15 分钟后开始」只会让他困惑「什么会?」(与忙闲那条判据同源,ADR-0003)
           AND p.notified_at IS NOT NULL
           -- ★三态判据(设计 §7①②)★:NULL=跟随个人默认 / 0=这场不提醒 / >0=提前这么多分钟。
           -- `> 0` 一处同时管掉「显式关闭」和「负数脏数据」。
           AND COALESCE(m.remind_minutes, u.default_remind_minutes, $1) > 0
           -- 到点了
           AND m.starts_at - make_interval(mins => COALESCE(m.remind_minutes, u.default_remind_minutes, $1)) <= now()
           -- ★已经开始的不补发★:pod 停两小时再起来,那两小时内该发的**不发** ——
           -- 提醒的价值全在「提前」,会都开始了再收到「15 分钟后开会」不只是没用,是**误导**。
           -- 顺带这一条也让「补录不发提醒」自动成立(补录的 starts_at 必在过去)。
           AND m.starts_at > now()
         ORDER BY m.starts_at
         LIMIT 200
         FOR UPDATE OF p SKIP LOCKED")
        .bind(DEFAULT_REMIND_MIN)
        .fetch_all(&mut *tx).await?;

    if due.is_empty() { return Ok(()) }

    // ★先标记再发信★，不是先发再标记。
    // 站内信是 best-effort（registry 不可达只 warn），而它**发不出去**和**发两遍**这两种失败
    // 严重度差得远：漏一条提醒是遗憾，重复轰炸是事故。所以宁可标记在前 ——
    // 极端情况下（标记成功、发信失败）丢一条，也不让它有机会发两遍。
    let ids: Vec<i64> = due.iter().map(|(a, _, _, _, _)| *a).collect();
    let users: Vec<String> = due.iter().map(|(_, u, _, _, _)| u.clone()).collect();
    sqlx::query(
        "UPDATE activity_participants SET reminded_at = now()
          WHERE (activity_id, username) IN (SELECT * FROM unnest($1::bigint[], $2::text[]))")
        .bind(&ids).bind(&users).execute(&mut *tx).await?;
    tx.commit().await?;

    for (mid, user, title, starts_at, mins) in &due {
        let body = format!(
            "{} 将于 {}后开始（{}）。",
            title, 人话时长(*mins),
            starts_at.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).format("%m-%d %H:%M"),
        );
        crate::notify::notify_activity(state, *mid, std::slice::from_ref(user), "活动即将开始", &body).await;
    }
    tracing::info!(count = due.len(), "已投递活动提醒");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::人话时长;

    /// ⚠★这条是 2026-08-12 liaoruili 收到真站内信时看出来的★:
    /// 「提前 1 天」那一档发出去的是「将于 **1440 分钟后**开始」——
    /// 数字没错,但没有人会去心算 1440 分钟是多久。
    /// 按规范「修 bug 先写复现测试」,把它钉在这里:纯函数,不需要库也不需要循环跑起来。
    #[test]
    fn 提醒时长要说人话() {
        // ★出事的就是这一个★
        assert_eq!(人话时长(1440), "1 天");
        assert_eq!(人话时长(2880), "2 天");
        assert_eq!(人话时长(60), "1 小时");
        assert_eq!(人话时长(120), "2 小时");
        // 不整的仍然说分钟 —— 「90 分钟」比「1.5 小时」少一次心算
        assert_eq!(人话时长(90), "90 分钟");
        assert_eq!(人话时长(5), "5 分钟");
        assert_eq!(人话时长(15), "15 分钟");
        // ⚠★边界:0 曾经返回「0 天」★(因为 0 % 1440 == 0)。现在走不到
        //   (SQL 的 `COALESCE(...) > 0` 挡着),但判据和文案是两处代码 ——
        //   ★指望另一处永远替自己兜底,是一种很脆的写法★,所以函数自己也收紧了。
        assert_eq!(人话时长(0), "0 分钟");
        assert_eq!(人话时长(-5), "-5 分钟");   // 脏数据也不该说成「-1 天」
    }
}
