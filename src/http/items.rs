//! 内容树:文件夹 / 文档(markdown)/ 文件。字节全在 S3,PG 只有元数据(无 PVC 铁律)。
//!
//! S3 key = spaces/<space_id>/<item_id>/<sha256> —— 内容寻址:同一 item 的重复内容
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
/// 真正的闸是每空间总配额 quota_bytes(默认 10GiB,迁移 0002)。
pub const PART_SIZE: usize = 8 * 1024 * 1024;

fn s3_key(space_id: i64, item_id: i64, sha: &str) -> String {
    format!("spaces/{space_id}/{item_id}/{sha}")
}

/// 空间配额与已用量。已用 = items ∪ item_versions 的对象按 (s3_key,size) 去重求和
/// (文档当前版与历史版共享同 sha 对象,去重后不重复计)。
pub async fn space_quota_used(pool: &sqlx::PgPool, sid: i64) -> AppResult<(i64, i64)> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT s.quota_bytes,
                COALESCE((SELECT sum(u.sz) FROM (
                    SELECT DISTINCT t.k, t.sz FROM (
                        SELECT s3_key k, size sz FROM items WHERE space_id = $1 AND s3_key IS NOT NULL
                        UNION SELECT v.s3_key, v.size FROM item_versions v
                              JOIN items i ON i.id = v.item_id WHERE i.space_id = $1
                    ) t) u), 0)::bigint
           FROM spaces s WHERE s.id = $1",
    )
    .bind(sid)
    .fetch_optional(pool)
    .await?;
    row.ok_or(AppError::NotFound)
}

/// item 所属空间(判权都要先拿它;不存在 = 404)。
pub async fn space_of(pool: &sqlx::PgPool, item_id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT space_id FROM items WHERE id = $1")
        .bind(item_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ItemRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub kind: String,
    pub name: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub created_by: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/spaces/{sid}/items —— 整空间平铺一次拉全(≥viewer),前端组树。
/// 空间量级(百~千条)不值得做 parent 分页;真到瓶颈再加。
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
) -> AppResult<Json<Vec<ItemRow>>> {
    require_role(&state.pool, &id, sid, Role::Viewer).await?;
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT id, parent_id, kind, name, size, mime, created_by, updated_at
           FROM items WHERE space_id = $1 ORDER BY kind = 'folder' DESC, name",
    )
    .bind(sid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct ItemIn {
    pub kind: String, // 'folder' | 'doc'(file/video 走 upload/预签名,不走这)
    pub name: String,
    pub parent_id: Option<i64>,
}

/// 校验 parent:必须存在、是 folder、且在同一空间(防把子树挂到别的空间绕权限)。
pub async fn check_parent(pool: &sqlx::PgPool, sid: i64, parent_id: Option<i64>) -> AppResult<()> {
    if let Some(pid) = parent_id {
        let ok: Option<(i64, String)> = sqlx::query_as("SELECT space_id, kind FROM items WHERE id = $1")
            .bind(pid)
            .fetch_optional(pool)
            .await?;
        match ok {
            Some((psid, kind)) if psid == sid && kind == "folder" => {}
            _ => return Err(AppError::BadRequest("父节点不存在或不是本空间的文件夹".into())),
        }
    }
    Ok(())
}

/// POST /api/spaces/{sid}/items —— 建文件夹/空文档(≥editor)。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    Json(input): Json<ItemIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    if input.kind != "folder" && input.kind != "doc" {
        return Err(AppError::BadRequest("kind 只能是 folder 或 doc(文件走上传)".into()));
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("名称不能为空".into()));
    }
    check_parent(&state.pool, sid, input.parent_id).await?;
    let iid: i64 = sqlx::query_scalar(
        "INSERT INTO items (space_id, parent_id, kind, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    )
    .bind(sid)
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
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    if let Some(new_parent) = p.parent_id {
        check_parent(&state.pool, sid, new_parent).await?;
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

/// DELETE /api/items/{id} —— 删除(≥editor)。folder 级联整棵子树;
/// S3 对象收集自「被删 items + 其 versions」,key 带 item_id 不跨 item 共享,放心删。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    // 先收集整棵子树的对象 key(items FK 级联删了就找不回了)。
    let keys: Vec<String> = sqlx::query_scalar(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id
         )
         SELECT DISTINCT k FROM (
           SELECT s3_key k FROM items WHERE id IN (SELECT id FROM sub) AND s3_key IS NOT NULL
           UNION SELECT s3_key FROM item_versions WHERE item_id IN (SELECT id FROM sub)
         ) t",
    )
    .bind(iid)
    .fetch_all(&state.pool)
    .await?;
    sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await?;
    for k in &keys {
        if let Err(e) = state.storage.delete(k).await {
            tracing::warn!(error = %e, key = %k, "item delete: s3 cleanup failed");
        }
    }
    audit::record(&state.pool, id.require_username()?, "item.delete", &iid.to_string(),
        &format!("space={} objects={}", sid, keys.len())).await;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/items/{id}/content —— 文档正文(≥viewer)。空文档(还没保存过)回空串。
pub async fn content_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Response> {
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Viewer).await?;
    let key: Option<String> = sqlx::query_scalar("SELECT s3_key FROM items WHERE id = $1 AND kind = 'doc'")
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
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT kind, s3_key, sha256 FROM items WHERE id = $1")
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
    let (quota, used) = space_quota_used(&state.pool, sid).await?;
    if used + size > quota {
        return Err(AppError::BadRequest("超出空间配额,删些内容或找超管调配额".into()));
    }
    let key = s3_key(sid, iid, &sha);
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
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Viewer).await?;
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
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
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

