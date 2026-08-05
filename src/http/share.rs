//! 公开分享链接(2026-08-05 用户需求:对标百度网盘 —— 提取码 / 有效期 / 次数上限 / 访问统计)。
//!
//! ★这是本系统第一个绕过空间授权的入口,所以整章按 fail-closed 写★:
//! - 令牌不存在、过期、超次数、被撤销 → **一律 404**,不区分。区分了就成了探测工具
//!   (「这个令牌存在只是过期了」本身就是信息)。
//! - **创建要 ≥editor**:viewer 只能看,不该有把内容捅到墙外的能力。
//! - 公开面在 `/pub/*`,**不经过 require_auth**(访客没有会话);但它只认令牌 + 提取码,
//!   拿不到任何空间级能力。
//! - 解锁后发一张**短命签名票**(HS256,2h),后续取内容都要带它——避免把提取码反复放在 URL 里。
//! - 文件夹分享可以逛子树,但每次取内容都**验它确实是被分享项的后代**(递归 CTE),
//!   否则改一个 item_id 就能越权取到同空间别的文件。

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::audit;
use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::http::items::space_of;
use crate::perm::{require_role, Role};
use crate::state::AppState;

/// 解锁票有效期:2 小时。够看完一份材料;过期再输一次提取码即可。
const TICKET_TTL_SEC: usize = 2 * 3600;

// ── 管理面(需登录,挂在 /api 下)──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateIn {
    /// 提取码。留空 = 不要提取码(链接即可访问);给了就存加盐 sha256,不存明文。
    #[serde(default)]
    pub code: Option<String>,
    /// 有效期(天)。0 或不给 = 永不过期。
    #[serde(default)]
    pub expires_days: Option<i64>,
    /// 访问次数上限。不给 = 不限。
    #[serde(default)]
    pub max_visits: Option<i32>,
    /// 是否允许下载原件。false = 只能在线看。
    #[serde(default = "yes")]
    pub allow_download: bool,
    /// 多选分享:一并放进这条链接的其它项(必须与主项**同一空间**,逐个校验)。
    #[serde(default)]
    pub items: Vec<i64>,
}
fn yes() -> bool { true }

/// POST /api/items/{id}/shares —— 建一条公开分享链接(**≥editor**)。
/// `items` 里可以再带若干项 → **一条链接带多份内容**(多选分享,2026-08-05);
/// 路径上的 {id} 是「主项」,访客页的标题与根目录用它。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<CreateIn>,
) -> AppResult<Json<serde_json::Value>> {
    let sid = space_of(&state.pool, iid).await?;
    // ★editor 而不是 viewer★:公开分享是把内容送出墙外,不是「看」的延伸。
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    let actor = id.require_username()?;

    let code = input.code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    if let Some(c) = &code {
        if c.chars().count() < 4 || c.chars().count() > 32 {
            return Err(AppError::BadRequest("提取码 4~32 个字符".into()));
        }
    }
    let (salt, hash) = match &code {
        Some(c) => { let s = rand_hex(8); let h = code_hash(&s, c); (Some(s), Some(h)) }
        None => (None, None),
    };
    let expires_days = input.expires_days.filter(|d| *d > 0);
    let max_visits = input.max_visits.filter(|v| *v > 0);
    let token = rand_hex(16);
    sqlx::query(
        "INSERT INTO share_links (token, item_id, code_salt, code_hash, expires_at, max_visits, allow_download, created_by)
         VALUES ($1,$2,$3,$4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() + ($5 || ' days')::interval END, $6,$7,$8)",
    )
    .bind(&token).bind(iid).bind(&salt).bind(&hash)
    .bind(expires_days).bind(max_visits).bind(input.allow_download).bind(actor)
    .execute(&state.pool).await?;
    // 多选:主项 + 附加项都登记进 share_items。附加项必须同空间(否则等于跨空间越权打包)。
    let mut all: Vec<i64> = vec![iid];
    for extra in input.items.iter().copied().filter(|x| *x != iid) {
        if space_of(&state.pool, extra).await? != sid {
            return Err(AppError::BadRequest("只能把同一空间的内容放进同一条分享".into()));
        }
        all.push(extra);
    }
    for x in &all {
        sqlx::query("INSERT INTO share_items (token, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(&token).bind(x).execute(&state.pool).await?;
    }
    audit::record(&state.pool, actor, "share.create", &iid.to_string(),
        &format!("token={} code={} days={:?} max={:?} download={}",
            &token[..8], if code.is_some() { "有" } else { "无" }, expires_days, max_visits, input.allow_download)).await;
    Ok(Json(json!({ "token": token, "code": code })))
}

/// GET /api/items/{id}/shares —— 本项的分享链接列表(**≥editor**,含访问次数)。
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let sid = space_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, sid, Role::Editor).await?;
    let rows: Vec<(String, Option<chrono::DateTime<chrono::Utc>>, Option<i32>, i32, bool, String,
                   chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>,
                   Option<chrono::DateTime<chrono::Utc>>, bool)> = sqlx::query_as(
        "SELECT token, expires_at, max_visits, visits, allow_download, created_by, created_at,
                revoked_at, last_visit_at, (code_hash IS NOT NULL)
           FROM share_links WHERE item_id = $1 ORDER BY created_at DESC",
    ).bind(iid).fetch_all(&state.pool).await?;
    Ok(Json(rows.into_iter().map(|(t, exp, maxv, v, dl, by, at, rev, last, has_code)| json!({
        "token": t, "expires_at": exp, "max_visits": maxv, "visits": v, "allow_download": dl,
        "created_by": by, "created_at": at, "revoked_at": rev, "last_visit_at": last, "has_code": has_code,
    })).collect()))
}

