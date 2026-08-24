//! 活动与日程(M1)—— 需求见 `docs/PRD-activities.md`,判权全走 `perm.rs`,handler 里不重写。
//!
//! ★贯穿本模块的一条线:**活动参与 ≠ 资料权限**★(D3/D8/D9)。
//! 这里的每个接口只管**活动元信息**(标题/议程/时间/地点/链接/名单/讨论);
//! 材料一律走项目那套(`require_role` + 项目成员身份),与「是不是参会人」无关。
//! 把两者混起来 = 「参会即获得资料权限」= 权限退回历史累积,而 R1 要的是当前状态的函数。
//!
//! 三个容易写错的地方,都在下面各自的注释里标了 ★:
//!   · 忙闲按**活动自己的 `busy`** 分流(PRD A4)—— ⚠★这条 2026-08-15 才订正★:
//!     原文写的是「按**项目可见性**分流,不是按活动」,那是 M0 之前的规则,
//!     `projects.visibility` 那一列在 M0-1 就删了,代码早已改判 `m.busy`,只有注释停在原地。
//!     ★注释里这种「按 X 判」的断言会过期,而且过期时是静默的★ —— 读它的人会照旧规则推理;
//!   · 「建议改期」是私事冲突**唯一的结构化出口**(D2),不是可选的便利功能;
//!   · 改线上链接要留痕(开会前十分钟改链接是真实场景)。

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::perm::{activity_view, require_activity_host, ActivityView};
use crate::state::AppState;
use crate::notify::{fmt_when, notify_activity, notify_targets};
use crate::{audit, perm};

type Ts = chrono::DateTime<chrono::Utc>;

#[derive(Serialize, sqlx::FromRow, schemars::JsonSchema)]
pub struct ActivityRow {
    pub id: i64,
    /// 活动类型名（ADR-0002）。★列表与详情都要显示它★ ——
    /// M0 把「这是哪种活动」提成了一等概念，界面上却一直看不见，
    /// 于是用户建完就再也分不清哪条是会议、哪条是个人日程。
    /// ⚠ 取的是 `activity_types.name` 而不是 id：软删的类型历史照常显示名字（L1）。
    #[sqlx(default)]
    pub type_name: Option<String>,
    /// 这个类型有没有纪要这回事（ADR-0002 的能力位）。
    ///
    /// ⚠★2026-08-11 liaoruili 从界面上看出来的★：活动列表给**每一条已结束的活动**
    /// 都挂「纪要待整理」徽章，于是「读 Acemoglu 2024」「（补录）上周跑数据」这些
    /// **个人日程**也被催交纪要 —— 而那个类型 `has_minutes=false`，压根没有纪要这回事。
    ///
    /// ★这是同一个根因的第四次现身★：「我是记录员且纪要非 done」这条判据被各处各写一遍，
    /// 而漏 `has_minutes` 的那几份都会多算。前三处（/me/stats 两处、待办卡）已经收进
    /// `activities_owing_minutes` 视图；这一处在**前端**，收不进视图，
    /// 那就把判据要用的**事实**带给它，让前端也只有一处判断。
    #[sqlx(default)]
    pub has_minutes: bool,
    pub title: String,
    pub agenda: String,
    pub organizer: String,
    pub recorder: String,
    pub starts_at: Ts,
    pub ends_at: Ts,
    pub timezone: String,
    pub location: String,
    pub online_url: String,
    pub visibility: String,
    pub status: String,
    pub created_at: Ts,
    /// 会后补录的实际时长(分钟,D5 第 2 级)。null = 没填过。
    #[sqlx(default)]
    pub actual_minutes: Option<i32>,
    /// 这一场提前多少分钟提醒(PRD F3)。★三态★:null=跟随个人默认 / 0=这场不提醒 / >0=提前这么多。
    /// ⚠ 旁听者那个裁剪版响应**故意不给这一项**:旁听者本来就收不到提醒
    /// (remind.rs 的 `kind <> 'observer'`),给了反而像是「可以设」。
    #[sqlx(default)]
    pub remind_minutes: Option<i32>,
    /// 活动粒度的材料策略(PRD 6.3.2)
    #[sqlx(default)] pub no_download: bool,
    #[sqlx(default)] pub no_share: bool,
    /// 我的答复(不在参会名单里则 None)。列表页据此显示「待你答复」。
    #[sqlx(default)]
    pub my_status: Option<String>,
    /// ★我在这场活动里是什么身份★(PRD C0–C2):`attendee` = 正式参会人 / `observer` = 旁听。
    /// 不在名单里则 None(可能是关联项目的成员,看得到但没被邀请)。
    ///
    /// 「我发起的」「我是记录员」前端拿 organizer/recorder 与自己比就知道,不必再查;
    /// ★只有「我是不是旁听」是库里的事实,推不出来★ —— 所以只补这一个字段。
    #[sqlx(default)]
    pub my_kind: Option<String>,
    /// 关联项目(id+名字),活动列表要显示项目标签(原型 meets 视图)。
    /// ★列表里一并带出,不让前端为每场会再打一次详情★(23 场会 = 23 个请求)。
    #[sqlx(default)]
    pub projects: Option<serde_json::Value>,
    /// 参会人数,列表显示「8 人」。
    #[sqlx(default)]
    pub participant_count: i64,
    /// 纪要状态:null=还没建 / draft=待整理 / done=已完成。
    /// 列表右侧「我负责的纪要」与状态标签靠它,否则前端要逐场会查一次。
    #[sqlx(default)]
    pub minutes_status: Option<String>,
    /// 这场会**只**关联私密项目吗?日历按它上色(私密=紫色虚框,公开=青色实框)。
    ///
    /// ★判据是**活动自己的** `visibility <> 'public'`★(M0 起;SQL 见下面 list 那条)。
    /// ⚠ 这段注释原来写的是「只要关联了任一公开项目就算公开的会」—— 那是 M0 之前的规则,
    ///   `projects.visibility` 已删,而注释停在原地整整一个里程碑(2026-08-15 订正)。
    /// 与忙闲分流仍然「保持一致」,只是两边都改成看活动自己的字段了
    /// (可见性看 `m.visibility`,忙闲看 `m.busy`)——★它们是两个正交的开关,别再绑在一起★。
    #[sqlx(default)]
    pub is_private: bool,
    /// ★关联的项目**全部**已归档吗★(PRD B1)。日历据此淡化 + 打「已归档」标。
    ///
    /// 归档项目的活动**照常显示**(B0 推翻了 D17 的这一半:日程也是「我做过什么」的记录),
    /// 但归档项目是**只读**的 —— 不标出来的话,人会点进去想传材料、想改时间,
    /// 才发现动不了。★标记是为了让「动不了」在点进去之前就可见。★
    /// 判据是「全部归档」而不是「有一个归档」:只要还有一个项目在进行中,这场会就还是活的。
    #[sqlx(default)]
    pub archived: bool,
}

#[derive(Deserialize)]
pub struct ActivityIn {
    /// 活动类型（ADR-0002）。★必填★：三个能力位（要不要纪要/项目/占忙闲）都从它来。
    pub type_id: i64,
    pub title: String,
    #[serde(default)] pub agenda: String,
    /// 记录员。★是否必填由类型的 `has_minutes` 决定★(D14:正式纪要由他按模板整理) ——
    /// 原来写死在 create 里,于是「个人日程」这类活动根本建不出来。
    #[serde(default)] pub recorder: String,
    pub starts_at: Ts,
    pub ends_at: Ts,
    #[serde(default)] pub timezone: Option<String>,
    #[serde(default)] pub location: String,
    #[serde(default)] pub online_url: String,
    #[serde(default)] pub visibility: Option<String>,
    /// 关联项目。★是否必填由类型的 `needs_project` 决定★(材料权限来自项目成员身份,D3)。
    #[serde(default)] pub project_ids: Vec<i64>,
    /// 一并邀请的人(可空,之后再加)。
    #[serde(default)] pub participants: Vec<String>,
    /// 这一场提前多少分钟提醒（PRD F3）。三态见 remind.rs：
    /// 不传/NULL = 跟随个人默认；0 = ★这场不提醒★；>0 = 提前这么多分钟。
    #[serde(default)] pub remind_minutes: Option<i32>,
}

/// GET /api/activities —— 时间线入口(D7):我参与的 + 我所在项目的活动,按时间排。
/// `from`/`to` 不给则默认「今天起 60 天」——日历页一次拉一屏,不要全量。
#[derive(Deserialize)]
pub struct RangeQ {
    pub from: Option<Ts>,
    pub to: Option<Ts>,
    /// 只看某个项目的(项目入口,D7 的另一半)。
    pub project_id: Option<i64>,
}

// ══════ 响应体类型(字段级契约,2026-08-23)══════

/// 时长的三个口径。★口径来源必须显示★(D5):不标来源,这个数字拿去汇报时没法自证。
/// 三级回退是 录制 > 手工 > 排程 —— 排程常常离谱(排 2 小时、20 分钟散会)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct HoursBySource {
    pub recording: f64,
    pub manual: f64,
    pub scheduled: f64,
}

/// 我的投入(个人面板)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MyStatsOut {
    /// 统计区间(如 `30d`)。
    pub range: String,
    /// 我参与的项目数。
    pub member_of: i64,
    pub totals: MyTotals,
    /// ★按类型是主视角★(PRD §K:「按项目答『我为哪个团队花了时间』,
    /// 按类型答『我在做什么』,后者才是个人视角的主问题」)。前端把它排在按项目**之前**。
    pub by_type: Vec<TypeStat>,
    /// ⚠★它自带一套合计,不能用上面那份 `totals`★:两张表口径不同
    /// (这张不要求有关联项目),合计自然对不上。
    /// ★拿上面那份去当这张表的合计 = 制造一个自相矛盾的数字。★
    pub totals_by_type: TypeTotals,
    pub by_project: Vec<ProjectStat>,
    /// 我主持的项目(有额外的治理数字:成员数、欠着的纪要)。
    pub hosting: Vec<HostingStat>,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MyTotals {
    pub activities: i64,
    pub hours: f64,
    pub projects: i64,
    /// 我欠着的纪要数。
    pub minutes_todo: i64,
    pub hours_by_source: HoursBySource,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct TypeStat {
    pub type_id: i64,
    pub name: String,
    pub count: i64,
    pub hours: f64,
    pub hours_by_source: HoursBySource,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct TypeTotals {
    pub activities: i64,
    pub hours: f64,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ProjectStat {
    pub id: i64,
    pub name: String,
    pub archived: bool,
    pub count: i64,
    pub hours: f64,
    /// 已完成的纪要数。
    pub minutes_done: i64,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct HostingStat {
    pub id: i64,
    pub name: String,
    pub archived: bool,
    pub members: i64,
    /// ★欠账清单★:这个项目里开完却没写完纪要的场次(不论记录员是谁)。
    pub minutes_pending: i64,
}

/// 某个项目的活动统计。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ProjectStatsOut {
    pub range: String,
    pub activities: i64,
    pub hours: f64,
    pub hours_by_source: HoursBySource,
    pub invited: i64,
    pub accepted: i64,
    /// 参会率 = 接受 / 邀请。⚠★分母不含旁听者★:他不是被邀请的,计进去会稀释这个比例。
    /// ⚠★一个人都没邀请过时是 `0.0` 而不是 null★(`accept_rate()` 里 `invited<=0` 直接回 0.0)——
    ///   我写类型时按「0/0 该是 null」写成了 Option,编译器纠正了我。
    ///   ★这里如实记下现状,而不是顺手把行为改了★:改它是产品判断
    ///   (「没邀请过人的项目参会率显示 0%」对不对),不该混在一次补契约里做。
    pub accept_rate: f64,
    /// 人均时长;null = 没有可算的样本。
    pub avg_hours_per_person: Option<f64>,
    pub minutes_done: i64,
    /// ★D6★:这是「分组展开」的数字,把多个项目的加起来 ≠ 总数。
    /// ⚠ 这句话**放在响应里**而不是只写文档:数字会被复制进汇报,而文档不会跟着走。
    pub dedup_note: String,
}

/// 活动详情。★两种形状★——旁听者拿的是裁剪版(ADR-0006 的白名单)。
///
/// ⚠ 用 `untagged` 如实表达「有两种」,而不是硬凑成一个类型:
///   凑成一个的话,要么给旁听版补上它**不该有**的字段(泄露),
///   要么把正常版的字段全标成可选(等于没有契约)。
/// ⚠★没有把两版合并成同一个结构★:那会改变旁听版的响应形状(多出 type_name 等键),
///   而这是**行为变化**,不该混在一次补契约里做。
#[derive(serde::Serialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum ActivityDetailOut {
    /// 旁听者视角。
    Observer(Box<ObserverDetail>),
    /// 参会人 / 关联项目成员视角。
    Full(Box<FullDetail>),
}

/// 旁听者看到的活动 —— ★白名单★:标题/议程/时间地点/发起人/线上地址,别的都没有。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ObserverDetail {
    pub activity: ObserverActivity,
    /// ★恒为 null★——连人数都不给(人数本身也是信息:「这会只有 2 个人」就足够说明性质)。
    pub participants: Option<serde_json::Value>,
    /// ★恒为空数组★。
    pub projects: Vec<serde_json::Value>,
    pub can_edit: bool,
    /// ★外层形状必须与正常版一致★:正常版有的键这里也要有 ——
    /// 前端 `d.can_see_items && …` 读到 undefined 虽然也是假,但
    /// ★「靠 undefined 恰好为假」不是判据,是运气★。
    pub can_see_items: bool,
    pub can_upload_items: bool,
    /// ★只有旁听版有这个键★,前端据此知道自己拿的是裁剪版。
    pub observer: bool,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ObserverActivity {
    pub id: i64,
    pub title: String,
    pub agenda: String,
    pub starts_at: chrono::DateTime<chrono::Utc>,
    pub ends_at: chrono::DateTime<chrono::Utc>,
    pub timezone: String,
    pub location: String,
    pub online_url: String,
    pub visibility: String,
    pub status: String,
    /// ★恒为 null★:旁听者不属于名单,也没有答复。显式给 null,别让前端读到 undefined。
    pub my_status: Option<String>,
    /// ★恒为 false★。
    pub is_private: bool,
    /// ★如实给★(ADR-0006):知道这场活动是谁攒的,正是旁听者判断「要不要去听」的依据之一。
    pub organizer: String,
    /// ★恒为空串★:记录员是活动内部的分工,不在白名单里。
    pub recorder: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// 参会人 / 关联项目成员看到的完整详情。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct FullDetail {
    pub activity: ActivityRow,
    pub participants: Vec<Participant>,
    pub projects: Vec<ProjectBrief>,
    pub can_edit: bool,
    /// ★由后端如实算,前端别再拿「是不是参会人」当替身判据★(ADR-0006 的实现纪律之二)——
    /// 那个替身判据正是「卡片在、列表空、上传失败」这个半截状态的成因。
    pub can_see_items: bool,
    pub can_upload_items: bool,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ProjectBrief {
    pub id: i64,
    pub name: String,
}

/// 我的未读私聊(按活动聚合)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct UnreadRow {
    pub activity_id: i64,
    pub title: String,
    pub sender: String,
    /// 最新一条的正文(节选)。
    pub body: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// 这场活动里我有几条未读 —— ★聚合到活动★,不是一条一条列。
    pub count: i64,
}

/// 我欠着的纪要。★判据是「我是记录员 且 会开完了 且 纪要非 done」★(D14)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MinutesTodoRow {
    pub activity_id: i64,
    pub title: String,
    pub starts_at: chrono::DateTime<chrono::Utc>,
    pub ends_at: chrono::DateTime<chrono::Utc>,
    /// 已经存过草稿(区分「一个字没写」和「写了一半」)。
    pub has_draft: bool,
}

/// 该提醒我的活动。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct RemindersOut {
    /// ★服务端的「现在」★:前端据此算「还有几分钟」,用本地时钟会因时钟偏差算错。
    pub now: chrono::DateTime<chrono::Utc>,
    pub items: Vec<ReminderRow>,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ReminderRow {
    pub activity_id: i64,
    pub title: String,
    pub starts_at: chrono::DateTime<chrono::Utc>,
    /// ★投递时刻,恒非空★——这个接口只返回**已经投过**的(查询里筛了 `reminded_at IS NOT NULL`)。
    /// 它存的是**事实**不是推导(ADR-0003),所以改期也不会让它翻转。
    /// ⚠ 我一开始把它写成 `Option`(以为「没投过 = null」),★编译器当场纠正★ ——
    ///   `json!` 里就不会有人问这个问题。
    pub reminded_at: chrono::DateTime<chrono::Utc>,
}

/// 一段忙碌区间。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct BusySlot {
    pub start: chrono::DateTime<chrono::Utc>,
    pub end: chrono::DateTime<chrono::Utc>,
}

/// 多人忙闲。★key 是用户名★,查了谁就有谁 —— 一个人没有任何忙碌区间时是空数组,
/// 而不是这个 key 不存在(否则前端分不清「查过了他很闲」和「压根没查他」)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct FreeBusyOut {
    pub busy: std::collections::BTreeMap<String, Vec<BusySlot>>,
}

/// 纪要 + 我能不能改它。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MinutesGetOut {
    /// null = 这场活动还没有纪要(而不是「有一份空的」)。
    pub minutes: Option<Minutes>,
    /// ★谁能改:记录员(本职)或发起人★ —— 不是「参会人都能改」,纪要要有唯一作者(D14)。
    pub can_edit: bool,
}

/// 答复一场活动(接受 / 拒绝 / 待定 / 建议改期)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct RespondOut {
    pub ok: bool,
    /// 答复之后的状态。
    pub status: String,
    /// ★拒绝出席之后,我还是不是记录员★——转走了就是 false。
    /// 只有「记录员拒绝出席」这条路径才给这两个字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub still_recorder: Option<bool>,
    /// 纪要自动转给了谁(记录员拒绝出席 → 落回发起人)。没转就是 null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorder_moved_to: Option<Option<String>>,
}

/// 批量邀请。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct InviteOut {
    pub ok: bool,
    /// 这次真正新加进去的人数 —— ★已经在名单里的不重复计★。
    pub invited: u64,
}

/// 催办未应答的人。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct RemindOut {
    pub ok: bool,
    /// 这次**该催**几个人(只算未应答的,已答复的不打扰)。
    pub targets: usize,
    /// 实际**投出去**几条站内信。★可能小于 targets★:平台 registry 不可达时
    /// 投递是 fire-and-forget、失败只记 warn —— 两个数分开给,才看得出「催了但没送到」。
    pub sent: usize,
}

/// 接受「建议改期」。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct AcceptCounterOut {
    pub ok: bool,
    /// 改期后的新起止 —— ★回显是必要的★:接受的是对方提的时间,发起人得看见自己接受了什么。
    pub starts_at: chrono::DateTime<chrono::Utc>,
    pub ends_at: chrono::DateTime<chrono::Utc>,
}

