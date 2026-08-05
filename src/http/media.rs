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
use serde_json;
use serde_json::json;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::http::items::space_quota_used;
use crate::perm::{require_role, Role};
use crate::state::AppState;

/// 直传 part 大小(前端按此切片)。**8MiB**(2026-08-03 从 32MiB 降):S3 下限是 5MiB,
/// 而公网入口层对大请求体/长请求会掐断(502,实测 pod 自身收 300MB 无碍)——片越小越容易
/// 穿过任意代理,单片失败重传代价也小。10GB 录屏 = 1280 片,离 S3 的万片上限还远。
pub const PART_SIZE: i64 = 8 * 1024 * 1024;
/// part URL 有效期:GB 级慢链路一传几小时,给 6h(SigV4 上限 7 天,富余)。
const PART_URL_TTL: Duration = Duration::from_secs(6 * 3600);
/// 播放 GET 时效 **6h**(2026-08-03 从 15min 提):`<video>` 拿到 302 后会**记住解析后的
/// 那个 URL**,后续拖动进度条是直接对它发 Range——15 分钟一过,看长录屏拖进度就 403。
/// 延长不放大权限面:它仍是一次判权后只对持有该 URL 者有效的短期凭证。
const GET_URL_TTL: Duration = Duration::from_secs(6 * 3600);

#[derive(Deserialize)]
pub struct BeginIn {
    pub name: String,
    pub size: i64,
    pub mime: Option<String>,
    pub parent_id: Option<i64>,
    /// 文件内容的 sha256(前端算完预检时顺手带来)。有它就走**内容寻址** blobs/<sha>:
    /// 同样内容全库一份。⚠ 客户端申报的哈希**不可信**——所以只在 blobs/<sha> **不存在**时才用它;
    /// 已存在说明别人先传过同名内容,这时另起一个 key(否则申报个假哈希就能覆盖别人的对象 = 内容投毒)。
    #[serde(default)]
    pub sha256: Option<String>,
    /// 文件指纹(前端给:大小+修改时间+文件名)。带上它就能**断点续传**:
    /// 同一个人、同一空间、24h 内、指纹相同且没传完的那一行会被复用,已传的片不再重传。
    #[serde(default)]
    pub fp: Option<String>,
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
    let actor = id.require_username()?;

