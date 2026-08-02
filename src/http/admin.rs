//! 超管面:用户列表 / 提拔·撤销超管 / 全局审计查询。整层挂 require_super(mod.rs)。

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::audit;
use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub username: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_super: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_login: Option<chrono::DateTime<chrono::Utc>>,
}

/// GET /api/admin/users —— 登录过的全部用户。
pub async fn users(State(state): State<AppState>) -> AppResult<Json<Vec<UserRow>>> {
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT username, name, email, is_super, created_at, last_login FROM app_user ORDER BY username",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct SuperIn {
    pub is_super: bool,
}

/// PUT /api/admin/users/{username}/super —— 提拔/撤销超管。
/// 防锁死:不能撤掉最后一个超管;白名单用户(env 种子)由登录逻辑重新置回,撤了也会复活——UI 提示即可。
pub async fn set_super(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(username): Path<String>,
    Json(input): Json<SuperIn>,
) -> AppResult<Json<serde_json::Value>> {
    if !input.is_super {
        let supers: i64 = sqlx::query_scalar("SELECT count(*) FROM app_user WHERE is_super").fetch_one(&state.pool).await?;
        let victim: Option<bool> = sqlx::query_scalar("SELECT is_super FROM app_user WHERE username = $1")
            .bind(&username)
            .fetch_optional(&state.pool)
            .await?;
        if victim == Some(true) && supers <= 1 {
            return Err(AppError::BadRequest("不能撤掉最后一个超管".into()));
        }
    }
    let n = sqlx::query("UPDATE app_user SET is_super = $1 WHERE username = $2")
        .bind(input.is_super)
        .bind(&username)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(&state.pool, id.require_username()?, "admin.super", &username,
        if input.is_super { "grant" } else { "revoke" }).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditRow {
    pub id: i64,
    pub ts: chrono::DateTime<chrono::Utc>,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub detail: String,
}

/// GET /api/admin/audit —— 全局审计(最近 N 条,默认 200 封顶 2000)。
pub async fn audit_list(State(state): State<AppState>, Query(q): Query<AuditQuery>) -> AppResult<Json<Vec<AuditRow>>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 2000);
    let rows: Vec<AuditRow> =
        sqlx::query_as("SELECT id, ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT $1")
            .bind(limit)
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(rows))
}