/// 自助旁听。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ObserveOut {
    pub ok: bool,
    /// ★这个接口是**切换**★:true = 现在开始旁听,false = 刚退出旁听。
    pub observing: bool,
    /// 开始旁听时给:false = 本来就在旁听(幂等,再点一次不报错也不重复加)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<bool>,
    /// 退出旁听时给:删掉了几行(0 = 本来就没在旁听)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u64>,
}

/// 取这场活动的材料文件夹(没有就建)。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MaterialsProjectOut {
    pub project_id: i64,
}

/// 标记已读。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MarkReadOut {
    /// 这次标掉的条数。
    pub marked: u64,
}

/// 存纪要。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MinutesPutOut {
    pub ok: bool,
    /// 存完之后纪要的状态(`draft` / `done`)。★由后端判,不由前端传什么就是什么★。
    pub status: String,
}

/// 导出纪要 PDF。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct MinutesPdfOut {
    /// PDF 落成的材料条目 id。★重复导出是同一条 item 的新版本,这个 id 不变★。
    pub item_id: i64,
    /// 这份 PDF 导的是不是草稿(纪要还没定稿)——是的话文件首页会带「【草稿 · 尚未定稿】」。
    pub draft: bool,
}


pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<RangeQ>,
) -> AppResult<Json<Vec<ActivityRow>>> {
    let username = id.require_username()?;
    let from = q.from.unwrap_or_else(|| chrono::Utc::now() - chrono::Duration::days(1));
    let to = q.to.unwrap_or_else(|| chrono::Utc::now() + chrono::Duration::days(60));
    // 可见性三条来源与 activity_view 同源(参会人 / 关联项目成员 / 超管),这里是它的**集合版**。
    // ⚠ public 活动**不进这个列表**:列表是「我的日程」,不是全平台公告板;
    //    旁听要靠拿到具体活动 id 去看详情(D9 给的是「可访问」,不是「推给你」)。
    let rows: Vec<ActivityRow> = sqlx::query_as(
        // ★is_private 必须由 SQL 算★:字段声明了却不算,#[sqlx(default)] 会静静给 false,
        // 于是私密项目的会在日历上显示成公开色 —— D1 的隐私提示当场失效且不报错。
        "SELECT m.*, at.name AS type_name, at.has_minutes, mp.status AS my_status, mp.kind AS my_kind,
                m.visibility <> 'public' AS is_private,
                -- ★全部关联项目都归档了吗★(B1):零关联项目的活动恒为 false ——
                -- 「没有项目」不等于「项目都归档了」,前者是个人活动、活得好好的。
                (EXISTS (SELECT 1 FROM activity_projects a1 JOIN projects q1 ON q1.id = a1.project_id
                          WHERE a1.activity_id = m.id AND q1.archived_at IS NOT NULL)
                 AND NOT EXISTS (SELECT 1 FROM activity_projects a2 JOIN projects q2 ON q2.id = a2.project_id
                          WHERE a2.activity_id = m.id AND q2.archived_at IS NULL)) AS archived,
                -- 列表要显示的三样,都在这条 SQL 里一次取全:
                -- ★不让前端为每场会再打一次详情★(23 场会 = 23 个请求 = 列表页卡住)
                (SELECT coalesce(json_agg(json_build_object('id', p2.id, 'name', p2.name)), '[]'::json)
                   FROM activity_projects mp2 JOIN projects p2 ON p2.id = mp2.project_id
                  WHERE mp2.activity_id = m.id AND p2.deleted_at IS NULL) AS projects,
                (SELECT count(*) FROM activity_participants x WHERE x.activity_id = m.id) AS participant_count,
                (SELECT mm.status FROM activity_minutes mm WHERE mm.activity_id = m.id) AS minutes_status
           FROM activities m
           JOIN activity_types at ON at.id = m.type_id
           LEFT JOIN activity_participants mp ON mp.activity_id = m.id AND mp.username = $1
          WHERE m.status = 'active' AND m.starts_at < $3 AND m.ends_at > $2
            AND ($4::bigint IS NULL OR EXISTS (
                  SELECT 1 FROM activity_projects x WHERE x.activity_id = m.id AND x.project_id = $4))
            -- 可见性:参会人 / 关联项目成员 / 超管,三选一
            -- ⚠★这三条必须包在同一对括号里★(2026-08-07 事故):加归档过滤时我把括号提前闭合了,
            --   超管那条掉进了下面 NOT EXISTS 的子查询里 → 对超管而言子查询 WHERE 恒真
            --   → 只要活动关联了任何项目就被 NOT EXISTS 滤掉 → ★超管一场会都看不到★。
            --   非超管完全不受影响,所以 24 条 E2E 全绿而用户(超管)的界面是空的。
            AND (mp.username IS NOT NULL
                 OR EXISTS (SELECT 1 FROM activity_projects mpj
                              JOIN project_members pm ON pm.project_id = mpj.project_id
                              JOIN projects p ON p.id = mpj.project_id AND p.deleted_at IS NULL
                             WHERE mpj.activity_id = m.id AND pm.username = $1)
                 -- 超管特权只认 super_now:关着超管模式时,别人的活动不进我的日历
                 OR EXISTS (SELECT 1 FROM super_now WHERE username = $1))
            -- ★关联项目**全部**被删则这场会不再出现★(2026-08-07,Playwright 截图里肉眼看出来的):
            -- 项目软删除不动 activity_projects 也不动成员表,所以删掉项目之后它的活动照样躺在日历上,
            -- 还因为「找不到未删的公开项目」被误标成**私密**(紫色虚框)。
            --
            -- ⚠★2026-08-09 这一条差点把「个人日程」整类活动吞掉★(liaoruili:「我创建完个人活动,
            --   这里没有显示呢??」)。它当初写作 `EXISTS(未删的关联项目)`,依据是当时那条
            --   「活动必须关联至少一个项目」的硬约束 —— ★而 ADR-0002 加了 needs_project
            --   能力位之后,这个前提就不成立了★:「个人日程」本来就是零关联项目。
            --   于是它被这条过滤悄悄滤掉:不报错、创建成功、日历上就是没有。
            --   ★「注释里写着的前提」会过期,而 SQL 不会自己发现★(同一天已在 D10 的只读区、
            --   AI 摘要的 kind 上各栽过一次)。
            -- 改成:**有关联就要求至少一个活着;没关联的直接放行**。
            AND (NOT EXISTS (SELECT 1 FROM activity_projects mpn WHERE mpn.activity_id = m.id)
                 OR EXISTS (SELECT 1 FROM activity_projects mpd
                              JOIN projects pd ON pd.id = mpd.project_id
                             WHERE mpd.activity_id = m.id AND pd.deleted_at IS NULL))
            -- ★归档项目的活动**照常进日历**★(PRD B0,2026-08-07 liaoruili 推翻了 D17 的这一半)。
            --
            -- ⚠★这里原来滤掉它们,执行的是一条已被明确推翻的决定★(2026-08-09 全量审计发现,
            --   PRD B0 写了两天没人落):我当初的理由是「日历回答『我接下来要做什么』,
            --   塞满已结题项目的历史会变成考古现场」——★这个视角是片面的★。
            --   liaoruili:「日程也是**我做过什么**的记录,有时候用户就想回顾之前的工作,
            --   看看满日程的很有成就感」。归档不该让过去消失,那些时间是真的花掉了。
            --
            -- 不加过滤,改为**标出来**:下面把 `archived` 一并回给前端,由它淡化 + 打「已归档」标(B1)。
            -- ★为什么必须标而不是一视同仁★:归档项目是**只读**的(D17 的这一半仍然成立),
            --   不加区分的话用户会点进去想传材料、想改时间,才发现动不了 ——
            --   标记是为了让「动不了」这件事在**点进去之前**就可见。
          ORDER BY m.starts_at",
    )
    .bind(username).bind(from).bind(to).bind(q.project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<ActivityIn>,
) -> AppResult<Json<crate::http::dto::IdOut>> {
    let username = id.require_username()?;
    let title = input.title.trim();
    if title.is_empty() { return Err(AppError::BadRequest("活动标题不能为空".into())) }
    // ★校验按类型的能力位走,不再写死★(ADR-0002)。
    let caps: crate::http::activity_types::Caps = sqlx::query_as(
        "SELECT has_minutes, needs_project, busy_default, allow_past FROM activity_types
          WHERE id = $1 AND deleted_at IS NULL AND (owner IS NULL OR owner = $2)")
        .bind(input.type_id).bind(username).fetch_optional(&state.pool).await?
        .ok_or_else(|| AppError::BadRequest("活动类型不存在,或者不是你的".into()))?;
    crate::http::activity_types::check_caps(&caps, &input.recorder, &input.project_ids)
        .map_err(|m| AppError::BadRequest(m.into()))?;
    // ★跨度上界 30 天★(F4):一条输错年份的活动会命中每一次日历/忙闲查询,
    // 把两条最热的路径一起拖垮,而任何一屏上都看不出是哪条记录干的。判据是纯函数,带单测。
    crate::http::activity_types::check_span(input.starts_at, input.ends_at)
        .map_err(AppError::BadRequest)?;
    // ★能不能填过去的时间,由**类型的能力位**说了算★(F0/F1,2026-08-09 liaoruili:
    // 「会议类型的活动只能发起未来的会议,其他类型可以后面补录」)。
    //
    // ⚠★这里原来是写死的「所有活动都不能排过去」★(2026-08-07 用户的原话是「不能发起已经
    //   过去的会」——说的是**会**),而 PRD F0 同一天写着「所有类型都能填任意时间」。
    //   两条同日的决定就这么在代码里打了半个月的架:补录一场昨天的读文献创建不了,
    //   人只能先建一条再去改时间绕过去(update 没有这道闸)。
    //   ★根因是把「会议」这一类的规则写成了全局规则★ —— 正是 A1「类型决定能力,不是纯标签」
    //   要避免的那件事。现在收回 `allow_past` 能力位,判据只有一个,就在 activity_types 表里。
    //
    // 容差只对**创建**放;改期(update)本来就不限,那是修正历史记录的正当场景。
    crate::http::activity_types::check_past(&caps, input.starts_at, chrono::Utc::now())
        .map_err(|m| AppError::BadRequest(m.into()))?;
    // ★每个关联项目都要 ≥editor★:把活动挂到一个项目上等于往那个项目里塞东西(纪要/材料最终落在那)。
    // 逐个校验而不是只验第一个——多项目关联时,漏验的那个就是越权入口(D4)。
    for pid in &input.project_ids {
        perm::require_role(&state.pool, &id, *pid, perm::Role::Editor).await?;
    }
    let vis = match input.visibility.as_deref() { Some("public") => "public", _ => "private" };

    let mut tx = state.pool.begin().await?;
    let mid: i64 = sqlx::query_scalar(
        // busy 取类型的 busy_default 作初值(A3);用户想改逐条改,不改类型。
        "INSERT INTO activities (title, agenda, organizer, recorder, starts_at, ends_at, timezone,
                               location, online_url, visibility, type_id, busy, remind_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'Asia/Shanghai'),$8,$9,$10,$11,$12,$13) RETURNING id")
        .bind(title).bind(&input.agenda).bind(username).bind(input.recorder.trim())
        .bind(input.starts_at).bind(input.ends_at).bind(input.timezone.as_deref())
        .bind(&input.location).bind(&input.online_url).bind(vis)
        .bind(input.type_id).bind(caps.busy_default).bind(input.remind_minutes)
        .fetch_one(&mut *tx).await?;
    for pid in &input.project_ids {
        sqlx::query("INSERT INTO activity_projects (activity_id, project_id) VALUES ($1,$2)")
            .bind(mid).bind(pid).execute(&mut *tx).await?;
    }
    // 发起人与记录员自动进名单(发起人 accepted:他自己定的时间,不用再答复一次)。
    // 发起人 notified_at=now():他自己定的时间,不存在「不知情」
    sqlx::query("INSERT INTO activity_participants (activity_id, username, status, responded_at, notified_at)
                 VALUES ($1,$2,'accepted',now(),now()) ON CONFLICT DO NOTHING")
        .bind(mid).bind(username).execute(&mut *tx).await?;
    // ⚠★记录员可能为空★(ADR-0002:`has_minutes=false` 的类型不要记录员)。
    //   不守这一下的话会往名单里插一行**空用户名** —— 它不属于任何人,
    //   却会出现在参与人列表、进忙闲、还占一个「未答复」名额。
    if !input.recorder.trim().is_empty() {
        sqlx::query("INSERT INTO activity_participants (activity_id, username) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(mid).bind(input.recorder.trim()).execute(&mut *tx).await?;
    }
    for u in &input.participants {
        let u = u.trim();
        if u.is_empty() { continue }
        sqlx::query("INSERT INTO activity_participants (activity_id, username) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(mid).bind(u).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    audit::record(&state.pool, username, "activity.create", &mid.to_string(), title).await;
    // ★约完就通知★:没有这一步,「我约了你」这件事只存在于我的屏幕上
    let who = notify_targets(&state.pool, mid, username).await;
    // ★标题用「<类型名>邀请」,不写「有人约你开会」★（2026-08-13 liaoruili:「直接说 会议邀请」）。
    //
    // ⚠★为什么取类型名而不是写死「会议」★:邀请对**任何**活动类型都会发,
    //   而 M0 起「会议」只是众多类型里的一个(ADR-0002,类型决定表单)。
    //   写死的话,一场「读书会」的邀请会被标成「会议邀请」—— 又一次把某一类的名字当成了全体的名字,
    //   那正是 M0 花了整整一轮把「会议」改名「活动」要根除的东西。
    //   取类型名:会议 → 「Congrove 会议邀请」(正是他要的),读书会 → 「Congrove 读书会邀请」。
    let 类型名: String = sqlx::query_scalar("SELECT name FROM activity_types WHERE id=$1")
        .bind(input.type_id).fetch_optional(&state.pool).await?.unwrap_or_else(|| "活动".into());
    notify_activity(&state, mid, &who, &format!("{类型名}邀请"),
        &format!("{username} 约你参加「{title}」,{}。请答复。", fmt_when(input.starts_at, crate::tzutil::parse(input.timezone.as_deref().unwrap_or_default()))), crate::notify::Kind::Invite).await;
    mark_notified(&state.pool, mid, &who).await?;
    Ok(Json(crate::http::dto::IdOut { id: mid }))
}

/// GET /api/activities/{id} —— 详情。★旁听者拿到的是**裁剪版**★(D9):
/// 只有标题/议程/时间/地点/链接,没有参会名单,更没有材料入口。
pub async fn detail(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<ActivityDetailOut>> {
    let view = activity_view(&state.pool, &id, mid).await?;
    let m: ActivityRow = sqlx::query_as(
        "SELECT m.*, at.name AS type_name, mp.status AS my_status,
                m.visibility <> 'public' AS is_private
           FROM activities m
           JOIN activity_types at ON at.id = m.type_id
           LEFT JOIN activity_participants mp ON mp.activity_id = m.id AND mp.username = $2
          WHERE m.id = $1")
        .bind(mid).bind(id.require_username()?)
        .fetch_optional(&state.pool).await?
        .ok_or(AppError::NotFound)?;
    if view == ActivityView::Observer {
        // ★逐字段挑出来给★,不是把 ActivityRow 塞进去删两个键——后者在加字段时会**默认泄露**。
        //
        // ⚠★外层形状必须与正常版一致★(2026-08-09 全量审计 A3):这里原来直接吐**扁平对象**
        // (`{id,title,…,observer:true}`),没有 `activity` 这一层,而前端第一行就是
        // `const m = d.activity` → 下一行 `m.status` **TypeError,整页白屏**。
        // 触发路径:日程页「公开活动」广场点标题、站内信 `?activity=` 深链、旁听后从日历点进去。
        // ★两边的门禁互相抵消了★:E2E 断言的恰好是扁平形状(把契约钉成了扁平),
        // 而 `tsc` 认定 `activity` 必存在 —— 于是**没有任何一道闸会红**。
        // 裁剪的是**内容**(无名单、无关联项目、can_edit=false),不该顺带把**结构**也裁了。
        return Ok(Json(ActivityDetailOut::Observer(Box::new(ObserverDetail {
            activity: ObserverActivity {
                id: m.id, title: m.title, agenda: m.agenda,
                starts_at: m.starts_at, ends_at: m.ends_at, timezone: m.timezone,
                location: m.location, online_url: m.online_url,
                visibility: m.visibility, status: m.status,
                my_status: None, is_private: false,
                // ★发起人如实给★(2026-08-17,ADR-0006 决定一的反方向缺口):原来置空串,
                //   旁听者界面上「发起人」那一行是**空的** —— 而白名单里明确含「发起人」。
                organizer: m.organizer, recorder: String::new(), created_at: m.created_at,
            },
            participants: None,
            projects: vec![],
            can_edit: false,
            can_see_items: false, can_upload_items: false,
            observer: true,
        }))));
    }
    let parts: Vec<Participant> = sqlx::query_as(
        "SELECT p.username, u.name, p.kind, p.required, p.status, p.counter_starts_at, p.counter_ends_at,
                p.counter_reason, p.responded_at, p.reminded_at
           FROM activity_participants p LEFT JOIN app_user u ON u.username = p.username
          WHERE p.activity_id = $1 ORDER BY p.invited_at")
        .bind(mid).fetch_all(&state.pool).await?;
    let projects: Vec<(i64, String)> = sqlx::query_as(
        "SELECT p.id, p.name FROM activity_projects mp JOIN projects p ON p.id = mp.project_id
          WHERE mp.activity_id = $1 AND p.deleted_at IS NULL")
        .bind(mid).fetch_all(&state.pool).await?;
    // ★由后端如实算「能不能看材料 / 能不能传」,前端别再拿「是不是参会人」当替身判据★
    // (2026-08-17,ADR-0006 的实现纪律之二)——那个替身判据正是
    // 「卡片在、列表空、上传失败」这个半截状态的成因。判据只有一处,新增入口自动被覆盖。
    let 材料权 = crate::perm::activity_material_access(&state.pool, &id, mid, None).await?;
    Ok(Json(ActivityDetailOut::Full(Box::new(FullDetail {
        activity: m, participants: parts,
        projects: projects.into_iter().map(|(id, name)| ProjectBrief { id, name }).collect(),
        can_edit: require_activity_host(&state.pool, &id, mid).await.is_ok(),
        can_see_items: 材料权 >= crate::perm::材料权::只读,
        can_upload_items: 材料权 >= crate::perm::材料权::可传,
    }))))
}

#[derive(Serialize, sqlx::FromRow, schemars::JsonSchema)]
pub struct Participant {
    pub username: String,
    /// 真实姓名;没登录过则为空
    #[sqlx(default)]
    pub name: Option<String>,
    pub kind: String,
    /// 必参 / 选参(PRD 6.1.2)。★只有必参人的冲突算「有冲突」★——
    /// 一场 10 人的会总有人撞车,每个人的冲突都标红,那个红色就变成了背景噪音。
    #[sqlx(default)]
    pub required: bool,
    pub status: String,
    pub counter_starts_at: Option<Ts>,
    pub counter_ends_at: Option<Ts>,
    pub counter_reason: Option<String>,
    pub responded_at: Option<Ts>,
    /// ★提醒是什么时候投出去的★(2026-08-16;NULL = 还没投)。
    ///
    /// 为什么要把它端到界面上:prod 上出过一次「改期通知没收到」,
    /// ★排查全靠猜★ —— 界面上看不出「到底提醒过没有」,只能进库查 activity_participants。
    /// 而这两种情况的处置完全不同:**没投**是我们的问题(扫描没跑到/判据把它排除了),
    /// **投了没收到**是站内信那一段的问题(registry 不可达、被去重吞掉)。
    /// ⚠ 它是「投递那一刻」,不是「会开始的时刻」——两个都是时间戳,极易看混。
    pub reminded_at: Option<Ts>,
}

/// 让 `Option<Option<T>>` 能区分「没传」与「传了 null」。
/// `#[serde(default)]` 负责「没传 → None」；字段一旦出现，这里就把它包成 `Some(...)`。
fn de_double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where D: serde::Deserializer<'de>, T: serde::Deserialize<'de> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
pub struct ActivityPatch {
    pub title: Option<String>,
    pub agenda: Option<String>,
    pub recorder: Option<String>,
    pub starts_at: Option<Ts>,
    pub ends_at: Option<Ts>,
    pub location: Option<String>,
    pub online_url: Option<String>,
    pub visibility: Option<String>,
    /// 活动粒度的材料策略(PRD 6.3.2)。⚠ 与项目级**叠加不是覆盖**:两处任一禁了就禁。
    pub no_download: Option<bool>,
    pub no_share: Option<bool>,
    /// ⚠★改它不清 reminded_at 是有意的★：把「提前 15 分」改成「提前 30 分」时，
    /// 如果这个人**已经**按 15 分那档收过提醒了，再发一遍是骚扰而不是补救。
    /// 清 reminded_at 只发生在**改时间**（reset_after_reschedule）—— 那时旧提醒才真的作废。
    /// ⚠★双层 Option★（2026-08-12 实现前端下拉时发现的真 bug）：
    /// 这一列的 `null` 是**一个合法取值**（跟随个人默认），不是「没传」。
    /// 而原来的写法是 `Option<i32>` + SQL 里 `COALESCE($n, remind_minutes)` ——
    /// 于是「传了 null」和「压根没传」在后端**长得一模一样**，用户在界面上选
    /// 「跟随个人默认」，请求 200、界面照常刷新，★数据库里一个字节都没变★。
    /// 静默失败是最贵的那种失败：没有报错可查，只有过一阵子有人问「我明明关过」。
    ///
    /// 双层的读法：`None` = 字段没出现在 JSON 里；`Some(None)` = 显式传了 null；
    /// `Some(Some(n))` = 传了值。SQL 侧配一个 bool「要不要动这一列」。
    /// ★凡是「null 有含义」的可空列都得这么写★ —— 同批把 actual_minutes 也改了，
    /// 它的 null 是「没填过」，此前「清空实际时长」同样是静默无效。
    #[serde(default, deserialize_with = "de_double_option")]
    pub remind_minutes: Option<Option<i32>>,
    /// ★会后补录的实际时长★(D5 三级回退的第 2 级,单位**分钟**)。
    /// 绝大多数会不会录屏,而排程时长常常离谱(排 2 小时、20 分钟讲完就散);
    /// 没有这一级,统计出来的数字系统性偏高 —— 而它是要拿去做季度汇报的。
    #[serde(default, deserialize_with = "de_double_option")]
    pub actual_minutes: Option<Option<i32>>,
    /// ★关联项目：只增不减★（2026-08-09 用户）。
    ///
    /// 传进来的 id 会被**并入**现有关联，**永远不删**。理由是关联项目一旦建立，
    /// 那个项目的成员就已经收到了通知、看得到材料 —— 事后解除关联并不能把
    /// 「他已经知道这场活动」收回去，只会让他手里的入口突然 404，
    /// 而库里再也查不出他当时是凭什么看到的。★能撤销的东西才适合做成开关。★
    /// 真要收回，走的是删活动（软删、留痕），不是悄悄摘掉一个项目。
    #[serde(default)]
    pub add_project_ids: Option<Vec<i64>>,
}

/// ★改期之后要作废的东西★（PRD F2 + D2）。两个入口共用：`update` 与 `accept_counter`。
///
/// 抽成一个函数不是为了省几行 —— 是因为**它们本来就是同一件事的两面**：时间变了，
/// 之前基于旧时间做出的一切都作废。此前只有「答复」一项，两处各写一遍；
/// 加「提醒」时若只改一处，另一处就会★静默地按旧时间已发过的状态★继续躺着，
/// 于是改期之后那批人再也收不到提醒 —— 而它不报错。
///
/// ⚠★两者的「除了谁」不一样，别顺手写齐★：
///   · **答复**排除操作人 —— 时间是他改的，他不用再答复一次；
///   · **提醒不排除任何人** —— 「会快开始了」对发起人同样成立，他也要被叫。
async fn reset_after_reschedule(
    tx: &mut sqlx::PgConnection, mid: i64, actor: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE activity_participants SET status='pending', responded_at=NULL,
                counter_starts_at=NULL, counter_ends_at=NULL, counter_reason=NULL
          WHERE activity_id=$1 AND username <> $2")
        .bind(mid).bind(actor).execute(&mut *tx).await?;
    sqlx::query("UPDATE activity_participants SET reminded_at=NULL WHERE activity_id=$1")
        .bind(mid).execute(&mut *tx).await?;
    Ok(())
}

pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(p): Json<ActivityPatch>,
) -> AppResult<Json<crate::http::dto::OkOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    // ★改「公开/私密」比改别的重★(PRD 6.1.7:「只有项目主持人或活动发起人能切换」):
    // 一旦公开,议题与议程对**全平台**可见 —— 这不是记录员该有的权限,
    // 而 require_activity_host 是把记录员算进去的(他要整理纪要,所以能改标题议程)。
    // ⚠ 判「项目主持人」用**任一关联项目的 owner**:活动可以挂多个项目,任何一个的主持人都算。
    if p.visibility.is_some() {
        let who = id.require_username()?;
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM activities WHERE id = $1 AND organizer = $2)
                 OR EXISTS (SELECT 1 FROM activity_projects mp
                              JOIN projects pr ON pr.id = mp.project_id AND pr.deleted_at IS NULL
                             WHERE mp.activity_id = $1 AND pr.owner = $2)
                 OR EXISTS (SELECT 1 FROM super_now WHERE username = $2)")
            .bind(mid).bind(who).fetch_one(&state.pool).await?;
        if !ok {
            return Err(AppError::Forbidden);
        }
    }
    // ⚠ 多取一个 `timezone`:下面重算材料文件夹名要用**活动自己的**时区
    //   (不是看的人的 —— 那个名字是存进库的,见 items.rs::activity_folder_name 的注释)。
    let cur: (Ts, Ts, String, String, String) =
        sqlx::query_as("SELECT starts_at, ends_at, online_url, title, timezone FROM activities WHERE id=$1")
        .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    let (s, e) = (p.starts_at.unwrap_or(cur.0), p.ends_at.unwrap_or(cur.1));
    // 跨度上界与创建同一套(F4)。⚠ 改期**不**受 allow_past 约束 —— 那是修正历史记录的正当场景。
    crate::http::activity_types::check_span(s, e).map_err(AppError::BadRequest)?;
    // ★实际时长按**这场活动的跨度**算上界,不写死一天★(F4 连带条):
    // 写死 1440 分钟的话,三天的出差就填不了实际时长。
    // ⚠ 双层 Option 后这里必须是 `Some(Some(..))`：`Some(None)` 是**显式清空**，
    // 清空没有范围可校验（也不该被上界拦下来）。写成 `Some(am)` 会把内层 Option 当值传进去。
    if let Some(Some(am)) = p.actual_minutes {
        crate::http::activity_types::check_actual_minutes(am, s, e).map_err(AppError::BadRequest)?;
    }

    // 先读原记录员:下面要判「这次是不是真的换人了」——只有换了才拉名单、才发信,
    // 否则每存一次活动都给同一个人发一条「你被指派为记录员」。
    let 原记录员: Option<String> = sqlx::query_scalar("SELECT recorder FROM activities WHERE id = $1")
        .bind(mid).fetch_optional(&state.pool).await?;
    let mut 换了记录员: Option<String> = None;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE activities SET title=COALESCE($2,title), agenda=COALESCE($3,agenda),
                recorder=COALESCE($4,recorder), starts_at=$5, ends_at=$6,
                location=COALESCE($7,location), online_url=COALESCE($8,online_url),
                visibility=COALESCE($9,visibility),
                -- ★$10 是「这次要不要动这一列」,$11 才是值★(2026-08-12)。
                -- 原来写的是 COALESCE($10,actual_minutes) —— 那样「显式清空」和「没传」
                -- 无法区分,于是清空静默失效。这两列的 null 都是**有含义的值**,不是缺省。
                actual_minutes=CASE WHEN $10 THEN $11 ELSE actual_minutes END,
                actual_by=CASE WHEN $10 AND $11 IS NOT NULL THEN $12 ELSE actual_by END,
                no_download=COALESCE($13,no_download), no_share=COALESCE($14,no_share),
                remind_minutes=CASE WHEN $15 THEN $16 ELSE remind_minutes END,
                updated_at=now()
          WHERE id=$1")
        .bind(mid).bind(p.title.as_deref()).bind(p.agenda.as_deref()).bind(p.recorder.as_deref())
        .bind(s).bind(e).bind(p.location.as_deref()).bind(p.online_url.as_deref())
        .bind(p.visibility.as_deref())
        .bind(p.actual_minutes.is_some()).bind(p.actual_minutes.flatten()).bind(id.require_username()?)
        .bind(p.no_download).bind(p.no_share)
        .bind(p.remind_minutes.is_some()).bind(p.remind_minutes.flatten())
        .execute(&mut *tx).await?;

    // ★换了记录员:把他拉进名单并通知他★(2026-08-23 liaoruili 报「无法修改记录人」时补齐)。
    //
    // ⚠★create 会做这件事,update 原来不做★ —— 这个不一致的后果是:
    //   指派一个不在参会名单里的人当记录员,他**既不在名单里、也收不到任何通知**,
    //   却会在自己的「待写纪要」里凭空多出一场会(那个查询按 `recorder` 判)。
    //   ★责任落到一个不知情的人头上★ —— 和 `respond` 里那段自动转移守的是同一条。
    if let Some(新记录员) = p.recorder.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if 原记录员.as_deref() != Some(新记录员) {
            sqlx::query("INSERT INTO activity_participants (activity_id, username) VALUES ($1,$2)
                         ON CONFLICT DO NOTHING")
                .bind(mid).bind(新记录员).execute(&mut *tx).await?;
            换了记录员 = Some(新记录员.to_string());
        }
    }
    // ★改线上链接留痕★:开会前十分钟换链接是真实场景,事后要能追溯「谁何时改成什么」。
    if let Some(new) = p.online_url.as_deref() {
        if new != cur.2 {
            sqlx::query("INSERT INTO activity_link_history (activity_id, old_url, new_url, changed_by)
                         VALUES ($1,$2,$3,$4)")
                .bind(mid).bind(&cur.2).bind(new).bind(id.require_username()?)
                .execute(&mut *tx).await?;
        }
    }
    // ★关联项目:只增不减★(见 ActivityPatch::add_project_ids 的注释)。
    // 每个新增的项目都要 ≥editor —— 把活动挂到一个项目上等于往那个项目塞材料入口,
    // 逐个校验而不是只验第一个(多项目关联时,漏验的那个就是越权入口)。
    if let Some(add) = p.add_project_ids.as_deref() {
        for pid in add {
            crate::perm::require_role(&state.pool, &id, *pid, crate::perm::Role::Editor).await?;
            sqlx::query("INSERT INTO activity_projects (activity_id, project_id) VALUES ($1,$2)
                         ON CONFLICT DO NOTHING")
                .bind(mid).bind(pid).execute(&mut *tx).await?;
        }
    }

    // ★改了时间就把所有人的答复清回 pending★:上次的「接受」是对**旧时间**说的,
    // 留着它等于替人答应了一个他没看过的时间。发起人与记录员除外(改的人自己知道)。
    if (p.starts_at.is_some() || p.ends_at.is_some()) && (s != cur.0 || e != cur.1) {
        reset_after_reschedule(&mut tx, mid, id.require_username()?).await?;
    }
    // ★活动材料文件夹的名字跟着活动走★（2026-08-09 liaoruili:「现在改了会议 title,
    // 文件夹名字会一起变吗」——**当时不会,这是个缺陷**）。
    //
    // 文件夹名是 `YYYY-MM-DD 活动标题`,是一个**派生值**;而同一批改动里我刚刚
    // ★禁掉了在项目树里给它改名★(理由正是「名字由活动决定」)。
    // 两条加在一起:源变了而派生值不变,这个名字就**永久错着、且谁都改不了** ——
    // ★把唯一的修正入口也堵上,比不派生更糟。★ 所以源一变就跟着改。
    //
    // 认领仍然靠 activity_id(不靠名字),所以改名不会让材料散成两处。
    let title_now = p.title.as_deref().unwrap_or(&cur.3);
    if title_now != cur.3 || s != cur.0 {
        // ★命名规则只有一处★:见 items.rs::activity_folder_name 的注释
        let name = crate::http::items::activity_folder_name(s, title_now, crate::tzutil::parse(&cur.4));
        sqlx::query("UPDATE items SET name=$2, updated_at=now()
                      WHERE activity_id=$1 AND kind='folder' AND deleted_at IS NULL AND name <> $2")
            .bind(mid).bind(&name).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let actor = id.require_username()?;
    audit::record(&state.pool, actor, "activity.update", &mid.to_string(), "").await;
    // 改时间和改链接是**两件不同的急事**,所以分开通知、正文不一样:
    //   · 改时间 → 所有人的答复已被清回 pending,他们必须重新答复;
    //   · 改链接 → 不用重新答复,但**到点前必须看到**(开会前十分钟换链接是真实场景)。
    // 其余改动(标题/议程/地点)不发信:够不上打扰所有人的分量,他们打开活动页就看得到。
    // ★换记录员要单独通知他★:上面那两条(改时间/改链接)发给的是**全体**,
    //   而「你被指派为记录员」只跟他一个人有关 —— 混在群发里他也未必看得出这条是冲他来的。
    //   ⚠ 通知在 commit 之后:事务回滚了信却发了 = 说了不算数的话(与 respond 同一条纪律)。
    if let Some(新人) = &换了记录员 {
        let mtitle: String = sqlx::query_scalar("SELECT title FROM activities WHERE id=$1")
            .bind(mid).fetch_one(&state.pool).await.unwrap_or_default();
        notify_activity(&state, mid, std::slice::from_ref(新人), "你被指派为这场活动的记录员",
            &format!("「{mtitle}」的记录员改成了你。正式纪要由记录员按模板整理(AI 转写只是原材料);                      要换人的话,发起人可以在活动页把「记录员」改掉。"),
            crate::notify::Kind::RecorderAssigned).await;
        // 被指派的人如果原来不在名单里,上面刚把他插进去 —— 他现在「知情」了,置位。
        mark_notified(&state.pool, mid, std::slice::from_ref(新人)).await?;
    }
    let time_changed = (p.starts_at.is_some() || p.ends_at.is_some()) && (s != cur.0 || e != cur.1);
    let link_changed = p.online_url.as_deref().is_some_and(|n| n != cur.2);
    if time_changed || link_changed {
        let who = notify_targets(&state.pool, mid, actor).await;
        let mtitle: String = sqlx::query_scalar("SELECT title FROM activities WHERE id=$1")
            .bind(mid).fetch_one(&state.pool).await?;
        if time_changed {
            notify_activity(&state, mid, &who, "活动时间已改",
                &format!("「{mtitle}」改到 {} —— ★你之前的答复已作废,请重新答复★。", fmt_when(s, crate::tzutil::parse(&cur.4))), crate::notify::Kind::Reschedule).await;
        }
        if link_changed {
            notify_activity(&state, mid, &who, "线上活动链接已改",
                &format!("「{mtitle}」({})的线上链接已更换,开会前请从活动页重新点开。", fmt_when(s, crate::tzutil::parse(&cur.4))), crate::notify::Kind::LinkChanged).await;
        }
        // ★ADR-0003 边界①:补录 → 改到未来,必须补发邀请**并置位**★。
        // 上面那两条通知就是「补发邀请」;这里把事实记下来 —— 否则一条从没通知过的活动
        // 被改到未来、通知也发了,库里却仍是「他不知情」,后续判定全错。
        mark_notified(&state.pool, mid, &who).await?;
    }
    Ok(Json(crate::http::dto::OkOut::yes()))
}

/// DELETE /api/activities/{id} —— ★取消不是删除★:置 status='canceled' 留档。
/// 活动是协作事实(谁邀了谁、谁拒了),真删掉之后没人说得清当时发生过什么。
pub async fn cancel(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<crate::http::dto::OkOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    let (mtitle, starts, mtz): (String, Ts, String) = sqlx::query_as("SELECT title, starts_at, timezone FROM activities WHERE id=$1")
        .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE activities SET status='canceled', updated_at=now() WHERE id=$1")
        .bind(mid).execute(&mut *tx).await?;
    // ★取消活动时,**材料区里**的材料跟着走★(PRD §J1b)。
    //
    // ⚠★只对「我的活动材料」成立,普通项目一个字节都不动★——PRD 把这条边界写得很重:
    //   普通项目里的材料是**项目的资产**,不该被一次活动的取消带走(D10「会议材料进项目树」的精神);
    //   而材料区里的每一份材料**都有主人(某条活动)**,不存在游离的文件 ——
    //   活动没了还留着,它在 §J0b 的虚拟分组里★根本渲染不出来★:
    //   用户看不见、删不掉,却一直占着配额。
    //
    // 走软删(进回收站 30 天),不是硬删 —— 与全站「所有删除都是软删除」一致。
    let n = sqlx::query(
        "UPDATE items SET deleted_at = now(), deleted_by = $2
           FROM projects p
          WHERE items.project_id = p.id AND p.kind = 'materials'
            AND items.activity_id = $1 AND items.deleted_at IS NULL")
        .bind(mid).bind(actor).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    audit::record(&state.pool, actor, "activity.cancel", &mid.to_string(),
                  &format!("材料区里连带软删 {n} 项(普通项目的材料保留)")).await;
    // ★取消最需要通知★:不通知的后果是有人按原计划去了,而会不存在了
    let who = notify_targets(&state.pool, mid, actor).await;
    notify_activity(&state, mid, &who, "活动已取消",
        &format!("「{mtitle}」({})已被 {actor} 取消。", fmt_when(starts, crate::tzutil::parse(&mtz))), crate::notify::Kind::Canceled).await;
    Ok(Json(crate::http::dto::OkOut::yes()))
}

#[derive(Deserialize)]
pub struct InviteIn {
    pub usernames: Vec<String>,
    /// ★字段留着但**永远不读**★(2026-08-07 推翻 D8):邀请这个动作本身就意味着「我请你来参会」,
    /// 「不拿材料的人」现在只有一种 —— 旁听者(observer),而旁听是**自助**的(D9),走 POST .../observe。
    ///
    /// 那为什么不直接删掉这个字段?★因为删了会让老前端的请求 400★:serde 默认虽然忽略未知字段,
    /// 但保留它 + 显式标 dead_code 才能让下一个读代码的人知道「这里曾经有个 guest,是故意不读的」,
    /// 而不是以为漏了。等确认没有老页面在跑之后再删。
    #[allow(dead_code)]
    #[serde(default)] pub kind: Option<String>,
    /// 必参(默认)/ 选参。★只有必参人的冲突算「有冲突」★(PRD 6.1.2)。
    #[serde(default)] pub required: Option<bool>,
}

/// 把「这些人已经被通知过」这个**事实**落库(ADR-0003)。
///
/// ★只在真的发出了通知之后调用★ —— 它是事实记录,不是状态标记。
/// 已经有值的不覆盖(`notified_at IS NULL` 才写):第一次知情的时刻才有意义,
/// 后续每次改期都刷新的话,「他到底知不知道这场活动」就答不了了。
///
/// ⚠ 谁**不该**进来:旁听者(observe 是自助的,他自己加的自己知道,但那不是「被通知」)。
async fn mark_notified(pool: &sqlx::PgPool, mid: i64, users: &[String]) -> AppResult<()> {
    if users.is_empty() { return Ok(()) }
    sqlx::query(
        "UPDATE activity_participants SET notified_at = now()
          WHERE activity_id = $1 AND username = ANY($2) AND notified_at IS NULL",
    )
    .bind(mid).bind(users).execute(pool).await?;
    Ok(())
}

/// PUT /api/activities/{id}/participants —— ★批量★邀请(删组之后,一场会拉 20 人不能点 20 次)。
pub async fn invite(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(input): Json<InviteIn>,
) -> AppResult<Json<InviteOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    // ★邀请恒为 attendee★:旁听不是「被邀请」出来的,它是自己跑来听(D9);
    // 老前端可能还在传 kind,直接忽略 —— 比报错温和,而且语义上确实只有这一种。
    let kind = "attendee";
    let mut n = 0;
    for u in &input.usernames {
        let u = u.trim();
        if u.is_empty() { continue }
        // 与拉项目成员同一条校验:用户名以平台 Keycloak 为准(registry 不可达时降级本地表)。
        crate::http::projects::ensure_platform_user(&state, u).await?;
        sqlx::query("INSERT INTO activity_participants (activity_id, username, kind, required)
                     VALUES ($1,$2,$3,COALESCE($4,true))
                     ON CONFLICT (activity_id, username)
                     DO UPDATE SET kind=EXCLUDED.kind, required=EXCLUDED.required")
            .bind(mid).bind(u).bind(kind).bind(input.required).execute(&state.pool).await?;
        n += 1;
    }
    let actor = id.require_username()?;
    audit::record(&state.pool, actor, "activity.invite", &mid.to_string(), &format!("{n} 人 kind={kind}")).await;
    // ★只通知这一批新加的人★,不打扰早就在名单里的人(他们什么都没变)。
    // 旁听者也不通知:observer 是自助加进来的(D9),他自己知道。
    {
        let (mtitle, starts, mtz): (String, Ts, String) = sqlx::query_as("SELECT title, starts_at, timezone FROM activities WHERE id=$1")
            .bind(mid).fetch_one(&state.pool).await?;
        let fresh: Vec<String> = input.usernames.iter().map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty() && u != actor).collect();
        // 同 create:标题取活动**自己的**类型名(见那里的头注),不写死「会议」
        let 类型名: String = sqlx::query_scalar(
            "SELECT t.name FROM activities a JOIN activity_types t ON t.id = a.type_id WHERE a.id=$1")
            .bind(mid).fetch_optional(&state.pool).await?.unwrap_or_else(|| "活动".into());
        notify_activity(&state, mid, &fresh, &format!("{类型名}邀请"),
            &format!("{actor} 邀你参加「{mtitle}」,{}。请答复。", fmt_when(starts, crate::tzutil::parse(&mtz))), crate::notify::Kind::Invite).await;
        mark_notified(&state.pool, mid, &fresh).await?;
    }
    Ok(Json(InviteOut { ok: true, invited: n }))
}

/// DELETE /api/activities/{id}/participants —— 移出参会人。
pub async fn uninvite(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<crate::http::dto::OkOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    let u = body.get("username").and_then(|v| v.as_str()).unwrap_or("").trim();
    if u.is_empty() { return Err(AppError::BadRequest("缺 username".into())) }
    // 发起人不能被移出——他被移出就没人能改这场会了(记录员可以,他还在)。
    let org: String = sqlx::query_scalar("SELECT organizer FROM activities WHERE id=$1")
        .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    if org == u { return Err(AppError::BadRequest("不能移出发起人".into())) }
    sqlx::query("DELETE FROM activity_participants WHERE activity_id=$1 AND username=$2")
        .bind(mid).bind(u).execute(&state.pool).await?;
    audit::record(&state.pool, id.require_username()?, "activity.uninvite", &mid.to_string(), u).await;
    Ok(Json(crate::http::dto::OkOut::yes()))
}

#[derive(Deserialize)]
pub struct RespondIn {
    /// accepted / declined / tentative / counter(建议改期)。
    pub status: String,
    /// status=counter 时的提议时间与理由。
    #[serde(default)] pub counter_starts_at: Option<Ts>,
    #[serde(default)] pub counter_ends_at: Option<Ts>,
    #[serde(default)] pub counter_reason: Option<String>,
}

/// POST /api/activities/{id}/respond —— 答复邀请。
///
/// ★「建议改期」(counter)不是便利功能,是私事冲突**唯一的结构化出口**(D2)★:
/// 私密项目的日程对发起人完全隐形,他根本不知道我忙,只能由我主动提。
/// 所以 counter 必须带**具体的替代时间**——只说「我不行」等于把问题丢回去。
pub async fn respond(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(r): Json<RespondIn>,
) -> AppResult<Json<RespondOut>> {
    let username = id.require_username()?;
    // ★只有名单里的人能答复★:旁听者(public 活动路人)看得见这场会,但不能给自己投一票。
    //
    // ⚠★2026-08-08 修:这句 SQL 此前不看 kind,于是上面这行注释描述的闸根本不存在★。
    //   `observe`(自助旁听)往这张表插的正是一行 `kind='observer'`,所以旁听者
    //   `listed` 必然是 Some → 闸放行 → 他能提交 `counter`(建议改期),
    //   而 counter **是唯一会给发起人发站内信的分支**(见下面 D2 那段)。
    //   也就是:任何看得到某场公开活动的人,点一下旁听就能给发起人投递消息。
    //   同一个根因(「表里有行」≠「是正式参会人」)在 `perm.rs::activity_view` 里
    //   还造成过一次真正的提权,两处同一批修。
    //   ★判据以 kind 为准★——统计(:1142)与答复进度(:1330)一直是这么写的,是这两处漏了。
    let listed: Option<String> = sqlx::query_scalar(
        "SELECT username FROM activity_participants
          WHERE activity_id=$1 AND username=$2 AND kind='attendee'")
        .bind(mid).bind(username).fetch_optional(&state.pool).await?;
    if listed.is_none() {
        // 活动存在但我不在名单 → 403;活动根本看不见 → activity_view 会给 404
        activity_view(&state.pool, &id, mid).await?;
        return Err(AppError::Forbidden);
    }
    // ★发起人不答复★(2026-08-09 用户:「发起人怎么还能拒绝呢？」)。
    //   他是**定这个时间的人**,create 时就写成了 accepted —— 再让他答复一次没有意义,
    //   而「拒绝自己发起的活动」更是自相矛盾的状态:名单里挂着一个拒绝了的发起人,
    //   统计、答复进度、催办全要为这个不可能的状态让路。
    //   想改时间就直接改(update 会把所有人的答复清回 pending);去不了就取消(DELETE)。
    let organizer: String = sqlx::query_scalar("SELECT organizer FROM activities WHERE id=$1")
        .bind(mid).fetch_one(&state.pool).await?;
    if organizer == username {
        return Err(AppError::BadRequest(
            "发起人不用答复自己发起的活动:想改时间直接改,去不了就取消".into()));
    }
    let st = match r.status.as_str() {
        s @ ("accepted" | "declined" | "tentative" | "counter") => s,
        _ => return Err(AppError::BadRequest("答复须为 accepted/declined/tentative/counter".into())),
    };
    if st == "counter" {
        let (Some(s), Some(e)) = (r.counter_starts_at, r.counter_ends_at) else {
            return Err(AppError::BadRequest("建议改期必须给出提议的起止时间(只说不行等于把问题丢回去)".into()));
        };
        if e <= s { return Err(AppError::BadRequest("提议的结束时间必须晚于开始时间".into())) }
        // ★活动开始后不再允许「建议改期」★(PRD 6.1.4 验收标准):会已经在开了,
        // 改期这个动作没有意义 —— 它要么是误点,要么是想表达「我没去」,而那该用「拒绝」。
        // ⚠ 其余三态(接受/拒绝/待定)**照常允许**:会后补一个「我其实没去」是正当的(D11 的雏形)。
        let started: bool = sqlx::query_scalar("SELECT starts_at <= now() FROM activities WHERE id=$1")
            .bind(mid).fetch_one(&state.pool).await?;
        if started {
            return Err(AppError::BadRequest("活动已经开始,不能再建议改期(可以标记拒绝)".into()));
        }
    }
    // ★答复与「纪要转回发起人」必须同生共死★(2026-08-23 全量审计):
    //   这两步原来是两条独立的 UPDATE。第一条成功、第二条失败时,状态是:
    //   **他记成了 declined,而 recorder 还挂在他名下** —— 于是系统会一直催他写
    //   一场他明说不去的会的纪要,而这正是下面那段自动转移要消除的东西。
    //   ⚠ 概率低但代价是「责任凭空悬在一个已经退出的人身上」,而且没有任何重试或告警。
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE activity_participants
            SET status=$3, responded_at=now(),
                counter_starts_at=$4, counter_ends_at=$5, counter_reason=$6
          WHERE activity_id=$1 AND username=$2")
        .bind(mid).bind(username).bind(st)
        .bind(r.counter_starts_at).bind(r.counter_ends_at).bind(r.counter_reason.as_deref())
        .execute(&mut *tx).await?;
    // ★「建议改期」必须通知发起人★(D2):私密项目的日程对他完全隐形,他不知道我为什么忙,
    // 这条建议就是他能收到的**唯一**信号。它躺在数据库里没人看 = 这个出口不存在。
    // 其余三态(接受/拒绝/待定)不发信 —— 发起人在活动页看得到答复进度,一人一条信只会淹掉真正要紧的这条。
    // ⚠★这条分支的 notify 在 commit **之前**★(2026-08-23 记下来,没改):
    //   它只发信不写库,而事务里此刻只有一条 `UPDATE activity_participants` ——
    //   commit 失败的话是「信发了、答复没存」。相比 declined 那条(它还要改 recorder)
    //   风险小一个量级,而把它挪到 commit 之后要重排整个函数(counter 分支不 return,
    //   commit 会消耗 tx,末尾那次就编译不过)。★权衡记在这儿,别当成没看见。★
    if st == "counter" {
        let (mtitle, organizer, mtz): (String, String, String) =
            sqlx::query_as("SELECT title, organizer, timezone FROM activities WHERE id=$1")
                .bind(mid).fetch_one(&state.pool).await?;
        if organizer != username {
            let when = r.counter_starts_at.map(|t| fmt_when(t, crate::tzutil::parse(&mtz))).unwrap_or_else(|| "(未给具体时间)".into());
            let why = r.counter_reason.as_deref().filter(|x| !x.trim().is_empty())
                .map(|x| format!(",理由:{x}")).unwrap_or_default();
            notify_activity(&state, mid, &[organizer], "改期建议",
                &format!("{username} 对「{mtitle}」提议改到 {when}{why}。"), crate::notify::Kind::Counter).await;
        }
    }
    // ★拒绝出席的人如果还挂着记录员,责任不能凭空蒸发★
    // （2026-08-14 liaoruili:「已拒绝为啥还看得到 纪要待整理？？？？」,他拍板选 B）。
    //
    // `activities_owing_minutes` 只看 `m.recorder = 我`,**完全没看我作为参与人的答复状态** ——
    // 于是拒绝出席之后,只要我还挂着记录员,系统就一直催我写一场我没去的会的纪要。
    //
    // ⚠★两种修法都有明显坏处,他选的是 B★:
    //   A：拒绝就不再催我 → ★这场会的纪要从此没人写、也没人知道★,它安静地消失在所有人的待办里;
    //   B：仍然挂在我名下,但**当场通知发起人另指派** → 多一步打扰,但★责任不会凭空蒸发★。
    //   本仓库反复踩过同一类坑:**「安静地消失」比「烦人地留着」难查得多** ——
    //   纪要没人写,要等到几周后有人翻记录才发现。
    //
    // ⚠ 这里**不自动改 recorder**:指派记录员是发起人的决定,系统替他改等于偷偷换人;
    //   而且换给谁也没有正确答案。给他一条明确的站内信,让他去改。
    if st == "declined" {
        // ★记录员拒绝出席 → 纪要**自动落回发起人**★（2026-08-15 liaoruili 拍板,改掉 08-14 的方案 B）。
        //
        // 08-14 那版是「仍挂在他名下 + 通知发起人另指派」,理由是**责任不能凭空蒸发**。
        // 这一版换了落点、但守的是同一条:★责任仍然不许悬空,只是默认落到**一个真实存在的人**头上★。
        // 为什么更好:方案 B 把活儿留给一个**已经说了不来**的人 —— 他多半不会写,
        // 而系统每天都在催他;发起人则是这场活动的所有者,由他兜底最自然,
        // 而且他**随时可以改指派**(记录员本来就是可编辑字段)。
        //
        // ⚠★两个边界★:
        //   ① 发起人自己就是记录员时(organizer == username)不动 —— 转给他自己没有意义,
        //      他拒绝自己发起的会本来就是个奇怪状态,但那不该由这里替他决定;
        //   ② 只有**我确实是记录员**时才转;普通参会人拒绝出席跟纪要没关系。
        let 我是记录员: bool = sqlx::query_scalar(
            "SELECT recorder = $2 FROM activities WHERE id = $1")
            .bind(mid).bind(username).fetch_one(&state.pool).await?;
        let mut 已转给发起人 = false;
        if 我是记录员 && organizer != username {
            sqlx::query("UPDATE activities SET recorder = $2 WHERE id = $1")
                .bind(mid).bind(&organizer).execute(&mut *tx).await?;
            已转给发起人 = true;
        }
        // ★先落库再发信★:notify 在事务里发的话,一旦回滚就是「信说纪要转给你了,而库里没转」。
        tx.commit().await?;
        if 已转给发起人 {
            let 标题: String = sqlx::query_scalar("SELECT title FROM activities WHERE id=$1")
                .bind(mid).fetch_one(&state.pool).await.unwrap_or_default();
            notify_activity(&state, mid, std::slice::from_ref(&organizer), "记录员拒绝出席,纪要已转到你名下",
                &format!("{username} 拒绝出席「{标题}」。为免这场的纪要没人写,\
                          记录员已**默认改成你**;要换人的话,在活动页把「记录员」改掉就行。"), crate::notify::Kind::RecorderMoved).await;
        }
        // `still_recorder`:拒绝之后我**还是不是**记录员。转走了就是 false ——
        // 界面靠它当场告诉我「这摊子已经不归你了」,否则我只会纳闷「我都拒了怎么还挂着」。
        return Ok(Json(RespondOut {
            ok: true, status: st.to_string(),
            still_recorder: Some(我是记录员 && !已转给发起人),
            recorder_moved_to: Some(if 已转给发起人 { Some(organizer.clone()) } else { None }),
        }));
    }
    tx.commit().await?;
    Ok(Json(RespondOut { ok: true, status: st.to_string(), still_recorder: None, recorder_moved_to: None }))
}

#[derive(Deserialize)]
pub struct FreeBusyQ {
    /// 逗号分隔的用户名。
    pub users: String,
    pub from: Ts,
    pub to: Ts,
}

/// GET /api/freebusy —— 忙闲查询(D1)。★只回时间段,不回任何内容★。
///
/// ★分流按**活动自己的 `busy`**★(PRD A4;2026-08-15 订正注释,代码早就是这样了):
///   · `busy = true` 的活动 → 产生忙闲(别人看到「忙」,但看不到标题);
///   · `busy = false` → ★完全隐形★,别人看到的是「空闲」。
/// ⚠ 旧规则是「按关联项目的可见性」,已随 `projects.visibility` 一起废除 ——
///   它把「内容给谁看」和「时间占不占别人」绑成一件事,而这两件事正交(见下面 SQL 里的长注)。
/// 这是刻意的:私事连「我忙」这件事都不该暴露。代价是发起人可能排到你头上,
/// 所以前端必须在**当事人自己**收到邀请时标红提醒 + 把「建议改期」放在旁边(D1 的三条硬要求之一)。
///
/// ⚠ 已拒绝(declined)的邀请不算忙——他明确说了不来。
pub async fn freebusy(
    State(state): State<AppState>,
    Extension(_id): Extension<Identity>,
    Query(q): Query<FreeBusyQ>,
) -> AppResult<Json<FreeBusyOut>> {
    if q.to <= q.from { return Err(AppError::BadRequest("to 必须晚于 from".into())) }
    let users: Vec<String> = q.users.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if users.is_empty() { return Err(AppError::BadRequest("users 不能为空".into())) }
    if users.len() > 200 { return Err(AppError::BadRequest("一次最多查 200 人".into())) }
    let rows: Vec<(String, Ts, Ts)> = sqlx::query_as(
        "SELECT mp.username, m.starts_at, m.ends_at
           FROM activity_participants mp
           JOIN activities m ON m.id = mp.activity_id
          WHERE mp.username = ANY($1) AND m.status='active'
            AND mp.status <> 'declined'
            -- ★没通知过的人不进忙闲★(ADR-0003):他对这场活动自始至终不知情,
            -- 却因此在别人眼里显示「忙」—— 那是凭空占用他的时间。
            AND mp.notified_at IS NOT NULL
            AND m.starts_at < $3 AND m.ends_at > $2
            -- ★判据是活动自己的 busy(PRD A4),不再是「有没有关联到公开项目」★
            --   旧判据把「内容给谁看」和「时间占不占别人」绑成一件事,后果有二:
            --   ① 不关联项目的活动**一个忙块都出不来**(A4 要的正是这种活动);
            --   ② 私密项目的会不占忙闲 —— 而「我这个时段没空」本来就不泄露任何内容。
            AND m.busy
            -- ★归档项目不再产生忙闲★(D17):项目结题了,它的历史活动不该继续把人显示成「忙」。
            -- 判据从「存在公开且未归档的关联项目」收成「不是所有关联项目都归档了」——
            -- 没有关联项目的活动(A4)不受这条影响。
            -- ⚠★这对括号是承重的★:`AND` 比 `OR` 结合得紧,少了它就变成
            --   `(… AND m.busy AND NOT EXISTS(…)) OR EXISTS(…)` —— OR 那支会**绕过前面全部条件**,
            --   包括 `username = ANY($1)` 和时间窗,于是任何关联了未归档项目的会
            --   都给**所有人、任何时段**产生忙块。写这段时当场踩了,PREPARE 抓不到(语法合法)。
            AND (NOT EXISTS (SELECT 1 FROM activity_projects mpj WHERE mpj.activity_id = m.id)
                 OR EXISTS (SELECT 1 FROM activity_projects mpj
                              JOIN projects p ON p.id = mpj.project_id
                             WHERE mpj.activity_id = m.id
                               AND p.deleted_at IS NULL AND p.archived_at IS NULL))
          ORDER BY mp.username, m.starts_at")
        .bind(&users).bind(q.from).bind(q.to)
        .fetch_all(&state.pool).await?;
    let mut busy: std::collections::BTreeMap<String, Vec<BusySlot>> = std::collections::BTreeMap::new();
    // ★查了谁就有谁★:没有忙碌区间的人也要给一个空数组 ——
    //   否则前端分不清「查过了,他很闲」和「压根没查他」。
    for u in &users { busy.insert(u.clone(), Vec::new()); }
    for (u, start, end) in rows {
        if let Some(v) = busy.get_mut(&u) { v.push(BusySlot { start, end }) }
    }
    Ok(Json(FreeBusyOut { busy }))
}

#[derive(Deserialize)]
pub struct MsgQ { pub channel: Option<String>, pub peer: Option<String> }

#[derive(Serialize, sqlx::FromRow, schemars::JsonSchema)]
pub struct MessageRow {
    pub id: i64, pub sender: String, pub channel: String,
    pub peer: Option<String>, pub body: String, pub created_at: Ts,
}

/// GET /api/activities/{id}/messages —— 活动讨论区(D13)。
/// public 频道:参会人可见;private:仅双方可见。★旁听者一律不给★。
pub async fn messages(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Query(q): Query<MsgQ>,
) -> AppResult<Json<Vec<MessageRow>>> {
    // ★讨论区是 Inside 专属★:D9 给旁听者的是「知道活动存在与议程」,不含听人聊天。
    if activity_view(&state.pool, &id, mid).await? != ActivityView::Inside {
        return Err(AppError::Forbidden);
    }
    let username = id.require_username()?;
    let rows: Vec<MessageRow> = match q.channel.as_deref() {
        Some("private") => {
            let peer = q.peer.as_deref().unwrap_or("").trim().to_string();
            if peer.is_empty() { return Err(AppError::BadRequest("私聊须指定 peer".into())) }
            // 只取「我与他」这一对的,两个方向都要。
            sqlx::query_as(
                "SELECT id, sender, channel, peer, body, created_at FROM activity_messages
                  WHERE activity_id=$1 AND channel='private'
                    AND ((sender=$2 AND peer=$3) OR (sender=$3 AND peer=$2))
                  ORDER BY created_at")
                .bind(mid).bind(username).bind(&peer).fetch_all(&state.pool).await?
        }
        // ★默认:公开 + **与我有关的**私聊,合成一条流★
        // (2026-08-12 liaoruili:「私聊和公开聊天为啥需要切换才能分别看到？腾讯会议已经有例子了」)
        //
        // 腾讯会议的做法:私聊与对所有人的消息**在同一个聊天窗口里**,私聊带标记
        // (meeting.tencent.com/support/topic/1592)。理由很实在 ——
        // ★分成两个要切换的视图,等于要求人**先猜对方在哪条频道说的话**★,
        // 而人在开会,不会为了找一句话去逐个频道翻。
        //
        // ⚠ 只并**与我有关**的私聊(我发的 or 发给我的):这是隐私边界,不是筛选偏好。
        //   写成 `channel='private'` 而不带这一条,就是把全场的私聊都端给每个人。
        _ => sqlx::query_as(
                "SELECT id, sender, channel, peer, body, created_at FROM activity_messages
                  WHERE activity_id=$1
                    AND (channel='public' OR (channel='private' AND (sender=$2 OR peer=$2)))
                  ORDER BY created_at")
                .bind(mid).bind(username).fetch_all(&state.pool).await?,
    };
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct MsgIn { pub body: String, #[serde(default)] pub channel: Option<String>, #[serde(default)] pub peer: Option<String> }

/// POST /api/activities/{id}/messages —— 发言。
/// ★私聊对象只限发起人与记录员★(D13):不做任意点对点,否则这里会长成一个 IM。
pub async fn send_message(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(m): Json<MsgIn>,
) -> AppResult<Json<crate::http::dto::IdOut>> {
    if activity_view(&state.pool, &id, mid).await? != ActivityView::Inside {
        return Err(AppError::Forbidden);
    }
    let username = id.require_username()?;
    let body = m.body.trim();
    if body.is_empty() { return Err(AppError::BadRequest("内容不能为空".into())) }
    if body.chars().count() > 4000 { return Err(AppError::BadRequest("单条最多 4000 字".into())) }
    let (channel, peer) = match m.channel.as_deref() {
        Some("private") => {
            let peer = m.peer.as_deref().unwrap_or("").trim().to_string();
            if peer.is_empty() { return Err(AppError::BadRequest("私聊须指定 peer".into())) }
            let hosts: Vec<String> = sqlx::query_scalar(
                "SELECT organizer FROM activities WHERE id=$1
                 UNION SELECT recorder FROM activities WHERE id=$1")
                .bind(mid).fetch_all(&state.pool).await?;
            if !hosts.iter().any(|h| h == &peer) {
                return Err(AppError::BadRequest("私聊只能发给发起人或记录员(D13:不做任意点对点)".into()));
            }
            ("private", Some(peer))
        }
        _ => ("public", None),
    };
    let id_: i64 = sqlx::query_scalar(
        "INSERT INTO activity_messages (activity_id, sender, channel, peer, body) VALUES ($1,$2,$3,$4,$5) RETURNING id")
        .bind(mid).bind(username).bind(channel).bind(peer.as_deref()).bind(body)
        .fetch_one(&state.pool).await?;
    Ok(Json(crate::http::dto::IdOut { id: id_ }))
}

// ── 活动纪要(D14)────────────────────────────────────────────────────────
// ★AI 只是原材料,记录员才是作者★:`/api/items/{id}/analysis` 出的转写与摘要是**给他看的**,
// 这里存的是**他整理过的正式纪要**。两者刻意不打通——一键把 AI 稿写进纪要,
// 等于让「记录员按模板整理」这条决策名存实亡(D14 反复确认过)。

#[derive(Serialize, sqlx::FromRow, schemars::JsonSchema)]
pub struct Minutes {
    pub activity_id: i64,
    pub status: String,
    /// 到场/列席/缺席:★会后补录的**事实**★(D11),不是邀请时的名单——
    /// 谁接受了邀请和谁真的来了是两件事,统计口径按这个。
    pub attendees: String,
    pub observers: String,
    pub absentees: String,
    pub agenda_text: String,
    /// 正文 Markdown。出 PDF 时转 LaTeX(走平台共享 latex-svc,congrove 镜像不装 TeX)。
    pub content_md: String,
    pub resolutions: String,
    pub todos: String,
    pub pdf_item_id: Option<i64>,
    pub completed_at: Option<Ts>,
    pub updated_at: Ts,
}

/// GET /api/activities/{id}/minutes —— 取纪要(没有则回一份空的,前端不用判 404)。
pub async fn minutes_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<MinutesGetOut>> {
    // ★纪要是活动内容,旁听者不给★(与讨论区同档):D9 给旁听者的是「知道有这个会」。
    if activity_view(&state.pool, &id, mid).await? != ActivityView::Inside {
        return Err(AppError::Forbidden);
    }
    let m: Option<Minutes> = sqlx::query_as("SELECT * FROM activity_minutes WHERE activity_id = $1")
        .bind(mid).fetch_optional(&state.pool).await?;
    // 谁能编辑:记录员(本职)或发起人。★不是「参会人都能改」★——纪要要有唯一作者,
    // 否则「按固定模板整理」会变成谁都能覆盖一遍的公共草稿。
    let can_edit = require_activity_host(&state.pool, &id, mid).await.is_ok();
    Ok(Json(MinutesGetOut { minutes: m, can_edit }))
}

#[derive(Deserialize)]
pub struct MinutesIn {
    pub attendees: Option<String>,
    pub observers: Option<String>,
    pub absentees: Option<String>,
    pub agenda_text: Option<String>,
    pub content_md: Option<String>,
    pub resolutions: Option<String>,
    pub todos: Option<String>,
    /// 置 done = 定稿。★定稿后仍可改★(会后补录到场情况是常事),只是记一个 completed_at。
    /// ★不传 = 保持原样★,与本结构体其余每一个字段同一个约定(见 minutes_put 里的长注释)。
    pub status: Option<String>,
}

/// PUT /api/activities/{id}/minutes —— 记录员保存纪要(upsert)。
pub async fn minutes_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(p): Json<MinutesIn>,
) -> AppResult<Json<MinutesPutOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    // ★`status` 不传 = **保持原样**,不是「回到 draft」★(2026-08-15 对抗检查抓到)。
    //   这一整个结构体的约定就是「不传的字段保留」——下面每个字段都是 `COALESCE($n, 老值)`,
    //   只有 status 原来是 `None => "draft"`。而前端**逐字段保存**(改一下参会人就 PUT 一次,
    //   身上不带 status),于是:纪要一旦定稿,记录员再补一句到场情况,
    //   ★状态被静默打回草稿、`completed_at` 一起清空★ —— 界面上没有任何提示,
    //   直到有人发现「明明定过稿的会又变草稿了」。定稿/撤稿只能由那个按钮显式发起。
    let status = match p.status.as_deref() {
        Some("done") => Some("done"),
        Some("draft") => Some("draft"),
        None => None,
        _ => return Err(AppError::BadRequest("状态须为 draft/done".into())),
    };
    let 结果状态: String = sqlx::query_scalar(
        "INSERT INTO activity_minutes
           (activity_id, status, attendees, observers, absentees, agenda_text, content_md, resolutions, todos,
            completed_at, updated_at)
         VALUES ($1,COALESCE($2,'draft'),COALESCE($3,''),COALESCE($4,''),COALESCE($5,''),COALESCE($6,''),
                 COALESCE($7,''),COALESCE($8,''),COALESCE($9,''),
                 CASE WHEN COALESCE($2,'draft')='done' THEN now() END, now())
         ON CONFLICT (activity_id) DO UPDATE SET
           status=COALESCE($2, activity_minutes.status),
           attendees=COALESCE($3, activity_minutes.attendees),
           observers=COALESCE($4, activity_minutes.observers),
           absentees=COALESCE($5, activity_minutes.absentees),
           agenda_text=COALESCE($6, activity_minutes.agenda_text),
           content_md=COALESCE($7, activity_minutes.content_md),
           resolutions=COALESCE($8, activity_minutes.resolutions),
           todos=COALESCE($9, activity_minutes.todos),
           -- ★定稿时间只记第一次★:之后补录到场情况不该把「什么时候定的稿」冲掉。
           -- 判据要用**这次写完之后**的状态(可能来自老行),不能只看这次传了什么。
           completed_at=CASE WHEN COALESCE($2, activity_minutes.status)='done'
                             THEN COALESCE(activity_minutes.completed_at, now()) ELSE NULL END,
           updated_at=now()
         RETURNING status")
        .bind(mid).bind(status)
        .bind(p.attendees.as_deref()).bind(p.observers.as_deref()).bind(p.absentees.as_deref())
        .bind(p.agenda_text.as_deref()).bind(p.content_md.as_deref())
        .bind(p.resolutions.as_deref()).bind(p.todos.as_deref())
        .fetch_one(&state.pool).await?;
    audit::record(&state.pool, id.require_username()?, "minutes.save", &mid.to_string(), &结果状态).await;
    Ok(Json(MinutesPutOut { ok: true, status: 结果状态.to_string() }))
}

// ── 活动材料 / 改动历史 / 催办 / 采纳改期 ──────────────────────────────────
// 对应原型 meet 视图右侧与中部的几块(docs/UI-GAP.md)。

#[derive(Serialize, sqlx::FromRow, schemars::JsonSchema)]
pub struct ActivityItem {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    /// ★录制 ≠ 材料★(D5):只有 is_recording 的文件会被转写、并作为活动时长依据。
    pub is_recording: bool,
    pub created_by: String,
    pub created_at: Ts,
}

/// GET /api/activities/{id}/items —— 活动的材料与录制。
/// 前端分两个 tab 显示;★这是活动的「只读区」★(D10):唯一写入口是活动详情页,
/// 在项目树里不允许对它改名/移动/删除。
pub async fn activity_items(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<Vec<ActivityItem>>> {
    // ★材料权走 perm::activity_material_access 这一处推导★(2026-08-17,ADR-0006 推翻 D8)。
    // 原来这里自己拼一段 UNION 判「是不是任一关联项目的成员」——★而前端另按「是不是参会人」
    // 画卡片★,两套判据不同源,于是「参会人但非项目成员」看到:卡片在、列表空、上传失败。
    // 判据收进一处之后,新增入口自动被覆盖(和 ADR-0005 的单点否决同一理由)。
    let 权 = crate::perm::activity_material_access(&state.pool, &id, mid, None).await?;
    let ok = if 权 >= crate::perm::材料权::只读 { Some(1i32) } else { None };
    if ok.is_none() {
        // 看得见活动但不是项目成员 → 403(他知道有这场会,只是拿不到材料);完全看不见 → 404
        activity_view(&state.pool, &id, mid).await?;
        return Err(AppError::Forbidden);
    }
    let rows: Vec<ActivityItem> = sqlx::query_as(
        "SELECT id, name, kind, size, mime, coalesce(is_recording,false) AS is_recording, created_by, created_at
           FROM items_alive WHERE activity_id = $1 AND deleted_at IS NULL AND kind <> 'folder'
          ORDER BY is_recording, created_at")
        .bind(mid).fetch_all(&state.pool).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct ItemRename { pub name: String }

/// PUT /api/activities/{mid}/items/{iid} —— 给一份活动材料/录制改名(≥editor)。
///
/// ★2026-08-09 liaoruili:「材料 录制 上传的文件,也要支持能够重命名」★。
/// 在此之前活动材料**在哪儿都改不了名**:项目树那条(`PUT /api/items/{iid}`)按 D10 拒绝,
/// 而活动这边压根没有对应的入口 —— 于是「Rec 0001.mp4」这种名字只能永远留着。
///
/// ★D10 说的是「在**项目树里**只读」,不是「永远不可改」★:名称与位置由活动决定,
/// 所以改名这个动作要**发生在活动页**,和删除同一个道理(那条路已经在了,这条是它的镜像)。
///
/// ⚠ 三条边界与 `delete_activity_item` 完全一致,别只改一处:
///   ① `activity_id = mid` 必须同时匹配 —— 否则「拿 A 活动的 id 改 B 活动的材料」就是越权;
///   ② `kind <> 'folder'` —— 活动文件夹的名字是**从活动派生**的(日期 + 标题),
///      手改了它下次活动改标题时又会被覆盖回去,是个假功能;
///   ③ 走 `require_material_owner` —— 材料区在 require_role 上全只读(PRD §J1)。
pub async fn rename_activity_item(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path((mid, iid)): Path<(i64, i64)>,
    Json(p): Json<ItemRename>,
) -> AppResult<Json<crate::http::dto::OkOut>> {
    let pid = crate::http::items::project_of(&state.pool, iid).await?;
    // ★项目角色不够时,参会人可以改/删**自己传的**那一份★(2026-08-17,ADR-0006 决定二):
    //   传错了一份却改不了删不掉,他只能再传一份对的 —— 错版本永远躺在那儿,还占着召集人的额度。
    // ⚠ 归属取库里的 `created_by`,不信调用方;失败时抛回项目那边的原错(别把 404 改成 403)。
    if let Err(项目那边的错) = crate::perm::require_material_owner(&state.pool, &id, pid).await {
        // items-ok: 只取归属判权,不读内容
        let 谁传的: Option<String> = sqlx::query_scalar("SELECT created_by FROM items WHERE id = $1")
            .bind(iid).fetch_optional(&state.pool).await?;
        if crate::perm::activity_material_access(&state.pool, &id, mid, 谁传的.as_deref()).await?
            < crate::perm::材料权::可管 { return Err(项目那边的错) }
    }
    let actor = id.require_username()?;
    let name = p.name.trim();
    if name.is_empty() { return Err(AppError::BadRequest("名称不能为空".into())) }
    let n = sqlx::query(
        "UPDATE items SET name = $3, updated_at = now()
          WHERE id = $1 AND activity_id = $2 AND kind <> 'folder' AND deleted_at IS NULL")
        .bind(iid).bind(mid).bind(name).execute(&state.pool).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound) }
    audit::record(&state.pool, actor, "activity.item.rename", &iid.to_string(),
        &format!("activity={mid} project={pid} 改名为 {name}")).await;
    Ok(Json(crate::http::dto::OkOut::yes()))
}

/// DELETE /api/activities/{mid}/items/{iid} —— 删一份活动材料/录制(≥editor)。
///
/// ★为什么不复用 DELETE /api/items/{iid}★(2026-08-09 liaoruili:「要去会议里面删除」):
/// D10 说活动材料在**项目树里**是只读区,唯一入口是活动页。而后端看不见「用户点的是哪个页面」——
/// ★只靠前端不画删除按钮,这条规则等于没有★(本仓库自己的原则:前端隐藏不是安全边界)。
/// 所以拆成两条路:通用那条**拒绝**带 activity_id 的 item,这条只收活动材料。
/// 接口的形状本身就说明了「你正在删的是某场活动的材料」。
///
/// ⚠ 只删**单份材料**,不删活动文件夹本身 —— 文件夹是结构,由活动决定,不该被手动删掉。
pub async fn delete_activity_item(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path((mid, iid)): Path<(i64, i64)>,
) -> AppResult<Json<crate::http::dto::OkOut>> {
    let pid = crate::http::items::project_of(&state.pool, iid).await?;
    // 材料区在 require_role 上是全只读的(PRD §J1),而「删材料」正是它放行的两条写路径之一
    // —— 普通项目里这个函数就等于 require_role(Editor),行为不变。
    // ★项目角色不够时,参会人可以改/删**自己传的**那一份★(2026-08-17,ADR-0006 决定二):
    //   传错了一份却改不了删不掉,他只能再传一份对的 —— 错版本永远躺在那儿,还占着召集人的额度。
    // ⚠ 归属取库里的 `created_by`,不信调用方;失败时抛回项目那边的原错(别把 404 改成 403)。
    if let Err(项目那边的错) = crate::perm::require_material_owner(&state.pool, &id, pid).await {
        // items-ok: 只取归属判权,不读内容
        let 谁传的: Option<String> = sqlx::query_scalar("SELECT created_by FROM items WHERE id = $1")
            .bind(iid).fetch_optional(&state.pool).await?;
        if crate::perm::activity_material_access(&state.pool, &id, mid, 谁传的.as_deref()).await?
            < crate::perm::材料权::可管 { return Err(项目那边的错) }
    }
    let actor = id.require_username()?;
    // ★路径里的 mid 必须与这份材料实际归属的活动一致★:否则「在我能编辑的 A 活动下,
    // 报一个属于 B 活动的 item id」就能删掉 B 的材料 —— 一个典型的越权形状。
    let n = sqlx::query(
        "UPDATE items SET deleted_at = now(), deleted_by = $3
          WHERE id = $1 AND activity_id = $2 AND kind <> 'folder' AND deleted_at IS NULL")
        .bind(iid).bind(mid).bind(actor).execute(&state.pool).await?.rows_affected();
    if n == 0 { return Err(AppError::NotFound) }
    audit::record(&state.pool, actor, "activity.item.delete", &iid.to_string(),
        &format!("activity={mid} project={pid} 删除活动材料(进回收站)")).await;
    Ok(Json(crate::http::dto::OkOut::yes()))
}

/// POST /api/activities/{id}/materials-project —— 拿到这场活动材料的**落点项目**。
///
/// ★2026-08-09 liaoruili:「个人活动无法上传材料」★。上传口是项目作用域的
/// (`POST /api/projects/{pid}/upload`),而不关联项目的活动(ADR-0002 `needs_project=false`)
/// 前端手上根本没有 pid —— 于是界面上只剩一句「这个活动还没有关联项目,材料没地方放」。
///
/// PRD §J0 的答案是:落到**发起人自己的「我的活动材料」**,没有就现建(见 projects::materials_project)。
///
/// ★为什么是一个 POST 接口,而不是在活动详情里带上这个 id★:
/// 那样每打开一次别人的个人日程详情就会**建出一个材料区**(GET 有了副作用),
/// 而这个区是「按需才存在」的东西 —— 真要传材料时才建,零成本地保持了这一点。
///
/// ★为什么限定发起人★:材料区只有 owner 有角色(ADR-0005 单点否决)。
/// 就算这里放行了别人,他拿着这个 pid 去 upload 也会被 `require_role` 挡回来 ——
/// 那样他得到的是一个费解的 403;这里直接说清「不是你的活动」。
pub async fn materials_project(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<MaterialsProjectOut>> {
    let me = id.require_username()?;
    // 先按看得见与否判 404/403(与其他活动接口同一套语义:看不见的活动不该确认它存在)
    activity_view(&state.pool, &id, mid).await?;
    // ★从「只有发起人」放宽到「能往这场活动传东西的人」★(2026-08-17,ADR-0006 决定二)。
    // 原来是 `organizer != me → Forbidden` —— 参会人在**第一步**就被挡住,后面的上传根本走不到。
    // ⚠ 落点仍由**后端**算(下面那段),前端给不了任意 project_id ——
    //   这是这次放宽仍然安全的三条既有机制之一(另两条:配额算项目 owner、禁下载是活动级策略)。
    let _ = &me;
    if crate::perm::activity_material_access(&state.pool, &id, mid, None).await?
        < crate::perm::材料权::可传 { return Err(AppError::Forbidden) }
    let linked: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM activity_projects mp JOIN projects p ON p.id = mp.project_id
          WHERE mp.activity_id = $1 AND p.deleted_at IS NULL LIMIT 1")
        .bind(mid).fetch_optional(&state.pool).await?;
    if linked.is_some() {
        // 有关联项目就该落进项目(D4:材料整份进所有关联项目)。放行的话同一场活动的材料
        // 会散在两处 —— 一半在项目树里、一半在只有发起人看得到的材料区。
        return Err(AppError::BadRequest("这个活动已经关联了项目,材料落在项目里".into()));
    }
    let pid = crate::http::projects::materials_project(&state, me).await?;
    Ok(Json(MaterialsProjectOut { project_id: pid }))
}

#[derive(Serialize, sqlx::FromRow, schemars::JsonSchema)]
pub struct LinkChange {
    pub old_url: String,
    pub new_url: String,
    pub changed_by: String,
    pub changed_at: Ts,
}

/// GET /api/activities/{id}/link-history —— 线上活动链接的改动历史。
/// 开会前十分钟改链接是真实场景,事后要能追溯「谁何时改成什么」。
pub async fn link_history(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<Vec<LinkChange>>> {
    if activity_view(&state.pool, &id, mid).await? != ActivityView::Inside {
        return Err(AppError::Forbidden);
    }
    let rows: Vec<LinkChange> = sqlx::query_as(
        "SELECT old_url, new_url, changed_by, changed_at FROM activity_link_history
          WHERE activity_id = $1 ORDER BY changed_at DESC")
        .bind(mid).fetch_all(&state.pool).await?;
    Ok(Json(rows))
}

/// POST /api/activities/{id}/remind —— 催办未应答的人(发起人/记录员)。
/// ★只催「还没答复」的★:已接受/已拒绝的人不该再被打扰。
pub async fn remind(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<RemindOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    let only = body.get("username").and_then(|v| v.as_str()).map(str::to_string);
    let targets: Vec<String> = sqlx::query_scalar(
        "SELECT username FROM activity_participants
          WHERE activity_id = $1 AND status = 'pending' AND ($2::text IS NULL OR username = $2)")
        .bind(mid).bind(only.as_deref()).fetch_all(&state.pool).await?;
    if targets.is_empty() {
        return Err(AppError::BadRequest("没有需要催的人(都已答复)".into()));
    }
    // ★时间必须取活动自己的时区,并且走 `fmt_when`★(2026-08-15 对抗检查抓到):
    //   这一行原来是 `starts.format("%m-%d %H:%M")` —— **裸 UTC**,既差 8 小时也不带时区标注。
    //   全仓十来处站内信都走 `fmt_when(t, tz)`,只有催办这一处是自己拼的,
    //   于是「将于 02:00 开始」发到收信人手里,他去自己日历上找 02:00 —— 那场会其实是 10:00。
    //   ★这类错不会报任何东西,只会让人错过会★;`tzutil` 已经把规则收成唯一推导了,别再手拼。
    let (title, starts, mtz): (String, Ts, String) =
        sqlx::query_as("SELECT title, starts_at, timezone FROM activities WHERE id=$1")
            .bind(mid).fetch_one(&state.pool).await?;
    // 站内信走平台 registry;不可达时降级为「只记审计不发信」——催办失败不该让接口报错。
    let mut sent = 0;
    if let Some(reg) = &state.registry {
        for u in &targets {
            let body = format!("「{title}」将于 {} 开始,你还没有答复。", fmt_when(starts, crate::tzutil::parse(&mtz)));
            // notify 是 best-effort(不返回 Result):站内信发不出去不该让催办接口失败
            // ★ref 走 Kind 的唯一推导,别在这儿手拼★:手拼的那份正是 2026-08-16 事故的一半 ——
            //   催办与邀请共用 `activity:{mid}`,平台按 (recipient, ref) 幂等 → 催办永远发不出去。
            reg.notify(u, "活动待你答复", &body, None, Some(&crate::notify::Kind::Nudge.ref_of(mid))).await;
            sent += 1;
        }
    }
    audit::record(&state.pool, id.require_username()?, "activity.remind", &mid.to_string(),
                  &format!("{} 人", targets.len())).await;
    Ok(Json(RemindOut { ok: true, targets: targets.len(), sent }))
}

/// POST /api/activities/{id}/reject-counter —— 驳回某人的改期建议。
/// ★驳回后他回到 pending 而不是 declined★:发起人拒绝的是**这个时间提议**,
/// 不代表替他决定「不来」—— 让他重新答复(接受原时间 / 拒绝 / 再提一个)。
pub async fn reject_counter(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<crate::http::dto::OkOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    let who = body.get("username").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if who.is_empty() { return Err(AppError::BadRequest("缺 username".into())) }
    let n = sqlx::query(
        "UPDATE activity_participants
            SET status='pending', responded_at=NULL,
                counter_starts_at=NULL, counter_ends_at=NULL, counter_reason=NULL
          WHERE activity_id=$1 AND username=$2 AND status='counter'")
        .bind(mid).bind(&who).execute(&state.pool).await?.rows_affected();
    if n == 0 { return Err(AppError::BadRequest("这个人没有待处理的改期建议".into())) }
    let actor = id.require_username()?;
    audit::record(&state.pool, actor, "activity.reject-counter", &mid.to_string(), &who).await;
    // 提了建议就该知道结果 —— 尤其驳回后他回到 pending、**还欠一次答复**,不说他不会知道
    let mtitle: String = sqlx::query_scalar("SELECT title FROM activities WHERE id=$1")
        .bind(mid).fetch_one(&state.pool).await?;
    notify_activity(&state, mid, std::slice::from_ref(&who), "改期建议未被采纳",
        &format!("「{mtitle}」的时间不变,{actor} 未采纳你的改期建议 —— ★请重新答复原时间★。"), crate::notify::Kind::CounterRejected).await;
    Ok(Json(crate::http::dto::OkOut::yes()))
}

/// POST /api/activities/{id}/accept-counter —— 采纳某人的改期建议。
/// ★采纳 = 把活动时间改成他提议的时间★,随后所有人的答复清回 pending(与改时间同一套语义)。
pub async fn accept_counter(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<AcceptCounterOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    let who = body.get("username").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if who.is_empty() { return Err(AppError::BadRequest("缺 username".into())) }
    let row: Option<(Option<Ts>, Option<Ts>)> = sqlx::query_as(
        "SELECT counter_starts_at, counter_ends_at FROM activity_participants
          WHERE activity_id=$1 AND username=$2 AND status='counter'")
        .bind(mid).bind(&who).fetch_optional(&state.pool).await?;
    let Some((Some(s), Some(e))) = row else {
        return Err(AppError::BadRequest("这个人没有提出改期建议".into()));
    };
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE activities SET starts_at=$2, ends_at=$3, updated_at=now() WHERE id=$1")
        .bind(mid).bind(s).bind(e).execute(&mut *tx).await?;
    // 时间变了,所有人的答复都得重来 —— 包括提议者本人:他提的是时间,不等于他一定能来。
    // 提醒也一并清（见 reset_after_reschedule 的头注:两者「除了谁」不一样）。
    reset_after_reschedule(&mut tx, mid, id.require_username()?).await?;
    tx.commit().await?;
    let actor = id.require_username()?;
    audit::record(&state.pool, actor, "activity.accept-counter", &mid.to_string(), &who).await;
    // 采纳 = 活动时间真的变了 → ★通知全员★(和 update 改时间同理:别人的答复已被清回 pending),
    // 提议人本人也要收到,他要知道自己的建议被采纳了。
    let (mtitle, mtz): (String, String) = sqlx::query_as("SELECT title, timezone FROM activities WHERE id=$1")
        .bind(mid).fetch_one(&state.pool).await?;
    let all = notify_targets(&state.pool, mid, actor).await;
    notify_activity(&state, mid, &all, "活动时间已改",
        &format!("「{mtitle}」采纳了 {who} 的改期建议,改到 {} —— ★之前的答复已作废,请重新答复★。", fmt_when(s, crate::tzutil::parse(&mtz))), crate::notify::Kind::Reschedule).await;
    Ok(Json(AcceptCounterOut { ok: true, starts_at: s, ends_at: e }))
}

// ── 公开活动广场 / 旁听(D9)──────────────────────────────────────────────
// ★这是 D9 明确要求、我一度漏做的入口★:公开活动若没有列表页,「全平台可旁听」就是一句空话
// —— 没人知道有哪些会可以听(2026-08-07 用户提出,查 PRD 确认是遗漏)。

#[derive(Deserialize)]
pub struct PublicQ {
    /// 往后看几天;不给或 <=0 表示「全部未来的」。前端默认 7。
    pub days: Option<i64>,
}

/// GET /api/activities/public —— 公开活动广场。
/// ★只列**还没结束**的★:旁听的意义是「我要去听」,已经开完的会列出来只是噪音
/// (要查历史去活动页搜)。
pub async fn public_list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<PublicQ>,
) -> AppResult<Json<Vec<ActivityRow>>> {
    let username = id.require_username()?;
    let days = q.days.filter(|d| *d > 0);
    let rows: Vec<ActivityRow> = sqlx::query_as(
        "SELECT m.*, at.name AS type_name, mp.status AS my_status,
                m.visibility <> 'public' AS is_private,
                (SELECT coalesce(json_agg(json_build_object('id', p2.id, 'name', p2.name)), '[]'::json)
                   FROM activity_projects mp2 JOIN projects p2 ON p2.id = mp2.project_id
                  WHERE mp2.activity_id = m.id AND p2.deleted_at IS NULL) AS projects,
                (SELECT count(*) FROM activity_participants x WHERE x.activity_id = m.id) AS participant_count,
                NULL::text AS minutes_status
           FROM activities m
           JOIN activity_types at ON at.id = m.type_id
           LEFT JOIN activity_participants mp ON mp.activity_id = m.id AND mp.username = $1
          WHERE m.visibility = 'public' AND m.status = 'active'
            AND m.ends_at > now()
            -- ★只列我**还没有关系**的会★(2026-08-07 用户:「公开活动明明是我发起的,
            --   为啥会有取消旁听…应该显示我没参与也没旁听的才对」)。
            --   广场是**发现**的入口:我已经参与或已经旁听的会**早就在我的日历里了**,
            --   再在右边提醒一遍是纯噪音 —— 更荒谬的是自己发起的会出现在这里,
            --   还配一个「取消旁听」按钮(我从来就不是旁听)。
            AND NOT EXISTS (SELECT 1 FROM activity_participants mpx
                             WHERE mpx.activity_id = m.id AND mpx.username = $1)
            AND ($2::bigint IS NULL OR m.starts_at < now() + ($2 || ' days')::interval)
            -- 关联项目全被删则不进广场(与日历同一条口径,见 list 里那段注释)——
            -- 同样放行零关联项目的活动(公开的个人日程也该能被旁听)
            AND (NOT EXISTS (SELECT 1 FROM activity_projects mpn WHERE mpn.activity_id = m.id)
                 OR EXISTS (SELECT 1 FROM activity_projects mpd
                              JOIN projects pd ON pd.id = mpd.project_id
                             WHERE mpd.activity_id = m.id AND pd.deleted_at IS NULL))
            -- 归档项目的会不进广场(与日历同一条口径:它不该再出现在「接下来要做什么」里)
            AND NOT (EXISTS (SELECT 1 FROM activity_projects mpj
                               JOIN projects p ON p.id = mpj.project_id
                              WHERE mpj.activity_id = m.id AND p.archived_at IS NOT NULL)
                     AND NOT EXISTS (SELECT 1 FROM activity_projects m2
                                       JOIN projects p2 ON p2.id = m2.project_id
                                      WHERE m2.activity_id = m.id AND p2.archived_at IS NULL))
          -- ★不设 LIMIT★(2026-08-14):原来写死 200,公开活动一多就**静默看不到** ——
          --   而这是「广场」,看不到就等于没发生。天然有界:上面已经筛掉了
          --   已结束(`ends_at > now()`)、我已参与、以及可选的 `days` 窗口。
          ORDER BY m.starts_at")
        .bind(username).bind(days)
        .fetch_all(&state.pool).await?;
    Ok(Json(rows))
}

/// POST /api/activities/{id}/observe —— 我要旁听 / 取消旁听(body: {observe: bool})。
///
/// ★旁听是**自助**的★(D9):不需要发起人同意 —— 活动既然标了 public,就是邀请全平台来听。
/// 旁听后这场会进入我的个人日历(list 接口本来就包含「我是参会人」的会)。
///
/// ⚠ 旁听**不给材料**:kind='observer' 在 activity_items 那里过不了项目成员判权(D9 与 D3 正交)。
pub async fn observe(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<ObserveOut>> {
    let username = id.require_username()?;
    let on = body.get("observe").and_then(|v| v.as_bool()).unwrap_or(true);
    let vis: Option<String> = sqlx::query_scalar(
        "SELECT visibility FROM activities WHERE id = $1 AND status = 'active'")
        .bind(mid).fetch_optional(&state.pool).await?;
    match vis.as_deref() {
        Some("public") => {}
        // 私密活动对无关的人本就 404(不泄露存在性);已取消的会也没什么可旁听的
        _ => return Err(AppError::NotFound),
    }
    if on {
        // ★已经是参会人就别降级成旁听★:被正式邀请的人点了旁听按钮不该丢掉自己的答复状态。
        let n = sqlx::query(
            "INSERT INTO activity_participants (activity_id, username, kind, status, responded_at)
             VALUES ($1,$2,'observer','accepted',now()) ON CONFLICT (activity_id, username) DO NOTHING")
            .bind(mid).bind(username).execute(&state.pool).await?.rows_affected();
        return Ok(Json(ObserveOut { ok: true, observing: true, added: Some(n == 1), removed: None }));
    }
    // 取消旁听:★只删自己的 observer 行★——正式参会人不能用这个接口把自己从活动里摘掉
    // (那是发起人的事,走 uninvite)。
    let n = sqlx::query(
        "DELETE FROM activity_participants WHERE activity_id=$1 AND username=$2 AND kind='observer'")
        .bind(mid).bind(username).execute(&state.pool).await?.rows_affected();
    Ok(Json(ObserveOut { ok: true, observing: false, added: None, removed: Some(n) }))
}

// ── 个人面板:我的投入(原型 me 视图)────────────────────────────────────────

#[derive(Deserialize)]
pub struct StatsQ {
    /// month | quarter | year。★白名单校验★:这个值要进 date_trunc 的第一参,
    /// 虽然是绑定参数注不进 SQL,但传个乱字符串会让 PG 直接报错 500,不如在门口挡掉。
    pub range: Option<String>,
}

/// GET /api/me/stats —— 「我的投入」统计。
///
/// ★口径写在这里,别在前端各算各的★:
///   · **只算已经开完的会**(`ends_at <= now`)——「投入」是回顾,把还没发生的会算进去
///     等于让人在月初就看到一个虚高的数字;
///   · **拒绝了的会不算**——人没去,不该计入他的时长;
///   · 发起人即使不在参会名单里也算(他在开会);
///   · **待写纪要 = 我是记录员且会已开完且纪要不是 done**(D14:记录员是纪要的作者)。
///
/// ⚠ 分项目那张表的次数之和 **≥ 总次数**:一场会可以同时关联多个项目(设计如此),
///   分项目按关联展开就会重复计。这不是 bug,但前端别拿它去反推总数。
/// 小时数保留一位小数。★统计到处要用★,散在各处 round 迟早出现「12.3 和 12.30000000001」并存。
fn r1(h: f64) -> f64 { (h * 10.0).round() / 10.0 }

/// 参会率 —— ★返回的是**比例(0~1)**,不是百分数★。前端乘 100 显示。
///
/// ⚠★2026-08-09 这里曾经是十倍错★(liaoruili:「参会率 333%咋回事??」):
/// 原式 `r1(accepted * 1000.0 / invited) / 100.0` —— 先放大 1000 倍取一位小数,
/// 却只除回 100,于是 1/3 算成 **3.33**,前端 ×100 显示成 **333%**。
/// ★这种错不报错、不越界、不 panic,只是数字不对★ —— 和 CODE-QUALITY.md 里
/// 记的「ms vs 秒 1000× 静默错位」是同一族:**量纲错**只有测试挡得住,
/// 类型检查看不见(两边都是 f64),PREPARE 也看不见(SQL 完全正常)。
/// 所以这里从表达式抽成了函数,只为了**它能被单测钉住**。
///
/// 放大 1000 再除回 1000 = 比例保留 3 位小数 = 百分数保留 1 位小数。
/// 分母不含旁听者:他不是被邀请的,计进去会稀释这个比例。
pub fn accept_rate(accepted: i64, invited: i64) -> f64 {
    if invited <= 0 { return 0.0 }
    ((accepted as f64 * 1000.0 / invited as f64).round()) / 1000.0
}

pub async fn my_stats(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<StatsQ>,
) -> AppResult<Json<MyStatsOut>> {
    let who = id.require_username()?;
    let range = match q.range.as_deref().unwrap_or("month") {
        "month" => "month", "quarter" => "quarter", "year" => "year",
        _ => return Err(AppError::BadRequest("range 只能是 month / quarter / year".into())),
    };

    // 「我参与过的、已开完的会」——两条统计共用这段口径。
    // ★写成 macro 而不是 String 拼接★:sqlx 的查询要求 `&'static str`,
    // format! 出来的 String 活不到 await 结束(E0597)。macro 展开即字面量,拼完还是 'static。
    // ★D5 的时长口径是**优先级回退**,不是三选一★:录制 > 手工 > 排程。
    // 三个来源一起带出来,因为统计界面**必须显示口径来源**(D5 原话:
    // 「这个数字会被用来做汇报,来源不透明就会有争议;标出来源,争议时可追溯」)。
    //
    // ⚠ 多份录制取 **max 不是 sum**:两个人各录一份是同一场会,累加会翻倍。
    macro_rules! mine_cte { () => { "WITH mine AS (
        SELECT m.id, m.recorder,
               ah.hours, ah.src
        FROM activities m JOIN activity_hours ah ON ah.activity_id = m.id
        WHERE m.status = 'active' AND m.ends_at <= now()
          AND m.starts_at >= date_trunc($2, now())
          -- ★关联项目全被删的会不计入★(2026-08-07,从个人面板的图上看出来的):
          -- 少了这一句,totals 会说「参会 1 次」而下面的分项目表是空的 ——
          -- 因为分项目那条 JOIN 了 projects 判 deleted_at,总数却没判。
          -- ★两个数字自相矛盾比两个都错更糟★:看的人会以为是自己看错了。
          --
          -- ⚠★这里**故意**保留「必须有活着的关联项目」,与日历那条不同★(2026-08-09):
          --   日历放行零关联项目的活动(它就是要显示我自己的安排),
          --   而这张表统计的是「参会次数 / 总时长」—— ★个人日程不是会★
          --   (预置的 `个人日程` 连 busy_default 都是 false,它只是我自己挡的一块时间)。
          --   把它算进参会时长会让这个数字失去意义。两处口径不同是**有意的**,别顺手改齐。
          AND EXISTS (SELECT 1 FROM activity_projects mpd
                        JOIN projects pd ON pd.id = mpd.project_id
                       WHERE mpd.activity_id = m.id AND pd.deleted_at IS NULL)
          AND (m.organizer = $1
               OR EXISTS (SELECT 1 FROM activity_participants p
                          WHERE p.activity_id = m.id AND p.username = $1
                            -- ★口径只认 accepted★(ADR-0003 边界②):原来是 `status <> 'declined'`,
                            -- 于是「建未来的会拉上张三 → 他被通知一次 → 改成昨天 9:00–18:00」
                            -- **两步就能给他的季度统计塞 9 小时**。
                            AND p.kind = 'attendee' AND p.status = 'accepted')))" } }

    // ══════ ★按类型统计用**另一套口径**★（PRD §K，liaoruili 2026-08-12 拍板）══════
    //
    // 与上面 `mine_cte!` 只差一条：**不要求「必须有活着的关联项目」**。
    //
    // ⚠★这不是把上面那条「顺手改齐」★（那条注释明令别改，两处口径不同是有意的）——
    //   是**两张表在回答两个不同的问题**：
    //     · 按项目答「我为哪个团队花了时间」→ 没有项目的活动在这个问题里没有位置；
    //     · 按类型答「我在做什么」→ ★PRD §K 举的例子就是「开会 6h、读文献 12h、写作 8h」★，
    //       而读文献/写作正是**不关联项目的个人日程**。带上那条过滤，这张表里
    //       就只剩「会议」一类，PRD 举的那一行永远是 0 —— 功能等于没做。
    //       （实测 dev：3 场个人日程里有关联项目的是 **0 场**。）
    //
    // ⚠★代价必须在界面上说出来★：两张表的总时长**对不上**（按类型 ≥ 按项目）。
    //   本仓有条疤：「两个数字自相矛盾比两个都错更糟，看的人会以为是自己看错了」——
    //   所以前端在**每张表下面标明各自的口径**，而不是让人自己去猜为什么不等。
    macro_rules! mine_all_cte { () => { "WITH mine AS (
        SELECT m.id, m.type_id,
               ah.hours, ah.src
        FROM activities m JOIN activity_hours ah ON ah.activity_id = m.id
        WHERE m.status = 'active' AND m.ends_at <= now()
          AND m.starts_at >= date_trunc($2, now())
          AND (m.organizer = $1
               OR EXISTS (SELECT 1 FROM activity_participants p
                          WHERE p.activity_id = m.id AND p.username = $1
                            AND p.kind = 'attendee' AND p.status = 'accepted')))" } }

    let (cnt, hours, h_rec, h_man, h_sch, projects, todo): (i64, f64, f64, f64, f64, i64, i64) =
        sqlx::query_as(concat!(mine_cte!(), "
         SELECT count(*)::bigint,
                COALESCE(SUM(hours), 0)::float8,
                COALESCE(SUM(hours) FILTER (WHERE src = 'recording'), 0)::float8,
                COALESCE(SUM(hours) FILTER (WHERE src = 'manual'), 0)::float8,
                COALESCE(SUM(hours) FILTER (WHERE src = 'scheduled'), 0)::float8,
                (SELECT count(DISTINCT mp.project_id) FROM activity_projects mp
                   WHERE mp.activity_id IN (SELECT id FROM mine))::bigint,
                -- ★判据走视图,别就地再写一遍★(2026-08-10):原来这里是
                -- 「我是记录员 AND 纪要非 done」,**漏了 has_minutes** ——
                -- 自建类型(A3 恒 false,没有纪要这回事)只要关联了项目就会被算成欠纪要。
                -- 视图定义见 0001_init.sql 的 activities_owing_minutes,「待我处理」卡同源。
                (SELECT count(*) FROM mine x
                   JOIN activities_owing_minutes o ON o.activity_id = x.id
                  WHERE o.recorder = $1)::bigint
         FROM mine"))
        .bind(who).bind(range).fetch_one(&state.pool).await?;

    // ★按类型统计(PRD §K,主视角)★ —— 走 mine_all_cte(不要求有关联项目,理由见它的头注)。
    // ⚠ JOIN activity_types **不过滤软删**:L1 定的是「软删的类型,历史活动照常显示它的名字」——
    //   把类型删了就让过去三个月的统计凭空少一行,那不是清理,是丢账。
    let by_type: Vec<(i64, String, i64, f64, f64, f64, f64)> = sqlx::query_as(concat!(mine_all_cte!(), "
         SELECT t.id, t.name, count(*)::bigint,
                COALESCE(SUM(x.hours), 0)::float8,
                COALESCE(SUM(x.hours) FILTER (WHERE x.src = 'recording'), 0)::float8,
                COALESCE(SUM(x.hours) FILTER (WHERE x.src = 'manual'), 0)::float8,
                COALESCE(SUM(x.hours) FILTER (WHERE x.src = 'scheduled'), 0)::float8
           FROM mine x JOIN activity_types t ON t.id = x.type_id
          GROUP BY t.id, t.name
          ORDER BY 4 DESC, t.name"))
        .bind(who).bind(range).fetch_all(&state.pool).await?;

    let by_project: Vec<(i64, String, bool, i64, f64, i64)> = sqlx::query_as(concat!(mine_cte!(), "
         SELECT p.id, p.name, p.archived_at IS NOT NULL,
                count(*)::bigint, COALESCE(SUM(x.hours), 0)::float8,
                count(*) FILTER (WHERE mm.status = 'done')::bigint
         FROM mine x
         JOIN activity_projects mp ON mp.activity_id = x.id
         JOIN projects p ON p.id = mp.project_id AND p.deleted_at IS NULL
         LEFT JOIN activity_minutes mm ON mm.activity_id = x.id
         GROUP BY p.id, p.name, p.archived_at
         ORDER BY count(*) DESC, p.name"))
        .bind(who).bind(range).fetch_all(&state.pool).await?;

    // 我主持的项目(原型下半张卡)。「N 份纪要待整理」是**项目视角**的:
    // 只要这项目里有开完却没完成纪要的会就算,不论记录员是谁 —— 主持人要的是「我这摊子有没有欠账」。
    let hosting: Vec<(i64, String, bool, i64, i64)> = sqlx::query_as(
        "SELECT p.id, p.name, p.archived_at IS NOT NULL,
                (SELECT count(*) FROM project_members pm WHERE pm.project_id = p.id)::bigint,
                -- ★同一个判据,同一个视图★(2026-08-10):这里也曾漏 has_minutes。
                -- 与上面那处不同的只是**范围**——项目视角不筛记录员(主持人要看的是整摊子的欠账)。
                (SELECT count(*) FROM activities_owing_minutes o
                   JOIN activity_projects mp ON mp.activity_id = o.activity_id
                  WHERE mp.project_id = p.id)::bigint
         -- ★「我的活动材料」不是项目,别算进「主持 N 个项目」★(2026-08-15 巡检截图看出来的):
         --   它在项目列表里是置顶特殊项、不计入「进行中 9 / 已归档 1」、
         --   搜索框也只说「在 10 个项目里找」—— 唯独这里把它当成一个我主持的项目数进去了,
         --   于是个人面板写「主持 8 个项目」而项目页只认 7 个。★同一个东西一处算一处不算。★
         --   判据用 kind(ADR-0005 定的 team/materials),与 `isMaterials()` 前端那处同源。
         FROM projects p WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.kind <> 'materials'
         ORDER BY p.archived_at IS NOT NULL, p.name")
        .bind(who).fetch_all(&state.pool).await?;

    // 「我参与 N 个项目」是**当下的成员身份**,与时间段无关 ——
    // 名片上那个数字若跟着「本月/本季度」变,读起来像「我这个月退出了几个项目」。
    // ★排除我自己主持的★:名片上「主持 2 个 | 参与 25 个」是并列关系(原型如此),
    // 而建项目时 owner 会自动进成员表 —— 不排除的话「参与」把「主持」也包进去了,
    // 两个数字加起来大于我实际有关系的项目数。
    let member_of: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_members pm
           JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
          WHERE pm.username = $1 AND p.owner <> $1")
        .bind(who).fetch_one(&state.pool).await?;

    Ok(Json(MyStatsOut {
        range: range.to_string(),
        member_of,
        totals: MyTotals {
            activities: cnt, hours: r1(hours), projects, minutes_todo: todo,
            hours_by_source: HoursBySource { recording: r1(h_rec), manual: r1(h_man), scheduled: r1(h_sch) },
        },
        // ★按类型是主视角★(PRD §K:「按项目答『我为哪个团队花了时间』,按类型答『我在做什么』,
        // 后者才是个人视角的主问题」)。前端把它排在按项目**之前**。
        //
        // ⚠★它自带一套 totals,不能复用上面那份★:两张表口径不同(这张不要求有关联项目),
        //   合计自然对不上。让前端拿上面那份去当这张表的合计 = 制造一个自相矛盾的数字。
        by_type: by_type.iter().map(|(type_id, name, count, h, rec, man, sch)| TypeStat {
            type_id: *type_id, name: name.clone(), count: *count, hours: r1(*h),
            hours_by_source: HoursBySource { recording: r1(*rec), manual: r1(*man), scheduled: r1(*sch) },
        }).collect(),
        totals_by_type: TypeTotals {
            activities: by_type.iter().map(|x| x.2).sum::<i64>(),
            hours: r1(by_type.iter().map(|x| x.3).sum::<f64>()),
        },
        by_project: by_project.iter().map(|(id, name, archived, count, h, minutes_done)| ProjectStat {
            id: *id, name: name.clone(), archived: *archived,
            count: *count, hours: r1(*h), minutes_done: *minutes_done,
        }).collect(),
        hosting: hosting.iter().map(|(id, name, archived, members, minutes_pending)| HostingStat {
            id: *id, name: name.clone(), archived: *archived,
            members: *members, minutes_pending: *minutes_pending,
        }).collect(),
    }))
}

// ── 待我处理:私聊未读(原型 me 之外那张 🔔 卡的第二类条目)────────────────────

/// GET /api/me/unread —— 有谁在活动里私聊了我、我还没看。
///
/// ★只算 private 频道且 peer 是我的★:公开讨论区的新消息不进这张卡 ——
/// 那是「群里有人说话」,不是「有人找我」;混进来会让这张卡天天有红点,
/// 红点天天有就等于没有。
///
/// 未读判据 = 该会我的 `read_at` 之前没有(从没进过)或早于消息时间。
/// ⚠ **没有记录 = 一条都没读过**(见迁移 0003 的注释)。
pub async fn my_unread(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<Vec<UnreadRow>>> {
    let who = id.require_username()?;
    let rows: Vec<(i64, String, String, String, Ts, i64)> = sqlx::query_as(
        "SELECT m.id, m.title, x.sender, x.body, x.created_at, x.cnt
         FROM (
            SELECT DISTINCT ON (mm.activity_id) mm.activity_id, mm.sender, mm.body, mm.created_at,
                   count(*) OVER (PARTITION BY mm.activity_id) AS cnt
            FROM activity_messages mm
            LEFT JOIN activity_reads r ON r.activity_id = mm.activity_id AND r.username = $1
            WHERE mm.channel = 'private' AND mm.peer = $1 AND mm.sender <> $1
              AND (r.read_at IS NULL OR mm.created_at > r.read_at)
            ORDER BY mm.activity_id, mm.created_at DESC
         ) x
         JOIN activities m ON m.id = x.activity_id AND m.status = 'active'
         -- limit-ok: 刻意举例 —— 这是「最近的消息」摘要,语义本来就是「最近 N 条」;
         --   全部消息在活动详情页里,不靠这个接口翻。
         ORDER BY x.created_at DESC LIMIT 20")
        .bind(who).fetch_all(&state.pool).await?;

    Ok(Json(rows.into_iter().map(|(activity_id, title, sender, body, created_at, count)| UnreadRow {
        activity_id, title, sender, body, created_at, count,
    }).collect()))
}

/// 「待我处理」的第四路:★等我整理的纪要★。
///
/// ⚠★2026-08-10 liaoruili:「其实纪要也是待我处理,但是通知里面没有出现」★。
/// 在此之前这张卡只有三路来源(邀请待答复 / 私聊未读 / 主持人转移),
/// 而**记录员**这个角色是 D14 明确设的位置(「AI 转写只是原材料,记录员才是作者」)——
/// 一件被系统指派给你的、有交付物的活儿,却是全系统唯一不提醒的那件。
/// ★把责任指派给某个人、又不给他一条看得见的待办,那条责任在实践中就等于没指派。★
///
/// 判据四条,缺一条都会造出噪声:
///   · `recorder = 我` —— 别人的活不进我的卡;
///   · `has_minutes` —— 「个人日程」这类类型压根没有纪要这回事(ADR-0002 的能力位);
///   · `ends_at < now()` —— ★会还没开完就催纪要是纯噪声★,那时候根本无从写起;
///   · 纪要行不存在 **或** `status <> 'done'` —— 「连草稿都没建」比「草稿没写完」更该提醒,
///     所以两者都算,用 `has_draft` 区分文案。
/// 取消掉的活动(`status='canceled'`)自然不算 —— 没开的会没有纪要。
///
/// ⚠★不设时间下限★(比如「只看最近 30 天」):欠着的纪要不会因为放久了就不欠。
/// 真嫌吵的话应该去把它写完或标 done,而不是让它自己淡出——那等于系统替人把账勾了。
/// 但**上限 50 条**是有的:再多就不是待办而是历史债,该走统计而不是这张卡。
pub async fn my_minutes_todo(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<Vec<MinutesTodoRow>>> {
    let who = id.require_username()?;
    let rows: Vec<(i64, String, Ts, Ts, bool)> = sqlx::query_as(
        "SELECT activity_id, title, starts_at, ends_at, has_draft
         FROM activities_owing_minutes WHERE recorder = $1
         -- ★不设 LIMIT★(2026-08-14):原来写死 50,超过就**静默断掉** ——
         --   而「待写纪要」是欠账清单,欠得越多越不该藏起来。
         --   天然有界:它只数**我当记录员、且还没定稿**的活动,而且前端(TodoCard)本来就折叠。
         ORDER BY ends_at DESC")
        .bind(who).fetch_all(&state.pool).await?;

    Ok(Json(rows.into_iter().map(|(activity_id, title, starts_at, ends_at, has_draft)| MinutesTodoRow {
        activity_id, title, starts_at, ends_at, has_draft,
    }).collect()))
}

#[derive(Deserialize)]
pub struct RemindersQuery {
    /// 上一次轮询拿到的 `now`。★不给 = 只回时间戳、不回任何提醒★(见下)。
    pub since: Option<Ts>,
}

/// GET /api/me/reminders —— 页面内弹窗的数据源(设计 §5)。
///
/// 后台循环(`remind.rs`)把提醒写进站内信,但站内信要人主动去看;
/// F2 要的是**开着页面就能弹出来**。所以前端每 60 秒问一次「从上次到现在,有没有新提醒发给我」。
///
/// ══════ 两个决定,都是为了不重复弹/不漏弹 ══════
///
/// ① ★`since` 用**服务端**的时间,不用客户端的★。
///    响应里带一个 `now`,前端下次原样送回来。看起来绕,但换成前端用 `Date.now()` 的话,
///    浏览器时钟比服务器快几秒就会**永远查不到**刚发的提醒(since 一直在未来),
///    慢几秒则**每轮重弹**同一条。而这两种偏差都无声无息 ——
///    ★用户只会觉得「提醒时灵时不灵」,而我们查不出为什么★。
///    时钟同步不是我们能假设的前提(用户笔记本合盖再打开就能漂几分钟)。
///
/// ② ★不给 `since` 时回空列表,而不是回「最近的全部」★。
///    首次进页面回一批历史提醒的话,用户一打开就被几条「XX 将于 15 分钟后开始」糊脸,
///    而那些会**早就开完了**。首轮只用来对时。
///
/// ⚠ `reminded_at` 是「投递那一刻」,`starts_at` 是会开始的时刻,别混:
///   翻页去重靠前者,文案里说的「还有几分钟」算的是后者。
pub async fn my_reminders(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<RemindersQuery>,
) -> AppResult<Json<RemindersOut>> {
    let who = id.require_username()?;
    let now: Ts = sqlx::query_scalar("SELECT now()").fetch_one(&state.pool).await?;
    let items = match q.since {
        None => vec![],
        Some(since) => {
            let rows: Vec<(i64, String, Ts, Ts)> = sqlx::query_as(
                "SELECT p.activity_id, m.title, m.starts_at, p.reminded_at
                 FROM activity_participants p
                 JOIN activities m ON m.id = p.activity_id
                 WHERE p.username = $1 AND p.reminded_at > $2
                   -- 取消的活动不弹:提醒发出去之后被取消,这一轮就别再冒出来了
                   AND m.status = 'active'
                   -- ★拒绝了的也不弹★(2026-08-14 liaoruili 截图:「我不是已经拒绝了 为啥还有提醒」)。
                   -- ⚠ 投递侧(remind.rs)**早就**有 `p.status <> 'declined'`,注释还写着
                   --   「拒绝了的人不必再提醒」—— 但它只管**要不要发**。
                   --   真实顺序常常是:先发出去(reminded_at 落库)、人看到之后才去拒。
                   --   ★于是「已经发过」这个事实继续在拉取侧生效,toast 照弹★。
                   -- 这和 ADR-0003 是同一族:存的是「当时发生过」的事实,
                   --   读的时候却没有再问一次「现在还成不成立」。两侧都要判,缺一边就是这个症状。
                   AND p.status <> 'declined'
                   -- ★只要**还没开始**的★(2026-08-14 liaoruili:「为啥又莫名其妙使用 limit」)。
                   -- 这一条和下面去掉 LIMIT 是同一件事的两半,原来的写法是
                   --   `ORDER BY m.starts_at LIMIT 20`,**没有**这个条件 ——
                   -- 于是早就开完的活动按开始时间排在最前,★把 20 个名额吃光★,
                   -- 真正「马上要开始」的反而被挤出去。而这个接口的全部用途就是弹
                   -- 「还有 N 分钟开始」:前端拿到已开始的会直接 `mins <= 0 continue` 扔掉。
                   -- ★于是那 20 条大半是垃圾,而该弹的静默不弹★ —— 症状是「提醒失灵」,
                   -- 没有任何报错,人只会以为「这次没提醒我」。实测 e2e 名下 54 条符合条件、
                   -- 只返 20 条,我造的那场就在被截掉的里面。
                   -- ⚠★判据本来只写在前端★(remind-poll 的 `mins <= 0`),
                   --   服务端不判就意味着「谁来取都得自己再判一遍」—— 与 remind.rs 的
                   --   `m.starts_at > now()`(「已经开始的不补发」)是同一条,现在两处一致。
                   AND m.starts_at > now()
                 -- ★不设 LIMIT★:加了上面那条之后,结果天然被「已提醒 + 尚未开始」双重夹住,
                 --   不会无限增长;而写死一个 LIMIT 又不给总数,就是让接口替数据撒谎
                 --   (回收站 / 我的分享那两处 LIMIT 500 是同一个病,已改真分页)。
                 ORDER BY m.starts_at")
                .bind(who).bind(since).fetch_all(&state.pool).await?;
            rows
        }
    };
    Ok(Json(RemindersOut {
        now,
        items: items.into_iter().map(|(activity_id, title, starts_at, reminded_at)| ReminderRow {
            activity_id, title, starts_at, reminded_at,
        }).collect(),
    }))
}

#[derive(Deserialize)]
pub struct ReadBody {
    /// 不给 = 全部标记已读(原型右上角那个链接);给了 = 只清这一场会的。
    pub activity_id: Option<i64>,
}

/// POST /api/me/unread/read —— 标记已读。
///
/// ★把 read_at 推到 now() 而不是「最后一条消息的时间」★:两者在正常情况下等价,
/// 但并发时不是 —— 若取最后一条的时间,恰好此刻发来的消息会被一起标成已读并**永远消失**。
/// 推到 now() 最坏只是把刚发来的那条也算读了,而它还在活动页里躺着,不会丢。
pub async fn mark_read(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(b): Json<ReadBody>,
) -> AppResult<Json<MarkReadOut>> {
    let who = id.require_username()?;
    let n = match b.activity_id {
        Some(mid) => sqlx::query(
            "INSERT INTO activity_reads (activity_id, username) VALUES ($1, $2)
             ON CONFLICT (activity_id, username) DO UPDATE SET read_at = now()")
            .bind(mid).bind(who).execute(&state.pool).await?.rows_affected(),
        // 全部:只针对**确实有私聊给我**的会,不给全库每场会都塞一行
        None => sqlx::query(
            "INSERT INTO activity_reads (activity_id, username)
             SELECT DISTINCT mm.activity_id, $1 FROM activity_messages mm
              WHERE mm.channel = 'private' AND mm.peer = $1 AND mm.sender <> $1
             ON CONFLICT (activity_id, username) DO UPDATE SET read_at = now()")
            .bind(who).execute(&state.pool).await?.rows_affected(),
    };
    Ok(Json(MarkReadOut { marked: n }))
}

// ── 项目统计(PRD 6.5.2 + D6)────────────────────────────────────────────

/// GET /api/projects/{id}/stats —— 项目视角的活动统计。
///
/// ★与个人统计(`/api/me/stats`)的口径差别写在这里,别各算各的★:
///   · 个人统计问的是「**我**花了多少时间开会」→ 只算我参与且没拒绝的;
///   · 项目统计问的是「**这个项目**开了多少会」→ 算项目的全部活动,与我参没参加无关。
///
/// D6 的去重规则在这一层体现为:本接口返回的就是**单个项目**的数字(分组展开的那一份),
/// 「总计按活动去重」发生在把多个项目的数字加起来的时候 —— ★所以这里给的 count
/// 不能被前端直接相加当总数★,响应里带 `dedup_note` 把这句话说出来。
///
/// 参会率 = 接受人数 / 邀请人数(旁听者不算 —— 他不是被邀请的,把他计进分母会稀释这个比例)。
pub async fn project_stats(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Query(q): Query<StatsQ>,
) -> AppResult<Json<ProjectStatsOut>> {
    // ★要 viewer 就够★:统计是「这个项目开了多少会」,属于项目内的公开事实;
    // 但它**只对成员**开放 —— 活动次数与时长本身也是信息(D3:权限来自当前成员身份)。
    perm::require_role(&state.pool, &id, pid, perm::Role::Viewer).await?;
    let range = match q.range.as_deref().unwrap_or("quarter") {
        "month" => "month", "quarter" => "quarter", "year" => "year",
        _ => return Err(AppError::BadRequest("range 只能是 month / quarter / year".into())),
    };

    // 时长口径与个人统计**完全一致**(D5 三级回退) —— 两处若各写一套,
    // 同一场会在个人页和项目页会显示不同的时长,而没人说得清该信哪个。
    let sql = "WITH mtg AS (
        SELECT m.id,
               ah.hours, ah.src,
               (SELECT count(*) FROM activity_participants p
                 WHERE p.activity_id = m.id AND p.kind = 'attendee') AS invited,
               (SELECT count(*) FROM activity_participants p
                 WHERE p.activity_id = m.id AND p.kind = 'attendee' AND p.status = 'accepted') AS accepted,
               EXISTS (SELECT 1 FROM activity_minutes mm
                        WHERE mm.activity_id = m.id AND mm.status = 'done') AS minutes_done
        FROM activities m JOIN activity_hours ah ON ah.activity_id = m.id
        JOIN activity_projects mp ON mp.activity_id = m.id AND mp.project_id = $1
        -- ★取消的场次不计入★(PRD 6.5.2 验收标准):它没发生过
        WHERE m.status = 'active' AND m.ends_at <= now()
          AND m.starts_at >= date_trunc($2, now()))
      SELECT count(*)::bigint,
             COALESCE(SUM(hours), 0)::float8,
             COALESCE(SUM(hours) FILTER (WHERE src = 'recording'), 0)::float8,
             COALESCE(SUM(hours) FILTER (WHERE src = 'manual'), 0)::float8,
             COALESCE(SUM(hours) FILTER (WHERE src = 'scheduled'), 0)::float8,
             COALESCE(SUM(invited), 0)::bigint,
             COALESCE(SUM(accepted), 0)::bigint,
             count(*) FILTER (WHERE minutes_done)::bigint
        FROM mtg";
    let (cnt, hours, h_rec, h_man, h_sch, invited, accepted, done):
        (i64, f64, f64, f64, f64, i64, i64, i64) =
        sqlx::query_as(sql).bind(pid).bind(range).fetch_one(&state.pool).await?;

    // 每人次平均时长:总时长 × 接受人数 / 活动数……不对。★= Σ(每场时长 × 该场接受人数) / 人次★
    // ⚠★别叫它「人均」★(2026-08-15 界面改过来了):分母是**人次**,
    //   3 场每场 1 人共 4h → 这个数是 1.3,而那个人实际坐了 4h。叫「人均」会少报 3 倍。
    // 简化成「总时长 / 活动数 × 参会率」会在各场人数差异大时明显失真,所以直接按人次算。
    let per_person: Option<f64> = sqlx::query_scalar(
        "SELECT SUM(h * acc) / NULLIF(SUM(acc), 0) FROM (
           SELECT ah.hours AS h,
                  (SELECT count(*) FROM activity_participants p
                    WHERE p.activity_id = m.id AND p.kind = 'attendee' AND p.status = 'accepted')::float8 AS acc
             FROM activities m JOIN activity_hours ah ON ah.activity_id = m.id
           JOIN activity_types at ON at.id = m.type_id JOIN activity_projects mp ON mp.activity_id = m.id AND mp.project_id = $1
            WHERE m.status = 'active' AND m.ends_at <= now() AND m.starts_at >= date_trunc($2, now())
         ) x")
        .bind(pid).bind(range).fetch_one(&state.pool).await?;

    Ok(Json(ProjectStatsOut {
        range: range.to_string(),
        activities: cnt,
        hours: r1(hours),
        hours_by_source: HoursBySource { recording: r1(h_rec), manual: r1(h_man), scheduled: r1(h_sch) },
        invited,
        accepted,
        accept_rate: accept_rate(accepted, invited),
        avg_hours_per_person: per_person.map(r1),
        minutes_done: done,
        dedup_note: "一场会可关联多个项目,本数字按「活动 × 项目」展开;跨项目求总数须按活动去重(D6)".into(),
    }))
}


// ══════ ★纪要导出 PDF★(2026-08-17,docs/TECH-DESIGN-minutes-pdf.md)══════

/// POST /api/activities/{id}/minutes/pdf —— 把纪要排成 PDF,存为活动材料里的一条 item。
///
/// ⚠★权限 = 能写纪要的人★(`require_activity_host`,与 minutes_put 同一判据):
///   导出是**产出正式文件**,不是读 —— 不放宽给普通参会人。
///
/// ⚠★已有 PDF 就写成同一条 item 的新版本,不新建行★:`pdf_item_id` 是单个 FK,
///   而且一条稳定的 item id 意味着★分享链接不会因为重新导出而失效★。
pub async fn minutes_pdf(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<MinutesPdfOut>> {
    require_activity_host(&state.pool, &id, mid).await?;
    let actor = id.require_username()?;
    let m: ActivityRow = sqlx::query_as(
        "SELECT m.*, at.name AS type_name, at.has_minutes, NULL::text AS my_status, NULL::text AS my_kind,
                NULL::timestamptz AS my_responded_at, NULL::text AS minutes_status
           FROM activities m LEFT JOIN activity_types at ON at.id = m.type_id WHERE m.id = $1")
        .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    let mn: Option<Minutes> = sqlx::query_as("SELECT * FROM activity_minutes WHERE activity_id = $1")
        .bind(mid).fetch_optional(&state.pool).await?;
    let mn = mn.ok_or_else(|| AppError::BadRequest("这场活动还没有纪要,先写点内容再导出".into()))?;
    // ★空纪要不给导★:导出一份什么都没有的 PDF,比报错更让人困惑(他会以为系统坏了)
    if mn.content_md.trim().is_empty() && mn.resolutions.trim().is_empty() && mn.todos.trim().is_empty() {
        return Err(AppError::BadRequest("纪要还是空的 —— 写点内容再导出".into()));
    }

    let 是草稿 = mn.status != "done";
    let 时间 = crate::tzutil::when_labeled(m.starts_at, crate::tzutil::parse(&m.timezone));
    // ★记录员印姓名不印账号★(2026-08-19):`m.recorder` 存的是账号名,
    //   而纪要是给人读的 —— 「liaoruili」对读者没有信息量。
    let 记录员 = crate::minutes_pdf::显示名(&state.pool, &m.recorder).await;
    let md = crate::minutes_pdf::拼纪要markdown(
        &m.title, 是草稿, &时间, &m.location, &m.online_url,
        &记录员, &mn.attendees, &mn.observers, &mn.absentees,
        &mn.agenda_text, &mn.content_md, &mn.resolutions, &mn.todos);
    let pdf = crate::minutes_pdf::编译(&md).await?;

    // ── 落点:与「上传材料」同一条路(后端算,前端给不了任意 project_id)──
    // ★落点由后端算★(与「上传材料」同一套规则):有关联项目就落第一个关联项目,
    //   没有就落发起人自己的材料区(PRD §J0)。
    let pid: i64 = match sqlx::query_scalar::<_, i64>(
        "SELECT mp.project_id FROM activity_projects mp JOIN projects p ON p.id = mp.project_id
          WHERE mp.activity_id = $1 AND p.deleted_at IS NULL ORDER BY mp.project_id LIMIT 1")
        .bind(mid).fetch_optional(&state.pool).await? {
        Some(p) => p,
        None => crate::http::projects::materials_project(&state, actor).await?,
    };
    let 文件名 = format!("{}-纪要.pdf", m.title.trim());
    let item = crate::http::items::存一份活动材料(
        &state, pid, mid, actor, &文件名, pdf, "application/pdf", mn.pdf_item_id).await?;
    sqlx::query("UPDATE activity_minutes SET pdf_item_id = $2, updated_at = now() WHERE activity_id = $1")
        .bind(mid).bind(item).execute(&state.pool).await?;
    crate::audit::record(&state.pool, actor, "minutes.pdf", &mid.to_string(),
        if 是草稿 { "draft" } else { "done" }).await;
    Ok(Json(MinutesPdfOut { item_id: item, draft: 是草稿 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★参会率的复现测试★(2026-08-09 liaoruili 报「参会率 333%」)。
    /// 3 人受邀 1 人接受 = 33.3%,前端拿到的必须是 **0.333**(它会 ×100 显示)。
    /// 旧实现给的是 3.333 → 界面 333%。
    ///
    /// ★这条测试的价值不在「算得对」,在于把**量纲**钉死★:
    /// 比例还是百分数,是这个函数唯一容易搞错的事,而搞错了不会报任何错。
    #[test]
    fn 参会率给的是比例不是百分数() {
        let r = accept_rate(1, 3);
        assert!((r - 0.333).abs() < 1e-9, "1/3 应为 0.333(比例),实得 {r}");
        assert!(r <= 1.0, "★比例不可能大于 1★ —— 大于 1 就是又一次十倍错");
        assert_eq!(accept_rate(3, 3), 1.0, "全员接受 = 1.0,不是 100.0");
        assert_eq!(accept_rate(0, 5), 0.0);
        // 没人受邀时不能除零(NaN 会让前端显示 NaN%)
        assert_eq!(accept_rate(0, 0), 0.0);
        assert_eq!(accept_rate(2, 0), 0.0);
    }

    /// 反向:任意输入都落在 [0,1]。★接受数不该超过邀请数,但真超了也不能吐出 >1★
    /// (数据异常时界面显示 250% 只会让人以为统计坏了,而不是数据坏了)。
    #[test]
    fn 参会率永远落在0到1之间() {
        for invited in 0..20i64 {
            for accepted in 0..=invited {
                let r = accept_rate(accepted, invited);
                assert!((0.0..=1.0).contains(&r), "accept_rate({accepted},{invited}) = {r}");
            }
        }
    }

    /// ★时区换算是站内信里最容易静默错的一格★:UTC 存、北京时间显示,
    /// 差 8 小时不会报错,只会让人在错的时间到场。星期也一起钉住 ——
    /// 它是从日期算出来的,算错了同样不报错。
    #[test]
    fn 站内信时间按北京时间显示并带星期() {
        let t: Ts = "2026-08-13T02:00:00Z".parse().unwrap();   // UTC 02:00 = 北京 10:00
        // ⚠★2026-08-12 起正文会带时区标注★(甲案):原来是「08-13 周四 10:00」,
        //   而纽约用户读到那串数字时不知道它是北京时间 —— ★于是他去自己的日历上找 10:00,找不到★。
        assert_eq!(fmt_when(t, crate::tzutil::FALLBACK), "08-13 周四 10:00（北京时间）");
        // 同一瞬时按纽约说,是另一个钟点、另一个标注 —— 两句话都对,因为各自都标了是按哪儿的钟
        assert_eq!(fmt_when(t, chrono_tz::America::New_York), "08-12 周三 22:00（纽约时间）");
    }

    /// 跨日的那一格:UTC 当天 20:00 在北京已经是**第二天**凌晨 4 点。
    /// 只按 UTC 取日期的写法在这里会给出错的日子和错的星期。
    #[test]
    fn 站内信时间跨日不串日期() {
        let t: Ts = "2026-08-13T20:00:00Z".parse().unwrap();   // 北京 08-14 04:00 周五
        assert_eq!(fmt_when(t, crate::tzutil::FALLBACK), "08-14 周五 04:00（北京时间）");
    }
}
