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

/// 取一行并判「这是不是我能改的」。★预置行谁都不能改★ —— 包括超管：
/// 它们是全平台活动的语义底座，改一下所有人的历史活动跟着变意思。
async fn mine_or_403(pool: &sqlx::PgPool, tid: i64, me: &str) -> AppResult<()> {
    let owner: Option<Option<String>> =
        sqlx::query_scalar("SELECT owner FROM activity_types WHERE id = $1 AND deleted_at IS NULL")
            .bind(tid)
            .fetch_optional(pool)
            .await?;
    match owner {
        None => Err(AppError::NotFound),
        // ★预置行（owner IS NULL）不可改不可删★
        Some(None) => Err(AppError::BadRequest("预置的活动类型不能改，也不能删".into())),
        Some(Some(o)) if o == me => Ok(()),
        Some(Some(_)) => Err(AppError::Forbidden),
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
    mine_or_403(&state.pool, tid, me).await?;
    let name = clean_name(&input.name)?;
    sqlx::query(
        "UPDATE activity_types SET name = $2, busy_default = COALESCE($3, busy_default)
          WHERE id = $1",
    )
    .bind(tid)
    .bind(name)
    .bind(input.busy_default)
    .execute(&state.pool)
    .await
    .map_err(name_taken)?;
    crate::audit::record(&state.pool, me, "atype.update", &tid.to_string(), name).await;
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
    mine_or_403(&state.pool, tid, me).await?;
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
