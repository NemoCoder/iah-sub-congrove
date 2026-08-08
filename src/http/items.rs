//! 内容树:文件夹 / 文档(markdown)/ 文件。字节全在 S3,PG 只有元数据(无 PVC 铁律)。
//!
//! S3 key = blobs/<sha256> —— ★内容寻址:同样内容全库只存一份★。
//! (版本恢复、原样重存)天然去重;key 带 item_id,**跨 item 不共享对象**,所以删 item 时
//! 只需对本 item 的 key 做引用计数(items.s3_key + item_versions.s3_key),不会误删别人的。
//!
//! 录屏(video,GB 级)P2 走预签名直传,不从这个文件的 upload 进来(60MB body limit 挡着)。

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::audit;
use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::perm::{require_role, Role};
use crate::state::AppState;

/// 流式上传的 part 缓冲(S3 multipart 最小 5MiB;8MiB 平衡内存与 part 数——512Mi 资源档下
/// 单上传常驻内存 ≈ 一个 part)。**单文件不限大小**(2026-08-02 用户定,录屏几百 MB 常见),
/// 真正的闸是每项目总配额 quota_bytes(默认 10GiB)。
pub const PART_SIZE: usize = 8 * 1024 * 1024;

/// 内容寻址的对象 key(2026-08-05 去重):**同样内容全库只存一份**。
/// 删除按引用计数(purge_subtree),所以谁删都不影响还引用着它的人。
pub(crate) fn blob_key(sha: &str) -> String {
    format!("blobs/{sha}")
}

/// 我能不能读到某份内容(按 sha256)——**秒传的安全闸**。
/// 百度网盘那个著名的坑:只凭哈希就能「认领」文件 = 知道哈希的人可以把别人的私有文件
/// 秒传进自己账户。所以这里区分两件事:
///   - **省空间**无条件:真传完字节的人指向同一对象(他确实拥有这份文件,安全);
///   - **省时间(秒传)有条件**:只有当调用者本来就能读到同 sha 的内容时才免传。
pub(crate) async fn readable_blob(state: &AppState, id: &Identity, sha: &str) -> AppResult<Option<(String, Option<i64>, Option<String>)>> {
    let rows: Vec<(i64, String, Option<i64>, Option<String>)> = sqlx::query_as(
        // ★只认 sha_verified★(迁移 0005):客户端申报的哈希不能当秒传源,
        // 否则「申报别人文件的哈希、传自己的内容」会让真正拥有那份文件的人秒传到错误字节。
        "SELECT project_id, s3_key, size, mime FROM items
          WHERE sha256 = $1 AND sha_verified AND s3_key IS NOT NULL AND deleted_at IS NULL LIMIT 50",
    ).bind(sha).fetch_all(&state.pool).await?;
    for (pid, key, size, mime) in rows {
        if crate::perm::effective_role(&state.pool, id, pid).await?.is_some() {
            return Ok(Some((key, size, mime)));
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
pub struct PrecheckIn {
    pub sha256: String,
    pub size: i64,
    pub name: String,
    pub mime: Option<String>,
    pub parent_id: Option<i64>,
}

/// POST /api/projects/{pid}/precheck —— 秒传预检(≥editor)。
/// 命中(我本来就能读到同内容)→ 直接建行指过去,**零字节传输**;否则告诉前端照常传。
pub async fn precheck(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<PrecheckIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    check_parent(&state.pool, pid, input.parent_id).await?;
    let sha = input.sha256.trim().to_lowercase();
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("sha256 形状不对".into()));
    }
    // ★size 必须非负★(v0.3.55 审计):下面命中时用 `size.unwrap_or(input.size)` —— 库里那份
    // size 为 NULL(历史行)时会退回客户端申报值。申报个负数,配额判断 `used + size > quota`
    // 恒为假、直接放行,还会把负数写进 items.size,把整个空间的已用量算小(甚至算成负的)。
    if input.size < 0 {
        return Err(AppError::BadRequest("size 不能为负".into()));
    }
    let Some((key, size, mime)) = readable_blob(&state, &id, &sha).await? else {
        // 没命中(或命中了但我读不到那份)→ 照常传。key 给出去,传完就是内容寻址的共享对象。
        return Ok(Json(json!({ "instant": false })));
    };
    // 配额照算:秒传省的是传输与存储,不是配额额度(否则同一份东西被反复「免费」摆进各空间)。
    let (quota, used) = project_quota_used(&state.pool, pid).await?;
    if used + size.unwrap_or(input.size) > quota {
        return Err(AppError::BadRequest("超出项目配额,删些内容或找超管调配额".into()));
    }
    let name = { let n = input.name.trim(); if n.is_empty() { "unnamed" } else { n } };
    let mime = input.mime.or(mime).unwrap_or_else(|| "application/octet-stream".into());
    let kind = if mime.starts_with("video/") { "video" } else { "file" };
    let iid: i64 = sqlx::query_scalar(
        "INSERT INTO items (project_id, parent_id, kind, name, mime, created_by, s3_key, size, sha256, sha_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id",
    )
    .bind(pid).bind(input.parent_id).bind(kind).bind(name).bind(&mime)
    .bind(id.require_username()?).bind(&key).bind(size.unwrap_or(input.size)).bind(&sha)
    .fetch_one(&state.pool).await?;
    tracing::info!(item = iid, sha = %&sha[..8], "秒传命中:零字节建立引用");
    crate::http::media::enqueue_analysis(&state, iid, id.require_username()?).await;
    Ok(Json(json!({ "instant": true, "id": iid })))
}

/// 空间配额与已用量。已用 = items ∪ item_versions 的对象按 (s3_key,size) 去重求和
/// (文档当前版与历史版共享同 sha 对象,去重后不重复计)。
pub async fn project_quota_used(pool: &sqlx::PgPool, pid: i64) -> AppResult<(i64, i64)> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        // 按 **key** 分组取 max(size),不是按 (key,size) 去重:同一个 key 若两行记了不同 size
        // (历史行与当前行先后写入的窗口),DISTINCT (k,sz) 会把它算两遍(2026-08-04 审计)。
        "SELECT s.quota_bytes,
                COALESCE((SELECT sum(u.sz) FROM (
                    SELECT t.k, max(t.sz) sz FROM (
                        SELECT s3_key k, size sz FROM items WHERE project_id = $1 AND s3_key IS NOT NULL
                        UNION ALL SELECT v.s3_key, v.size FROM item_versions v
                              JOIN items i ON i.id = v.item_id WHERE i.project_id = $1
                    ) t GROUP BY t.k) u), 0)::bigint
           FROM projects s WHERE s.id = $1",
    )
    .bind(pid)
    .fetch_optional(pool)
    .await?;
    row.ok_or(AppError::NotFound)
}