/// GET /api/shares/mine —— **我发出去的全部分享**(跨空间)。
/// 2026-08-05 用户:分享链接要有个独立的地方统一看,而不是散在每个文件的对话框里。
/// 只回我自己创建的(别人的分享与我无关);带上内容名、空间名、访问次数与状态。
pub async fn mine(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let me = id.require_username()?;
    let rows: Vec<(String, i64, String, String, Option<String>, String,
                   Option<chrono::DateTime<chrono::Utc>>, Option<i32>, i32, bool,
                   chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>,
                   Option<chrono::DateTime<chrono::Utc>>, bool, i64)> = sqlx::query_as(
        "SELECT l.token, i.id, i.kind, i.name, i.mime, s.name,
                l.expires_at, l.max_visits, l.visits, l.allow_download, l.created_at,
                l.revoked_at, l.last_visit_at, (l.code_hash IS NOT NULL),
                (SELECT count(*) FROM share_items si WHERE si.token = l.token)
           FROM share_links l
           JOIN items  i ON i.id = l.item_id
           JOIN spaces s ON s.id = i.space_id
          WHERE l.created_by = $1
          ORDER BY l.created_at DESC LIMIT 500",
    ).bind(me).fetch_all(&state.pool).await?;
    Ok(Json(rows.into_iter().map(|(token, iid, kind, name, mime, space, exp, maxv, v, dl, at, rev, last, has_code, cnt)| json!({
        "token": token, "item_id": iid, "kind": kind, "name": name, "mime": mime, "space": space,
        "expires_at": exp, "max_visits": maxv, "visits": v, "allow_download": dl,
        "created_at": at, "revoked_at": rev, "last_visit_at": last, "has_code": has_code,
        "item_count": if cnt > 0 { cnt } else { 1 },
    })).collect()))
}

/// DELETE /api/shares/{token} —— 撤销(创建者或空间 admin)。保留行,便于事后审计与统计。
pub async fn revoke(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(token): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(i64, String)> = sqlx::query_as("SELECT item_id, created_by FROM share_links WHERE token = $1")
        .bind(&token).fetch_optional(&state.pool).await?;
    let Some((iid, creator)) = row else { return Err(AppError::NotFound) };
    let sid = space_of(&state.pool, iid).await?;
    let me = id.require_username()?;
    // 创建者本人,或该空间的 admin。
    if creator != me { require_role(&state.pool, &id, sid, Role::Admin).await?; }
    else { require_role(&state.pool, &id, sid, Role::Editor).await?; }
    sqlx::query("UPDATE share_links SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL")
        .bind(&token).execute(&state.pool).await?;
    audit::record(&state.pool, me, "share.revoke", &iid.to_string(), &token[..8]).await;
    Ok(Json(json!({ "ok": true })))
}

// ── 公开面(不需登录,挂在 /pub 下)────────────────────────────────────────────

