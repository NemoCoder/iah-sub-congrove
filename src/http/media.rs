//! P2 预签名直传/直取(DESIGN.md §6/§7.4b,PoC 全绿后实施):
//! GB 级录屏浏览器直传 Garage,**字节不过 pod**(默认资源档 512Mi 正好贴合);
//! 播放 = 判权后 302 到短时效预签名 GET,Range 由 Garage 处理(单 range,拖动够用)。
//!
//! 流程(complete 放服务端,ETag 由前端收集交回——完成态的可信信号,对抗核查 §7.4b-4):
//!   begin   → 建 items 行 + create_multipart_upload(内网 client)+ 一次性签出全部 part URL
//!   (前端逐 part PUT 直传,收集响应 ETag)
//!   complete→ 服务端 complete_multipart_upload + head 实际大小落行
//!   abort   → abort + 删行(前端失败时调;没调到的由 lib.rs 清理任务兜底)
//! 配额:begin 时按申报 size 预判;complete 后以 head 实际值落账(申报不实多占的量
//! 会在下一次 begin 被总量判定拦住,不值得为它做在线核减)。

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::http::items::space_quota_used;
use crate::perm::{require_role, Role};
use crate::state::AppState;

/// 直传 part 大小(前端按此切片)。32MiB:10GB 录屏 = 320 片,兼顾请求数与失败重传粒度;
/// ≥5MiB 的 S3 下限,末片豁免。
pub const PART_SIZE: i64 = 32 * 1024 * 1024;
/// part URL 有效期:GB 级慢链路一传几小时,给 6h(SigV4 上限 7 天,富余)。
const PART_URL_TTL: Duration = Duration::from_secs(6 * 3600);
/// 播放/下载 GET 短时效:每次播放都经判权重签,15 分钟够 <video> 开流(开流后不再验 URL)。
const GET_URL_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Deserialize)]
pub struct BeginIn {
    pub name: String,
    pub size: i64,
    pub mime: Option<String>,
    pub parent_id: Option<i64>,
}

/// POST /api/spaces/{sid}/media/begin(≥editor)。预签名不可用回 501,前端回退后端流式上传。
pub async fn begin(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(sid): Path<i64>,
    Json(input): Json<BeginIn>,
) -> AppResult<Response> {
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    if state.storage.presign.is_none() {
        return Ok((StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "预签名未启用" }))).into_response());
    }
    crate::http::items::check_parent(&state.pool, sid, input.parent_id).await?;
    if input.size <= 0 {
        return Err(AppError::BadRequest("size 必须为正(前端 File.size)".into()));
    }
    let (quota, used) = space_quota_used(&state.pool, sid).await?;
    if used + input.size > quota {
        return Err(AppError::BadRequest("超出空间配额,删些内容或找超管调配额".into()));
    }
    let name = { let n = input.name.trim(); if n.is_empty() { "unnamed" } else { n } };
    let mime = input.mime.unwrap_or_else(|| "application/octet-stream".into());
    let kind = if mime.starts_with("video/") { "video" } else { "file" };
    let iid: i64 = sqlx::query_scalar(
        "INSERT INTO items (space_id, parent_id, kind, name, mime, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    )
    .bind(sid)
    .bind(input.parent_id)
    .bind(kind)
    .bind(name)
    .bind(&mime)
    .bind(id.require_username()?)
    .fetch_one(&state.pool)
    .await?;
    let key = format!("spaces/{sid}/{iid}/blob");

    let run = async {
        let upload_id = state.storage.multipart_begin(&key, &mime).await?;
        let parts = ((input.size + PART_SIZE - 1) / PART_SIZE).max(1); // 有符号 div_ceil 尚未稳定
        if parts > 10_000 {
            anyhow::bail!("超过 S3 万片上限(单文件 >320GB?)");
        }
        let mut urls = Vec::with_capacity(parts as usize);
        for n in 1..=parts as i32 {
            urls.push(state.storage.presign_part(&key, &upload_id, n, PART_URL_TTL).await?);
        }
        anyhow::Ok((upload_id, urls))
    };
    match run.await {
        Ok((upload_id, part_urls)) => Ok(Json(json!({
            "item_id": iid, "upload_id": upload_id, "part_size": PART_SIZE, "part_urls": part_urls,
        }))
        .into_response()),
        Err(e) => {
            let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
            Err(AppError::Other(e))
        }
    }
}