/// item 所属空间(判权都要先拿它;不存在 = 404)。
pub async fn project_of(pool: &sqlx::PgPool, item_id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT project_id FROM items WHERE id = $1")
        .bind(item_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ItemRow {
    pub id: i64,
    /// 所属空间。列表接口用不着(调用方本来就按空间拉),但**分享链接**要靠它:
    /// 拿到 /i/{id} 只知道 item,得先定位到空间才能打开(迁移无关,纯查询字段)。
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
    pub parent_id: Option<i64>,
    pub kind: String,
    pub name: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub created_by: String,
    /// 上传/创建时间。★列表展示用它而不是 updated_at★:移动、重命名都会刷新 updated_at
    /// (update handler 两条路径都写了 now()),用户看到「刚挪了一下位置,修改时间就变了」很困惑
    /// (2026-08-05 反馈)。
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/projects/{pid}/items —— 整空间平铺一次拉全(≥viewer),前端组树。
/// 空间量级(百~千条)不值得做 parent 分页;真到瓶颈再加。
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<Vec<ItemRow>>> {
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    // ★过滤未完成的上传占位行★(s3_key IS NULL 的 file/video):media/begin 会先建行拿 item_id
    // 用于拼 S3 key,传完才回填 s3_key。不过滤的话「还没传完就出现在列表里」(2026-08-03 反馈),
    // 而且点它会 404。上传中的条目由前端自己在表头渲染(带进度与取消)。
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT id, parent_id, kind, name, size, mime, created_by, created_at, updated_at
           FROM items WHERE project_id = $1 AND deleted_at IS NULL AND (kind IN ('folder','doc') OR s3_key IS NOT NULL)
          ORDER BY kind = 'folder' DESC, name",
    )
    .bind(pid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// GET /api/items/{id} —— 单项元数据(≥viewer)。独立播放窗(/viewer/{id})靠它拿到
/// 名称/类型/mime,而不必先拉整个空间的列表。
pub async fn detail(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<ItemRow>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let row: Option<ItemRow> = sqlx::query_as(
        "SELECT id, project_id, parent_id, kind, name, size, mime, created_by, created_at, updated_at
           FROM items WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(iid)
    .fetch_optional(&state.pool)
    .await?;
    row.map(Json).ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct ProgressIn {
    pub position_sec: f64,
    pub duration_sec: Option<f64>,
}

/// GET /api/items/{id}/progress —— 我上次看到哪(≥viewer)。没看过回 position_sec=0。
pub async fn progress_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let row: Option<(f64, Option<f64>)> = sqlx::query_as(
        "SELECT position_sec, duration_sec FROM play_progress WHERE username = $1 AND item_id = $2",
    )
    .bind(id.require_username()?)
    .bind(iid)
    .fetch_optional(&state.pool)
    .await?;
    let (pos, dur) = row.unwrap_or((0.0, None));
    Ok(Json(json!({ "position_sec": pos, "duration_sec": dur })))
}

/// PUT /api/items/{id}/progress —— 记录播放位置(≥viewer,覆盖写)。
/// 前端每 ~5s 与暂停/关窗时打一次;快到结尾(剩 <15s)当作看完,归零以免下次一进来就跳到片尾。
pub async fn progress_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<ProgressIn>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let mut pos = input.position_sec.max(0.0);
    if let Some(d) = input.duration_sec {
        if d > 0.0 && pos > d - 15.0 {
            pos = 0.0; // 看到尾了,下次从头
        }
    }
    sqlx::query(
        "INSERT INTO play_progress (username, item_id, position_sec, duration_sec) VALUES ($1,$2,$3,$4)
         ON CONFLICT (username, item_id) DO UPDATE SET position_sec = EXCLUDED.position_sec,
           duration_sec = COALESCE(EXCLUDED.duration_sec, play_progress.duration_sec), updated_at = now()",
    )
    .bind(id.require_username()?)
    .bind(iid)
    .bind(pos)
    .bind(input.duration_sec)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true, "position_sec": pos })))
}

#[derive(Deserialize)]
pub struct ItemIn {
    pub kind: String, // 'folder' | 'doc'(file/video 走 upload/预签名,不走这)
    pub name: String,
    pub parent_id: Option<i64>,
}

