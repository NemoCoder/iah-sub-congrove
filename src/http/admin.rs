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

/// GET /api/users?q=… —— 选人下拉的数据源(**不在** admin 闸内,任何登录用户可用)。
///
/// ★两条口径,合起来才是「能选到人,但看不到名册」★
/// (2026-08-15 对抗检查提出,liaoruili 拍板:「只能通过完整账号搜索,
///  然后同一个项目的人是可以直接列举出来的 —— 你可以看到所有项目里面的人,
///  但是你看不到整个系统的人」):
///
///   ① **陌生人:只认完整账号**。`username = q`,一个字都不能少。
///      这是一个 **oracle**(问「有没有这个人」),不是 **dump**(要「有哪些人」)——
///      前者是拉人所必需的,后者就是目录枚举。
///   ② **同项目的人:随便搜,前缀就行**。你们已经在同一个项目里共事,
///      他的名字对你本来就不是秘密(成员页上就列着)。
///
/// ⚠★为什么把前缀搜索砍掉★:此前是「username 或 name 前缀 ILIKE,回 20 条」。
///   `q=a` 就能拿到 20 个人,`q=b` 再 20 个 —— 敲 26 个字母基本就把全所名册抄走了,
///   带真名。★限 20 条限的是**每次**的量,不是**总共**能拿到的量★,
///   而枚举攻击从来不介意多打几次请求。这与平台「不做用户 list/search 接口」
///   (2026-08-07 liaoruili 拍板)是同一条线。
///
/// 仍不回邮箱。口径仍是「登录过汇流的人」(平台名录真相在 Keycloak,拉人时 users/exists 兜底)。
pub async fn user_options(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<UserQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let 输入 = q.q.unwrap_or_default().trim().to_string();
    if 输入.is_empty() {
        return Ok(Json(vec![]));
    }
    let me = id.require_username()?;
    let like = format!("{}%", 输入.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT u.username, u.name FROM app_user u
          WHERE
            -- ① 完整账号精确命中:问得出「有没有这个人」,问不出「有哪些人」
            u.username = $1
            -- ② 与我共过项目的人:名字对我本来就不是秘密,允许前缀搜
            OR ((u.username ILIKE $2 ESCAPE '\\' OR u.name ILIKE $2 ESCAPE '\\')
                AND EXISTS (SELECT 1 FROM project_members 我 JOIN project_members 他
                                     ON 他.project_id = 我.project_id
                                  WHERE 我.username = $3 AND 他.username = u.username))
          ORDER BY u.username -- limit-ok: 输入即搜的候选 —— typeahead 取前 20 个,人再敲一个字就换一批;
              --   ★它不是「用户列表」★:平台明令不做用户 list/search(会变成目录枚举)。
              LIMIT 20",
    )
    .bind(&输入)
    .bind(&like)
    .bind(me)
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
