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
/// ★一条站内信的「种类」—— 它决定平台按 `ref` 去重时把哪些消息当成同一条★(2026-08-16 热修)。
///
/// ══ 这个枚举是一次线上事故换来的 ══
/// 在此之前**所有**关于某个活动的站内信共用 `ref = activity:{mid}`。而平台的 `notify()` 是
/// `insert … on conflict (recipient, ref) do nothing returning id` —— 撞了就跳过插入、
/// **回查旧行并返回 2xx**。于是:
///   邀请永远是第一条 → 占住 `(收件人, activity:34)` →
///   ★此后关于这个活动的**每一条**通知(改期/链接改/取消/催办/提醒)都被静默吞掉,而我们收到 2xx★。
/// 2026-08-16 liaoruili 反馈「早上的会没收到提醒」,查到最后是这个;平台侧同日已改成回 `deduped` 标志。
/// (发起人反而收得到提醒 —— 他不收邀请,提醒是该 ref 的第一条。这个反常现象正是线索。)
///
/// ⚠★分种类还不够,还要分「会不会重复发生」★:
///   同一场会可以**改期两次**、催办两次 —— 那是两条各自成立的新消息,不能被去重。
///   所以下面 `ref_of` 里,可重复的种类会带一个时间戳;一次性的不带(去重是对的,避免重复打扰)。
///   ★把这个策略放在**一个 match** 里,而不是让 9 个调用点各自记得★ ——
///   编译器会强制新增种类时也做这个决定。
#[derive(Clone, Copy)]
pub enum Kind {
    /// 邀请:一场活动对一个人只该有一条(重复邀请不该再打扰)
    Invite,
    /// 到点提醒:每场每人只投一次(`reminded_at` 保证),去重与否都无所谓,分开只是为了不占住 invite 的位置
    Remind,
    /// 记录员拒绝出席 → 纪要转给发起人:同一场只会发生一次
    RecorderMoved,
    /// 改期:★可重复★
    Reschedule,
    /// 线上链接变更:★可重复★
    LinkChanged,
    /// 取消:一场只会取消一次
    Canceled,
    /// 有人提改期建议:★可重复★(不同人、或同一人再提)
    Counter,
    /// 改期建议未被采纳:★可重复★
    CounterRejected,
    /// 催办「你还没答复」:★可重复★——催第二次就是要再响一声
    Nudge,
    /// AI 纪要生成好了:★可重复★——「重新生成」是正当操作,生成完该再响一次
    MinutesReady,
    /// ★被指派为记录员★:★可重复★——同一场可以换好几次记录员,每次那个人都得知道。
    /// (与 `RecorderMoved` 是两件事:那条是「拒绝出席导致纪要自动落回发起人」,一场只发生一次。)
    RecorderAssigned,
}

impl Kind {
    /// 这条消息在平台侧的去重键。
    /// ⚠ 加新种类时**必须**在这里决定它可不可重复 —— match 不写全编译不过。
    pub fn ref_of(self, mid: i64) -> String {
        let (名, 可重复) = match self {
            Kind::Invite => ("invite", false),
            Kind::Remind => ("remind", false),
            Kind::RecorderMoved => ("recorder", false),
            Kind::Canceled => ("canceled", false),
            Kind::Reschedule => ("reschedule", true),
            Kind::LinkChanged => ("link", true),
            Kind::Counter => ("counter", true),
            Kind::CounterRejected => ("counter-rejected", true),
            Kind::Nudge => ("nudge", true),
            Kind::MinutesReady => ("minutes", true),
            Kind::RecorderAssigned => ("recorder-assigned", true),
        };
        if 可重复 {
            // 时间戳只为「让 ref 不同」,不表达语义;秒级足够(同一秒内重复发同一种类=误触,去重反而是对的)。
            format!("activity:{mid}:{名}:{}", chrono::Utc::now().timestamp())
        } else {
            format!("activity:{mid}:{名}")
        }
    }
}

pub async fn notify_activity(state: &AppState, mid: i64, targets: &[String], title: &str, body: &str, kind: Kind) {
    let Some(reg) = &state.registry else { return };      // 本地 dev 无 registry:静默跳过
    // 站内信点进去要能到那场会。前端不用路由库(app.tsx 头注的既有约定),所以用查询参数,
    // 由 app.tsx 启动时读一次 ?activity= 直接把人放到那场会上。
    let url = state.config.public_url.as_ref().map(|b| format!("{b}/?activity={mid}"));
    for u in targets {
        reg.notify(u, title, body, url.as_deref(), Some(&kind.ref_of(mid))).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// ★同一场活动的不同种类,ref 必须互不相同★ —— 这正是 2026-08-16 事故的判据:
    /// 邀请与提醒共用 `activity:{mid}` → 平台按 (recipient, ref) 幂等 → 提醒永远发不出去。
    #[test]
    fn 不同种类的ref互不相同() {
        let ks = [Kind::Invite, Kind::Remind, Kind::RecorderMoved, Kind::Canceled];
        let mut v: Vec<String> = ks.iter().map(|k| k.ref_of(7)).collect();
        v.sort(); v.dedup();
        assert_eq!(v.len(), ks.len(), "一次性种类之间不能撞 ref");
        // 不同活动之间也不能撞
        assert_ne!(Kind::Invite.ref_of(7), Kind::Invite.ref_of(8));
    }

    /// ★可重复的种类,连发两次也必须是两个不同的 ref★ ——
    /// 改期两次、催办两次都是**各自成立的新消息**,被去重掉等于第二次没发生。
    #[test]
    fn 可重复的种类每次都是新ref() {
        for k in [Kind::Reschedule, Kind::LinkChanged, Kind::Counter, Kind::CounterRejected,
                  Kind::Nudge, Kind::MinutesReady] {
            let a = k.ref_of(7);
            // 时间戳是秒级:同一秒内故意视为同一条(误触去重是对的),所以这里跨一秒再取
            std::thread::sleep(std::time::Duration::from_millis(1100));
            assert_ne!(a, k.ref_of(7), "可重复的种类第二次必须换 ref");
        }
    }

    /// ★一次性的种类必须**稳定**★:重复邀请同一个人不该再打扰他。
    #[test]
    fn 一次性的种类ref稳定() {
        assert_eq!(Kind::Invite.ref_of(7), Kind::Invite.ref_of(7));
        assert_eq!(Kind::Canceled.ref_of(9), Kind::Canceled.ref_of(9));
    }
}
