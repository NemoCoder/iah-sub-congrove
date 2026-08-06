//! 项目 CRUD + 授权管理(project_members)。判权全走 perm.rs,handler 里不重写角色逻辑。
//! 谁能建项目:任何登录用户(Confluence 模式),建者自动落一条 user→admin 授权。

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::perm::Role;
use crate::state::AppState;
use crate::{audit, perm::require_role};

#[derive(Serialize, sqlx::FromRow)]
pub struct ProjectRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub created_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub quota_bytes: i64,
    pub no_download: bool,
    /// 本空间的转写术语表(空格/换行分隔;迁移 0007)。人名与专业词按组不同,由项目管理员维护。
    pub hotwords: String,
    /// 我的有效角色(列表接口顺带回,前端显隐编辑入口用;真判权仍在每个写接口)。
    #[sqlx(skip)]
    pub my_role: Option<Role>,
    /// 已用字节(单独聚合查询回填,见 usage_map)。
    #[sqlx(skip)]
    pub used_bytes: i64,
    /// 归档时间;非空 = ★只读存档★(D17)。前端据此隐藏写入入口并显示只读横幅。
    #[sqlx(default)]
    pub archived_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// 校验 username 是平台注册用户(加成员时用):
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
        "SELECT pid, COALESCE(sum(sz),0)::bigint FROM (
           SELECT DISTINCT i.project_id pid, i.s3_key k, i.size sz FROM items i WHERE i.s3_key IS NOT NULL
           UNION SELECT DISTINCT i.project_id, v.s3_key, v.size FROM item_versions v JOIN items i ON i.id = v.item_id
         ) t GROUP BY pid",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// GET /api/projects —— 我可见的项目(有效角色非空);超管见全部。
pub async fn list(State(state): State<AppState>, Extension(id): Extension<Identity>) -> AppResult<Json<Vec<ProjectRow>>> {
    let usage = usage_map(&state.pool).await?;
    if crate::perm::is_super_now(&state.pool, &id).await? {
        let mut rows: Vec<ProjectRow> =
            sqlx::query_as("SELECT id, name, description, created_by, created_at, quota_bytes, no_download, hotwords, archived_at \
                            FROM projects WHERE deleted_at IS NULL ORDER BY archived_at NULLS FIRST, id")
                .fetch_all(&state.pool)
                .await?;
        rows.iter_mut().for_each(|r| {
            r.my_role = Some(Role::Admin);
            r.used_bytes = usage.get(&r.id).copied().unwrap_or(0);
        });
        return Ok(Json(rows));
    }
    let username = id.require_username()?;
    // ★权限只到人(D12)★:一条 JOIN 就够,不再有「我属于哪些组、那些组有什么授权」这一层。
    // ★排序:进行中在前,归档的沉到后面★(D17)——列表默认是「我手头的活」,
    // 归档的还在同一份数据里(前端可切换筛选),但不该抢占视线。
    type Row = (i64, String, String, String, chrono::DateTime<chrono::Utc>, i64, bool, String, String,
                Option<chrono::DateTime<chrono::Utc>>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.quota_bytes, s.no_download, s.hotwords, g.role, s.archived_at
           FROM projects s JOIN project_members g ON g.project_id = s.id AND g.username = $1
          WHERE s.deleted_at IS NULL
          ORDER BY s.archived_at NULLS FIRST, s.id",
    )
    .bind(username)
    .fetch_all(&state.pool)
    .await?;
    // 一个人在一个项目里只有一行,不再需要跨行合并取 max。
    Ok(Json(rows.into_iter()
        .map(|(pid, name, description, created_by, created_at, quota_bytes, no_download, hotwords, role, archived_at)| ProjectRow {
            id: pid, name, description, created_by, created_at, quota_bytes, no_download, hotwords,
            my_role: Role::parse(&role), used_bytes: usage.get(&pid).copied().unwrap_or(0), archived_at,
        }).collect()))
}