/// 一条可用的分享(过期/超次数/撤销都取不到)。
struct Live { item_id: i64, has_code: bool, salt: Option<String>, hash: Option<String>, allow_download: bool }

/// 本条分享的**全部根**(多选时 N 个;老链接没登记 share_items 就退回主项一个)。
async fn share_roots(pool: &sqlx::PgPool, token: &str, main: i64) -> AppResult<Vec<i64>> {
    let rows: Vec<i64> = sqlx::query_scalar("SELECT item_id FROM share_items WHERE token = $1").bind(token)
        .fetch_all(pool).await?;
    Ok(if rows.is_empty() { vec![main] } else { rows })
}

async fn live(pool: &sqlx::PgPool, token: &str) -> AppResult<Live> {
    // 令牌形状先卡一道:非 32 位十六进制根本不查库(省得被拿来刷)。
    if token.len() != 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::NotFound);
    }
    let row: Option<(i64, Option<String>, Option<String>, bool)> = sqlx::query_as(
        "SELECT item_id, code_salt, code_hash, allow_download FROM share_links
          WHERE token = $1 AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND (max_visits IS NULL OR visits < max_visits)",
    ).bind(token).fetch_optional(pool).await?;
    // ★不区分「不存在 / 过期 / 超次数 / 已撤销」★:区分了就是给探测者送信息。
    let (item_id, salt, hash, allow_download) = row.ok_or(AppError::NotFound)?;
    Ok(Live { item_id, has_code: hash.is_some(), salt, hash, allow_download })
}

/// GET /pub/share/{token} —— 只回「要不要提取码」。**不回文件名**(没验证之前不给任何内容信息),
/// 也不计访问次数(计数发生在真正打开时)。
pub async fn pub_meta(State(state): State<AppState>, Path(token): Path<String>) -> AppResult<Json<serde_json::Value>> {
    let l = live(&state.pool, &token).await?;
    Ok(Json(json!({ "needs_code": l.has_code })))
}

#[derive(Deserialize)]
pub struct OpenIn { #[serde(default)] pub code: Option<String> }

/// POST /pub/share/{token}/open —— 校验提取码 → 计一次访问 → 发短命票 + 回内容元数据。
pub async fn pub_open(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Json(input): Json<OpenIn>,
) -> AppResult<Json<serde_json::Value>> {
    let l = live(&state.pool, &token).await?;
    if l.has_code {
        let given = input.code.unwrap_or_default();
        let ok = match (&l.salt, &l.hash) {
            (Some(s), Some(h)) => ct_eq(&code_hash(s, given.trim()), h),
            _ => false,
        };
        if !ok { return Err(AppError::BadRequest("提取码不对".into())) }
    }
    // ★原子计数 + 次数上限★:并发打开时不会冲破上限(条件写在 UPDATE 的 WHERE 里)。
    let bumped: Option<i32> = sqlx::query_scalar(
        "UPDATE share_links SET visits = visits + 1, last_visit_at = now()
          WHERE token = $1 AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND (max_visits IS NULL OR visits < max_visits)
      RETURNING visits",
    ).bind(&token).fetch_optional(&state.pool).await?;
    if bumped.is_none() { return Err(AppError::NotFound) }
    // 访问明细只留粗粒度(IP /24、UA 摘要):够统计「多少不同的人来过」,不攒可识别信息。
    let ipp = ip_prefix(&peer, &headers);
    let uah = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok())
        .map(|ua| hex::encode(Sha256::digest(ua.as_bytes()))[..16].to_string());
    let _ = sqlx::query("INSERT INTO share_visits (token, ip_prefix, ua_hash) VALUES ($1,$2,$3)")
        .bind(&token).bind(&ipp).bind(&uah).execute(&state.pool).await;

    let it = item_brief(&state.pool, l.item_id).await?;
    let roots = share_roots(&state.pool, &token, l.item_id).await?;
    Ok(Json(json!({
        "ticket": issue_ticket(&state, &token)?, "item": it,
        "allow_download": l.allow_download, "multi": roots.len() > 1, "count": roots.len(),
    })))
}

#[derive(Deserialize)]
pub struct TicketQuery {
    /// 解锁票(pub_open 发的)。
    pub k: String,
    /// 文件夹分享时:要列哪个子目录(必须是被分享项的后代)。
    #[serde(default)]
    pub parent: Option<i64>,
    #[serde(default)]
    pub inline: Option<i32>,
}

