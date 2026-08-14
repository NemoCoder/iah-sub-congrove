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
    // ★没有 quota_bytes 了★（ADR-0004）：额度挂在**人**身上（`user_quota`），不挂在项目上。
    // `used_bytes` 留着 —— 它是「这个项目占了多少」，信息性，不是判据。
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
    /// `team` = 普通项目;`materials` = ★「我的活动材料」,系统建的只读存档区★(ADR-0005)。
    /// 前端据它藏掉全部写入口并打「系统·只读」标 —— 真闸在 perm.rs,这里只管界面别给假按钮。
    #[sqlx(default)]
    pub kind: String,
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
    // items-ok: 配额 —— ★「回收站里的内容仍占用项目配额」是明写的规矩★,不数上就漏算
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
            // ★超管也看不到**别人的**材料区★(PRD §J1c):它里面是体检报告、私人录音这类东西。
            // 超管仍看得到「这个人占了多少 GB」(配额页另走 usage),但看不到项目名之外的任何东西。
            //
            // ⚠★这里原来滤掉的是**全部**材料区,包括超管自己那一个★(2026-08-13 逐张看巡检截图发现):
            //   于是开着超管模式的两小时里,liaoruili 自己的「我的活动材料」从项目页**凭空消失**——
            //   而它平时是置顶的第一行(2026-08-09 他定的「永远置顶」)。
            //   ★最该记的是:原注释白纸黑字写着「超管自己的材料区在下面那条分支里(超管也是人)」,
            //     而上面这条分支 `return` 了,下面那条根本不会执行。★
            //     ——「设计了 ≠ 执行了」的又一例:注释描述的是意图,代码执行的是另一回事,
            //     而两者不一致时**没有任何东西会报错**。
            //   判据改成「不是材料区,或者是我自己的材料区」:别人的照旧一个都看不到。
            sqlx::query_as("SELECT id, name, description, created_by, created_at, no_download, hotwords, archived_at, kind \
                            FROM projects WHERE deleted_at IS NULL AND (kind <> 'materials' OR owner = $1) \
                            ORDER BY (kind <> 'materials'), archived_at NULLS FIRST, id")
                .bind(id.username.as_deref().unwrap_or(""))
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
    type Row = (i64, String, String, String, chrono::DateTime<chrono::Utc>, bool, String, String,
                Option<chrono::DateTime<chrono::Utc>>, String);
    let rows: Vec<Row> = sqlx::query_as(
        // ★材料区**要**出现在这个列表里,排在最后★(2026-08-09 liaoruili:「在项目 tab
        // 里面不是应该有个文件夹吗?只读的」——改判了 PRD §J1「不出现在项目列表里」那一行)。
        //
        // 理由是原来那句话解决不了「东西传进去了,人找不到」:PRD §J0b 画的那个页面属于 M1,
        // 在它做出来之前,材料区是一个**只能写不能看**的黑洞。
        // 而 §J1 真正要防的是「把个人存档区当协作项目用」——那由**只读**(perm.rs 的写闸)
        // 与「关联项目下拉里不列它」来保证,不必靠藏起来。
        //
        // ⚠ `kind` 一并回给前端:它决定前端要不要藏掉全部写入口、要不要打「系统·只读」标。
        "SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.no_download, s.hotwords, g.role, s.archived_at, s.kind
           FROM projects s JOIN project_members g ON g.project_id = s.id AND g.username = $1
          WHERE s.deleted_at IS NULL
          -- ★材料区永远排第一★(2026-08-09 liaoruili:「把我的活动材料永远置顶」):
          --   它是每个人**天天都在**的那一个,而普通项目会越攒越多 ——
          --   放在最后等于「项目一多就再也看不见」。前端也不让筛选/搜索把它挤掉。
          ORDER BY (s.kind <> 'materials'), s.archived_at NULLS FIRST, s.id",
    )
    .bind(username)
    .fetch_all(&state.pool)
    .await?;
    // 一个人在一个项目里只有一行,不再需要跨行合并取 max。
    Ok(Json(rows.into_iter()
        .map(|(pid, name, description, created_by, created_at, no_download, hotwords, role, archived_at, kind)| ProjectRow {
            id: pid, name, description, created_by, created_at, no_download, hotwords,
            my_role: Role::parse(&role), used_bytes: usage.get(&pid).copied().unwrap_or(0), archived_at, kind,
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
        "INSERT INTO projects (name, description, owner, created_by)
         VALUES ($1,$2,$3,$3) RETURNING id")
        .bind(name)
        .bind(&input.description)
        .bind(username)
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
    // 待答复的主持人转移。★挂在详情里而不是新开一个「我的待办」接口★:
    // 被转让人必然是本项目成员(T3),他打开项目就该看到 —— 不必为一条极低频的东西再加一次请求。
    let pt: Option<(i64, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, from_user, to_user, created_at FROM owner_transfers
          WHERE project_id = $1 AND status = 'pending'")
        .bind(pid).fetch_optional(&state.pool).await?;
    Ok(Json(json!({
        "id": pid, "name": name, "description": description,
        "created_by": created_by, "created_at": created_at, "my_role": role,
        "pending_transfer": pt.map(|(tid, from, to, at)| json!({
            "id": tid, "from": from, "to": to, "created_at": at,
        })),
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
    let mut tx = state.pool.begin().await?;
    let n = sqlx::query(
        "UPDATE projects SET name = $1, description = $2,
            no_download = COALESCE($3, no_download),
            hotwords    = COALESCE($5, hotwords),
            no_share    = COALESCE($6, no_share)
          WHERE id = $4 AND deleted_at IS NULL")
        .bind(input.name.trim())
        .bind(&input.description)
        .bind(input.no_download)
        .bind(pid)
        // 术语表规范化:空白/换行统一成单空格(平台契约是空格分隔),顺手去重留原序。
        .bind(input.hotwords.as_deref().map(normalize_hotwords))
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

/// DELETE /api/projects/{id} —— ★软删除★项目(主持人专属),进回收站 30 天。
///
/// ⚠★2026-08-09 全量审计 A5:这里原来是 `DELETE FROM projects`,一条硬删除★。
/// FK CASCADE 会连带清掉 items / 版本 / 成员 / 分享 / 纪要 / 转写…,S3 对象也一并删,
/// **没有回收站、没有 30 天窗口、没有还原入口** —— 一次误点 = 整个项目连同全部录屏永久消失。
/// 而与此同时:
///   · CLAUDE.md 与迁移头注写着「★所有删除都是软删除★」(用户明令);
///   · `apidoc.rs` 与 docs/openapi.json 对外宣称「删项目(**软删除**)」——★发布出去的契约在说谎★;
///   · 表里有 `deleted_at`/`deleted_by` 两列,20+ 处 SQL 在过滤 `projects.deleted_at`,
///     而这一列★全仓从没被写过一次★。**不是回归,是从没实现**;两种语义各写了一半。
/// 2026-08-09 liaoruili 拍板:**走软删除**。
///
/// ⚠★必须与 perm.rs 的 A5b 同一个提交★:`effective_role` 的两条**授权**支原本不判
/// `projects.deleted_at`(fail-open),单补软删会当场变成「删进回收站后成员照常读写」+
/// 「超管拿到别人材料区」。那一条已在同提交里补成 BLOCK。
///
/// ★分享链接连带撤销★:`share.rs::live()` 判的是 items.deleted_at,而软删项目**不给 item 打标记**
/// —— 不撤销的话,项目删了、墙外的公开链接照常下得到。与项目级 `no_share` 那条同一个处理。
/// 撤销是终态,还原**不**恢复链接(与 no_share 一致)。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    // ★删项目是主持人专属(D0)★,不是 admin —— perm.rs 头注一直这么写,
    // 但这里长期用的是 require_role(Admin),两处不一致(2026-08-07 归档功能顺带发现)。
    //
    // 改用 require_owner 还顺手解决了一个回归:归档的写闸挡 `need >= Editor`,
    // 而 Admin >= Editor,于是**归档的项目连删都删不掉**,必须先恢复再删 —— 反直觉
    // (「结题归档了,后来发现是废的想清理掉」是很自然的诉求)。require_owner 不受那道闸约束。
    crate::perm::require_owner(&state.pool, &id, pid).await?;
    let me = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    let n = sqlx::query(
        "UPDATE projects SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL")
        .bind(pid).bind(me).execute(&mut *tx).await?.rows_affected();
    if n == 0 { tx.rollback().await?; return Err(AppError::NotFound) }
    // 连带撤销指向本项目的公开链接(理由见函数头注)
    let links = sqlx::query(
        "UPDATE share_links SET revoked_at = now()
          WHERE revoked_at IS NULL AND item_id IN (SELECT id FROM items WHERE project_id = $1)")
        .bind(pid).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    // ★S3 一个字节都不动★ —— 30 天后由清理任务 purge 时才按引用计数决定对象删不删。
    audit::record(&state.pool, me, "project.delete", &pid.to_string(),
                  &format!("软删除,进回收站 30 天;连带撤销公开链接 {links} 条")).await;
    Ok(Json(json!({ "ok": true, "restorable_days": 30 })))
}

/// GET /api/projects/trash —— 我删掉的项目(30 天内可还原)。
///
/// ★没有这一页,「软删除」就只是「永久看不见」★ —— 与 §J1b-2 给材料区回收站的那条理由同源:
/// 只能删不能还原的回收站不是回收站。
pub async fn trash(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    // 判据是 owner —— 删项目本来就是主持人专属(D0),还原自然也是。超管走影子账户,不在这里开口子。
    let rows: Vec<(i64, String, chrono::DateTime<chrono::Utc>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, deleted_at, deleted_by FROM projects
          WHERE owner = $1 AND deleted_at IS NOT NULL AND kind <> 'materials'
          ORDER BY deleted_at DESC")
        .bind(me).fetch_all(&state.pool).await?;
    Ok(Json(json!(rows.iter().map(|(pid, name, at, by)| json!({
        "id": pid, "name": name, "deleted_at": at, "deleted_by": by,
        // 前端显示「还剩 N 天」比显示一个删除时刻有用 —— 人关心的是「还来得及吗」
        "days_left": 30 - (chrono::Utc::now() - *at).num_days(),
    })).collect::<Vec<_>>())))
}

/// POST /api/projects/{id}/undelete —— 从回收站还原(主持人本人)。
///
/// ⚠★不能走 require_owner★:它查的是 `WHERE id=$1 AND deleted_at IS NULL`,
/// 对已删项目直接 NotFound —— 那样这个项目就**永远还不回来**了。
/// 所以这里显式按 owner 判,且**只**认 owner(与删除对称)。
pub async fn undelete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    let n = sqlx::query(
        "UPDATE projects SET deleted_at = NULL, deleted_by = NULL
          WHERE id = $1 AND owner = $2 AND deleted_at IS NOT NULL")
        .bind(pid).bind(me).execute(&state.pool).await?.rows_affected();
    // 不是我的、不存在、或根本没删 —— 一律 404(不给存在性预言机,与 perm.rs 口径一致)
    if n == 0 { return Err(AppError::NotFound) }
    audit::record(&state.pool, me, "project.undelete", &pid.to_string(),
                  "从回收站还原(公开链接不随还原恢复)").await;
    Ok(Json(json!({ "ok": true })))
}

/// 满 30 天的项目彻底删除 —— 由 `lib.rs` 的清理任务调用。
///
/// ★这才是原来那段硬删除该待的地方★:先收 key,再 DELETE(FK CASCADE 清干净),
/// 最后**按引用计数**删对象。
/// ⚠ 必须走 `delete_unreferenced` 而不是直接 `storage.delete`(2026-08-08 修):
/// 内容寻址之后 `blobs/<sha>` 是**全库共享**的,直接删会把别人项目里同内容的文件一起打空。
/// (此处原本的注释写着「key 带 project_id 前缀,不会误伤别的项目」—— 那是改成内容寻址**之前**
///  的事实,注释没跟着改,于是那个洞在代码里挂了三天。)
pub async fn purge_project(state: &AppState, pid: i64) -> AppResult<usize> {
    // items-ok: 回收站生命周期 —— 彻底删项目时收集要清的 S3 key,含已删的行
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT k FROM (
           SELECT s3_key k FROM items WHERE project_id = $1 AND s3_key IS NOT NULL
           UNION SELECT v.s3_key FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.project_id = $1
         ) t",
    ).bind(pid).fetch_all(&state.pool).await?;
    sqlx::query("DELETE FROM projects WHERE id = $1").bind(pid).execute(&state.pool).await?;
    Ok(crate::http::items::delete_unreferenced(state, &keys).await)
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
    // ★诊断链必须与 perm.rs 同一推导★:所以这里问的也是「他此刻有没有超管**特权**」,
    // 不是「有没有资格」——否则会报「他是超管所以看得到」,而他的超管模式关着、其实看不到。
    let is_super: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM super_now WHERE username = $1)")
        .bind(username).fetch_one(&state.pool).await?;
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
    /// 真实姓名(app_user.name)。★拉进来但还没登录过的人为空★——正常状态,前端只显示用户名。
    #[sqlx(default)]
    pub name: Option<String>,
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
    // ★带出真实姓名★(2026-08-07 用户:「平台用户应该是有真实姓名的」):
    // app_user.name 在登录时由 OIDC claims 落库、拉人时由平台 users/exists 回填。
    // LEFT JOIN:★拉进来但还没登录过的人 name 为空★,前端只显示用户名 —— 这是正常状态不是错误。
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT m.username, m.role, m.added_by, m.added_at, u.name
           FROM project_members m LEFT JOIN app_user u ON u.username = m.username
          WHERE m.project_id = $1 ORDER BY m.role DESC, m.added_at",
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
///   ③ 本项目的活动从他的时间线上消失(时间线只是索引,权限仍按成员身份判)。
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

/// POST /api/projects/{id}/transfer —— ★发起★转移主持人(现任主持人;超管可强推)。
///
/// ★不再是直接转★(2026-08-07,PRD ⑨.5;设计见 docs/TECH-DESIGN-M1-owner-transfer.md):
/// 主持人是有责任的位置(纪要欠账、成员治理都挂他名下),单方面塞给别人不合适;
/// 更糟的是甩给一个已经不活跃的人之后,项目实际无人负责而系统显示它有主持人 ——
/// **比明确无主更糟,因为没人会去管它**。
///
/// ★待接受期间原主持人仍是主持人★(T1):若发起即卸任,项目在空档期无主 ——
/// 没人能加人、没人能改设置,而对方可能永远不点。
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
    if to == actor { return Err(AppError::BadRequest("已经是你自己了".into())) }
    // T3:只能转给现有成员 —— 转给非成员 = 他接受的瞬间成了一个自己都进不去的项目的主持人
    let is_member: Option<String> = sqlx::query_scalar(
        "SELECT role FROM project_members WHERE project_id = $1 AND username = $2",
    ).bind(pid).bind(to).fetch_optional(&state.pool).await?;
    if is_member.is_none() {
        return Err(AppError::BadRequest("只能转给本项目的成员,请先把他加进来".into()));
    }
    // T6:归档项目不能**发起**转移(归档 = 只读存档,D17)。已 pending 的仍可接受,见 respond。
    let (archived, name): (bool, String) = sqlx::query_as(
        "SELECT archived_at IS NOT NULL, name FROM projects WHERE id = $1 AND deleted_at IS NULL")
        .bind(pid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    if archived { return Err(AppError::BadRequest("项目已归档,请先取消归档再转移主持人".into())) }

    // ★同一项目只允许一条 pending 由库里的部分唯一索引堵死★(迁移 0004):
    // 先查后插中间有窗口,并发两条会造成「两个人都以为自己接手了」。这里只把冲突翻译成人话。
    let r = sqlx::query_scalar::<_, i64>(
        "INSERT INTO owner_transfers (project_id, from_user, to_user) VALUES ($1,$2,$3) RETURNING id")
        .bind(pid).bind(actor).bind(to).fetch_one(&state.pool).await;
    let tid = match r {
        Ok(v) => v,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() =>
            return Err(AppError::BadRequest("已有一条待答复的转移,请先撤回".into())),
        Err(e) => return Err(e.into()),
    };
    audit::record(&state.pool, actor, "project.transfer.offer", &pid.to_string(),
        &format!("主持人 {actor} → {to}(待对方接受)")).await;
    // ⚠ 产品名前缀★不在这里加★,收口在 `registry.rs::notify`(2026-08-13):
    //   这里曾经是全系统唯一带「Congrove」的一条,其余十几条都没有 —— 同一条要求只在一处执行等于没执行。
    crate::notify::notify_project(&state, pid, &[to.to_string()], "项目转移申请",
        &format!("{actor} 想把项目「{name}」的主持人转给你。接受后由你负责这个项目。")).await;
    Ok(Json(json!({ "ok": true, "transfer_id": tid })))
}

#[derive(Deserialize)]
pub struct TransferRespondIn { pub accept: bool }

/// POST /api/projects/{id}/transfer/respond —— ★仅被转让人本人★答复。
///
/// ★接受时重新校验一次成员身份★(T5):权限是「当前成员身份的函数」(D3),
/// 不信发起那一刻的快照 —— 中间他可能已经离开项目了。
pub async fn transfer_respond(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<TransferRespondIn>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    // ⚠ 这里**不能**用 require_role/require_owner:被转让人可能只是 editor,
    //   而归档项目的写闸会拒绝一切 ≥editor 的写(T6:已 pending 的必须能接受,否则归档把请求永久卡死)。
    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT id, from_user, to_user FROM owner_transfers
          WHERE project_id = $1 AND status = 'pending'")
        .bind(pid).fetch_optional(&state.pool).await?;
    let (tid, from, to) = row.ok_or_else(|| AppError::BadRequest("没有待答复的转移".into()))?;
    if to != me { return Err(AppError::Forbidden) }

    let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1 AND deleted_at IS NULL")
        .bind(pid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;

    if !input.accept {
        sqlx::query("UPDATE owner_transfers SET status='declined', settled_at=now() WHERE id=$1")
            .bind(tid).execute(&state.pool).await?;
        audit::record(&state.pool, me, "project.transfer.decline", &pid.to_string(), &from).await;
        // ★拒绝也要通知★:不说他不会知道,请求会静静躺在那里
        crate::notify::notify_project(&state, pid, std::slice::from_ref(&from), "转移主持人被拒绝",
            &format!("{me} 拒绝接手项目「{name}」的主持人。")).await;
        return Ok(Json(json!({ "ok": true, "accepted": false })));
    }

    // T5:接受这一刻重新校验 —— 他可能已经不在项目里了
    let still: Option<String> = sqlx::query_scalar(
        "SELECT role FROM project_members WHERE project_id=$1 AND username=$2")
        .bind(pid).bind(me).fetch_optional(&state.pool).await?;
    if still.is_none() {
        return Err(AppError::BadRequest("你已不是本项目成员,无法接手".into()));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE projects SET owner = $2 WHERE id = $1").bind(pid).bind(me)
        .execute(&mut *tx).await?;
    // 新主持人必须是 admin;★原主持人保留 admin★(T4:交棒不是逐出,他通常还要继续参与)
    sqlx::query("UPDATE project_members SET role='admin' WHERE project_id=$1 AND username IN ($2,$3)")
        .bind(pid).bind(me).bind(&from).execute(&mut *tx).await?;
    sqlx::query("UPDATE owner_transfers SET status='accepted', settled_at=now() WHERE id=$1")
        .bind(tid).execute(&mut *tx).await?;
    tx.commit().await?;
    audit::record(&state.pool, me, "project.transfer.accept", &pid.to_string(),
        &format!("主持人 {from} → {me}")).await;
    crate::notify::notify_project(&state, pid, std::slice::from_ref(&from), "主持人已交接",
        &format!("{me} 已接受项目「{name}」的主持人,你不再是负责人(仍是管理员)。")).await;
    Ok(Json(json!({ "ok": true, "accepted": true, "owner": me })))
}

/// DELETE /api/projects/{id}/transfer —— 撤回(发起人;超管)。
/// ★手滑转错人的唯一退路★(T2):不给撤回就只能去求对方点「拒绝」。
pub async fn transfer_cancel(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perm::require_owner(&state.pool, &id, pid).await?;
    let actor = id.require_username()?;
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, to_user FROM owner_transfers WHERE project_id=$1 AND status='pending'")
        .bind(pid).fetch_optional(&state.pool).await?;
    let (tid, to) = row.ok_or_else(|| AppError::BadRequest("没有待撤回的转移".into()))?;
    sqlx::query("UPDATE owner_transfers SET status='canceled', settled_at=now() WHERE id=$1")
        .bind(tid).execute(&state.pool).await?;
    audit::record(&state.pool, actor, "project.transfer.cancel", &pid.to_string(), &to).await;
    let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1")
        .bind(pid).fetch_one(&state.pool).await?;
    // ★撤回也通知★:否则他点进去发现按钮没了,以为是坏了
    crate::notify::notify_project(&state, pid, std::slice::from_ref(&to), "转移主持人已撤回",
        &format!("{actor} 撤回了把项目「{name}」转给你的请求。")).await;
    Ok(Json(json!({ "ok": true })))
}


/// POST /api/projects/{id}/archive —— 归档 / 取消归档(D17,2026-08-07)。
///
/// ★归档 = 「做完了,留着备查」,不是「不要了」★:材料/活动/纪要全保留、可读可下载,
/// 只是不能再往里加东西。配额仍然占着 —— 东西还在盘上,不算数就成了绕过配额的口子。
///
/// **只有主持人能做**(与删项目同档):它影响所有成员能不能继续写,不是某个 admin 的日常操作。
/// ⚠ 走 `require_owner` 而不是 `require_role` —— 后者对归档项目会拒绝一切写操作,
///   那样归档之后就再也解不开了。
/// GET /api/projects/{id}/archive-blockers —— ★谁挡着归档★(2026-08-14)
///
/// liaoruili:「你这个错误有问题,你要直接弹出来要取消的项目列表,然后一键取消之类的功能;
///  而且确认和红字同时显示 啥意思呢」。
///
/// ★上一版只把「不行」说出来,没解决人接下来要干什么★:红字里列 5 场,人还得自己一场场去找、
/// 一场场取消,而且**确认框和红字同时挂在屏幕上** —— 等于同时问「确定吗」又答「不行」。
/// 现在改成:点归档先问这个接口,有挡路的就**直接把它们摆出来 + 一键取消**,屏幕上只有一个对话框。
///
/// ⚠★WHERE 必须和 `archive` 里那条**一模一样**★:两处推导一旦漂移,
///   就会出现「列表说没有挡路的、点下去照样被拒」这种最难查的错。
/// ⚠ 不设 LIMIT:界面要**全部**列出来才好一键处理;它天然被「本项目 + 未开始 + active」夹住。
pub async fn archive_blockers(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perm::require_owner(&state.pool, &id, pid).await?;
    let me = id.require_username()?;
    let rows: Vec<(i64, String, chrono::DateTime<chrono::Utc>, bool)> = sqlx::query_as(
        "SELECT m.id, m.title, m.starts_at,
                -- ★能不能由我来取消★:取消是「发起人 / 记录员」的权限(见 activities::remove)。
                --   界面要靠它把「我取消不了的那几场」单独标出来 —— ★批量操作里最坏的事
                --   就是默不作声地跳过几条★,人以为都处理完了,回头再点归档还是被拒。
                (m.organizer = $2 OR m.recorder = $2) AS can_cancel
           FROM activities m
           JOIN activity_projects mp ON mp.activity_id = m.id
          WHERE mp.project_id = $1 AND m.status = 'active' AND m.starts_at > now()
          ORDER BY m.starts_at")
        .bind(pid).bind(me).fetch_all(&state.pool).await?;
    Ok(Json(json!({
        "total": rows.len(),
        "items": rows.iter().map(|(i, t, at, ok)| json!({
            "id": i, "title": t, "starts_at": at, "can_cancel": ok,
        })).collect::<Vec<_>>(),
    })))
}

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
    // ★有未开始的活动就不许归档★(PRD B2,2026-08-09 全量审计发现这里此前**零校验**)。
    //
    // 归档 = 做完了。还有排在未来的活动 = 没做完 —— 直接拒,让人先处理(取消它们,或等它们开完)。
    // 推论:归档项目里不会存在「未来的活动」,于是「归档项目的活动要不要占忙闲」这个问题自然消失。
    //
    // ★不含已取消的★(2026-08-07 确认):取消了就不算有安排,不该因为一条作废的记录卡住归档。
    //
    // ⚠★跨项目的活动不能静默跳过★:A 想归档却卡在一场**同时关联 A 和 B** 的会上,而那场会主要是 B 的事。
    //   处置是★把是哪几场列出来★,让他自己决定(把 A 从关联里去掉,或直接取消它)——
    //   静默跳过等于允许「项目归档了、名下还有未来的会」。
    if want {
        // ★列 5 场,但把总数一起带出来★(2026-08-14 liaoruili 拍板「等 N 场」)。
        //   原来是写死 `LIMIT 5` 且不给总数 —— 卡着 12 场时,报错只说得出 5 场,
        //   ★人处理完这 5 场再来归档,又被拒,还是只看到 5 场★:不知道还剩多少、要来几轮。
        //   这里的 5 是**刻意的举例**(全列出来一行报错会长到没法读),
        //   所以判据是「限量必须同时说出总数」——`COUNT(*) OVER()` 一次查询带回来。
        let pending: Vec<(String, chrono::DateTime<chrono::Utc>, i64)> = sqlx::query_as(
            "SELECT m.title, m.starts_at, COUNT(*) OVER() AS total FROM activities m
               JOIN activity_projects mp ON mp.activity_id = m.id
              WHERE mp.project_id = $1 AND m.status = 'active' AND m.starts_at > now()
              -- limit-ok: 刻意举例 —— 报错文案里列 5 场示意(全列出来一行报错长到没法读),
              --   ★而总数由上面的 COUNT(*) OVER() 一并带回、文案里写「等 N 场」★。
              ORDER BY m.starts_at LIMIT 5")
            .bind(pid).fetch_all(&state.pool).await?;
        if !pending.is_empty() {
            // ★这条文案是给**操作者**看的即时报错,所以用他的时区★(2026-08-12,PRD E0)。
            // 原来写死东八区 —— 一个纽约用户被拒时看到的「还有没开始的活动:X(08-13 10:00)」
            // 是北京时间,他去日历上找 10:00 那一场,找不到。
            let tz = crate::tzutil::of_user(&state.pool, username).await;
            let list = pending.iter()
                .map(|(t, at, _)| format!("{}（{}）", t, at.with_timezone(&tz).format("%m-%d %H:%M")))
                .collect::<Vec<_>>().join("、");
            let total = pending[0].2;
            // 只有真的没列全时才加那半句 —— 5 场以内说「等 5 场」是废话
            let 还有 = if total > pending.len() as i64 {
                format!("等 {total} 场")
            } else { String::new() };
            return Err(AppError::BadRequest(format!(
                "还有没开始的活动,先处理掉再归档:{list}{还有}。（取消它们,或把本项目从它的关联里去掉）")));
        }
    }
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

/// 某人的「我的活动材料」——★没有就现建一个★,返回项目 id。
///
/// ★为什么要有它★(PRD §J0,2026-08-09 liaoruili:「个人活动无法上传材料」):
/// 不关联项目的个人活动(ADR-0002 的 `needs_project=false`)★也要能传材料★,
/// 可材料必须落到某个项目才有权限归属(D3)—— 于是给每人一个系统建的存档区。
///
/// ⚠★它不是一个项目★(PRD §J1),只是技术上复用了 projects 表:
/// 不出现在项目列表里(`list` 里 `kind <> 'materials'`)、拉不了成员、
/// 别人(含超管,J1c)一律无角色 —— 隔离在 `perm.rs::effective_role` 单点否决(ADR-0005)。
///
/// ⚠★owner 也要写一行 project_members★:`effective_role` 是从成员表读角色的,
/// projects.owner 那一列**不参与**角色推导。少这一行的话,材料区连它主人自己都进不去
/// (而 `create` 早就是这么写的 —— 同一个坑,照抄它)。
///
/// ⚠★还没做的那半边(别看到这个函数就以为 §J 落地了)★:PRD §J1 的**白名单**
/// (材料区只放行「读树/读 item/下载/复制出去/回收站还原」,其余一律拒)、
/// §J0b 的「我的活动材料」页、§J1c 的影子账户 —— 都是 M1 的活。
/// 现在这里只解决一件事:★个人活动传得进材料★。它的主人对这个区仍是 admin,
/// 也就是说他从 URL 直接进去还能建文件夹 —— 不理想,但不是越权(是他自己的东西)。
///
/// 并发两个请求同时建靠**部分唯一索引** `idx_proj_materials` 兜:
/// 第二个 INSERT 冲突返回 0 行,回头再查一次拿第一个建好的那个(与 `activity_folder` 同一手法)。
pub async fn materials_project(state: &AppState, owner: &str) -> AppResult<i64> {
    if let Some(pid) = find_materials_project(&state.pool, owner).await? { return Ok(pid) }
    let mut tx = state.pool.begin().await?;
    let made: Option<i64> = sqlx::query_scalar(
        "INSERT INTO projects (name, description, owner, created_by, kind)
         VALUES ('我的活动材料', '不关联项目的个人活动,材料落在这里。只有你自己看得到。', $1, $1, 'materials')
         ON CONFLICT DO NOTHING RETURNING id")
        .bind(owner).fetch_optional(&mut *tx).await?;
    let Some(pid) = made else {
        tx.rollback().await?;
        return find_materials_project(&state.pool, owner).await?.ok_or(AppError::NotFound);
    };
    sqlx::query("INSERT INTO project_members (project_id, username, role, added_by) VALUES ($1,$2,'admin',$2)")
        .bind(pid).bind(owner).execute(&mut *tx).await?;
    tx.commit().await?;
    audit::record(&state.pool, owner, "project.materials.create", &pid.to_string(), "我的活动材料").await;
    Ok(pid)
}

async fn find_materials_project(pool: &sqlx::PgPool, owner: &str) -> AppResult<Option<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM projects WHERE owner = $1 AND kind = 'materials' AND deleted_at IS NULL")
        .bind(owner).fetch_optional(pool).await?)
}

/// GET /api/me/transfers —— 等我答复的主持人转移。
///
/// ★为什么不是在项目页里看★:被转让人可能**压根不会打开那个项目**——
/// 一个躺着的请求要是只在项目内部可见,它多半永远不会被答复。
/// 所以它归到「待我处理」那张卡里,和活动邀请、私聊未读并列:
/// 那张卡的定义就是「需要我动作的事」,这条完全符合。
pub async fn my_transfers(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<serde_json::Value>> {
    let me = id.require_username()?;
    let rows: Vec<(i64, i64, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT t.id, t.project_id, p.name, t.from_user, t.created_at
           FROM owner_transfers t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          WHERE t.status = 'pending' AND t.to_user = $1
          ORDER BY t.created_at")
        .bind(me).fetch_all(&state.pool).await?;
    Ok(Json(json!(rows.iter().map(|(tid, pid, name, from, at)| json!({
        "id": tid, "project_id": pid, "project_name": name, "from": from, "created_at": at,
    })).collect::<Vec<_>>())))
}
