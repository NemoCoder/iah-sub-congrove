//! 站内信 —— 全站共用的通知出口。
//!
//! ★M1 最后一块闭环★:在这之前**只有「催办」一处发信**,于是系统处在一个荒诞的状态 ——
//! 会约好了,被约的人不知道,除非他自己想起来打开系统看一眼。
//! M1 的验收标准是「一个新人能在不问任何人的情况下把一次会约成并如期开上」,
//! 而「被约的人得先知道有人约他」是这句话的前半截。
//!
//! 三条贯穿本模块的约定:
//!   · **best-effort**:registry 不可达只 warn,绝不让业务接口失败 —— 发不出信是通知的事故,不是约会的事故;
//!   · **不发给动作发起人自己**:他知道自己干了什么,收到「你约了自己」只会让人觉得系统啰嗦;
//!   · **带 url 直达那件事**:只说「有事发生」而点不进去等于没通知。
//!
//! ⚠ 本模块从 `http/activities.rs` 抽出(2026-08-07):转移主持人也要发信之后,
//! 通知就不再是活动独有的了。把它留在 activities 里会让 projects.rs 去调另一个 handler 模块的私有函数 ——
//! 那种依赖方向一旦开了头,两个模块很快就会互相伸手。

use crate::state::AppState;

type Ts = chrono::DateTime<chrono::Utc>;

/// 一场会该收到通知的人:参会人 + 记录员 + 发起人,减去动作发起人自己。
/// ★旁听者(observer)不收★:他是自己凑过来听的,活动怎么改不该塞满他的收件箱(D9)。
pub async fn notify_targets(pool: &sqlx::PgPool, mid: i64, exclude: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT username FROM activity_participants
          WHERE activity_id = $1 AND username <> $2 AND kind <> 'observer'")
        .bind(mid).bind(exclude).fetch_all(pool).await.unwrap_or_default()
}

/// 发一批站内信。`targets` 空则什么都不做(不是错误 —— 一个人的会就是没人要通知)。
pub async fn notify_activity(state: &AppState, mid: i64, targets: &[String], title: &str, body: &str) {
    let Some(reg) = &state.registry else { return };      // 本地 dev 无 registry:静默跳过
    // 站内信点进去要能到那场会。前端不用路由库(app.tsx 头注的既有约定),所以用查询参数,
    // 由 app.tsx 启动时读一次 ?activity= 直接把人放到那场会上。
    let url = state.config.public_url.as_ref().map(|b| format!("{b}/?activity={mid}"));
    for u in targets {
        reg.notify(u, title, body, url.as_deref(), Some(&format!("activity:{mid}"))).await;
    }
}

/// 「08-13 周三 10:00（北京时间）」—— 站内信正文里的时间格式。
/// ★带星期★:纯数字日期读起来要在脑子里换算一次,而「周三」是人真正安排生活用的单位。
///
/// ⚠★2026-08-12:加了时区参数和时区标注★(PRD E0,liaoruili 拍板的甲案)。
/// 原来写死东八区且不标 —— 纽约用户读到的「08-13 10:00」是北京时间而他不知道,
/// ★于是他去自己的日历上找 10:00 那一场,找不到★。
/// `tz` 传的是**活动自己的**时区(`activities.timezone`),不是收件人的 ——
/// 理由与两个方案的取舍写在 `tzutil::when_labeled` 的头注里。
pub fn fmt_when(t: Ts, tz: chrono_tz::Tz) -> String { crate::tzutil::when_labeled(t, tz) }


/// 项目相关的站内信(转移主持人等)。与活动版的区别只在 `ref` 前缀与直达链接的形状,
/// 收信规则(best-effort、不发给自己)完全一致 —— ★那些规则只该有一处★。
pub async fn notify_project(state: &AppState, pid: i64, targets: &[String], title: &str, body: &str) {
    let Some(reg) = &state.registry else { return };
    let url = state.config.public_url.as_ref().map(|b| format!("{b}/?project={pid}"));
    for u in targets {
        reg.notify(u, title, body, url.as_deref(), Some(&format!("project:{pid}"))).await;
    }
}