/// GET /pub/share/{token}/list?k=&parent= —— 列子目录(文件夹分享)。
pub async fn pub_list(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<TicketQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let l = live(&state.pool, &token).await?;
    check_ticket(&state, &token, &q.k)?;
    let roots = share_roots(&state.pool, &token, l.item_id).await?;
    // 不带 parent:多选分享列「所有根」;单选就是那一项(文件夹则列它的子项)。
    let parent = match q.parent {
        Some(p) => { ensure_any_descendant(&state.pool, &roots, p).await?; p }
        None if roots.len() > 1 => {
            let rows: Vec<(i64, String, String, Option<i64>, Option<String>, chrono::DateTime<chrono::Utc>)> =
                sqlx::query_as("SELECT id, kind, name, size, mime, created_at FROM items
                                 WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY kind = 'folder' DESC, name")
                    .bind(&roots).fetch_all(&state.pool).await?;
            return Ok(Json(rows.into_iter().map(|(id, kind, name, size, mime, at)| json!({
                "id": id, "kind": kind, "name": name, "size": size, "mime": mime, "created_at": at,
            })).collect()));
        }
        None => l.item_id,
    };
    let rows: Vec<(i64, String, String, Option<i64>, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, kind, name, size, mime, created_at FROM items
          WHERE parent_id = $1 AND (kind IN ('folder','doc') OR s3_key IS NOT NULL)
          ORDER BY kind = 'folder' DESC, name",
    ).bind(parent).fetch_all(&state.pool).await?;
    Ok(Json(rows.into_iter().map(|(id, kind, name, size, mime, at)| json!({
        "id": id, "kind": kind, "name": name, "size": size, "mime": mime, "created_at": at,
    })).collect()))
}

/// GET /pub/share/{token}/file/{item_id}?k=&inline= —— 取内容(流式转发,不暴露对象存储)。
pub async fn pub_file(
    State(state): State<AppState>,
    Path((token, iid)): Path<(String, i64)>,
    Query(q): Query<TicketQuery>,
) -> AppResult<Response> {
    let l = live(&state.pool, &token).await?;
    check_ticket(&state, &token, &q.k)?;
    let roots = share_roots(&state.pool, &token, l.item_id).await?;
    ensure_any_descendant(&state.pool, &roots, iid).await?;
    let inline = q.inline.unwrap_or(0) == 1;
    // 分享方关掉「允许下载」时只放行在线预览(inline),不给原件。
    if !l.allow_download && !inline {
        return Err(AppError::BadRequest("该分享未开放下载".into()));
    }
    let row: Option<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT s3_key, name, mime FROM items WHERE id = $1").bind(iid)
            .fetch_optional(&state.pool).await?;
    let Some((Some(key), name, mime)) = row else { return Err(AppError::NotFound) };
    let (stream, len) = state.storage.get_stream(&key).await.map_err(AppError::Other)?;
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(stream.into_async_read()));
    let mime_s = mime.clone().unwrap_or_default();
    // inline 白名单同 items::download:HTML/SVG 一律 attachment,避免在我们域下执行访客内容。
    let inline_ok = mime_s == "application/pdf"
        || (mime_s.starts_with("image/") && mime_s != "image/svg+xml")
        || mime_s.starts_with("video/") || mime_s.starts_with("audio/") || mime_s == "text/plain";
    let disp = if inline && inline_ok { "inline" } else { "attachment" };
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.unwrap_or_else(|| "application/octet-stream".into()))
        .header(header::CONTENT_DISPOSITION, format!("{disp}; filename*=UTF-8''{}", crate::http::items::urlencode(&name)))
        // 公开内容别让中间层缓存(链接可撤销、可过期)。
        .header(header::CACHE_CONTROL, "private, no-store");
    if let Some(l) = len { resp = resp.header(header::CONTENT_LENGTH, l) }
    Ok(resp.body(body).map_err(|e| AppError::Other(e.into()))?)
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

