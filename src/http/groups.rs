//! 小组 CRUD + 成员管理。自助模式(决策 B 的落点):任何人可建组,建者自动 manager;
//! manager 可增删本组成员、改组信息、解散组。成员 username 不要求已登录过——
//! 平台用户首次登录 congrove 前就能被拉进组,登录后授权即刻生效(组授权按 username 匹配)。

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::audit;
use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 组内管理权:超管 || 组 manager。(组的 manager 和空间的 admin 是两套独立体系,别混。)
async fn require_manager(pool: &PgPool, id: &Identity, gid: i64) -> AppResult<()> {
    if id.is_super {
        return Ok(());
    }
    let username = id.require_username()?;
    let is_mgr: Option<String> =
        sqlx::query_scalar("SELECT role FROM group_members WHERE group_id = $1 AND username = $2")
            .bind(gid)
            .bind(username)
            .fetch_optional(pool)
            .await?;
    match is_mgr.as_deref() {
        Some("manager") => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct GroupRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub created_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub member_count: i64,
    pub my_role: Option<String>,
}

/// GET /api/groups —— 我所在的组;超管见全部(便于治理)。
pub async fn list(State(state): State<AppState>, Extension(id): Extension<Identity>) -> AppResult<Json<Vec<GroupRow>>> {
    let username = id.require_username()?;
    let rows: Vec<GroupRow> = if id.is_super {
        sqlx::query_as(
            "SELECT g.id, g.name, g.description, g.created_by, g.created_at,
                    (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) member_count,
                    (SELECT role FROM group_members m WHERE m.group_id = g.id AND m.username = $1) my_role
               FROM groups g ORDER BY g.id",
        )
        .bind(username)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT g.id, g.name, g.description, g.created_by, g.created_at,
                    (SELECT count(*) FROM group_members m2 WHERE m2.group_id = g.id) member_count,
                    m.role my_role
               FROM groups g JOIN group_members m ON m.group_id = g.id AND m.username = $1
              ORDER BY g.id",
        )
        .bind(username)
        .fetch_all(&state.pool)
        .await?
    };
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct GroupIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// POST /api/groups —— 建组,建者自动 manager。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<GroupIn>,
) -> AppResult<Json<serde_json::Value>> {
    let username = id.require_username()?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("组名不能为空".into()));
    }
    let mut tx = state.pool.begin().await?;
    let gid: i64 = sqlx::query_scalar("INSERT INTO groups (name, description, created_by) VALUES ($1,$2,$3) RETURNING id")
        .bind(name)
        .bind(&input.description)
        .bind(username)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO group_members (group_id, username, role, added_by) VALUES ($1,$2,'manager',$2)")
        .bind(gid)
        .bind(username)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit::record(&state.pool, username, "group.create", &gid.to_string(), name).await;
    Ok(Json(json!({ "id": gid })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MemberRow {
    pub username: String,
    pub role: String,
    pub added_by: String,
    pub added_at: chrono::DateTime<chrono::Utc>,
    /// 登录过的成员带显示名,没登录过为 NULL(拉人先于登录是合法状态)。
    pub name: Option<String>,
}

/// GET /api/groups/{id}/members —— 成员列表(本组成员或超管可见)。
pub async fn members(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(gid): Path<i64>,
) -> AppResult<Json<Vec<MemberRow>>> {
    if !id.is_super {
        let username = id.require_username()?;
        let in_group: Option<String> =
            sqlx::query_scalar("SELECT role FROM group_members WHERE group_id = $1 AND username = $2")
                .bind(gid)
                .bind(username)
                .fetch_optional(&state.pool)
                .await?;
        if in_group.is_none() {
            return Err(AppError::Forbidden);
        }
    }
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT m.username, m.role, m.added_by, m.added_at, u.name
           FROM group_members m LEFT JOIN app_user u ON u.username = m.username
          WHERE m.group_id = $1 ORDER BY m.role DESC, m.username",
    )
    .bind(gid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct MemberIn {
    pub username: String,
    #[serde(default = "default_member")]
    pub role: String,
}
fn default_member() -> String {
    "member".into()
}

/// POST /api/groups/{id}/members —— 拉人/改角色(manager,upsert)。
pub async fn member_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(gid): Path<i64>,
    Json(m): Json<MemberIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_manager(&state.pool, &id, gid).await?;
    let uname = m.username.trim();
    if uname.is_empty() || !uname.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(AppError::BadRequest("用户名只能是 ASCII 字母数字 . - _".into()));
    }
    // 平台注册用户校验(users/exists,AI_Talks 0094):真相源 Keycloak,可拉还没登录过汇流的人。
    // registry 不可达(本地 dev / 平台抖动)降级到本地 app_user(fail-closed,只是范围收窄)。
    crate::http::spaces::ensure_platform_user(&state, uname).await?;
    if m.role != "member" && m.role != "manager" {
        return Err(AppError::BadRequest("role 必须是 member 或 manager".into()));
    }
    let actor = id.require_username()?;
    sqlx::query(
        "INSERT INTO group_members (group_id, username, role, added_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (group_id, username) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(gid)
    .bind(uname)
    .bind(&m.role)
    .bind(actor)
    .execute(&state.pool)
    .await?;
    audit::record(&state.pool, actor, "group.member", &gid.to_string(), &format!("{} -> {}", uname, m.role)).await;
    // 站内信告知对方(0094 附赠;best-effort,ref 幂等:改角色重拉不刷屏)。
    if let Some(reg) = state.registry.clone() {
        let gname: String = sqlx::query_scalar("SELECT name FROM groups WHERE id = $1").bind(gid).fetch_one(&state.pool).await?;
        let (rcpt, actor_s, role_s) = (uname.to_string(), actor.to_string(), m.role.clone());
        let url = state.config.public_url.clone();
        tokio::spawn(async move {
            reg.notify(
                &rcpt,
                &format!("汇流:你已被加入小组「{gname}」"),
                &format!("{actor_s} 把你加入了小组「{gname}」(角色 {role_s})。该组被授权的空间你现在都能访问了。"),
                url.as_deref(),
                Some(&format!("group-{gid}-{rcpt}")),
            )
            .await;
        });
    }
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/groups/{id}/members/{username} —— 移出成员(manager),或自己退组。
/// 防锁死:最后一个 manager 不能被移/退——组会变成没人能管。
pub async fn member_delete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path((gid, uname)): Path<(i64, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let actor = id.require_username()?.to_string();
    if actor != uname {
        require_manager(&state.pool, &id, gid).await?;
    }
    let victim_role: Option<String> =
        sqlx::query_scalar("SELECT role FROM group_members WHERE group_id = $1 AND username = $2")
            .bind(gid)
            .bind(&uname)
            .fetch_optional(&state.pool)
            .await?;
    if victim_role.is_none() {
        return Err(AppError::NotFound);
    }
    if victim_role.as_deref() == Some("manager") {
        let mgrs: i64 = sqlx::query_scalar("SELECT count(*) FROM group_members WHERE group_id = $1 AND role = 'manager'")
            .bind(gid)
            .fetch_one(&state.pool)
            .await?;
        if mgrs <= 1 {
            return Err(AppError::BadRequest("不能移出最后一个 manager".into()));
        }
    }
    sqlx::query("DELETE FROM group_members WHERE group_id = $1 AND username = $2")
        .bind(gid)
        .bind(&uname)
        .execute(&state.pool)
        .await?;
    audit::record(&state.pool, &actor, "group.member.remove", &gid.to_string(), &uname).await;
    Ok(Json(json!({ "ok": true })))
}

/// PUT /api/groups/{id} —— 改组信息(manager)。
pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(gid): Path<i64>,
    Json(input): Json<GroupIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_manager(&state.pool, &id, gid).await?;
    let n = sqlx::query("UPDATE groups SET name = $1, description = $2 WHERE id = $3")
        .bind(input.name.trim())
        .bind(&input.description)
        .bind(gid)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/groups/{id} —— 解散组(manager)。组的 space_grants 行不级联(grantee_id 是文本),
/// 显式清掉,否则残留的「幽灵组授权」永远匹配不上又删不掉。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(gid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    require_manager(&state.pool, &id, gid).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM space_grants WHERE grantee_type = 'group' AND grantee_id = $1")
        .bind(gid.to_string())
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query("DELETE FROM groups WHERE id = $1").bind(gid).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(&state.pool, id.require_username()?, "group.delete", &gid.to_string(), "").await;
    Ok(Json(json!({ "ok": true })))
}