/// POST /api/spaces/{sid}/upload —— **流式** multipart 上传(≥editor,单文件不限大小)。
/// 浏览器 → pod 边收边按 8MiB part 转推 S3(常驻内存≈一个 part,512Mi 资源档安全);
/// sha256 边收边算(存 DB 做完整性记录)。⚠ 流式下 key 用不了内容寻址(开传时 sha 未知,
/// S3 rename=拷贝,Garage 上不划算)→ 文件/录屏的 key 是 `spaces/<sid>/<iid>/blob`,
/// 一上传一 item 行天然唯一;**文档**(content_put)仍是 sha 内容寻址(版本去重靠它)。
/// 配额:开传前查一次(拦明显超的),每收一块再累计判(拦"传一半才超"的),超即 abort+删行。
pub async fn upload(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    Query(q): Query<UploadQuery>,
    mut mp: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    check_parent(&state.pool, sid, q.parent_id).await?;
    let (quota, used) = space_quota_used(&state.pool, sid).await?;
    if used >= quota {
        return Err(AppError::BadRequest("空间配额已满,删些内容或找超管调配额".into()));
    }
    let actor = id.require_username()?;

    while let Some(mut field) = mp.next_field().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
        if field.file_name().is_none() {
            continue;
        }
        let fname = { let f = field.file_name().unwrap_or("unnamed").trim(); if f.is_empty() { "unnamed".to_string() } else { f.to_string() } };
        let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
        // 先插行拿 item_id(key 要用);kind 按 mime 粗分,失败路径统一删行。
        let kind = if mime.starts_with("video/") { "video" } else { "file" };
        let iid: i64 = sqlx::query_scalar(
            "INSERT INTO items (space_id, parent_id, kind, name, mime, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        )
        .bind(sid).bind(q.parent_id).bind(kind).bind(&fname).bind(&mime).bind(actor)
        .fetch_one(&state.pool)
        .await?;
        let key = format!("spaces/{sid}/{iid}/blob");

        match stream_field_to_s3(&state, &mut field, &key, &mime, quota - used).await {
            Ok((sha, total)) => {
                sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3 WHERE id = $4")
                    .bind(&key).bind(total).bind(&sha).bind(iid)
                    .execute(&state.pool)
                    .await?;
                return Ok(Json(json!({ "id": iid, "sha256": sha, "size": total })));
            }
            Err(e) => {
                let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                return Err(e);
            }
        }
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
pub async fn download(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Response> {
    let sid = space_of(&state.pool, iid).await?;
    let role = require_role(&state.pool, &id, sid, Role::Viewer).await?;
    // D4 开关(迁移 0003):viewer 禁下载原件;editor/admin/超管不受限。阅读/播放不走这,不拦。
    if role == Role::Viewer {
        let blocked: bool = sqlx::query_scalar("SELECT viewer_no_download FROM spaces WHERE id = $1")
            .bind(sid)
            .fetch_one(&state.pool)
            .await?;
        if blocked {
            return Err(AppError::BadRequest("本空间已设置 viewer 禁止下载原件(找空间 admin 提权或关闭该限制)".into()));
        }
    }
    let row: Option<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT s3_key, name, mime FROM items WHERE id = $1")
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((Some(key), name, mime)) = row else { return Err(AppError::NotFound) };
    let (stream, len) = state.storage.get_stream(&key).await.map_err(AppError::Other)?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(stream.into_async_read()));
    // filename* 用 RFC5987 编码,中文文件名不炸 header(纯 ASCII 名两种写法等价)。
    let disp = format!("attachment; filename*=UTF-8''{}", urlencode(&name));
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.unwrap_or_else(|| "application/octet-stream".into()))
        .header(header::CONTENT_DISPOSITION, disp);
    if let Some(l) = len {
        resp = resp.header(header::CONTENT_LENGTH, l);
    }
    Ok(resp.body(body).map_err(|e| AppError::Other(e.into()))?)
}

/// 最小 percent-encode(RFC5987 attr-char 之外全编),够 Content-Disposition 用,不引 crate。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