async fn item_brief(pool: &sqlx::PgPool, iid: i64) -> AppResult<serde_json::Value> {
    let row: Option<(i64, String, String, Option<i64>, Option<String>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT id, kind, name, size, mime, created_at FROM items WHERE id = $1")
            .bind(iid).fetch_optional(pool).await?;
    let (id, kind, name, size, mime, at) = row.ok_or(AppError::NotFound)?;
    Ok(json!({ "id": id, "kind": kind, "name": name, "size": size, "mime": mime, "created_at": at }))
}

/// 多根版本:命中任一根即可(多选分享)。
async fn ensure_any_descendant(pool: &sqlx::PgPool, roots: &[i64], target: i64) -> AppResult<()> {
    for r in roots {
        if ensure_descendant(pool, *r, target).await.is_ok() { return Ok(()) }
    }
    Err(AppError::NotFound)
}

/// 目标必须是被分享项本身或它的后代——文件夹分享时挡住「改个 item_id 越权取」。
async fn ensure_descendant(pool: &sqlx::PgPool, root: i64, target: i64) -> AppResult<()> {
    if root == target { return Ok(()) }
    let ok: bool = sqlx::query_scalar(
        "WITH RECURSIVE up AS (
           SELECT id, parent_id FROM items WHERE id = $2
           UNION ALL SELECT i.id, i.parent_id FROM items i JOIN up ON i.id = up.parent_id
         ) SELECT EXISTS (SELECT 1 FROM up WHERE id = $1)",
    ).bind(root).bind(target).fetch_one(pool).await?;
    if ok { Ok(()) } else { Err(AppError::NotFound) }
}

#[derive(Serialize, Deserialize)]
struct Ticket { tok: String, exp: usize }

/// 票的签名密钥:从平台注入的 AUTH_SECRET(或机密客户端 secret)派生,和会话 cookie 用不同的
/// 域分隔字符串——两者绝不能互相冒充。鉴权关闭的本地 dev 用固定串。
fn ticket_key(state: &AppState) -> Vec<u8> {
    let seed = state.config.oidc.as_ref()
        .and_then(|o| o.auth_secret.clone().or_else(|| o.client_secret.clone()))
        .unwrap_or_else(|| "congrove-dev".into());
    let mut h = Sha256::new();
    h.update(b"congrove-share-ticket-v1:");
    h.update(seed.as_bytes());
    h.finalize().to_vec()
}

fn issue_ticket(state: &AppState, token: &str) -> AppResult<String> {
    let key = ticket_key(state);
    let t = Ticket { tok: token.to_string(), exp: now_sec() + TICKET_TTL_SEC };
    encode(&Header::new(Algorithm::HS256), &t, &EncodingKey::from_secret(&key))
        .map_err(|e| AppError::Other(anyhow::anyhow!("签发分享票失败:{e}")))
}

fn check_ticket(state: &AppState, token: &str, ticket: &str) -> AppResult<()> {
    let key = ticket_key(state);
    let mut v = Validation::new(Algorithm::HS256);
    v.validate_aud = false;
    let data = decode::<Ticket>(ticket, &DecodingKey::from_secret(&key), &v).map_err(|_| AppError::NotFound)?;
    // 票只对签发它的那条分享有效(不能拿 A 的票取 B 的内容)。
    if data.claims.tok != token { return Err(AppError::NotFound) }
    Ok(())
}

/// 加盐哈希提取码。盐每条分享独立,所以同一个提取码在不同分享里哈希不同。
fn code_hash(salt: &str, code: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(b":");
    h.update(code.as_bytes());
    hex::encode(h.finalize())
}

/// 定长比较:两串都是等长十六进制,逐字节异或累加,不早退——不给计时侧信道。
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() { return false }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 随机十六进制。★直接读 /dev/urandom★,不引 rand 依赖也不用时间戳凑——
/// 令牌可猜 = 整个公开分享的安全性归零。读不到就 panic,绝不退化。
fn rand_hex(bytes: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("/dev/urandom 不可读——拒绝生成可猜的分享令牌");
    hex::encode(buf)
}

/// 访客 IP 的粗粒度前缀:v4 取 /24、v6 取 /48。网关后要认 X-Forwarded-For 的第一跳。
fn ip_prefix(peer: &std::net::SocketAddr, headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next()).map(str::trim).map(str::to_string)
        .unwrap_or_else(|| peer.ip().to_string());
    match raw.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V4(v4) => { let o = v4.octets(); Some(format!("{}.{}.{}.0/24", o[0], o[1], o[2])) }
        std::net::IpAddr::V6(v6) => { let s = v6.segments(); Some(format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2])) }
    }
}

fn now_sec() -> usize {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as usize).unwrap_or(0)
}
