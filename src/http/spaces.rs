//! 空间 CRUD + 授权管理(space_grants)。判权全走 perm.rs,handler 里不重写角色逻辑。
//! 谁能建空间:任何登录用户(Confluence 模式),建者自动落一条 user→admin 授权。

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::{audit, perm::require_role};

#[derive(Serialize, sqlx::FromRow)]
pub struct SpaceRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub created_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub quota_bytes: i64,
    pub viewer_no_download: bool,
    /// 我的有效角色(列表接口顺带回,前端显隐编辑入口用;真判权仍在每个写接口)。
    #[sqlx(skip)]
    pub my_role: Option<Role>,
    /// 已用字节(单独聚合查询回填,见 usage_map)。
    #[sqlx(skip)]
    pub used_bytes: i64,
}

/// 校验 username 是平台注册用户(groups/grants 共用):
/// 首选平台 users/exists(真相源 Keycloak,可拉/授权还没登录过汇流的人;AI_Talks 0094);
/// registry 不可达(本地 dev / 平台抖动)**降级**到本地 app_user——fail-closed,只是范围收窄。
pub async fn ensure_platform_user(state: &AppState, username: &str) -> AppResult<()> {
    if let Some(reg) = &state.registry {
        match reg.user_exists(username).await {
            Ok((true, name)) => {
                // 顺手把显示名占位进 app_user(还没登录过的人下拉里也能显示人名;登录后 upsert 会补全)。
                let _ = sqlx::query(
                    "INSERT INTO app_user (username, name) VALUES ($1,$2)
                     ON CONFLICT (username) DO UPDATE SET name = COALESCE(app_user.name, EXCLUDED.name)",
                )
                .bind(username)
                .bind(&name)
                .execute(&state.pool)
                .await;
                return Ok(());
            }
            Ok((false, _)) => return Err(AppError::BadRequest("平台没有这个用户名(以 hub 登录名为准)".into())),
            Err(e) => tracing::warn!(error = %e, "users/exists 不可达,降级本地校验"),
        }
    }
    let known: Option<String> = sqlx::query_scalar("SELECT username FROM app_user WHERE username = $1")
        .bind(username)
        .fetch_optional(&state.pool)
        .await?;
    if known.is_none() {
        return Err(AppError::BadRequest("平台校验暂不可用,且该用户没登录过汇流——稍后再试".into()));
    }
    Ok(())
}

/// 全部空间的已用量一把查(items ∪ item_versions 按 (s3_key,size) 去重)。
async fn usage_map(pool: &sqlx::PgPool) -> AppResult<std::collections::HashMap<i64, i64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT sid, COALESCE(sum(sz),0)::bigint FROM (
           SELECT DISTINCT i.space_id sid, i.s3_key k, i.size sz FROM items i WHERE i.s3_key IS NOT NULL
           UNION SELECT DISTINCT i.space_id, v.s3_key, v.size FROM item_versions v JOIN items i ON i.id = v.item_id
         ) t GROUP BY sid",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// GET /api/spaces —— 我可见的空间(有效角色非空);超管见全部。