#[derive(Deserialize)]
pub struct ProjectIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// D4 开关(docs/PERMISSIONS.md):Some 才更新;只拦 download 原件,阅读/播放不拦(见迁移 0003 头注)。
    #[serde(default)]
    pub no_download: Option<bool>,
    /// 转写术语表:Some 才更新,空字符串 = 清空。
    #[serde(default)]
    pub hotwords: Option<String>,
    /// 可见性 public/private(D1)。★只影响忙闲★,与资料可见性无关。
    #[serde(default)]
    pub visibility: Option<String>,
    /// 禁止对外分享。★开启时连带撤销本项目已有的公开链接★,否则这个开关是空的(⑨.2)。
    #[serde(default)]
    pub no_share: Option<bool>,
}

/// POST /api/projects —— 建项目,建者自动 admin。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<ProjectIn>,
) -> AppResult<Json<serde_json::Value>> {
    let username = id.require_username()?;
    // D2 决策(docs/PERMISSIONS.md):CONGROVE_PROJECT_CREATORS 非空时仅名单内 + 超管可建。
    let creators = &state.config.project_creators;
    if !creators.is_empty() && !crate::perm::is_super_now(&state.pool, &id).await? && !creators.iter().any(|u| u == username) {
        return Err(AppError::Forbidden);
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("项目名不能为空".into()));
    }
    let mut tx = state.pool.begin().await?;
    // ★建者自动成为主持人(owner)且是 admin 成员★(D0)。
    // owner 是项目上的字段,admin 是成员表里的角色,两者都要写——owner 不进成员表就进不了自己的项目。
    let pid: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, description, visibility, owner, created_by)
         VALUES ($1,$2,COALESCE($4,'public'),$3,$3) RETURNING id")
        .bind(name)
        .bind(&input.description)
        .bind(username)
        .bind(input.visibility.as_deref())
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO project_members (project_id, username, role, added_by) VALUES ($1,$2,'admin',$2)")
        .bind(pid)
        .bind(username)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit::record(&state.pool, username, "project.create", &pid.to_string(), name).await;
    Ok(Json(json!({ "id": pid })))
}