/// 校验 parent:必须存在、是 folder、在同一空间(防把子树挂到别的空间绕权限)、**且不在回收站里**。
/// ★deleted_at IS NULL★(v0.3.55 审计):原先没这一条,于是能把新建或移动的内容挂到一个
/// 已经删掉的文件夹底下 —— 子项自己 deleted_at 是 NULL、父却不在树里,tree 拉不到它的父,
/// 结果是个**谁也看不见、回收站里也找不到的孤儿**(要等有人恰好还原了那个父目录才会重现)。
pub async fn check_parent(pool: &sqlx::PgPool, pid: i64, parent_id: Option<i64>) -> AppResult<()> {
    // ⚠ 内层变量**不能**也叫 pid:那会遮蔽外层的项目 id,让下面的同项目校验恒假
    //   (2026-08-06 批量改名 sid→pid 时真的踩过一次)。
    if let Some(parent) = parent_id {
        let ok: Option<(i64, String)> =
            sqlx::query_as("SELECT project_id, kind FROM items WHERE id = $1 AND deleted_at IS NULL")
                .bind(parent)
                .fetch_optional(pool)
                .await?;
        match ok {
            Some((parent_pid, kind)) if parent_pid == pid && kind == "folder" => {}
            _ => return Err(AppError::BadRequest("父节点不存在或不是本项目的文件夹".into())),
        }
    }
    Ok(())
}

/// POST /api/projects/{pid}/items —— 建文件夹/空文档(≥editor)。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<ItemIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    if input.kind != "folder" && input.kind != "doc" {
        return Err(AppError::BadRequest("kind 只能是 folder 或 doc(文件走上传)".into()));
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("名称不能为空".into()));
    }
    check_parent(&state.pool, pid, input.parent_id).await?;
    let iid: i64 = sqlx::query_scalar(
        "INSERT INTO items (project_id, parent_id, kind, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    )
    .bind(pid)
    .bind(input.parent_id)
    .bind(&input.kind)
    .bind(name)
    .bind(id.require_username()?)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({ "id": iid })))
}

#[derive(Deserialize)]
pub struct ItemPatch {
    pub name: Option<String>,
    /// Some(None) 表示移到根:JSON 里传 parent_id: null 移根,不传字段则不动。
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<i64>>,
}

/// 区分「字段缺席」与「显式 null」:serde 默认二者同貌,包一层 Option。
fn double_option<'de, D>(de: D) -> Result<Option<Option<i64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<i64>::deserialize(de)?))
}

/// PUT /api/items/{id} —— 改名/移动(≥editor)。移动校验目标 parent 同空间,并拒把文件夹挪进自己的子树(成环即整棵树从视图消失)。
pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(p): Json<ItemPatch>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    // 回收站里的东西不给改名/移动 —— 要动它先还原(v0.3.55 审计)。
    let alive: Option<i64> = sqlx::query_scalar("SELECT id FROM items WHERE id = $1 AND deleted_at IS NULL")
        .bind(iid).fetch_optional(&state.pool).await?;
    if alive.is_none() { return Err(AppError::NotFound) }
    if let Some(new_parent) = p.parent_id {
        check_parent(&state.pool, pid, new_parent).await?;
        if let Some(np) = new_parent {
            // 递归 CTE 查 np 的祖先链里有没有 iid(含 np 自己):有 = 成环,拒。
            let cyclic: bool = sqlx::query_scalar(
                "WITH RECURSIVE up AS (
                   SELECT id, parent_id FROM items WHERE id = $1
                   UNION ALL SELECT i.id, i.parent_id FROM items i JOIN up ON i.id = up.parent_id
                 ) SELECT EXISTS (SELECT 1 FROM up WHERE id = $2)",
            )
            .bind(np)
            .bind(iid)
            .fetch_one(&state.pool)
            .await?;
            if cyclic {
                return Err(AppError::BadRequest("不能把文件夹移进它自己的子树".into()));
            }
        }
        sqlx::query("UPDATE items SET parent_id = $1, updated_at = now() WHERE id = $2")
            .bind(new_parent)
            .bind(iid)
            .execute(&state.pool)
            .await?;
    }
    if let Some(name) = &p.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::BadRequest("名称不能为空".into()));
        }
        sqlx::query("UPDATE items SET name = $1, updated_at = now() WHERE id = $2")
            .bind(name)
            .bind(iid)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/items/{id} —— **软删除**(≥editor,2026-08-05 用户:「所有的删除都是软删除」)。
/// 整棵子树打 deleted_at 标记,S3 对象一个字节都不动;进回收站,空间 admin 可还原或彻底删除,
/// 满 30 天由清理任务自动 purge。★配额仍然计入回收站里的东西★——占着空间就该算,
/// 这也是「清空回收站」的动力(与网盘一致)。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    let actor = id.require_username()?;
    let n = sqlx::query(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id
         )
         UPDATE items SET deleted_at = now(), deleted_by = $2
          WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL",
    ).bind(iid).bind(actor).execute(&state.pool).await?.rows_affected();
    audit::record(&state.pool, actor, "item.delete", &iid.to_string(),
        &format!("project={pid} 软删除 {n} 项(进回收站)")).await;
    Ok(Json(json!({ "ok": true, "trashed": n })))
}