    // ★断点续传★(迁移 0009):带指纹来的先看看「上次没传完的那个文件」还在不在。
    // 条件卡死到本人 + 本空间 + 本目录 + 未完成 + 24h 内——别把别人的半截上传认成我的。
    // 24h 与 lib.rs 的清扫窗口对齐:过期的那半截已被 abort,续也续不上。
    let mut resume: Option<(i64, String, Vec<(i32, String, i64)>)> = None;
    if let Some(fp) = input.fp.as_deref().filter(|f| !f.trim().is_empty()) {
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT id, upload_id FROM items
              WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND s3_key IS NULL
                AND created_by = $3 AND upload_fp = $4 AND upload_id IS NOT NULL
                AND created_at > now() - interval '24 hours'
              ORDER BY id DESC LIMIT 1",
        )
        .bind(sid).bind(input.parent_id).bind(actor).bind(fp)
        .fetch_optional(&state.pool).await?;
        if let Some((old_iid, Some(old_uid))) = row {
            let old_key = format!("spaces/{sid}/{old_iid}/blob");
            match state.storage.list_parts(&old_key, &old_uid).await {
                // 断点还在:复用它。已传的片原样保留,前端只补缺的。
                // ⚠ 先校验切法一致:除最后一片外每片都必须正好 PART_SIZE。
                //   将来若调整 PART_SIZE,24h 内的旧断点就是按旧切法传的,继续接着传会把文件**拼坏**
                //   (而且 complete 会成功,是静默的数据损坏)。对不上就当断点失效,重新来过。
                Ok(done) => {
                    let last = done.iter().map(|(n, _, _)| *n).max().unwrap_or(0);
                    let uniform = done.iter().all(|(n, _, sz)| *n == last || *sz == PART_SIZE);
                    if uniform {
                        resume = Some((old_iid, old_uid, done));
                    } else {
                        tracing::warn!(item = old_iid, "续传:分片大小与当前 PART_SIZE 不一致,弃用该断点");
                        state.storage.multipart_abort(&old_key, &old_uid).await;
                        let _ = sqlx::query("DELETE FROM items WHERE id = $1 AND s3_key IS NULL")
                            .bind(old_iid).execute(&state.pool).await;
                    }
                }
                // upload_id 已失效(被清扫 abort / 服务端丢了)→ 当新上传,顺手把废行删掉。
                Err(e) => {
                    tracing::info!(error = %e, item = old_iid, "续传断点已失效,改为重新开始");
                    let _ = sqlx::query("DELETE FROM items WHERE id = $1 AND s3_key IS NULL")
                        .bind(old_iid).execute(&state.pool).await;
                }
            }
        }
    }

    let (iid, existing) = match &resume {
        Some((old_iid, old_uid, done)) => (*old_iid, Some((old_uid.clone(), done.clone()))),
        None => {
            let iid: i64 = sqlx::query_scalar(
                "INSERT INTO items (space_id, parent_id, kind, name, mime, created_by, upload_fp) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            )
            .bind(sid)
            .bind(input.parent_id)
            .bind(kind)
            .bind(name)
            .bind(&mime)
            .bind(actor)
            .bind(input.fp.as_deref())
            .fetch_one(&state.pool)
            .await?;
            // 申报大小先记进 size(未完成行的 size 本来闲着):complete 时拿它对账,
            // 少传了片也能发现(见 complete 的完整性校验)。
            let _ = sqlx::query("UPDATE items SET size = $1 WHERE id = $2")
                .bind(input.size).bind(iid).execute(&state.pool).await;
            (iid, None)
        }
    };
    // ★内容寻址★(2026-08-05 去重):有可信形状的 sha 就用 blobs/<sha>,同内容全库一份。
    // 已存在则另起 `blobs/<sha>-<rand>`:客户端申报的哈希不可信,覆盖已有对象 = 内容投毒。
    // 续传时沿用原 key(断点是按那个 key 建的)。
    let key = match &existing {
        Some(_) => format!("spaces/{sid}/{iid}/blob"),
        None => match input.sha256.as_deref().map(str::trim).filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())) {
            Some(sha) => {
                let k = crate::http::items::blob_key(sha);
                if state.storage.exists(&k).await { format!("{k}-{}", &rand_suffix()) } else { k }
            }
            None => format!("spaces/{sid}/{iid}/blob"),
        },
    };
    // key 记进行里:complete/part/abort 都要用同一个(内容寻址之后不能再按 sid/iid 现拼)。
    sqlx::query("UPDATE items SET upload_key = $2, sha256 = $3 WHERE id = $1")
        .bind(iid).bind(&key).bind(input.sha256.as_deref()).execute(&state.pool).await?;

    let run = async {
        // 续传复用旧 upload_id;新上传才 create。
        let upload_id = match &existing {
            Some((uid, _)) => uid.clone(),
            None => state.storage.multipart_begin(&key, &mime).await?,
        };
        let parts = ((input.size + PART_SIZE - 1) / PART_SIZE).max(1); // 有符号 div_ceil 尚未稳定
        if parts > 10_000 {
            anyhow::bail!("超过 S3 万片上限(单文件 >320GB?)");
        }
        // ⚠ URL **每次都重签**:预签名 6 小时到期,续传时旧 URL 多半已经死了。
        let mut urls = Vec::with_capacity(parts as usize);
        for n in 1..=parts as i32 {
            urls.push(state.storage.presign_part(&key, &upload_id, n, PART_URL_TTL).await?);
        }
        anyhow::Ok((upload_id, urls))
    };
    match run.await {
        Ok((upload_id, part_urls)) => {
            // 记住 upload_id:下次断了才认得回来(新上传要写,续传是幂等重写)。
            sqlx::query("UPDATE items SET upload_id = $1, upload_fp = COALESCE($2, upload_fp) WHERE id = $3")
                .bind(&upload_id).bind(input.fp.as_deref()).bind(iid)
                .execute(&state.pool).await?;
            let done = existing.map(|(_, d)| d).unwrap_or_default();
            if !done.is_empty() {
                tracing::info!(item = iid, parts = done.len(), "续传:跳过已传分片");
            }
            Ok(Json(json!({
                "item_id": iid, "upload_id": upload_id, "part_size": PART_SIZE, "part_urls": part_urls,
                // 已经传好的片(片号 + 字节数);前端据此跳过并把进度条直接推到对应位置。
                "uploaded_parts": done.iter().map(|(n, _, sz)| json!({"part_number": n, "size": sz})).collect::<Vec<_>>(),
                "resumed": !done.is_empty(),
            }))
            .into_response())
        }
        Err(e) => {
            // 只删「本次新建的」行;续传失败别把用户已经传了一半的断点删了。
            if resume.is_none() {
                let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
            }
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
/// 每个请求只有一片(8MiB),任何代理都过得去;失败只重这一片(前端另有 3 次重试)。
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
    let key = upload_key_of(&state, sid, iid).await?;
    let p = state
        .storage
        .multipart_part(&key, &q.upload_id, q.part_number, body.to_vec())
        .await
        .map_err(AppError::Other)?;
    Ok(Json(json!({ "part_number": q.part_number, "etag": p.e_tag().unwrap_or_default() })))
}

#[derive(Deserialize)]
pub struct PartIn {
    // 只反序列化用来对数(清单以服务端 ListParts 为准),字段本身不再读——别删,
    // 删了前端交回的 JSON 会因为多余字段…… serde 默认忽略未知字段,但保留它是接口契约的一部分。
    #[allow(dead_code)]
    pub part_number: i32,
    #[allow(dead_code)]
    pub etag: String,
}

#[derive(Deserialize)]
pub struct CompleteIn {
    pub upload_id: String,
    /// 前端本次传的分片(续传时只有增量,甚至可能为空)。**只用来对数**,
    /// 真正提交的清单来自服务端 ListParts。
    #[serde(default)]
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
    let key = upload_key_of(&state, sid, iid).await?;
    // ★分片清单以 S3 为准★(断点续传后必须这样):续传时前端手里只有**本次**传的那几片的 ETag,
    // 上一轮传好的它根本没有。ListParts 是权威来源,拿它组装;前端交回的 parts 只用来对数量、
    // 对不上就把两边的数字写进日志(不拦——以服务端看到的为准更安全)。
    let listed = state.storage.list_parts(&key, &input.upload_id).await.map_err(AppError::Other)?;
    if listed.is_empty() {
        return Err(AppError::BadRequest("这个上传没有任何已完成的分片(可能已过期或被清理)".into()));
    }
    if listed.len() != input.parts.len() {
        tracing::info!(item = iid, listed = listed.len(), client = input.parts.len(), "complete:分片数与前端不一致(续传属正常)");
    }
    let parts: Vec<_> = listed
        .iter()
        .map(|(n, etag, _)| {
            aws_sdk_s3::types::CompletedPart::builder().part_number(*n).e_tag(etag.as_str()).build()
        })
        .collect();
    state.storage.multipart_complete(&key, &input.upload_id, parts).await.map_err(AppError::Other)?;
    let head = state.storage.s3.head_object().bucket(&state.storage.bucket).key(&key).send().await
        .map_err(|e| AppError::Other(e.into()))?;
    let size = head.content_length().unwrap_or(0);
    // ★完整性校验★(2026-08-04 二轮审计,我自己 P2 代码里的洞):分片清单以 ListParts 为准之后,
    // 「只传了一半就调 complete」会拼出一个**不完整却报成功**的文件 —— 静默数据损坏,最难查。
    // begin 时把前端申报的大小记进了 items.size,这里对账:差一个字节都不认。
    let declared: Option<i64> = sqlx::query_scalar("SELECT size FROM items WHERE id = $1")
        .bind(iid).fetch_optional(&state.pool).await?.flatten();
    if let Some(d) = declared.filter(|d| *d > 0) {
        if d != size {
            tracing::warn!(item = iid, declared = d, actual = size, "complete:大小对不上,判定为不完整上传");
            return Err(AppError::BadRequest(format!(
                "上传不完整(应为 {d} 字节,实到 {size} 字节)——分片没传全,把同一个文件再拖进来可从断点继续")));
        }
    }
    // ★按实际大小复核配额★(2026-08-04 审计):begin 只按前端**申报**的 size 预判,
    // 而预签名 PUT 不限制单片实际字节数——申报 1MB 传 5GB 就把配额绕过去了。
    // 超了就地回滚(删对象 + 删行),不留既成事实。
    let (quota, used) = space_quota_used(&state.pool, sid).await?;
    if used + size > quota {
        let _ = state.storage.delete(&key).await;
        let _ = sqlx::query("DELETE FROM items WHERE id = $1 AND s3_key IS NULL").bind(iid).execute(&state.pool).await;
        return Err(AppError::BadRequest("实际大小超出空间配额,已回滚本次上传".into()));
    }
    // 落 s3_key 的同时清掉续传痕迹:这一行已经完成,不该再被当成断点认领。
    sqlx::query("UPDATE items SET s3_key = $1, size = $2, upload_id = NULL, upload_fp = NULL, upload_key = NULL, updated_at = now() WHERE id = $3")
        .bind(&key)
        .bind(size)
        .bind(iid)
        .execute(&state.pool)
        .await?;
    // ★后台核验哈希★(迁移 0005):直传的字节没经过我们,sha256 只是客户端申报的,
    // 不核验就当秒传源会造成静默数据损坏。这里从对象存储**内部**读一遍算真值(不占用户带宽),
    // 算完置 sha_verified;与申报不符就以真值为准(那条假记录自然再也命中不了秒传)。
    tokio::spawn(verify_sha(state.clone(), iid, key.clone()));
    // 录屏/录音传完即自动排队生成纪要(2026-08-05):后台队列串行跑,用户不用再点一次。
    enqueue_analysis(&state, iid, id.require_username()?).await;
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
    let key = upload_key_of(&state, sid, iid).await?;
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
    // ★只对可播类型放行★(2026-08-04 审计):/play 会吐一条 6 小时的预签名直链,
    // 谁拿到谁能取原件。对 video 这是刻意的(能播就能录屏,D4 也明说不拦播放);
    // 但对 pdf/zip/doc 就等于**把 viewer_no_download 整条开关废掉**——viewer 打一下
    // /api/items/{id}/play 就拿到原件下载地址。所以这里钉死 kind。
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT kind, s3_key FROM items WHERE id = $1")
        .bind(iid)
        .fetch_optional(&state.pool)
        .await?;
    let Some((kind, key)) = row else { return Err(AppError::NotFound) };
    if kind != "video" {
        return Err(AppError::BadRequest("只有录屏/视频能用播放地址(其他类型走 /download,受空间下载策略约束)".into()));
    }
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

/// 直传期间该用哪个 key:begin 时记在 items.upload_key(内容寻址后不能再按 sid/iid 现拼)。
/// 老行没有这一列就退回旧规则,不至于把历史上传搞挂。
async fn upload_key_of(state: &AppState, sid: i64, iid: i64) -> AppResult<String> {
    let k: Option<String> = sqlx::query_scalar("SELECT upload_key FROM items WHERE id = $1")
        .bind(iid).fetch_optional(&state.pool).await?.flatten();
    Ok(k.unwrap_or_else(|| format!("spaces/{sid}/{iid}/blob")))
}

/// 后台核验对象的真实 sha256(从集群内部流式读,不占用户带宽)。
async fn verify_sha(state: AppState, iid: i64, key: String) {
    use sha2::{Digest, Sha256};
    // ⚠ 别 `use futures_util::TryStreamExt`:try_next 是 ByteStream 的**固有方法**,
    //   加了那个 import 反而是 unused(v0.3.27 因此删过这个依赖)。
    let mut hasher = Sha256::new();
    let stream = match state.storage.get_stream(&key).await {
        Ok((s, _)) => s,
        Err(e) => { tracing::warn!(error = %e, item = iid, "核验哈希:读对象失败"); return }
    };
    let mut body = stream;
    loop {
        match body.try_next().await {
            Ok(Some(chunk)) => hasher.update(&chunk),
            Ok(None) => break,
            Err(e) => { tracing::warn!(error = %e, item = iid, "核验哈希:读流中断"); return }
        }
    }
    let real = hex::encode(hasher.finalize());
    let declared: Option<String> = sqlx::query_scalar("SELECT sha256 FROM items WHERE id = $1")
        .bind(iid).fetch_optional(&state.pool).await.ok().flatten().flatten();
    if declared.as_deref() != Some(real.as_str()) {
        tracing::warn!(item = iid, declared = ?declared, real = %&real[..8], "核验哈希:与客户端申报不符,以真值为准");
    }
    let _ = sqlx::query("UPDATE items SET sha256 = $2, sha_verified = true WHERE id = $1")
        .bind(iid).bind(&real).execute(&state.pool).await;
    tracing::info!(item = iid, sha = %&real[..8], "核验哈希:完成,可作秒传源");
}

/// 撞名时的随机后缀(短即可,只为避免覆盖已有对象)。
fn rand_suffix() -> String {
    use std::io::Read;
    let mut b = [0u8; 4];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("/dev/urandom");
    hex::encode(b)
}

// ── 录屏分析(转写 + 纪要),docs/VIDEO-SUMMARY.md P1 ────────────────────────

/// 这一项能不能做转写+纪要:**视频**或**音频**。
/// 音频没有单独的 kind(items.kind 的 CHECK 只有 folder/doc/file/video),按 mime 认——
/// 加一档 kind 要改 CHECK 约束还要牵动图标/播放器/预览三处,收益不抵改动面。
pub async fn analyzable(pool: &sqlx::PgPool, iid: i64) -> AppResult<bool> {
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT kind, mime FROM items WHERE id = $1")
        .bind(iid).fetch_optional(pool).await?;
    let (kind, mime) = row.ok_or(AppError::NotFound)?;
    Ok(kind == "video" || mime.as_deref().is_some_and(|m| m.starts_with("audio/")))
}

/// 排一个分析任务(幂等:同一项已有 queued/running 就什么都不做)。
/// 上传完成后自动调用——用户传完录音/录屏不用再点一次「生成纪要」(2026-08-05 需求)。
/// ⚠ 只在 ASR 端点已注入时排:没配就排 = 攒一堆必败的任务,还把失败态摆给用户看。
pub async fn enqueue_analysis(state: &AppState, iid: i64, actor: &str) {
    if state.config.asr_base_url.is_none() { return }
    match analyzable(&state.pool, iid).await {
        Ok(true) => {}
        _ => return,
    }
    let r = sqlx::query("INSERT INTO media_jobs (item_id, requested_by) VALUES ($1,$2) ON CONFLICT DO NOTHING")
        .bind(iid).bind(actor).execute(&state.pool).await;
    match r {
        Ok(q) if q.rows_affected() > 0 => tracing::info!(item = iid, "上传完成:已自动排队生成纪要"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, item = iid, "自动排队失败(用户仍可手动点生成)"),
    }
}

/// POST /api/items/{id}/analyze(≥editor)—— 排一个分析任务。
/// 已有在跑的任务就返回它(唯一部分索引挡住重复排队),不报错。
pub async fn analyze(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    if !analyzable(&state.pool, iid).await? {
        return Err(AppError::BadRequest("只能分析视频或音频".into()));
    }
    let job: Option<i64> = sqlx::query_scalar(
        "INSERT INTO media_jobs (item_id, requested_by) VALUES ($1,$2)
         ON CONFLICT DO NOTHING RETURNING id",
    )
    .bind(iid).bind(id.require_username()?)
    .fetch_optional(&state.pool).await?;
    let job_id = match job {
        Some(j) => j,
        // 冲突了才走这:多半是已有在跑的任务。但它可能**恰好在这一瞬跑完**,
        // fetch_one 会 RowNotFound → 500(2026-08-04 审计)。取最近一条兜底。
        None => sqlx::query_scalar("SELECT id FROM media_jobs WHERE item_id=$1 ORDER BY id DESC LIMIT 1")
            .bind(iid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?,
    };
    Ok(Json(json!({ "job_id": job_id })))
}

/// GET /api/items/{id}/analysis(≥viewer)—— 任务状态 + 逐字稿 + 三份纪要。
pub async fn analysis(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Viewer).await?;
    let job: Option<(String, String, i32, Option<String>)> = sqlx::query_as(
        "SELECT status, stage, progress, error FROM media_jobs WHERE item_id=$1 ORDER BY id DESC LIMIT 1",
    ).bind(iid).fetch_optional(&state.pool).await?;
    let tr: Option<(String, Option<serde_json::Value>, Option<f64>, Option<serde_json::Value>, Option<serde_json::Value>)> =
        sqlx::query_as("SELECT text, segments, duration_sec, char_ts, fine FROM transcripts WHERE item_id=$1")
            .bind(iid).fetch_optional(&state.pool).await?;
    // 库里存的是 ASR 原始细分段(按逗号结句,平均 2.4s/14 字);读取时才合并成可读段落,
    // 这样调阈值不必重跑 ASR(调研结论,见 docs/VIDEO-SUMMARY.md §10)。
    let tr = tr.map(|(text, segs, dur, cts, fine_cached)| {
        let fine: Vec<crate::media_ai::Segment> = segs
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        // 同字幕:先按全文重排句界,再合并成可读段落。
        let char_ts: Vec<(f64, f64)> = cts.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        // 优先用转写时算好的重排结果(迁移 0008);没有再现算(老数据)。
        let fine = fine_cached
            .and_then(|v| serde_json::from_value::<Vec<crate::media_ai::Segment>>(v).ok())
            .unwrap_or_else(|| crate::media_ai::realign(&text, &fine, &char_ts).unwrap_or(fine));
        let drift = crate::media_ai::timeline_drift(&fine, dur);
        let merged = serde_json::to_value(crate::media_ai::merge_paragraphs(&fine)).ok();
        (text, merged, dur, drift)
    });
    let sums: Vec<(String, String)> = sqlx::query_as("SELECT kind, content FROM summaries WHERE item_id=$1")
        .bind(iid).fetch_all(&state.pool).await?;
    Ok(Json(json!({
        "job": job.map(|(status, stage, progress, error)| json!({
            "status": status, "stage": stage, "progress": progress, "error": error })),
        "transcript": tr.map(|(text, segments, duration, drift)| json!({
            "text": text, "segments": segments, "duration_sec": duration,
            // 时间轴漂移自检:>0 表示尾部有多少秒没有文字覆盖(见 media_ai::timeline_drift)。
            "drift_sec": drift })),
        "summaries": sums.into_iter().map(|(k, c)| json!({"kind": k, "content": c})).collect::<Vec<_>>(),
        "asr_ready": state.config.asr_base_url.is_some(),
    })))
}

/// GET /api/items/{id}/subtitles.vtt(≥viewer)—— 把转写分段转成 WebVTT 字幕轨。
/// 挂到 <video> 的 <track> 上就是**原生实时字幕**(播放器自带开关/样式,不用自己画)。
/// 说话人作为前缀写进 cue 文本(`spk0: …`),这样字幕里也看得出谁在说。
pub async fn subtitles(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Response> {
    let sid = crate::http::items::space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Viewer).await?;
    let row: Option<(String, Option<serde_json::Value>, Option<serde_json::Value>, Option<serde_json::Value>)> =
        sqlx::query_as("SELECT text, segments, char_ts, fine FROM transcripts WHERE item_id=$1")
            .bind(iid).fetch_optional(&state.pool).await?;
    let (text, segs, cts, fine_cached) = row.unwrap_or_default();
    let char_ts: Vec<(f64, f64)> = cts.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    // 字幕用**更短的**合并阈值:Netflix 简中规范单行 16 字 ×2 行 = 32 字、时长 1.2~7 秒。
    // 逐字稿那套 200 字的段落直接当字幕会糊满屏(v0.3.19 的错,已分开)。
    let fine: Vec<crate::media_ai::Segment> = segs
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    // 句界重排(见 media_ai::realign)。转写时已经算好存进 transcripts.fine(迁移 0008),
    // 这里直接用;老转写没有那列才现算——每次请求重算 17000 字纯属浪费(审计 2026-08-04)。
    let fine = fine_cached
        .and_then(|v| serde_json::from_value::<Vec<crate::media_ai::Segment>>(v).ok())
        .unwrap_or_else(|| crate::media_ai::realign(&text, &fine, &char_ts).unwrap_or(fine));
    let cues = crate::media_ai::merge_cues(&fine);
    let mut out = String::from("WEBVTT\n\n");
    for (i, s) in cues.iter().enumerate() {
        let txt = s.text.trim();
        if txt.is_empty() { continue }
        // 时长下限 1.2s:太短的 cue 一闪而过读不完(Netflix 硬下限 5/6 秒,中文取 1.2)。
        // ★但绝不能压到下一条头上★(2026-08-04 反馈「字幕位置一直在变动」):
        //   重叠的 cue 在 WebVTT 里是合法的,浏览器会**同时渲染并上下叠放**,于是字幕忽高忽低。
        //   实测这份 61 分钟的稿子有 43/917 条(4.7%)因为这条下限规则压到了后一条身上,最长重叠 1.0s。
        //   现在拉长到「下一条开始前 40ms」为止;实在没空间就保底 0.3s,宁可短也不重叠。
        //   收尾规则:顶到**下一条开始为止**(相接不相叠)。留 0.3s 保底那版还剩 6 条重叠——
        //   保底值本身就会压过去,所以干脆不留:实测 917 条里最短 0.20s(「对,」这种短插话),
        //   重叠 **0 条**。短一点无非是一闪,叠起来却会让整条字幕跳位置。
        let mut en = s.end.max(s.start + 1.2);
        if let Some(next) = cues.get(i + 1) { en = en.min(next.start) }
        let en = en.max(s.start + 0.05); // 兜底:时间戳异常时也不产出零长/倒挂的 cue
        let prefix = s.speaker.as_deref().map(|k| format!("{k}: ")).unwrap_or_default();
        // `line:-2` = 从底往上第二行:位置**固定**,不再随「控制条显示/隐藏」上下跳
        //   (line 缺省是 auto,浏览器会自己挪来避开控制条);留一行余量正好让开控制条。
        // `align:center` 明确水平居中,不依赖各浏览器默认值。
        out.push_str(&format!(
            "{}\n{} --> {} line:-2 align:center\n{prefix}{txt}\n\n",
            i + 1, vtt_time(s.start), vtt_time(en)));
    }
    Ok(([(header::CONTENT_TYPE, "text/vtt; charset=utf-8")], out).into_response())
}

fn vtt_time(t: f64) -> String {
    let t = t.max(0.0);
    let h = (t / 3600.0) as u64;
    let m = ((t % 3600.0) / 60.0) as u64;
    let s = t % 60.0;
    format!("{h:02}:{m:02}:{s:06.3}")
}
