//! 活动类型（ADR-0002）：一条活动必须有类型，三个能力位挂在类型上。
//!
//! ★为什么是一张表而不是一串布尔★：「会议」这个词原本把三件事绑死了 ——
//! 必须有纪要、必须关联项目、必然占忙闲。而「个人日程」三条都不该有。
//! 每加一种活动就往 `activities` 上加一个布尔、再改所有判定分支，是加不动的；
//! 类型表把它变成**加一行数据**。
use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 三个能力位。★纯数据，判定见 `check_caps`★。
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::FromRow)]
pub struct Caps {
    /// 有正式纪要与记录员 → `recorder` 必填
    pub has_minutes: bool,
    /// 必须关联项目 → `project_ids` 至少一个（材料权限来自项目成员身份，D3）
    pub needs_project: bool,
    /// 默认占不占忙闲（自建类型时**唯一开放**的开关，A3）
    pub busy_default: bool,
    /// ★能不能填过去的时间（补录）★（F0/F1，2026-08-09 liaoruili：
    /// 「会议类型的活动只能发起未来的会议，其他类型可以后面补录」）。
    /// 自建类型恒为 true —— 补录本来就是自建类型（读文献 / 跑数据 / 健身）的主要用法。
    pub allow_past: bool,
}

/// 建活动时按类型校验入参。★纯函数，所以 hermetic 的 `cargo test` 够得着★。
///
/// 判定藏在 handler 的 async 分支里的话，`cargo test` 永远测不到它 ——
/// 这条教训在 `perm.rs` 已经吃过两次（旁听者提权 v0.4.39、材料区隔离 v0.4.49）。
pub fn check_caps(c: &Caps, recorder: &str, project_ids: &[i64]) -> Result<(), &'static str> {
    if c.has_minutes && recorder.trim().is_empty() {
        return Err("这类活动要出正式纪要，必须指定记录员（D14：纪要由他按模板整理）");
    }
    if c.needs_project && project_ids.is_empty() {
        return Err("这类活动必须关联至少一个项目（材料权限来自项目成员身份）");
    }
    Ok(())
}

/// 一条活动的跨度上限 —— ★30 天★（PRD F4，2026-08-08 liaoruili 拍板）。
///
/// **为什么需要一个上界**：此前只有「结束必须晚于开始」这一条下界。
/// 一条 `2026-08-08 → 2126-08-08`（输错年份）会命中**每一次**日历查询与忙闲查询的时间窗，
/// 把两条最热的路径一起拖垮，而用户在任何一屏上都看不出是哪条记录干的。
///
/// **为什么是 30 天而不是更松**：真实的长活动是「出差两周」「年假一个月」。
/// 更常见的手滑不是输错年份，而是**输错月份**（8 月 8 日打成次年 3 月 1 日 = 205 天）——
/// ★365 天的上界挡不住它，30 天挡得住。★
pub const MAX_SPAN_DAYS: i64 = 30;

/// 时间区间本身合法吗（纯函数，`cargo test` 够得着）。
///
/// ⚠★必须在应用层校验并返 400 带可读文案★（F4 明写）：只靠数据库 CHECK 的话，
/// `error.rs` 把 sqlx 错误一律映射成 500 `"internal error"` ——
/// 用户会拿到一个「服务器出错了」，而问题其实出在他填的日期上。
pub fn check_span(starts_at: chrono::DateTime<chrono::Utc>,
                  ends_at: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
    if ends_at <= starts_at { return Err("结束时间必须晚于开始时间".into()) }
    let days = (ends_at - starts_at).num_days();
    if days > MAX_SPAN_DAYS {
        return Err(format!(
            "一条活动最长 {MAX_SPAN_DAYS} 天，这条是 {days} 天——是不是月份或年份填错了？真要记这么长的一段，拆成几条。"));
    }
    Ok(())
}