/// GET /api/projects/{id}/trash —— 回收站(≥editor)。只列**被直接删除的那一项**
/// (子树里的行也打了标记,但它们是被连带的,列出来只会刷屏)。
pub async fn trash(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    let rows: Vec<(i64, String, String, Option<i64>, Option<String>, String,
                   chrono::DateTime<chrono::Utc>, Option<String>)> = sqlx::query_as(
        "SELECT i.id, i.kind, i.name, i.size, i.mime, COALESCE(i.deleted_by,''), i.deleted_at, i.mime
           FROM items i
          WHERE i.project_id = $1 AND i.deleted_at IS NOT NULL
            -- 只要「删除动作的根」:父节点没被删(或没有父节点)的那些
            AND (i.parent_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM items p WHERE p.id = i.parent_id AND p.deleted_at IS NOT NULL))
          ORDER BY i.deleted_at DESC LIMIT 500",
    ).bind(pid).fetch_all(&state.pool).await?;
    Ok(Json(rows.into_iter().map(|(id, kind, name, size, mime, by, at, _)| json!({
        "id": id, "kind": kind, "name": name, "size": size, "mime": mime,
        "deleted_by": by, "deleted_at": at,
    })).collect()))
}

/// POST /api/items/{id}/undelete —— 从回收站还原(≥editor)。整棵子树一起还原;
/// 若它的父目录也在回收站里(没被一起还原),就还原到空间根 —— 否则还原出来的东西看不见。
pub async fn undelete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    // ★只还原「和它同一批被删的」行★(v0.3.55 审计)。remove 是一条 UPDATE 打的标记,
    // 同一次删除动作里所有行的 deleted_at 完全相等,拿它当批次号。
    // 原先用 `deleted_at IS NOT NULL` 还原整棵子树,会把**先前单独删掉的子项一起复活**:
    //   删文件 a(T1) → 删它的父目录 F(T2,a 因已有标记不动) → 还原 F ⇒ a 也回来了。
    // 用户明确删过的东西自己爬回来,是数据错误,不是便利。
    let batch: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT deleted_at FROM items WHERE id = $1")
            .bind(iid).fetch_optional(&mut *tx).await?.flatten();
    let Some(batch) = batch else {
        return Err(AppError::BadRequest("这一项不在回收站里".into()));
    };
    let n = sqlx::query(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id
         )
         UPDATE items SET deleted_at = NULL, deleted_by = NULL
          WHERE id IN (SELECT id FROM sub) AND deleted_at = $2",
    ).bind(iid).bind(batch).execute(&mut *tx).await?.rows_affected();
    // ★父目录一起还原★(2026-08-05 用户纠正:原来是挪到空间根)。
    // 还原一份材料却把它从原来的目录里拽出来,等于"还原了但路径没了" —— 用户要找回的是
    // 「东西回到它原来在的地方」。所以沿 parent 链往上,把还在回收站里的祖先一并还原。
    let n2 = sqlx::query(
        "WITH RECURSIVE up AS (
           SELECT id, parent_id FROM items WHERE id = $1
           UNION ALL SELECT i.id, i.parent_id FROM items i JOIN up ON i.id = up.parent_id
         )
         UPDATE items SET deleted_at = NULL, deleted_by = NULL
          WHERE id IN (SELECT id FROM up) AND deleted_at IS NOT NULL",
    ).bind(iid).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    audit::record(&state.pool, actor, "item.undelete", &iid.to_string(),
        &format!("project={pid} 还原 {n} 项(含连带还原的上级目录 {n2} 层)")).await;
    Ok(Json(json!({ "ok": true, "restored": n + n2 })))
}

/// DELETE /api/items/{id}/purge —— **彻底删除**(空间 **admin**)。行删掉、对象按引用计数清。
/// ⚠ 引用计数必须把**软删除的行也算上**:回收站里的东西还指着同一个对象,
/// 现在删掉它,回收站里那份还原出来就是个空壳(内容寻址共享对象之后,这是最容易踩的坑)。
pub async fn purge(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    let actor = id.require_username()?;
    // ★必须先在回收站里★(v0.3.55 审计):原先这里不看 deleted_at,空间 admin 直接
    // DELETE /api/items/{id}/purge 就能把一个**正常的、没删过的**文件永久抹掉,绕开回收站
    // ——正对着「所有的删除都是软删除」这条要求。UI 上没这个入口,但 API 是公开的,
    // 而且到期清理任务也调 purge_subtree,唯有在这道人工入口上钉死才算数。
    let trashed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT deleted_at FROM items WHERE id = $1")
            .bind(iid).fetch_optional(&state.pool).await?.flatten();
    if trashed.is_none() {
        return Err(AppError::BadRequest("只能彻底删除回收站里的内容,请先删除(软删除)".into()));
    }
    let n = purge_subtree(&state, iid).await?;
    audit::record(&state.pool, actor, "item.purge", &iid.to_string(), &format!("project={pid} 彻底删除,清对象 {n}")).await;
    Ok(Json(json!({ "ok": true, "objects_deleted": n })))
}

