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
pub struct UserQuery {
    /// 前缀(用户名或显示名)。**必填**,见下。
    pub q: Option<String>,
}

/// GET /api/users?q=前缀 —— 选人下拉的数据源(**不在** admin 闸内,任何登录用户可用)。
/// ★2026-08-04 审计收紧★:原来不带参数就吐全表 = 任何登录用户可枚举全所名单
/// (username + 真名),这是没必要的暴露面。现在**必须带 q 前缀**、只回 20 条、且要求 ≥1 字符;
/// 不带 q 回空数组(前端下拉在用户开始输入后才有候选)。仍不回邮箱。
/// 口径仍是「登录过汇流的人」(平台名录真相在 Keycloak,拉人时由 users/exists 兜底校验)。
pub async fn user_options(
    State(state): State<AppState>,
    Query(q): Query<UserQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let prefix = q.q.unwrap_or_default().trim().to_string();
    if prefix.is_empty() {
        return Ok(Json(vec![]));
    }
    let like = format!("{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT username, name FROM app_user
          WHERE username ILIKE $1 ESCAPE '\\' OR name ILIKE $1 ESCAPE '\\'
          ORDER BY username -- limit-ok: 输入即搜的候选 —— typeahead 取前 20 个,人再敲一个字就换一批;
              --   ★它不是「用户列表」★:平台明令不做用户 list/search(会变成目录枚举)。
              LIMIT 20",
    )
    .bind(&like)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(|(u, n)| serde_json::json!({ "username": u, "name": n })).collect()))
}

#[derive(Deserialize)]
pub struct QuotaIn {
    pub quota_bytes: i64,
}

/// PUT /api/admin/users/{username}/quota —— ★调**某个人**的配额★（ADR-0004，超管专属）。
///
/// 从「按项目」改成「按人」：额度是给人的资源，挂在项目上意味着建一个新项目就白得 10GiB。
/// ★upsert★：没有行 = 用系统默认（不是 0），所以第一次调额度要插行。
pub async fn set_quota(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(username): Path<String>,
    Json(input): Json<QuotaIn>,
) -> AppResult<Json<serde_json::Value>> {
    if input.quota_bytes < 0 {
        return Err(AppError::BadRequest("配额不能为负".into()));
    }
    let who = username.trim();
    if who.is_empty() {
        return Err(AppError::BadRequest("用户名不能为空".into()));
    }
    let actor = id.require_username()?;
    sqlx::query(
        "INSERT INTO user_quota (username, quota_bytes, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (username) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes,
                                              updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(who).bind(input.quota_bytes).bind(actor)
    .execute(&state.pool)
    .await?;
    audit::record(&state.pool, actor, "admin.quota", who, &input.quota_bytes.to_string()).await;
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
