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

/// PUT /api/me/prefs —— 改我的偏好（upsert，★整对象替换★）。
///
/// ⚠★为什么不是 COALESCE 部分更新★（2026-08-09 改的）：第一版写成
/// `COALESCE(EXCLUDED.x, user_prefs.x)`，意思是「没传的字段保留」——
/// 听起来贴心，但它让 **null 变得不可表达**：用户在界面上点「清空时区」，
/// 前端送 `{timezone: null}`，后端把它当成「这次没传」→ 旧值原样留着。
/// ★点了没反应、也不报错★，正是最难查的那种。
/// 这个对象只有两个字段，整体替换语义清楚：**传什么就是什么**。
/// （要保留部分更新的话，得用 `Option<Option<T>>` 区分「缺字段」与「显式 null」，
///  为两个字段引入那套机制不值当。）
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
            SET timezone = EXCLUDED.timezone,
                default_remind_minutes = EXCLUDED.default_remind_minutes",
    )
    .bind(me).bind(input.timezone.as_deref()).bind(input.default_remind_minutes)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// 超管模式开关时长 —— ★2 小时★（2026-08-09 liaoruili 拍板）。
///
/// 参照 GitLab Admin Mode（6h）与 GitHub sudo mode（2h）。取 2h 的理由：
/// 这里的超管活儿（调配额、看审计、收拾无主项目）都是几分钟的事，
/// ★开着的每一分钟都在放大「误看别人东西」的窗口★，短一点更贴合它存在的目的。
const ADMIN_MODE_HOURS: i64 = 2;

#[derive(Deserialize)]
pub struct AdminModeIn { pub on: bool }

/// POST /api/me/admin-mode —— 进入 / 退出超管模式（docs/TECH-DESIGN-admin-mode.md）。
///
/// ★2026-08-09 liaoruili：「我自己也要使用这个系统，但我默认能看到所有人的内容，
/// 这对日常使用带来困扰」★。照 GitLab Admin Mode 那套：**超管平时就是普通用户**，
/// 要用特权得刻意开一下，2 小时自动关，退出登录也关。
///
/// ⚠★判据是「资格」不是「特权」★：这里必须查 `app_user.is_super` 那一列，
/// **不能**走 `is_super_now`／`super_now` —— 后者在模式关着时返回 false，
/// 于是「关掉之后就再也开不回来」。这是本次改动里唯一一处**故意**不用视图的判权。
///
/// 不要求重新认证（GitLab 要）：这里的威胁模型是「我不想天天看见别人的东西」，
/// 不是「会话被盗」；为一个日常开关往 Keycloak 绕一圈不划算。要加是独立一步。
pub async fn set_admin_mode(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<AdminModeIn>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    let capable: bool = sqlx::query_scalar("SELECT is_super FROM app_user WHERE username = $1")
        .bind(me).fetch_optional(&state.pool).await?.unwrap_or(false);
    if !capable { return Err(crate::error::AppError::Forbidden) }
    let until: Option<chrono::DateTime<chrono::Utc>> = input.on
        .then(|| chrono::Utc::now() + chrono::Duration::hours(ADMIN_MODE_HOURS));
    sqlx::query("UPDATE app_user SET admin_mode_until = $2 WHERE username = $1")
        .bind(me).bind(until).execute(&state.pool).await?;
    // ★两个方向都留痕★：这是这个功能白赚的好处 —— 在此之前「超管读了什么」一点痕迹都没有，
    // 现在「想用特权就必然留下一条记录」（与 PRD §J1c 影子账户同一个思路）。
    crate::audit::record(&state.pool, me,
        if input.on { "admin_mode.enter" } else { "admin_mode.exit" }, me,
        &if input.on { format!("超管模式开启，{ADMIN_MODE_HOURS} 小时后自动关闭") } else { "超管模式关闭".to_string() }).await;
    Ok(Json(json!({ "admin_mode": input.on, "until": until })))
}