pub async fn list(State(state): State<AppState>, Extension(id): Extension<Identity>) -> AppResult<Json<Vec<SpaceRow>>> {
    let usage = usage_map(&state.pool).await?;
    if id.is_super {
        let mut rows: Vec<SpaceRow> =
            sqlx::query_as("SELECT id, name, description, created_by, created_at, quota_bytes, viewer_no_download FROM spaces ORDER BY id")
                .fetch_all(&state.pool)
                .await?;
        rows.iter_mut().for_each(|r| {
            r.my_role = Some(Role::Admin);
            r.used_bytes = usage.get(&r.id).copied().unwrap_or(0);
        });
        return Ok(Json(rows));
    }
    let username = id.require_username()?;
    // 拉「我的全部授权 × 空间」一把出,内存里按空间合并取 max(空间量级小,不值得进 SQL 排序)。
    let rows: Vec<(i64, String, String, String, chrono::DateTime<chrono::Utc>, i64, bool, String)> = sqlx::query_as(
        "SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.quota_bytes, s.viewer_no_download, g.role
           FROM spaces s JOIN space_grants g ON g.space_id = s.id
          WHERE (g.grantee_type = 'user' AND g.grantee_id = $1)
             OR (g.grantee_type = 'group' AND g.grantee_id IN
                   (SELECT group_id::text FROM group_members WHERE username = $1))
          ORDER BY s.id",
    )
    .bind(username)
    .fetch_all(&state.pool)
    .await?;
    let mut out: Vec<SpaceRow> = Vec::new();
    for (sid, name, description, created_by, created_at, quota_bytes, viewer_no_download, role) in rows {
        let r = Role::parse(&role);
        match out.last_mut() {
            Some(last) if last.id == sid => last.my_role = perm::merge([last.my_role, r]),
            _ => out.push(SpaceRow {
                id: sid, name, description, created_by, created_at, quota_bytes, viewer_no_download,
                my_role: r, used_bytes: usage.get(&sid).copied().unwrap_or(0),
            }),
        }
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct SpaceIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// D4 开关(docs/PERMISSIONS.md):Some 才更新;只拦 download 原件,阅读/播放不拦(见迁移 0003 头注)。
    #[serde(default)]
    pub viewer_no_download: Option<bool>,
}

/// POST /api/spaces —— 建空间,建者自动 admin。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<SpaceIn>,
) -> AppResult<Json<serde_json::Value>> {
    let username = id.require_username()?;
    // D2 决策(docs/PERMISSIONS.md):CONGROVE_SPACE_CREATORS 非空时仅名单内 + 超管可建。
    let creators = &state.config.space_creators;
    if !creators.is_empty() && !id.is_super && !creators.iter().any(|u| u == username) {
        return Err(AppError::Forbidden);
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("空间名不能为空".into()));
    }
    let mut tx = state.pool.begin().await?;
    let sid: i64 = sqlx::query_scalar("INSERT INTO spaces (name, description, created_by) VALUES ($1,$2,$3) RETURNING id")
        .bind(name)
        .bind(&input.description)
        .bind(username)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO space_grants (space_id, grantee_type, grantee_id, role, granted_by) VALUES ($1,'user',$2,'admin',$2)")
        .bind(sid)
        .bind(username)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit::record(&state.pool, username, "space.create", &sid.to_string(), name).await;
    Ok(Json(json!({ "id": sid })))
}

/// GET /api/spaces/{id} —— 详情(≥viewer)。
pub async fn detail(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let role = require_role(&state.pool, &id, sid, Role::Viewer).await?;
    let row: Option<(String, String, String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT name, description, created_by, created_at FROM spaces WHERE id = $1")
            .bind(sid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((name, description, created_by, created_at)) = row else { return Err(AppError::NotFound) };
    Ok(Json(json!({
        "id": sid, "name": name, "description": description,
        "created_by": created_by, "created_at": created_at, "my_role": role,
    })))
}

/// PUT /api/spaces/{id} —— 改名/描述(admin)。
pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    Json(input): Json<SpaceIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Admin).await?;
    let n = sqlx::query("UPDATE spaces SET name = $1, description = $2, viewer_no_download = COALESCE($3, viewer_no_download) WHERE id = $4")
        .bind(input.name.trim())
        .bind(&input.description)
        .bind(input.viewer_no_download)
        .bind(sid)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(&state.pool, id.require_username()?, "space.update", &sid.to_string(), input.name.trim()).await;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/spaces/{id} —— 删空间(admin)。DB 行级联删(FK CASCADE);
/// S3 对象按 items+versions 收集 key 逐个删——key 带 space_id 前缀,不会误伤别的空间。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Admin).await?;
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT k FROM (
           SELECT s3_key k FROM items WHERE space_id = $1 AND s3_key IS NOT NULL
           UNION SELECT v.s3_key FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.space_id = $1
         ) t",
    )
    .bind(sid)
    .fetch_all(&state.pool)
    .await?;
    let n = sqlx::query("DELETE FROM spaces WHERE id = $1").bind(sid).execute(&state.pool).await?.rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    // DB 先删(权限即刻收回),对象后清;清失败只 warn——孤儿对象可由 P3 的空间容量巡检兜底。
    for k in &keys {
        if let Err(e) = state.storage.delete(k).await {
            tracing::warn!(error = %e, key = %k, "space delete: s3 cleanup failed");
        }
    }
    audit::record(&state.pool, id.require_username()?, "space.delete", &sid.to_string(), &format!("objects={}", keys.len())).await;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/spaces/{id}/diagnose?username=X(admin)—— 权限诊断:「为什么他能/不能看」。