/// 彻底删一棵子树:先收集候选对象 key,删行,再对**已无人引用**的 key 删对象。返回真正删掉的对象数。
/// 删一批 S3 对象,★但只删「已经没人引用」的★。
///
/// ⚠ 2026-08-05 内容寻址(`blobs/<sha256>`)之后,**同一个 key 会被任意多个项目、
/// 任意多个人共享** —— 两个毫不相干的人上传同一份 PDF 就共用一个 blob。
/// 所以「我删我的东西」绝不能直接 `storage.delete(key)`:那会把**别人的文件**一起打空
/// (items 行还在、名字还在、点开是空的)。
///
/// ★2026-08-08 抽成公共函数★:此前 `purge_subtree` 做了计数、`projects::remove` **没做**,
/// 两份实现只有一份是对的。而 `projects::remove` 那段的注释还停在内容寻址之前的模型
/// (「key 带 project_id 前缀,不会误伤别的项目」)—— ★一条过期的注释就是下一次事故的许可证★。
/// 后果是:任何登录用户建个项目、传一份和别人相同的文件、再删掉自己的项目,
/// 就能永久销毁别人项目里的那一份。
pub(crate) async fn delete_unreferenced(state: &AppState, keys: &[String]) -> usize {
    let mut gone = 0usize;
    for k in keys {
        // ★含软删除行★:回收站里的东西也算引用,它还等着被还原。
        let refs: i64 = match sqlx::query_scalar(
            "SELECT (SELECT count(*) FROM items WHERE s3_key = $1)
                  + (SELECT count(*) FROM item_versions WHERE s3_key = $1)",
        ).bind(k).fetch_one(&state.pool).await {
            Ok(v) => v,
            // ★查不出引用数就**不删**★(fail-closed):删错了不可逆,留个孤儿对象只是占点空间
            Err(e) => { tracing::warn!(error = %e, key = %k, "引用计数查询失败,跳过删除"); continue }
        };
        if refs == 0 {
            if let Err(e) = state.storage.delete(k).await {
                tracing::warn!(error = %e, key = %k, "s3 清理失败(孤儿对象,待巡检)");
            } else { gone += 1 }
        }
    }
    gone
}

pub(crate) async fn purge_subtree(state: &AppState, iid: i64) -> AppResult<usize> {
    let keys: Vec<String> = sqlx::query_scalar(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id
         )
         SELECT DISTINCT k FROM (
           SELECT s3_key k FROM items WHERE id IN (SELECT id FROM sub) AND s3_key IS NOT NULL
           UNION SELECT s3_key FROM item_versions WHERE item_id IN (SELECT id FROM sub)
         ) t",
    ).bind(iid).fetch_all(&state.pool).await?;
    sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await?;
    Ok(delete_unreferenced(state, &keys).await)
}

/// GET /api/items/{id}/content —— 文档正文(≥viewer)。空文档(还没保存过)回空串。
pub async fn content_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Response> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let key: Option<String> = sqlx::query_scalar("SELECT s3_key FROM items WHERE id = $1 AND kind = 'doc' AND deleted_at IS NULL")
        .bind(iid)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let text = match key {
        Some(k) => state.storage.get_bytes(&k).await.map_err(AppError::Other)?,
        None => Vec::new(),
    };
    Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], text).into_response())
}

#[derive(Deserialize)]
pub struct ContentIn {
    pub text: String,
    /// 版本标签(可选),如「初稿」「会前定稿」。
    pub label: Option<String>,
}

