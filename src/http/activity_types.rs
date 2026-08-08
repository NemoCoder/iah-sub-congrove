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

#[derive(Serialize, sqlx::FromRow)]
pub struct TypeRow {
    pub id: i64,
    /// NULL = 系统预置。前端据此决定「改/删」按钮给不给。
    pub owner: Option<String>,
    pub name: String,
    pub has_minutes: bool,
    pub needs_project: bool,
    pub busy_default: bool,
}

/// GET /api/activity-types —— 预置的 + 我自建的。★别人自建的看不到★（那是他的分类习惯）。
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<Vec<TypeRow>>> {
    let rows: Vec<TypeRow> = sqlx::query_as(
        "SELECT id, owner, name, has_minutes, needs_project, busy_default
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
    pub name: String,
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
    let name = clean_name(&input.name)?;
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

/// 一行的可改范围。★预置行与自建行不是「能改 / 不能改」两档★ ——
/// 原型（相位 3 已签核）画得很清楚：
///   · 「会议」行：占忙闲显示「✅ 固定」，末列 **不可改**；
///   · 「个人日程」行：占忙闲是**可勾的 checkbox**，末列 **不可删**。
/// ★措辞不同是有意的★：个人日程的 `busy_default` 可以改，只是不能删。
#[derive(Debug, PartialEq, Eq)]
pub enum TypeScope {
    /// 自建的：改名 / 改忙闲 / 删，都行
    Full,
    /// 预置的简单型：★只能改 busy_default★，不能改名、不能删
    BusyOnly,
    /// 预置的全能力型：一点都不能动
    None,
}

/// ★判据（从原型反推，与 O4 的理由一致）★：`has_minutes || needs_project` 的类型，
/// 占忙闲**固定为 true 不可改** —— O4 拍板 `busy_default` 时的原话是
/// 「占忙闲 = **影响别人**，而会议本来就是多人的事」。要出纪要、要挂项目的活动，
/// 按定义就是多人的事，让人把它调成「不占」等于给「我开着会但别人约得到我」开门。
/// 简单型（两位都 false）才可调 —— 自建类型全是简单型，所以它们天然可调。
pub fn scope_of(owner: Option<&str>, me: &str, has_minutes: bool, needs_project: bool) -> TypeScope {
    match owner {
        Some(o) if o == me => TypeScope::Full,
        Some(_) => TypeScope::None,          // 别人自建的：看不到也动不了
        None if has_minutes || needs_project => TypeScope::None,
        None => TypeScope::BusyOnly,
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
    let scope = scope_or_err(&state.pool, tid, me).await?;
    // ★预置的简单型只让改 busy_default★：改名会让所有人的历史活动跟着变名字。
    let name = if scope == TypeScope::Full { Some(clean_name(&input.name)?) } else { None };
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
    // ★删只对自建的开放★：预置行删了 = 历史活动失去类型名（`type_id` 是 NOT NULL 外键）
    if scope_or_err(&state.pool, tid, me).await? != TypeScope::Full {
        return Err(AppError::BadRequest("预置的活动类型不能删".into()));
    }
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
    const 会议: Caps = Caps { has_minutes: true, needs_project: true, busy_default: true };
    const 个人日程: Caps = Caps { has_minutes: false, needs_project: false, busy_default: false };

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

    // ══════ 可改范围（原型「我的活动类型」那一页）══════
    #[test]
    fn 预置的会议一点都不能动() {
        // 「会议」有纪要且须关联项目 → 占忙闲固定，末列「不可改」
        assert_eq!(scope_of(None, "alice", true, true), TypeScope::None);
    }

    #[test]
    fn 预置的个人日程可以改忙闲但不能删() {
        // ★原型措辞不同是有意的★：会议「不可改」，个人日程「不可删」
        assert_eq!(scope_of(None, "alice", false, false), TypeScope::BusyOnly);
    }

    #[test]
    fn 自建的全都能动_别人的一律不能() {
        assert_eq!(scope_of(Some("alice"), "alice", false, false), TypeScope::Full);
        assert_eq!(scope_of(Some("bob"), "alice", false, false), TypeScope::None);
    }

    #[test]
    fn 只要沾一个能力位就固定忙闲() {
        // 判据是 has_minutes || needs_project，不是「两个都要」——
        // 要出纪要的活动即使不挂项目，也是多人的事
        assert_eq!(scope_of(None, "alice", true, false), TypeScope::None);
        assert_eq!(scope_of(None, "alice", false, true), TypeScope::None);
    }

    #[test]
    fn 能力位是逐条判的_不是一刀切() {
        // 只要纪要不要项目
        let c = Caps { has_minutes: true, needs_project: false, busy_default: true };
        assert!(check_caps(&c, "bob", &[]).is_ok());
        assert!(check_caps(&c, "", &[]).is_err());
        // 只要项目不要纪要
        let c = Caps { has_minutes: false, needs_project: true, busy_default: false };
        assert!(check_caps(&c, "", &[7]).is_ok());
        assert!(check_caps(&c, "", &[]).is_err());
    }
}