#[derive(Deserialize)]
pub struct PartQuery {
    pub upload_id: String,
    pub part_number: i32,
}

/// PUT /api/items/{id}/media/part?upload_id=&part_number=(≥editor)—— **代理分片**:
/// 浏览器把这一片的原始字节 PUT 到我们(同源),我们转推 S3,回 ETag。
/// 为什么要它(2026-08-03 线上事故):浏览器直传要过 s3api 的证书关(公网中转层还没套真证书),
/// 回退到「整个大文件一次 POST 给后端」又会被公网入口层在长/大请求上掐断成 502
/// (实测:pod 自身收 300MB 完全正常,是入口层的限)。**分片走同源**两边的坑都绕开:
/// 每个请求只有一片(32MiB),任何代理都过得去;失败只重这一片。
pub async fn part(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<PartQuery>,
    body: axum::body::Bytes,
) -> AppResult<Json<serde_json::Value>> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    if body.is_empty() {
        return Err(AppError::BadRequest("空分片".into()));
    }
    let key = format!("spaces/{sid}/{iid}/blob");
    let p = state
        .storage
        .multipart_part(&key, &q.upload_id, q.part_number, body.to_vec())
        .await
        .map_err(AppError::Other)?;
    Ok(Json(json!({ "part_number": q.part_number, "etag": p.e_tag().unwrap_or_default() })))
}

#[derive(Deserialize)]
pub struct PartIn {
    pub part_number: i32,
    pub etag: String,
}

#[derive(Deserialize)]
pub struct CompleteIn {
    pub upload_id: String,
    pub parts: Vec<PartIn>,
}

/// POST /api/items/{id}/media/complete(≥editor)。ETag 前端收集交回,服务端 complete + head 落账。
pub async fn complete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<CompleteIn>,
) -> AppResult<Json<serde_json::Value>> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    if input.parts.is_empty() {
        return Err(AppError::BadRequest("parts 为空".into()));
    }
    let key = format!("spaces/{sid}/{iid}/blob");
    let parts: Vec<_> = input
        .parts
        .iter()
        .map(|p| {
            aws_sdk_s3::types::CompletedPart::builder()
                .part_number(p.part_number)
                .e_tag(p.etag.trim_matches('"'))
                .build()
        })
        .collect();
    state.storage.multipart_complete(&key, &input.upload_id, parts).await.map_err(AppError::Other)?;
    let head = state.storage.s3.head_object().bucket(&state.storage.bucket).key(&key).send().await
        .map_err(|e| AppError::Other(e.into()))?;
    let size = head.content_length().unwrap_or(0);
    sqlx::query("UPDATE items SET s3_key = $1, size = $2, updated_at = now() WHERE id = $3")
        .bind(&key)
        .bind(size)
        .bind(iid)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true, "size": size })))
}

#[derive(Deserialize)]
pub struct AbortIn {
    pub upload_id: String,
}

/// POST /api/items/{id}/media/abort(≥editor)。前端直传失败时清理:abort + 删行。
pub async fn abort(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<AbortIn>,
) -> AppResult<Json<serde_json::Value>> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    let key = format!("spaces/{sid}/{iid}/blob");
    state.storage.multipart_abort(&key, &input.upload_id).await;
    // 只删还没完成的行(s3_key 仍 NULL);已完成的 abort 无意义也不该误删。
    sqlx::query("DELETE FROM items WHERE id = $1 AND s3_key IS NULL").bind(iid).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/items/{id}/play(≥viewer)→ 302 到 15min 预签名 GET。
/// <video src> 同源打到这,判权后跳 Garage;Range 拖动由 Garage 206(PoC 第 4 项已验)。
/// 预签名未启用 → 302 回同源流式 download(不支持 Range,能看不能拖,回退语义)。
pub async fn play(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Response> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Viewer).await?;
    let key: Option<String> = sqlx::query_scalar("SELECT s3_key FROM items WHERE id = $1")
        .bind(iid)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let Some(key) = key else { return Err(AppError::NotFound) };
    let target = match state.storage.presign_get(&key, GET_URL_TTL).await {
        Ok(u) => u,
        Err(_) => format!("/api/items/{iid}/download"),
    };
    Ok(Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, target)
        .header(header::CACHE_CONTROL, "no-store") // 预签名短时效,别被缓存住过期 URL
        .body(axum::body::Body::empty())
        .map_err(|e| AppError::Other(e.into()))?)
}