/// 会后补录的「实际时长」上界 —— ★按这场活动的跨度算，不写死 1440 分钟★（F4 连带条）。
/// 写死一天的话，三天的出差就填不了实际时长。
/// ⚠ 上界是「跨度 + 1 天」而不是「跨度」：跨度按 num_days() 取整会丢掉不满一天的尾巴。
pub fn check_actual_minutes(minutes: i32, starts_at: chrono::DateTime<chrono::Utc>,
                            ends_at: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
    if minutes < 0 { return Err("实际时长不能是负数".into()) }
    let cap = ((ends_at - starts_at).num_minutes() + 24 * 60).max(24 * 60);
    if i64::from(minutes) > cap {
        return Err(format!("实际时长比这场活动的跨度还长（上限 {} 分钟）", cap));
    }
    Ok(())
}

/// 开始时间能不能是过去（F0/F1）。★与 check_caps 分开是因为它要"现在几点"★——
/// 揉进去会让那个纯函数依赖时钟，单测就得注入时间，反而更难测。
///
/// ⚠ 留 5 分钟容差：填表本身要花时间，选了「最近的整点」再慢慢填完议程，
/// 提交时那个点可能刚过 —— 卡死到秒会让人白填一轮。
pub fn check_past(c: &Caps, starts_at: chrono::DateTime<chrono::Utc>,
                  now: chrono::DateTime<chrono::Utc>) -> Result<(), &'static str> {
    if !c.allow_past && starts_at < now - chrono::Duration::minutes(5) {
        return Err("「会议」只能排未来的时间。要补录一场已经开过的会，先建再改时间，或者换一个可补录的类型");
    }
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct TypeRow {
    pub id: i64,
    /// NULL = 系统预置。前端据此决定「改/删」按钮给不给。
    pub owner: Option<String>,
    pub name: String,
    pub has_minutes: bool,
    pub needs_project: bool,
    pub busy_default: bool,
    pub allow_past: bool,
}

/// GET /api/activity-types —— 预置的 + 我自建的。★别人自建的看不到★（那是他的分类习惯）。
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<Vec<TypeRow>>> {
    let rows: Vec<TypeRow> = sqlx::query_as(
        "SELECT id, owner, name, has_minutes, needs_project, busy_default, allow_past
           FROM activity_types
          WHERE deleted_at IS NULL AND (owner IS NULL OR owner = $1)
          ORDER BY owner NULLS FIRST, id",
    )
    .bind(id.require_username()?)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct TypeIn {
    /// ⚠★必须是 Option★(2026-08-09 全量审计 A4):原来是裸 `String`,而「我的活动类型」页勾
    /// 「占忙闲」时只送 `{busy_default}` —— axum 的 Json 提取器在**进 handler 之前**就 422,
    /// 响应体是纯文本,用户看到的是一个裸的「422」。于是 A3 说的「自建类型唯一的开关」
    /// ★从来没工作过★。前端注释里写的「后端 name 是 COALESCE 更新,不传就保留」描述的是 SQL,
    /// 而 serde 在 SQL 之前就把请求毙了 —— ★「后端会兜住」这种话要去看它兜在哪一层★。
    #[serde(default)]
    pub name: Option<String>,
    /// ★自建类型只开放这一个开关★（A3）：`has_minutes` / `needs_project` 是系统语义，
    /// 不给用户改 —— 让人自己勾「不需要纪要」等于把 D14 的约束交给使用者绕过。
    #[serde(default)]
    pub busy_default: Option<bool>,
}

fn clean_name(s: &str) -> AppResult<&str> {
    let n = s.trim();
    if n.is_empty() {
        return Err(AppError::BadRequest("类型名不能为空".into()));
    }
    if n.chars().count() > 12 {
        return Err(AppError::BadRequest("类型名最多 12 个字".into()));
    }
    Ok(n)
}

/// 唯一索引撞了 → 给人话，而不是把数据库错误吐出去。
fn name_taken(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(d) = &e {
        if d.code().as_deref() == Some("23505") {
            return AppError::BadRequest("已经有同名的活动类型了（预置的也算）".into());
        }
    }
    e.into()
}

/// POST /api/activity-types —— 自建一个（A2）。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<TypeIn>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    // 建类型时名字是**必填**的(改名时才可省)——缺了就给人话,不是 422
    let name = clean_name(input.name.as_deref().ok_or_else(|| AppError::BadRequest("类型名不能为空".into()))?)?;
    let nid: i64 = sqlx::query_scalar(
        // has_minutes / needs_project 一律 false：自建类型是「我自己的日程分类」，
        // 要正式纪要与项目归属的话，用预置的「会议」。
        "INSERT INTO activity_types (owner, name, busy_default) VALUES ($1,$2,COALESCE($3,true))
         RETURNING id",
    )
    .bind(me)
    .bind(name)
    .bind(input.busy_default)
    .fetch_one(&state.pool)
    .await
    .map_err(name_taken)?;
    crate::audit::record(&state.pool, me, "atype.create", &nid.to_string(), name).await;
    Ok(Json(json!({ "id": nid })))
}