/// PUT /api/items/{id}/content —— 保存文档(≥editor):内容寻址写 S3 → 旧版入 item_versions → 更新 items。
/// 同内容重复保存(sha 相同)是 no-op,不产生新版本。
pub async fn content_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<ContentIn>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    // 回收站里的文档不接受写入(v0.3.55 审计):否则改完还得先还原才看得见,白改一场。
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT kind, s3_key, sha256 FROM items WHERE id = $1 AND deleted_at IS NULL")
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((kind, old_key, old_sha)) = row else { return Err(AppError::NotFound) };
    if kind != "doc" {
        return Err(AppError::BadRequest("只有文档能在线编辑".into()));
    }
    let bytes = input.text.into_bytes();
    let sha = hex::encode(Sha256::digest(&bytes));
    if old_sha.as_deref() == Some(sha.as_str()) {
        return Ok(Json(json!({ "ok": true, "unchanged": true })));
    }
    let size = bytes.len() as i64;
    let (quota, used) = project_quota_used(&state.pool, pid).await?;
    if used + size > quota {
        return Err(AppError::BadRequest("超出项目配额,删些内容或找超管调配额".into()));
    }
    // ★统一走内容寻址★(2026-08-06 清库时收口):文档此前用 `spaces/{pid}/{iid}/{sha}` 前缀,
    // 与文件/录屏的 blobs/<sha> 是两套。同一份内容在不同文档里重复保存时,旧前缀会各存一份;
    // 收口之后全库一份,而且删除的引用计数逻辑也只剩一套。
    let key = blob_key(&sha);
    state.storage.put_bytes(&key, bytes, "text/markdown; charset=utf-8").await.map_err(AppError::Other)?;
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    if let Some(ok) = old_key {
        // 旧当前版进历史(内容寻址:同 sha 的历史行指向同一对象,不重复存)。
        sqlx::query(
            "INSERT INTO item_versions (item_id, s3_key, size, sha256, label, created_by)
             SELECT id, s3_key, size, sha256, NULL, $2 FROM items WHERE id = $1 AND s3_key = $3",
        )
        .bind(iid)
        .bind(actor)
        .bind(&ok)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3, mime = 'text/markdown', updated_at = now() WHERE id = $4")
        .bind(&key)
        .bind(size)
        .bind(&sha)
        .bind(iid)
        .execute(&mut *tx)
        .await?;
    if let Some(label) = &input.label {
        // 带标签的保存,同时给「新当前版」记一行历史(命名快照语义,DESIGN §1)。
        sqlx::query("INSERT INTO item_versions (item_id, s3_key, size, sha256, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(iid)
            .bind(&key)
            .bind(size)
            .bind(&sha)
            .bind(label.trim())
            .bind(actor)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "sha256": sha })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct VersionRow {
    pub id: i64,
    pub size: Option<i64>,
    pub sha256: Option<String>,
    pub label: Option<String>,
    pub created_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/items/{id}/versions —— 版本历史(≥viewer)。
pub async fn versions(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<Vec<VersionRow>>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let rows: Vec<VersionRow> = sqlx::query_as(
        "SELECT id, size, sha256, label, created_by, created_at FROM item_versions WHERE item_id = $1 ORDER BY id DESC",
    )
    .bind(iid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// POST /api/items/{id}/restore/{version_id} —— 恢复到某历史版本(≥editor)。
/// 恢复 = 把当前版存进历史,再把 items 指回历史对象(纯改指针,零字节搬运——内容寻址的红利)。
pub async fn restore(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path((iid, vid)): Path<(i64, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    let v: Option<(String, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT s3_key, size, sha256 FROM item_versions WHERE id = $1 AND item_id = $2")
            .bind(vid)
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((vkey, vsize, vsha)) = v else { return Err(AppError::NotFound) };
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO item_versions (item_id, s3_key, size, sha256, label, created_by)
         SELECT id, s3_key, size, sha256, '恢复前自动快照', $2 FROM items WHERE id = $1 AND s3_key IS NOT NULL",
    )
    .bind(iid)
    .bind(actor)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3, updated_at = now() WHERE id = $4")
        .bind(&vkey)
        .bind(vsize)
        .bind(&vsha)
        .bind(iid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UploadQuery {
    /// 空串按 None 收(浏览器拼 `?parent_id=` 是常见形态,直接 400 太脆——2026-08-03 线上踩过)。
    #[serde(default, deserialize_with = "empty_as_none")]
    pub parent_id: Option<i64>,
    /// ★活动材料★(D10):非空表示这份材料属于某次活动的只读区。
    /// 上传落在**关联项目之一**(前端传 projects[0]),但靠 activity_id 让**所有**关联项目的成员都看得到
    /// —— 这就是 D4「一次活动多个项目、材料整份进所有关联项目」的实现方式(不复制文件)。
    #[serde(default, deserialize_with = "empty_as_none")]
    pub activity_id: Option<i64>,
    /// ★录制 ≠ 材料★(D5):只有它为真的文件会被转写、并作为活动时长依据。
    #[serde(default)]
    pub is_recording: bool,
}

fn empty_as_none<'de, D>(de: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s: Option<String> = Option::deserialize(de)?;
    match s.as_deref() {
        None | Some("") => Ok(None),
        Some(v) => v.parse().map(Some).map_err(serde::de::Error::custom),
    }
}

/// POST /api/projects/{pid}/upload —— **流式** multipart 上传(≥editor,单文件不限大小)。
/// 浏览器 → pod 边收边按 8MiB part 转推 S3(常驻内存≈一个 part,512Mi 资源档安全);
/// sha256 边收边算(存 DB 做完整性记录)。⚠ 流式下 key 用不了内容寻址(开传时 sha 未知,
/// S3 rename=拷贝,Garage 上不划算)→ 文件/录屏的 key 是 `spaces/<pid>/<iid>/blob`,
/// 一上传一 item 行天然唯一;**文档**(content_put)仍是 sha 内容寻址(版本去重靠它)。
/// 配额:开传前查一次(拦明显超的),每收一块再累计判(拦"传一半才超"的),超即 abort+删行。
pub async fn upload(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Query(q): Query<UploadQuery>,
    mut mp: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    check_parent(&state.pool, pid, q.parent_id).await?;
    let (quota, used) = project_quota_used(&state.pool, pid).await?;
    if used >= quota {
        return Err(AppError::BadRequest("空间配额已满,删些内容或找超管调配额".into()));
    }
    let actor = id.require_username()?;

    // 收**所有**文件字段(2026-08-04 审计):原来处理完第一个就 return,同一请求里的第二个文件
    // **连报错都没有、直接消失**。前端是一文件一请求,但接口不该静默丢数据。
    // 兼容:响应仍带首个文件的 id/sha256/size,另加 items 数组列全部。
    let mut done: Vec<serde_json::Value> = Vec::new();
    while let Some(mut field) = mp.next_field().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
        if field.file_name().is_none() {
            continue;
        }
        let fname = { let f = field.file_name().unwrap_or("unnamed").trim(); if f.is_empty() { "unnamed".to_string() } else { f.to_string() } };
        let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
        // 先插行拿 item_id(key 要用);kind 按 mime 粗分,失败路径统一删行。
        let kind = if mime.starts_with("video/") { "video" } else { "file" };
        let iid: i64 = sqlx::query_scalar(
            // activity_id / is_recording:活动材料走同一条上传路径(D10 说活动材料是只读区,
            // 唯一写入口是活动详情页 —— 那指的是**入口**,不必为它另写一套 79 行的流式上传)。
            "INSERT INTO items (project_id, parent_id, kind, name, mime, created_by, activity_id, is_recording)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        )
        .bind(pid).bind(q.parent_id).bind(kind).bind(&fname).bind(&mime).bind(actor)
        .bind(q.activity_id).bind(q.is_recording)
        .fetch_one(&state.pool)
        .await?;
        // ★先落临时 key,算完真实 sha 再按内容寻址归位★:边收边算哈希,收完才知道内容的 key。
        // 直接按客户端申报的 sha 写会给「内容投毒」开门(写坏别人引用着的同名对象)——
        // 服务端自己算出来的哈希才作数。
        let tmp_key = format!("tmp/{pid}-{iid}");
        let (q_now, used_now) = project_quota_used(&state.pool, pid).await?;
        match stream_field_to_s3(&state, &mut field, &tmp_key, &mime, q_now - used_now).await {
            Ok((sha, total)) => {
                // 归位:对象已存在就直接引用(哈希是我们自己算的,内容必然一致),否则服务端复制过去。
                let key = blob_key(&sha);
                if !state.storage.exists(&key).await {
                    if let Err(e) = state.storage.copy(&tmp_key, &key).await {
                        let _ = state.storage.delete(&tmp_key).await;
                        let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                        return Err(AppError::Other(e));
                    }
                }
                let _ = state.storage.delete(&tmp_key).await;
                // ★收尾复核配额★:开传前那次 used 是快照,同一空间并发上传各自都会读到它,
                // 两个 9GiB 能一起过 10GiB 的闸。按落地时的真实总量再判一次,超了回滚。
                let (q2, used2) = project_quota_used(&state.pool, pid).await?;
                if used2 + total > q2 {
                    // ⚠★2026-08-08 修:这里原来是 `storage.delete(&key)` —— 会打空别人的文件★
                    //   内容寻址之后 `blobs/<sha>` 是**全库共享**的:上面十行刚写着
                    //   「对象已存在就直接引用」,也就是说这个 key 很可能早就被别人的 items 行引用着。
                    //   配额回滚直接删它 → 那些行还在、点开是空的 —— 静默数据损坏。
                    //   这与 v0.4.38 修 `projects::remove` 的是**同一个洞**,当时漏了这一处。
                    //
                    // ★顺序要紧:先删自己这行,再数引用★。`delete_unreferenced` 按
                    //   items ∪ item_versions 数引用,本行还在的话它会把自己算成一个引用,于是永远删不掉。
                    let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                    delete_unreferenced(&state, std::slice::from_ref(&key)).await;
                    return Err(AppError::BadRequest("空间配额已被并发上传占满,本次已回滚".into()));
                }
                sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3, sha_verified = true WHERE id = $4")
                    .bind(&key).bind(total).bind(&sha).bind(iid)
                    .execute(&state.pool)
                    .await?;
                // 录屏/录音传完即自动排队生成纪要(2026-08-05,与预签名直传那条路径一致)。
                crate::http::media::enqueue_analysis(&state, iid, actor).await;
                done.push(json!({ "id": iid, "sha256": sha, "size": total, "name": fname }));
            }
            Err(e) => {
                let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                return Err(e);
            }
        }
    }
    if let Some(first) = done.first().cloned() {
        let mut out = first;
        out["items"] = json!(done);
        return Ok(Json(out));
    }
    Err(AppError::BadRequest("没有收到文件".into()))
}

/// 把一个 multipart field 流进 S3:小于一个 part 直接 put,否则 S3 multipart。
/// 返回 (sha256, 总字节)。任何失败(含超配额)内部已 abort 半截 multipart,调用方只须删行。
async fn stream_field_to_s3(
    state: &AppState,
    field: &mut axum::extract::multipart::Field<'_>,
    key: &str,
    mime: &str,
    budget: i64,
) -> AppResult<(String, i64)> {
    let mut hasher = Sha256::new();
    let mut buf: Vec<u8> = Vec::with_capacity(PART_SIZE);
    let mut total: i64 = 0;
    let mut upload_id: Option<String> = None;
    let mut parts: Vec<aws_sdk_s3::types::CompletedPart> = Vec::new();
    let mut part_no: i32 = 1;

    // 统一的失败出口:半截 multipart 必 abort(不 abort 在 S3 里永久占存储)。
    macro_rules! fail {
        ($err:expr) => {{
            if let Some(uid) = &upload_id {
                state.storage.multipart_abort(key, uid).await;
            }
            return Err($err);
        }};
    }

    loop {
        let chunk = match field.chunk().await {
            Ok(c) => c,
            Err(e) => fail!(AppError::BadRequest(format!("读取上传流失败:{e}"))),
        };
        match chunk {
            Some(c) => {
                total += c.len() as i64;
                if total > budget {
                    fail!(AppError::BadRequest("超出空间配额(默认 10GiB),删些内容或找超管调配额".into()));
                }
                hasher.update(&c);
                buf.extend_from_slice(&c);
                if buf.len() >= PART_SIZE {
                    let uid = match &upload_id {
                        Some(u) => u.clone(),
                        None => match state.storage.multipart_begin(key, mime).await {
                            Ok(u) => { upload_id = Some(u.clone()); u }
                            Err(e) => fail!(AppError::Other(e)),
                        },
                    };
                    match state.storage.multipart_part(key, &uid, part_no, std::mem::take(&mut buf)).await {
                        Ok(p) => { parts.push(p); part_no += 1; buf.reserve(PART_SIZE); }
                        Err(e) => fail!(AppError::Other(e)),
                    }
                }
            }
            None => break,
        }
    }

    match &upload_id {
        // 走了 multipart:把尾巴(可小于 5MiB,末 part 豁免)传完再 complete。
        Some(uid) => {
            if !buf.is_empty() {
                match state.storage.multipart_part(key, uid, part_no, std::mem::take(&mut buf)).await {
                    Ok(p) => parts.push(p),
                    Err(e) => fail!(AppError::Other(e)),
                }
            }
            if let Err(e) = state.storage.multipart_complete(key, uid, parts).await {
                fail!(AppError::Other(e));
            }
        }
        // 整个文件不足一个 part:单发 put_object 最省事。
        None => {
            if let Err(e) = state.storage.put_bytes(key, std::mem::take(&mut buf), mime).await {
                return Err(AppError::Other(e));
            }
        }
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// GET /api/items/{id}/download —— 流式下载(≥viewer)。S3 → 客户端直转,不落内存。
#[derive(Deserialize)]
pub struct DownloadQuery {
    /// ?inline=1 → 浏览器内嵌渲染(PDF/图片/音视频/纯文本白名单内);缺省或非安全类型都下载。
    #[serde(default, deserialize_with = "empty_as_none_bool")]
    pub inline: Option<bool>,
}

fn empty_as_none_bool<'de, D>(de: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s: Option<String> = Option::deserialize(de)?;
    Ok(match s.as_deref() {
        None | Some("") => None,
        Some("0") | Some("false") => Some(false),
        Some(_) => Some(true),
    })
}

pub async fn download(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Query(q): Query<DownloadQuery>,
) -> AppResult<Response> {
    let pid = project_of(&state.pool, iid).await?;
    let role = require_role(&state.pool, &id, pid, Role::Viewer).await?;
    // D4 开关(迁移 0003):viewer 禁下载原件;editor/admin/超管不受限。阅读/播放不走这,不拦。
    if role == Role::Viewer {
        // ⚠★2026-08-08:这里原本查的是 `viewer_no_download`,而 projects 的列叫 `no_download`
        //   —— 列根本不存在,`fetch_one` 直接 Err → 500。也就是说 **D4「viewer 禁下载」从
        //   2026-08-03 落地那天(b47978a)起就没工作过,整整五天**,而它是一条「权」路径:
        //   本该「禁下载」的人拿到的是 500 不是 403,本该能下载的 viewer 则一律下不了。
        //   ★为什么 13 条安全网 + 70 条 E2E 全绿也没发现★:两个原因叠加 ——
        //   ① 这个分支只在 `role == Viewer` 时才走,而测试用的都是 owner/admin 身份;
        //   ② 现有的「禁下载」测试覆盖的全是**活动级** `activities.no_download`(0007 加的),
        //      项目级这条一条都没有。
        //   抓到它的是 `scripts/sql-prepare-check.py`(全量 SQL 对真库 PREPARE)第一次跑 ——
        //   这正是它存在的理由:**冷门路径的 SQL 错,靠测试覆盖是等不到的**。
        let blocked: bool = sqlx::query_scalar("SELECT no_download FROM projects WHERE id = $1")
            .bind(pid)
            .fetch_one(&state.pool)
            .await?;
        if blocked {
            return Err(AppError::BadRequest("本空间已设置 viewer 禁止下载原件(找空间 admin 提权或关闭该限制)".into()));
        }
    }
    // ★活动粒度的禁下载★(PRD 6.3.2,迁移 0007):「这次会涉及敏感内容,想让大家能看但不能下载」——
    // 说的是**这一次会**,不是把整个项目锁上(项目级那个太钝,会连带影响无关材料)。
    //
    // ⚠ 与项目级是**叠加不是覆盖**:两处任一禁了就禁。反过来做(活动放开能盖过项目)
    // 就成了「在活动上开个口子绕过项目策略」,那是权限模型里最容易被利用的缝。
    // ⚠ 这一条**对所有角色生效**,不像项目那条只拦 viewer —— 发起人说「这次不许下载」
    // 是对全体说的,把 editor 排除在外等于这个开关基本不起作用(活动材料多半是 editor 传的)。
    let activity_blocked: Option<bool> = sqlx::query_scalar(
        "SELECT m.no_download FROM items i JOIN activities m ON m.id = i.activity_id WHERE i.id = $1")
        .bind(iid).fetch_optional(&state.pool).await?;
    if activity_blocked == Some(true) {
        return Err(AppError::BadRequest("这场活动的材料已设为禁止下载原件(可在线预览/播放)".into()));
    }
    // ★deleted_at IS NULL★(v0.3.55 审计):删进回收站的东西,直链也不该再下得到。
    let row: Option<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT s3_key, name, mime FROM items WHERE id = $1 AND deleted_at IS NULL")
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((Some(key), name, mime)) = row else { return Err(AppError::NotFound) };
    let (stream, len) = state.storage.get_stream(&key).await.map_err(AppError::Other)?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(stream.into_async_read()));
    // filename* 用 RFC5987 编码,中文文件名不炸 header(纯 ASCII 名两种写法等价)。
    // ★ inline 只对**安全类型**放行(PDF/图片/纯文本/音视频)★:同源 inline 渲染上传的
    // HTML/SVG 就是存储型 XSS——脚本能读会话 cookie(HttpOnly 挡不住同源 fetch 带 cookie 的操作)。
    // 白名单之外一律 attachment,浏览器只会下载不会执行。
    let mime_s = mime.clone().unwrap_or_default();
    let inline_ok = mime_s == "application/pdf"
        || (mime_s.starts_with("image/") && mime_s != "image/svg+xml")
        || mime_s.starts_with("video/")
        || mime_s.starts_with("audio/")
        || mime_s == "text/plain";
    let disp = if q.inline.unwrap_or(false) && inline_ok {
        format!("inline; filename*=UTF-8''{}", urlencode(&name))
    } else {
        format!("attachment; filename*=UTF-8''{}", urlencode(&name))
    };
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.unwrap_or_else(|| "application/octet-stream".into()))
        .header(header::CONTENT_DISPOSITION, disp);
    if let Some(l) = len {
        resp = resp.header(header::CONTENT_LENGTH, l);
    }
    resp.body(body).map_err(|e| AppError::Other(e.into()))
}

/// 最小 percent-encode(RFC5987 attr-char 之外全编),够 Content-Disposition 用,不引 crate。
pub(crate) fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
