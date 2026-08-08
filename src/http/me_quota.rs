//! 「我的」配额与偏好（ADR-0004）。★两张表分开，因为写权限不同★：
//! 偏好用户自己改，配额只有超管能改（`admin::set_quota`）。
use axum::extract::State;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use crate::auth::Identity;
use crate::error::AppResult;
use crate::state::AppState;

/// GET /api/me/quota —— 我的额度与已用量。
///
/// ★用量算的是「我名下所有项目」★（我是 owner 的那些），不是「我上传的东西」——
/// 材料归项目，额度归主持人（PRD L3，口径改过一次）。
pub async fn get_quota(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    let (quota, used) = crate::http::items::owner_quota_used(&state.pool, me).await?;
    Ok(Json(json!({ "quota_bytes": quota, "used_bytes": used })))
}

/// GET /api/me/prefs —— 我的偏好。★没有行就回 null，不回默认值★
/// （PRD E0「不设默认北京」：服务端不猜时区，由前端按浏览器时区显示）。
pub async fn get_prefs(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT timezone, default_remind_minutes FROM user_prefs WHERE username = $1",
    )
    .bind(id.require_username()?)
    .fetch_optional(&state.pool)
    .await?;
    let (tz, remind) = row.unwrap_or((None, None));
    Ok(Json(json!({ "timezone": tz, "default_remind_minutes": remind })))
}

#[derive(Deserialize)]
pub struct PrefsIn {
    #[serde(default)] pub timezone: Option<String>,
    #[serde(default)] pub default_remind_minutes: Option<i32>,
}

/// PUT /api/me/prefs —— 改我的偏好（upsert）。
pub async fn put_prefs(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<PrefsIn>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    // ⚠ 用 COALESCE 保留没传的字段：PUT 半个对象不该把另一半清空。
    sqlx::query(
        "INSERT INTO user_prefs (username, timezone, default_remind_minutes) VALUES ($1,$2,$3)
         ON CONFLICT (username) DO UPDATE
            SET timezone = COALESCE(EXCLUDED.timezone, user_prefs.timezone),
                default_remind_minutes = COALESCE(EXCLUDED.default_remind_minutes,
                                                  user_prefs.default_remind_minutes)",
    )
    .bind(me).bind(input.timezone.as_deref()).bind(input.default_remind_minutes)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}