/// 一行的可改范围。★两档,就两档★:自建的随便改,预置的一点都不能动。
///
/// ⚠★这里原来有第三档 `BusyOnly`(预置的简单型可以改 `busy_default`),已删★
///   (2026-08-15 对抗检查抓到,liaoruili 拍板「预置的不能改」)。它的来历是相位 3 的原型:
///   「个人日程」那一行的占忙闲画成了**可勾的复选框**,于是我照着实现了。
///   ★原型对的是「一个人看到的界面」,而 `owner IS NULL` 的那一行是**全系统共用的一行**★ ——
///   甲把「个人日程」勾成不占忙闲,乙、丙、丁的个人日程当场跟着不占,
///   而他们四个人的界面上什么提示都没有,只有别人约他们时才会发现「他明明有安排却显示空闲」。
///   ★把「一个人的偏好」写进一行全局记录,是这类 bug 的通用形状★:
///   界面上它长得像个人设置,数据上它是共享状态。
///   真想要一个「不占忙闲的个人分类」,自建一个就是了 —— 自建行 `owner = 我`,天然只归我。
#[derive(Debug, PartialEq, Eq)]
pub enum TypeScope {
    /// 自建的:改名 / 改忙闲 / 删,都行
    Full,
    /// 预置的(以及别人自建的):一点都不能动
    None,
}

/// ★判据★:只问一句「这一行是不是我自己建的」。
/// 预置行归全系统共用,任何一次修改都是替所有人做决定 —— 那不是用户该有的权力。
/// (`has_minutes` / `needs_project` 曾经参与判定,现在不再需要:预置行一律不可改。)
pub fn scope_of(owner: Option<&str>, me: &str, _has_minutes: bool, _needs_project: bool) -> TypeScope {
    match owner {
        Some(o) if o == me => TypeScope::Full,
        _ => TypeScope::None,   // 别人自建的看不到也动不了;预置的谁都不能动
    }
}