/// 三家共同痛点、Confluence 的付费卖点,我们内建(docs/PERMISSIONS.md 共识 6)。
/// 输出完整判定链:超管? / 直接授权? / 经哪些组授了什么? / 最终有效角色(与 perm.rs 同一推导)。
pub async fn diagnose(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Admin).await?;
    let username = q.get("username").map(|s| s.trim()).filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("缺 username 参数".into()))?;
    let is_super: bool = sqlx::query_scalar("SELECT is_super FROM app_user WHERE username = $1")
        .bind(username)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(false);
    let direct: Option<String> = sqlx::query_scalar(
        "SELECT role FROM space_grants WHERE space_id = $1 AND grantee_type = 'user' AND grantee_id = $2",
    )
    .bind(sid)
    .bind(username)
    .fetch_optional(&state.pool)
    .await?;
    let via_groups: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT gr.id, gr.name, g.role FROM space_grants g
           JOIN group_members m ON g.grantee_type = 'group' AND g.grantee_id = m.group_id::text AND m.username = $2
           JOIN groups gr ON gr.id = m.group_id
          WHERE g.space_id = $1",
    )
    .bind(sid)
    .bind(username)
    .fetch_all(&state.pool)
    .await?;
    // 有效角色与 perm.rs 同一合并规则(超管短路 admin;否则 direct ∪ groups 取 max)。
    let effective = if is_super {
        Some(Role::Admin)
    } else {
        perm::merge(
            std::iter::once(direct.as_deref().and_then(Role::parse))
                .chain(via_groups.iter().map(|(_, _, r)| Role::parse(r))),
        )
    };
    Ok(Json(json!({
        "username": username,
        "is_super": is_super,
        "direct": direct,
        "via_groups": via_groups.iter().map(|(gid, name, role)| json!({"group_id": gid, "group": name, "role": role})).collect::<Vec<_>>(),
        "effective": effective,
    })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct GrantRow {
    pub grantee_type: String,
    pub grantee_id: String,
    pub role: String,
    pub granted_by: String,
    pub granted_at: chrono::DateTime<chrono::Utc>,
    /// 组授权顺带带组名,前端别再拉一次。
    pub grantee_name: Option<String>,
}

/// GET /api/spaces/{id}/grants —— 授权列表(admin)。
pub async fn grants(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
) -> AppResult<Json<Vec<GrantRow>>> {
    require_role(&state.pool, &id, sid, Role::Admin).await?;
    let rows: Vec<GrantRow> = sqlx::query_as(
        "SELECT g.grantee_type, g.grantee_id, g.role, g.granted_by, g.granted_at,
                CASE WHEN g.grantee_type = 'group' THEN gr.name ELSE g.grantee_id END AS grantee_name
           FROM space_grants g
           LEFT JOIN groups gr ON g.grantee_type = 'group' AND gr.id::text = g.grantee_id
          WHERE g.space_id = $1 ORDER BY g.grantee_type, g.grantee_id",
    )
    .bind(sid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct GrantIn {
    pub grantee_type: String, // 'user' | 'group'
    pub grantee_id: String,
    pub role: Role,
}

/// PUT /api/spaces/{id}/grants —— 加/改一条授权(admin,upsert)。
pub async fn grant_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    Json(g): Json<GrantIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Admin).await?;
    if g.grantee_type != "user" && g.grantee_type != "group" {
        return Err(AppError::BadRequest("grantee_type 必须是 user 或 group".into()));
    }
    if g.grantee_type == "group" {
        let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM groups WHERE id::text = $1")
            .bind(&g.grantee_id)
            .fetch_optional(&state.pool)
            .await?;
        if exists.is_none() {
            return Err(AppError::BadRequest("组不存在".into()));
        }
    } else {
        // 平台注册用户校验(users/exists,AI_Talks 0094);registry 不可达降级本地 app_user。
        ensure_platform_user(&state, &g.grantee_id).await?;
    }
    // 防锁死(0.3.3):把「最后一个 admin 授权」降级,和撤销同款闸——空间从此没人能管。
    if g.role != Role::Admin {
        let cur: Option<String> = sqlx::query_scalar(
            "SELECT role FROM space_grants WHERE space_id = $1 AND grantee_type = $2 AND grantee_id = $3",
        )
        .bind(sid)
        .bind(&g.grantee_type)
        .bind(&g.grantee_id)
        .fetch_optional(&state.pool)
        .await?;
        if cur.as_deref() == Some("admin") {
            let admins: i64 =
                sqlx::query_scalar("SELECT count(*) FROM space_grants WHERE space_id = $1 AND role = 'admin'")
                    .bind(sid)
                    .fetch_one(&state.pool)
                    .await?;
            if admins <= 1 {
                return Err(AppError::BadRequest("不能把最后一个 admin 授权降级".into()));
            }
        }
    }
    let actor = id.require_username()?;
    sqlx::query(
        "INSERT INTO space_grants (space_id, grantee_type, grantee_id, role, granted_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (space_id, grantee_type, grantee_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = now()",
    )
    .bind(sid)
    .bind(&g.grantee_type)
    .bind(&g.grantee_id)
    .bind(g.role.as_str())
    .bind(actor)
    .execute(&state.pool)
    .await?;
    audit::record(&state.pool, actor, "space.grant", &sid.to_string(),
        &format!("{}:{} -> {}", g.grantee_type, g.grantee_id, g.role.as_str())).await;
    // 按用户授权时站内信告知(0094;组授权不逐人打扰,组成员由组内通知覆盖)。
    if g.grantee_type == "user" {
        if let Some(reg) = state.registry.clone() {
            let sname: String = sqlx::query_scalar("SELECT name FROM spaces WHERE id = $1").bind(sid).fetch_one(&state.pool).await?;
            let (rcpt, actor_s, role_s) = (g.grantee_id.clone(), actor.to_string(), g.role.as_str().to_string());
            let url = state.config.public_url.clone();
            tokio::spawn(async move {
                reg.notify(
                    &rcpt,
                    &format!("汇流:你获得了空间「{sname}」的 {role_s} 权限"),
                    &format!("{actor_s} 给了你空间「{sname}」的 {role_s} 权限。"),
                    url.as_deref(),
                    Some(&format!("grant-{sid}-{rcpt}")),
                )
                .await;
            });
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct GrantDel {
    pub grantee_type: String,
    pub grantee_id: String,
}

/// DELETE /api/spaces/{id}/grants —— 撤一条授权(admin)。
/// 防锁死:不许删掉「最后一个 admin 授权」,否则空间从此没人能管(超管除外,但别依赖超管救火)。
pub async fn grant_delete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    Json(g): Json<GrantDel>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Admin).await?;
    let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM space_grants WHERE space_id = $1 AND role = 'admin'")
        .bind(sid)
        .fetch_one(&state.pool)
        .await?;
    let victim_is_admin: Option<String> = sqlx::query_scalar(
        "SELECT role FROM space_grants WHERE space_id = $1 AND grantee_type = $2 AND grantee_id = $3",
    )
    .bind(sid)
    .bind(&g.grantee_type)
    .bind(&g.grantee_id)
    .fetch_optional(&state.pool)
    .await?;
    if victim_is_admin.as_deref() == Some("admin") && admins <= 1 {
        return Err(AppError::BadRequest("不能撤掉最后一个 admin 授权".into()));
    }
    let n = sqlx::query("DELETE FROM space_grants WHERE space_id = $1 AND grantee_type = $2 AND grantee_id = $3")
        .bind(sid)
        .bind(&g.grantee_type)
        .bind(&g.grantee_id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(&state.pool, id.require_username()?, "space.grant.revoke", &sid.to_string(),
        &format!("{}:{}", g.grantee_type, g.grantee_id)).await;
    Ok(Json(json!({ "ok": true })))
}