/// GET /api/projects/{id} —— 详情(≥viewer)。
pub async fn detail(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let role = require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let row: Option<(String, String, String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT name, description, created_by, created_at FROM projects WHERE id = $1")
            .bind(pid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((name, description, created_by, created_at)) = row else { return Err(AppError::NotFound) };
    Ok(Json(json!({
        "id": pid, "name": name, "description": description,
        "created_by": created_by, "created_at": created_at, "my_role": role,
    })))
}

/// PUT /api/projects/{id} —— 改名/描述(admin)。
pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<ProjectIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    // ★改可见性只有主持人能做★(D0):它决定本项目的会议要不要占成员的忙闲,影响面超出单个项目。
    if input.visibility.is_some() {
        let v = input.visibility.as_deref().unwrap_or("");
        if v != "public" && v != "private" {
            return Err(AppError::BadRequest("visibility 必须是 public 或 private".into()));
        }
        crate::perm::require_owner(&state.pool, &id, pid).await?;
    }
    let mut tx = state.pool.begin().await?;
    let n = sqlx::query(
        "UPDATE projects SET name = $1, description = $2,
            no_download = COALESCE($3, no_download),
            hotwords    = COALESCE($5, hotwords),
            visibility  = COALESCE($6, visibility),
            no_share    = COALESCE($7, no_share)
          WHERE id = $4 AND deleted_at IS NULL")
        .bind(input.name.trim())
        .bind(&input.description)
        .bind(input.no_download)
        .bind(pid)
        // 术语表规范化:空白/换行统一成单空格(平台契约是空格分隔),顺手去重留原序。
        .bind(input.hotwords.as_deref().map(normalize_hotwords))
        .bind(input.visibility.as_deref())
        .bind(input.no_share)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    // ★开启「禁止对外分享」时,连带撤销本项目已有的公开链接★(⑨.2)。
    // 不撤销的话这个开关就是空的:已经发出去的链接照样能打开,而设置它的人以为已经收回了。
    let mut revoked = 0u64;
    if input.no_share == Some(true) {
        revoked = sqlx::query(
            "UPDATE share_links SET revoked_at = now()
              WHERE revoked_at IS NULL
                AND item_id IN (SELECT id FROM items WHERE project_id = $1)",
        ).bind(pid).execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    if revoked > 0 {
        audit::record(&state.pool, id.require_username()?, "project.no_share",
            &pid.to_string(), &format!("开启禁止分享,连带撤销 {revoked} 条公开链接")).await;
    }
    audit::record(&state.pool, id.require_username()?, "project.update", &pid.to_string(), input.name.trim()).await;
    Ok(Json(json!({ "ok": true })))
}

/// 术语表规范化:换行/多空格 → 单空格,去重保序。词表是给 ASR 的 `hotword`(空格分隔),
/// 重复词没有意义,还会把请求撑大。
/// 上限 500 词 / 4000 字符(2026-08-04 审计):词表会跟着**每一次**转写请求发给 ASR,
/// 没有上限的话粘一篇文章进来就是每次转写都多传几 MB,而且拼音模糊匹配的误替换面积也随之爆炸。
const HOTWORDS_MAX_WORDS: usize = 500;
const HOTWORDS_MAX_CHARS: usize = 4000;

fn normalize_hotwords(raw: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    let mut chars = 0usize;
    for w in raw.split_whitespace() {
        if seen.len() >= HOTWORDS_MAX_WORDS || chars + w.chars().count() > HOTWORDS_MAX_CHARS { break }
        if !seen.contains(&w) { chars += w.chars().count() + 1; seen.push(w) }
    }
    seen.join(" ")
}

/// DELETE /api/projects/{id} —— 删项目(admin)。DB 行级联删(FK CASCADE);
/// S3 对象按 items+versions 收集 key 逐个删——key 带 project_id 前缀,不会误伤别的项目。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT k FROM (
           SELECT s3_key k FROM items WHERE project_id = $1 AND s3_key IS NOT NULL
           UNION SELECT v.s3_key FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.project_id = $1
         ) t",
    )
    .bind(pid)
    .fetch_all(&state.pool)
    .await?;
    let n = sqlx::query("DELETE FROM projects WHERE id = $1").bind(pid).execute(&state.pool).await?.rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    // DB 先删(权限即刻收回),对象后清;清失败只 warn——孤儿对象可由 P3 的项目容量巡检兜底。
    for k in &keys {
        if let Err(e) = state.storage.delete(k).await {
            tracing::warn!(error = %e, key = %k, "project delete: s3 cleanup failed");
        }
    }
    audit::record(&state.pool, id.require_username()?, "project.delete", &pid.to_string(), &format!("objects={}", keys.len())).await;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/projects/{id}/diagnose?username=X(admin)—— 权限诊断:「为什么他能/不能看」。
/// 三家共同痛点、Confluence 的付费卖点,我们内建(docs/PERMISSIONS.md 共识 6)。
///
/// ★2026-08-06 起判定链只剩两段★:超管? / 成员表里是什么角色?
/// 删掉「经哪些组授了什么」那一段(D12)——**这正是删组的好处**:
/// 「他为什么能看到」的答案从一条推导链变成一次查表。
pub async fn diagnose(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    let username = q.get("username").map(|s| s.trim()).filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("缺 username 参数".into()))?;
    let is_super: bool = sqlx::query_scalar("SELECT is_super FROM app_user WHERE username = $1")
        .bind(username).fetch_optional(&state.pool).await?.unwrap_or(false);
    let member: Option<String> = sqlx::query_scalar(
        "SELECT role FROM project_members WHERE project_id = $1 AND username = $2",
    ).bind(pid).bind(username).fetch_optional(&state.pool).await?;
    let is_owner: bool = sqlx::query_scalar::<_, Option<String>>(
        "SELECT owner FROM projects WHERE id = $1",
    ).bind(pid).fetch_optional(&state.pool).await?.flatten().as_deref() == Some(username);
    // 与 perm.rs 同一推导:超管短路 admin,否则就是成员表那一行。
    let effective = if is_super { Some(Role::Admin) } else { member.as_deref().and_then(Role::parse) };
    Ok(Json(json!({
        "username": username,
        "is_super": is_super,
        "is_owner": is_owner,
        "member_role": member,
        "effective": effective,
    })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MemberRow {
    pub username: String,
    pub role: String,
    pub added_by: String,
    pub added_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/projects/{id}/members —— 成员列表(≥viewer)。★只有人,没有组(D12)★。
pub async fn members(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT username, role, added_by, added_at FROM project_members
          WHERE project_id = $1 ORDER BY role DESC, added_at",
    ).bind(pid).fetch_all(&state.pool).await?;
    let owner: Option<String> = sqlx::query_scalar("SELECT owner FROM projects WHERE id = $1")
        .bind(pid).fetch_optional(&state.pool).await?;
    Ok(Json(json!({ "owner": owner, "members": rows })))
}

#[derive(Deserialize)]
pub struct MemberIn {
    /// ★批量★:删掉「组」之后,一次加一个人会让第一次拉 20 人变成点 20 次(D12 的代价,必须用批量抵消)。
    pub usernames: Vec<String>,
    pub role: String,
}

/// PUT /api/projects/{id}/members —— 批量添加/改角色(admin)。
pub async fn member_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<MemberIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    let actor = id.require_username()?;
    if Role::parse(&input.role).is_none() {
        return Err(AppError::BadRequest("role 必须是 viewer/editor/admin".into()));
    }
    // ★只有主持人能给/收 admin★(D0):管理员是副手,副手不能自己再任命副手。
    if input.role == "admin" {
        crate::perm::require_owner(&state.pool, &id, pid).await?;
    }
    let mut added = 0usize;
    for u in input.usernames.iter().map(|u| u.trim()).filter(|u| !u.is_empty()) {
        // 走平台 users/exists 校验:可以拉还没登录过本系统的人(Keycloak 是真相源)。
        ensure_platform_user(&state, u).await?;
        sqlx::query(
            "INSERT INTO project_members (project_id, username, role, added_by) VALUES ($1,$2,$3,$4)
             ON CONFLICT (project_id, username) DO UPDATE SET role = EXCLUDED.role,
                 added_by = EXCLUDED.added_by, added_at = now()",
        ).bind(pid).bind(u).bind(&input.role).bind(actor).execute(&state.pool).await?;
        added += 1;
    }
    audit::record(&state.pool, actor, "project.member.put", &pid.to_string(),
        &format!("{} 人 → {}", added, input.role)).await;
    Ok(Json(json!({ "ok": true, "added": added })))
}

/// DELETE /api/projects/{id}/members?username=X —— 移出成员(admin)。
///
/// ★移出会发生三件事★(D3 硬要求):
///   ① 他上传的材料**全部留在项目里**、署名保留 —— 材料是项目资产,不随人走;
///   ② ★连带撤销他创建的、指向本项目内容的公开分享链接★ ——
///      公开链接是**绕过项目成员身份**的独立通道,不撤销的话「离开即失去全部」就有后门;
///   ③ 本项目的会议从他的时间线上消失(时间线只是索引,权限仍按成员身份判)。
pub async fn member_delete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    let actor = id.require_username()?;
    let who = q.get("username").map(|s| s.trim()).filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("缺 username 参数".into()))?;
    // ★主持人不能被移出★:他得先把 owner 转给别人(否则项目变成无主)。
    let owner: Option<String> = sqlx::query_scalar("SELECT owner FROM projects WHERE id = $1")
        .bind(pid).fetch_optional(&state.pool).await?;
    if owner.as_deref() == Some(who) {
        return Err(AppError::BadRequest("主持人不能被移出,请先转移主持人".into()));
    }
    let mut tx = state.pool.begin().await?;
    let n = sqlx::query("DELETE FROM project_members WHERE project_id = $1 AND username = $2")
        .bind(pid).bind(who).execute(&mut *tx).await?.rows_affected();
    // ②:撤销他建的、指向本项目内容的公开链接。不做这一步,R1 就是空的。
    let revoked = sqlx::query(
        "UPDATE share_links SET revoked_at = now()
          WHERE created_by = $2 AND revoked_at IS NULL
            AND item_id IN (SELECT id FROM items WHERE project_id = $1)",
    ).bind(pid).bind(who).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    audit::record(&state.pool, actor, "project.member.delete", &pid.to_string(),
        &format!("移出 {who};连带撤销公开链接 {revoked} 条")).await;
    Ok(Json(json!({ "ok": true, "removed": n, "revoked_links": revoked })))
}