async fn scope_or_err(pool: &sqlx::PgPool, tid: i64, me: &str) -> AppResult<TypeScope> {
    let row: Option<(Option<String>, bool, bool)> = sqlx::query_as(
        "SELECT owner, has_minutes, needs_project FROM activity_types
          WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(tid).fetch_optional(pool).await?;
    let Some((owner, hm, np)) = row else { return Err(AppError::NotFound) };
    match scope_of(owner.as_deref(), me, hm, np) {
        TypeScope::None if owner.is_none() =>
            Err(AppError::BadRequest("这个预置类型不能改，也不能删".into())),
        TypeScope::None => Err(AppError::Forbidden),
        s => Ok(s),
    }
}

/// PUT /api/activity-types/{id} —— 改名 / 改忙闲默认值。
pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(tid): Path<i64>,
    Json(input): Json<TypeIn>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    // 走到这里 scope 只可能是 Full(预置行与别人的行在 scope_or_err 里就被拒了)。
    let _ = scope_or_err(&state.pool, tid, me).await?;
    // ★没传 name 就只改 busy_default★:这正是「占忙闲」那个复选框走的路(A4)。
    let name = match &input.name {
        Some(n) => Some(clean_name(n)?),
        None => None,
    };
    if name.is_none() && input.busy_default.is_none() {
        return Err(AppError::BadRequest("没有要改的字段".into()));
    }
    sqlx::query(
        "UPDATE activity_types SET name = COALESCE($2, name),
                                   busy_default = COALESCE($3, busy_default)
          WHERE id = $1",
    )
    .bind(tid)
    .bind(name)
    .bind(input.busy_default)
    .execute(&state.pool)
    .await
    .map_err(name_taken)?;
    crate::audit::record(&state.pool, me, "atype.update", &tid.to_string(), name.unwrap_or("busy")).await;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/activity-types/{id} —— ★软删★（L1）。
///
/// 硬删不行：`activities.type_id` 是 NOT NULL 外键，删了 = 历史活动失去类型名。
/// 软删之后新建活动挑不到它，历史照常显示。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(tid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    // ★删只对自建的开放★：预置行删了 = 历史活动失去类型名（`type_id` 是 NOT NULL 外键）。
    // scope_or_err 已经把预置行与别人的行拒掉了,这里只剩 Full。
    let _ = scope_or_err(&state.pool, tid, me).await?;
    sqlx::query("UPDATE activity_types SET deleted_at = now() WHERE id = $1")
        .bind(tid)
        .execute(&state.pool)
        .await?;
    crate::audit::record(&state.pool, me, "atype.delete", &tid.to_string(), "").await;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    const 会议: Caps = Caps { has_minutes: true, needs_project: true, busy_default: true, allow_past: false };
    const 个人日程: Caps = Caps { has_minutes: false, needs_project: false, busy_default: false, allow_past: true };

    #[test]
    fn 会议要记录员也要项目() {
        assert!(check_caps(&会议, "bob", &[1]).is_ok());
        assert!(check_caps(&会议, "  ", &[1]).is_err());   // 没记录员
        assert!(check_caps(&会议, "bob", &[]).is_err());   // 没项目
    }

    #[test]
    fn 个人日程两样都不要() {
        // ★这条是类型表存在的理由★：旧代码把「必须有记录员 + 必须关联项目」写死在 create 里，
        // 于是「个人日程」这类活动根本建不出来。
        assert!(check_caps(&个人日程, "", &[]).is_ok());
    }

    // ══════ 补录（F0/F1，2026-08-09 liaoruili：「会议类型的活动只能发起未来的会议，
    //        其他类型可以后面补录」）══════
    fn t(min: i64) -> chrono::DateTime<chrono::Utc> {
        // 用一个固定基准点 + 偏移，别取 now()：测试不该依赖时钟
        chrono::DateTime::from_timestamp(1_800_000_000, 0).unwrap() + chrono::Duration::minutes(min)
    }

    #[test]
    fn 会议只能排未来() {
        assert!(check_past(&会议, t(60), t(0)).is_ok(), "一小时后的会当然可以");
        assert!(check_past(&会议, t(-60), t(0)).is_err(), "★昨天的会不许直接建★");
        // 5 分钟容差：填表要花时间，选了「最近的整点」再慢慢填完议程，提交时那个点可能刚过
        assert!(check_past(&会议, t(-3), t(0)).is_ok(), "容差内不该卡人白填一轮");
        assert!(check_past(&会议, t(-6), t(0)).is_err(), "超出容差就该拒");
    }

    #[test]
    fn 其他类型可以补录() {
        // ★这条是这个能力位存在的理由★：在此之前「不能排过去」是**写死的全局规则**，
        // 于是「昨天下午改论文改了 3 小时」这种正当的补录根本建不出来，
        // 只能先建一条再去改时间绕过去（update 没有这道闸）。
        assert!(check_past(&个人日程, t(-60 * 24 * 30), t(0)).is_ok(), "一个月前也该能补");
    }

    // ══════ 跨度上界（F4，2026-08-08 liaoruili 拍板）══════
    #[test]
    fn 跨度超过三十天就拒() {
        assert!(check_span(t(0), t(60)).is_ok(), "一小时的会");
        assert!(check_span(t(0), t(60 * 24 * 30)).is_ok(), "正好 30 天：出差/年假的真实上限");
        assert!(check_span(t(0), t(60 * 24 * 31)).is_err(), "31 天");
        // ★这条才是它真正要挡的★：输错月份（8-08 打成次年 3-01 ≈ 205 天）——
        // 365 天的上界挡不住它，30 天挡得住。
        assert!(check_span(t(0), t(60 * 24 * 205)).is_err(), "输错月份");
        assert!(check_span(t(60), t(0)).is_err(), "结束早于开始");
        assert!(check_span(t(0), t(0)).is_err(), "零长度");
    }

    #[test]
    fn 实际时长按跨度算上界_不写死一天() {
        // 三天的出差：填 40 小时是合理的，写死 1440 分钟（一天）会把它挡掉
        assert!(check_actual_minutes(40 * 60, t(0), t(60 * 24 * 3)).is_ok());
        // 一小时的会：上界仍留一天的余量（补录时人常常估个整数）
        assert!(check_actual_minutes(90, t(0), t(60)).is_ok());
        assert!(check_actual_minutes(60 * 24 * 5, t(0), t(60)).is_err(), "比跨度长太多");
        assert!(check_actual_minutes(-1, t(0), t(60)).is_err());
    }

    // ══════ 可改范围（原型「我的活动类型」那一页）══════
    #[test]
    fn 预置的会议一点都不能动() {
        // 「会议」有纪要且须关联项目 → 占忙闲固定，末列「不可改」
        assert_eq!(scope_of(None, "alice", true, true), TypeScope::None);
    }

    #[test]
    fn 预置的个人日程也一点都不能动() {
        // ★这条用例的断言 2026-08-15 反过来了★:原来是 `BusyOnly`(照相位 3 的原型,
        //   那一行画的是可勾的复选框)。而 `owner IS NULL` 的行是**全系统共用的一行** ——
        //   甲勾一下,乙丙丁的个人日程一起变成不占忙闲,四个人的界面上什么都不会说。
        //   liaoruili 拍板:预置的不能改;想要不占忙闲的个人分类就自建一个(那才归自己)。
        assert_eq!(scope_of(None, "alice", false, false), TypeScope::None);
    }

    #[test]
    fn 自建的全都能动_别人的一律不能() {
        assert_eq!(scope_of(Some("alice"), "alice", false, false), TypeScope::Full);
        assert_eq!(scope_of(Some("bob"), "alice", false, false), TypeScope::None);
    }

    #[test]
    fn 预置行的可改范围与能力位无关() {
        // 能力位曾经参与这个判定(简单型可改忙闲),现在不再 —— 四种组合一律 None。
        // ⚠ 留着这条是为了钉住「不再看能力位」这件事本身:哪天有人想按能力位再开口子,
        //   会先看到这四行断言,而不是重新发明一遍上面那个 bug。
        for (hm, np) in [(true, true), (true, false), (false, true), (false, false)] {
            assert_eq!(scope_of(None, "alice", hm, np), TypeScope::None);
        }
    }

    #[test]
    fn 能力位是逐条判的_不是一刀切() {
        // 只要纪要不要项目
        let c = Caps { has_minutes: true, needs_project: false, busy_default: true, allow_past: true };
        assert!(check_caps(&c, "bob", &[]).is_ok());
        assert!(check_caps(&c, "", &[]).is_err());
        // 只要项目不要纪要
        let c = Caps { has_minutes: false, needs_project: true, busy_default: false, allow_past: true };
        assert!(check_caps(&c, "", &[7]).is_ok());
        assert!(check_caps(&c, "", &[]).is_err());
    }
}