#[derive(Deserialize)]
pub struct TransferIn { pub to: String }

/// POST /api/projects/{id}/transfer —— 转移主持人(仅现任主持人;超管可强转)。
///
/// ⚠ 本版是**直接转移**。PRD ⑨.5 定的是「需对方接受才生效」,
/// 那需要一张待接受表 + 通知 + 接受入口 —— 排在 M1 收尾,先留 TODO 免得阻塞主线。
/// 现在至少保证了「不能转给非成员」与「转完原主持人仍是 admin」。
pub async fn transfer(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<TransferIn>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perm::require_owner(&state.pool, &id, pid).await?;
    let actor = id.require_username()?;
    let to = input.to.trim();
    if to.is_empty() { return Err(AppError::BadRequest("缺 to".into())) }
    let is_member: Option<String> = sqlx::query_scalar(
        "SELECT role FROM project_members WHERE project_id = $1 AND username = $2",
    ).bind(pid).bind(to).fetch_optional(&state.pool).await?;
    if is_member.is_none() {
        return Err(AppError::BadRequest("只能转给本项目的成员,请先把他加进来".into()));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE projects SET owner = $2 WHERE id = $1").bind(pid).bind(to)
        .execute(&mut *tx).await?;
    // 新主持人必须是 admin;原主持人保留 admin(他还要继续干活,只是不再是负责人)。
    sqlx::query("UPDATE project_members SET role = 'admin' WHERE project_id = $1 AND username = $2")
        .bind(pid).bind(to).execute(&mut *tx).await?;
    tx.commit().await?;
    audit::record(&state.pool, actor, "project.transfer", &pid.to_string(),
        &format!("主持人 {actor} → {to}")).await;
    Ok(Json(json!({ "ok": true })))
}


/// POST /api/projects/{id}/archive —— 归档 / 取消归档(D17,2026-08-07)。
///
/// ★归档 = 「做完了,留着备查」,不是「不要了」★:材料/会议/纪要全保留、可读可下载,
/// 只是不能再往里加东西。配额仍然占着 —— 东西还在盘上,不算数就成了绕过配额的口子。
///
/// **只有主持人能做**(与删项目同档):它影响所有成员能不能继续写,不是某个 admin 的日常操作。
/// ⚠ 走 `require_owner` 而不是 `require_role` —— 后者对归档项目会拒绝一切写操作,
///   那样归档之后就再也解不开了。
pub async fn archive(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perm::require_owner(&state.pool, &id, pid).await?;
    // 不带 archived 字段 = 归档;显式传 false = 恢复为进行中
    let want = body.get("archived").and_then(|v| v.as_bool()).unwrap_or(true);
    let username = id.require_username()?;
    let n = sqlx::query(
        "UPDATE projects SET archived_at = CASE WHEN $2 THEN now() END,
                             archived_by = CASE WHEN $2 THEN $3 END
          WHERE id = $1 AND deleted_at IS NULL")
        .bind(pid).bind(want).bind(username)
        .execute(&state.pool).await?
        .rows_affected();
    if n == 0 { return Err(AppError::NotFound) }
    audit::record(&state.pool, username, if want { "project.archive" } else { "project.unarchive" },
                  &pid.to_string(), "").await;
    Ok(Json(json!({ "ok": true, "archived": want })))
}
