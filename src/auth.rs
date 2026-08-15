//! 鉴权 —— 从 citeroot src/auth.rs 移植(2026-08-01),congrove 化的差异:
//! - 用户主键是 preferred_username(决策 A),登录即 upsert app_user 并按
//!   CONGROVE_SUPER_USERS 白名单置 is_super(只置不清,白名单是种子)。
//! - 会话签名密钥优先用平台注入的 AUTH_SECRET(重建保留不踢登录),缺省回退
//!   client_secret 派生;citeroot 只有后者。
//! - 无桌面端,但 Bearer 路径保留(成本≈0,给以后 CLI/脚本留门),allowed_azp
//!   只认 sub-congrove 自己。
//!
//! 两条入口、一个 Identity:
//! 1. 浏览器 = 服务端 OIDC(平台零配置 SSO):后端是机密客户端 sub-congrove,
//!    /auth/login → Keycloak → /auth/callback 服务端换码,自签 HS256 会话 cookie
//!    (HttpOnly)。SPA 永远不碰 token。
//! 2. Bearer JWT:出示 Keycloak access token,按 JWKS 自验(签名+iss+exp+azp+typ)。
//!
//! 鉴权开关 = 有没有配 OIDC_ISSUER。没配 = 关闭 + 启动大声 WARN(仅本地 dev,
//! require_auth 放行一个 dev/超管假身份让本地 CRUD 可用)。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, HOST, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use jsonwebtoken::{decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::config::OidcConfig;
use crate::error::AppError;
use crate::state::AppState;

/// 已验证的调用者,由 require_auth 插进 request extensions。
/// 鉴权关闭(本地 dev)时是 username="dev" + is_super 的假身份。
#[derive(Clone, Debug, Default)]
pub struct Identity {
    pub sub: Option<String>,
    pub username: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_super: bool,
}

impl Identity {
    /// 业务层拿用户名的唯一入口:已过 require_auth 必有,拿不到就是 bug → 401 兜底。
    pub fn require_username(&self) -> Result<&str, AppError> {
        self.username.as_deref().ok_or(AppError::Unauthorized)
    }
}

/// 我们读的 Keycloak access-token claims。iss/exp 由 Validation 查,不在这。
#[derive(Deserialize)]
struct Claims {
    sub: String,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    // azp = token 发给哪个 client。realm 全平台共享,只验签名+iss+exp 的话,
    // 发给**别的子系统**的 token 也能过——必须钉死 azp 是 congrove 自己的 client。
    #[serde(default)]
    azp: Option<String>,
    // token 类型:access token 是 "Bearer",ID token 是 "ID"。同一把 realm key 签的,
    // 不查这个 ID token 就能冒充 API bearer。
    #[serde(default)]
    typ: Option<String>,
}

/// 自签会话 cookie 的载荷(HS256 JWT,不是 Keycloak token)。
/// is_super 是登录时刻的快照(8h 会话),超管变更要重登录生效——P0 接受,别在每请求查库。
#[derive(Serialize, Deserialize)]
struct Session {
    username: String,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    is_super: bool,
    exp: usize,
}

/// 登录往返之间的短命签名 cookie:带 CSRF state + 回跳路径。
#[derive(Serialize, Deserialize)]
struct Flow {
    state: String,
    ret: String,
    exp: usize,
}

/// 机密客户端 + 会话 cookie 签名材料。平台注入了 OIDC_CLIENT_ID+SECRET 才有。
struct OidcClient {
    client_id: String,
    client_secret: String,
    enc: EncodingKey, // HS256,key = sha256(AUTH_SECRET 或 client_secret)
    dec: DecodingKey,
    hs256: Validation,
}

/// JWKS 活缓存 + 校验规则 + (可选)服务端 OIDC 客户端。
pub struct Auth {
    http: reqwest::Client,
    jwks_url: String,
    issuer: String,
    validation: Validation, // Keycloak RS256 access token
    keys: RwLock<HashMap<String, DecodingKey>>,
    oidc_client: Option<OidcClient>,
    /// Bearer 只认发给 congrove 自己 client 的 token(azp 钉死,防共享 realm 串门)。
    allowed_azp: Vec<String>,
    /// JWKS 重拉的单飞 + 限频闸:verify_bearer 在验签**前**就读了未签名头里的 kid,
    /// 乱造 kid 的 Bearer 洪水不能每发一个就打一次 Keycloak(未认证 DoS 放大器)。
    refresh_gate: tokio::sync::Mutex<Option<std::time::Instant>>,
}

/// kid miss 后的 JWKS 重拉间隔下限。正常的密钥轮换在一个间隔内就能拉到。
const REFRESH_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(20);

impl Auth {
    /// 启动时的 JWKS 首拉是 **best-effort**:Keycloak 抖一下不能把 pod 打成 CrashLoop,
    /// 空缓存靠首个 token 的 kid miss 惰性自愈。
    pub async fn new(cfg: &OidcConfig) -> anyhow::Result<Arc<Self>> {
        let http = build_http_client()?;

        let keys = match fetch_jwks(&http, &cfg.jwks_url).await {
            Ok(k) => {
                tracing::info!(keys = k.len(), "JWKS loaded at startup");
                k
            }
            Err(e) => {
                tracing::warn!(error = %e, url = %cfg.jwks_url,
                    "initial JWKS fetch failed — starting anyway, will retry on first token");
                HashMap::new()
            }
        };

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&cfg.issuer]);
        // Keycloak 默认 access-token 的 aud 不是 client id,没配 mapper 就别验 aud。
        validation.validate_aud = false;

        // 平台注入了机密客户端才开服务端浏览器 SSO。会话签名密钥:
        // 优先 AUTH_SECRET(平台注入、重建保留),回退 client_secret——两者都跨重启/多副本稳定。
        let oidc_client = match (&cfg.client_id, &cfg.client_secret) {
            (Some(id), Some(secret)) => {
                let seed = cfg.auth_secret.as_deref().unwrap_or(secret.as_str());
                let mut h = Sha256::new();
                h.update(b"congrove-session-v1:");
                h.update(seed.as_bytes());
                let key = h.finalize();
                let mut hs256 = Validation::new(Algorithm::HS256);
                hs256.validate_aud = false; // 自己签的 token
                tracing::info!(client_id = %id, "server-side browser SSO enabled");
                Some(OidcClient {
                    client_id: id.clone(),
                    client_secret: secret.clone(),
                    enc: EncodingKey::from_secret(&key),
                    dec: DecodingKey::from_secret(&key),
                    hs256,
                })
            }
            _ => None,
        };

        let allowed_azp = cfg.client_id.iter().cloned().collect();

        Ok(Arc::new(Self {
            http,
            jwks_url: cfg.jwks_url.clone(),
            issuer: cfg.issuer.trim_end_matches('/').to_string(),
            validation,
            keys: RwLock::new(keys),
            oidc_client,
            allowed_azp,
            refresh_gate: tokio::sync::Mutex::new(None),
        }))
    }

    /// 验 Keycloak access token(RS256,JWKS)→ 身份骨架(is_super 由调用方查库定)。
    /// Bearer 路径和换码回调共用。
    async fn verify_bearer(&self, token: &str) -> Option<(String, Claims)> {
        let kid = decode_header(token).ok().and_then(|h| h.kid)?;
        let key = self.lookup(&kid).await?;
        let data = decode::<Claims>(token, &key, &self.validation).ok()?;
        match &data.claims.azp {
            Some(azp) if self.allowed_azp.iter().any(|c| c == azp) => {}
            _ => {
                tracing::warn!(azp = ?data.claims.azp, "bearer rejected: azp not a congrove client");
                return None;
            }
        }
        if let Some(typ) = &data.claims.typ {
            if !typ.eq_ignore_ascii_case("Bearer") {
                tracing::warn!(typ = %typ, "bearer rejected: not an access token");
                return None;
            }
        }
        let username = data.claims.preferred_username.clone()?;
        Some((username, data.claims))
    }

    /// 签会话 cookie(HS256 JWT,8h)。服务端 SSO 未开时 None。
    fn issue_session(&self, id: &Identity) -> Option<String> {
        let oc = self.oidc_client.as_ref()?;
        let s = Session {
            username: id.username.clone().unwrap_or_default(),
            sub: id.sub.clone(),
            name: id.name.clone(),
            email: id.email.clone(),
            is_super: id.is_super,
            exp: now() + 8 * 3600,
        };
        encode(&Header::new(Algorithm::HS256), &s, &oc.enc).ok()
    }

    /// 验会话 cookie → 身份。
    fn verify_session(&self, token: &str) -> Option<Identity> {
        let oc = self.oidc_client.as_ref()?;
        let data = decode::<Session>(token, &oc.dec, &oc.hs256).ok()?;
        Some(Identity {
            sub: data.claims.sub,
            username: Some(data.claims.username),
            name: data.claims.name,
            email: data.claims.email,
            is_super: data.claims.is_super,
        })
    }

    /// 授权码换 access token(机密客户端,服务端带 secret)。
    async fn exchange_code(&self, oc: &OidcClient, code: &str, redirect_uri: &str) -> anyhow::Result<String> {
        #[derive(Deserialize)]
        struct Tok {
            access_token: String,
        }
        let url = format!("{}/protocol/openid-connect/token", self.issuer);
        let tok: Tok = self
            .http
            .post(url)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", oc.client_id.as_str()),
                ("client_secret", oc.client_secret.as_str()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(tok.access_token)
    }

    /// 按 kid 找签名 key。miss(= Keycloak 轮换密钥的样子)就限频重拉一次再试,
    /// 轮换不会 401 到重启。
    async fn lookup(&self, kid: &str) -> Option<DecodingKey> {
        if let Some(k) = self.keys.read().unwrap().get(kid).cloned() {
            return Some(k);
        }
        let mut last = self.refresh_gate.lock().await;
        if let Some(k) = self.keys.read().unwrap().get(kid).cloned() {
            return Some(k); // 别的任务刚拉完
        }
        let due = last.is_none_or(|t| t.elapsed() >= REFRESH_MIN_GAP);
        if !due {
            return None;
        }
        *last = Some(std::time::Instant::now());
        if let Err(e) = self.refresh().await {
            tracing::warn!(error = %e, "JWKS refresh failed after kid miss");
            return None;
        }
        self.keys.read().unwrap().get(kid).cloned()
    }

    async fn refresh(&self) -> anyhow::Result<()> {
        let keys = fetch_jwks(&self.http, &self.jwks_url).await?;
        let n = keys.len();
        *self.keys.write().unwrap() = keys;
        tracing::info!(keys = n, "JWKS refreshed");
        Ok(())
    }
}

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    kty: String,
    /// "sig" | "enc":Keycloak 同时发签名键和 RSA-OAEP 加密键,只要签名的。
    #[serde(rename = "use", default)]
    use_: Option<String>,
    n: Option<String>,
    e: Option<String>,
}
#[derive(Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

/// 拉 JWKS 用的 reqwest client。auth.ruciah.com 是内网 CA 签的,rustls 默认只信
/// webpki-roots 不读系统库 → UnknownIssuer。把平台挂在 SSL_CERT_FILE
/// (默认 /etc/ssl/iah/ca.crt)的内网 CA **追加**进去——公共根仍信,
/// 本地 dev 无此文件走公网不受影响。
pub(crate) fn build_http_client() -> anyhow::Result<reqwest::Client> {
    build_http_client_timeout(Duration::from_secs(15))
}

/// 长超时版(ASR 转写 / LLM 摘要可能跑几分钟;模型缩零冷启动官方说要等 1~5 分钟)。
pub(crate) fn build_http_client_long() -> anyhow::Result<reqwest::Client> {
    build_http_client_timeout(Duration::from_secs(900))
}

fn build_http_client_timeout(timeout: Duration) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder().timeout(timeout);

    let ca_path = std::env::var("SSL_CERT_FILE").unwrap_or_else(|_| "/etc/ssl/iah/ca.crt".into());
    match std::fs::read(&ca_path) {
        Ok(pem) => match reqwest::Certificate::from_pem_bundle(&pem) {
            Ok(certs) => {
                let n = certs.len();
                for cert in certs {
                    builder = builder.add_root_certificate(cert);
                }
                tracing::info!(ca = %ca_path, certs = n, "trusting internal CA for OIDC http client");
            }
            Err(e) => tracing::warn!(error = %e, ca = %ca_path, "internal CA present but unparseable"),
        },
        Err(_) => tracing::debug!(ca = %ca_path, "no internal CA file — using public roots only"),
    }

    Ok(builder.build()?)
}

async fn fetch_jwks(http: &reqwest::Client, url: &str) -> anyhow::Result<HashMap<String, DecodingKey>> {
    let set: JwkSet = http.get(url).send().await?.error_for_status()?.json().await?;

    let mut map = HashMap::new();
    for jwk in set.keys {
        if jwk.kty != "RSA" {
            continue;
        }
        if jwk.use_.as_deref() == Some("enc") {
            continue;
        }
        let (Some(n), Some(e)) = (jwk.n, jwk.e) else { continue };
        match DecodingKey::from_rsa_components(&n, &e) {
            Ok(k) => {
                map.insert(jwk.kid, k);
            }
            Err(err) => tracing::warn!(error = %err, "skipping malformed JWK"),
        }
    }
    if map.is_empty() {
        anyhow::bail!("JWKS at {url} had no usable RSA keys");
    }
    Ok(map)
}

/// 中间件:会话 cookie(浏览器)或 Bearer JWT 二选一,验过插 Identity。
/// 鉴权关闭时放行 dev 超管假身份(本地 CRUD 可用;线上绝不能跑没配 OIDC 的构建)。
pub async fn require_auth(State(state): State<AppState>, mut req: Request, next: Next) -> Result<Response, AppError> {
    let Some(auth) = state.auth.clone() else {
        req.extensions_mut().insert(Identity {
            username: Some("dev".into()),
            name: Some("本地开发".into()),
            is_super: true,
            ..Default::default()
        });
        return Ok(next.run(req).await);
    };

    let session_tok = cookie(req.headers(), "cg_session");
    let bearer_tok = bearer(req.headers()).map(str::to_string);

    // 1) 会话 cookie(浏览器 SSO)——纯本地验签,零网络零查库。
    if let Some(t) = session_tok {
        if let Some(id) = auth.verify_session(&t) {
            req.extensions_mut().insert(id);
            return Ok(next.run(req).await);
        }
    }
    // 2) Bearer JWT(CLI/脚本)。upsert 一次拿 is_super(低频路径,可承受一次查库)。
    if let Some(t) = bearer_tok {
        if let Some((username, claims)) = auth.verify_bearer(&t).await {
            let is_super = ensure_app_user(
                &state.pool,
                &username,
                claims.sub.as_str().into(),
                claims.name.as_deref(),
                claims.email.as_deref(),
                &state.config.super_users,
            )
            .await
            .map_err(AppError::Other)?;
            req.extensions_mut().insert(Identity {
                sub: Some(claims.sub),
                username: Some(username),
                name: claims.name,
                email: claims.email,
                is_super,
            });
            return Ok(next.run(req).await);
        }
    }
    // 3) ★dev E2E 免登通道(平台 registry v1.3.80,群 #128/#131)★
    //
    // 平台的 dev 网关在**校验过 per-子系统的 X-IAH-E2E-Key 之后**,才会给下游注入
    // `X-Forwarded-Preferred-Username: e2e`。key 不对的请求根本走不到这里(403/302,已用
    // unit_tests/congrove/e2e/gate.spec.ts 钉死)。所以这个头**本身就是网关校验通过的凭证**。
    //
    // ★双重门闩,缺一不可★(2026-08-07 用户拍板走这条,权衡见 docs/E2E-CHANNEL.md):
    //   ① `is_dev_channel()` —— 判据是平台按通道注入的 `PUBLIC_URL`,**不是**编译期常量、
    //      也不是 iah.yaml 里的值(那些两个通道共用同一份,会跟着 promote 到 prod);
    //   ② 请求确实带着这个头。
    //
    // ⚠ 这条分支**推翻了架构决策①的后半句**(「平台不注入身份头」)——那句话写于平台确实不注入的时候,
    //   现在 dev 通道会注入,所以前提变了。但它只在 dev 成立:prod 的 IngressRoute **根本没有**
    //   这条 E2E 路由,加上 ① 的门闩,prod 上这段代码永远不会执行。
    //
    // ⚠ 放在 cookie 与 Bearer **之后**:真人带着自己的会话来测时,身份应当是他本人而不是 `e2e`。
    if state.config.is_dev_channel() {
        if let Some(u) = req.headers().get("X-Forwarded-Preferred-Username")
            .and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty())
        {
            let u = u.to_string();
            // 与 Bearer 路径同一条 upsert:E2E 身份也要在 app_user 里落一行,
            // 否则它建的项目、发的邀请都挂在一个「不存在的人」名下。
            let is_super = ensure_app_user(&state.pool, &u, None, Some(&u), None, &state.config.super_users)
                .await
                .map_err(AppError::Other)?;
            tracing::debug!(user = %u, "E2E 通道身份(仅 dev)");
            req.extensions_mut().insert(Identity {
                sub: None, username: Some(u.clone()), name: Some(u), email: None, is_super,
            });
            return Ok(next.run(req).await);
        }
    }
    Err(AppError::Unauthorized)
}

/// 中间件:超管闸。叠在 require_auth **里层**(Identity 已就位),非超管 403 不是 401。
pub async fn require_super(State(state): State<AppState>, req: Request, next: Next) -> Result<Response, AppError> {
    let id = req.extensions().get::<Identity>().cloned().unwrap_or_default();
    // ★以库为准,不信 cookie 里的快照★(2026-08-04 审计):会话 8 小时,撤销超管后
    // 那 8 小时他还能进超管面。这条路径调用频率极低(只有超管面),多一次查库无所谓。
    // 鉴权关闭的本地 dev(state.auth 为 None)保持假身份放行。
    let ok = if state.auth.is_none() { id.is_super } else { crate::perm::is_super_now(&state.pool, &id).await? };
    if ok {
        Ok(next.run(req).await)
    } else {
        tracing::warn!(user = ?id.username, "super route denied");
        Err(AppError::Forbidden)
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

// ── 服务端浏览器 OIDC(/auth/*)─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginQuery {
    #[serde(rename = "return")]
    return_to: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// /auth/login → 302 去 Keycloak。签个短命 cookie 带上 CSRF state + 回跳路径。
pub async fn oidc_login(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<LoginQuery>) -> Response {
    let (Some(auth), Some(oc)) = pick(&state) else { return no_sso() };
    let redirect_uri = callback_uri(&headers);
    let st = rand_state(oc);
    // 连控制字符一起拒:"/\r\nx" 这种 return_to 过得了 starts_with('/'),烙进签名 cookie 后
    // 回调 .header(LOCATION, ret) 构造非法 HeaderValue 直接 panic(citeroot 踩过)。
    let ret = q
        .return_to
        .filter(|r| r.starts_with('/') && !r.chars().any(char::is_control))
        .unwrap_or_else(|| "/".into());
    let flow = encode(&Header::new(Algorithm::HS256), &Flow { state: st.clone(), ret, exp: now() + 600 }, &oc.enc)
        .unwrap_or_default();

    let authorize = reqwest::Url::parse_with_params(
        &format!("{}/protocol/openid-connect/auth", auth.issuer),
        &[
            ("client_id", oc.client_id.as_str()),
            ("response_type", "code"),
            ("scope", "openid profile email"),
            ("redirect_uri", redirect_uri.as_str()),
            ("state", st.as_str()),
        ],
    );
    let Ok(url) = authorize else { return bad("bad issuer url") };

    Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, url.as_str())
        .header(SET_COOKIE, set_cookie("cg_oauth", &flow, 600))
        .body(Body::empty())
        .unwrap()
}

/// /auth/callback → 验 state、服务端换码、upsert app_user、签会话 cookie、跳回应用。
pub async fn oidc_callback(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<CallbackQuery>) -> Response {
    let (Some(auth), Some(oc)) = pick(&state) else { return no_sso() };

    let flow = match cookie(&headers, "cg_oauth").and_then(|c| decode::<Flow>(&c, &oc.dec, &oc.hs256).ok()) {
        Some(d) => d.claims,
        None => return bad("登录会话已过期,请重试"),
    };
    if let Some(err) = &q.error {
        return bad(&format!("authorize error: {err}"));
    }
    if q.state.as_deref() != Some(flow.state.as_str()) {
        return bad("state mismatch");
    }
    let Some(code) = q.code else { return bad("no code") };

    let redirect_uri = callback_uri(&headers);
    let access = match auth.exchange_code(oc, &code, &redirect_uri).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "code exchange failed");
            return bad("token exchange failed");
        }
    };
    let Some((username, claims)) = auth.verify_bearer(&access).await else {
        return bad("exchanged token failed verification");
    };

    // 登录即 upsert + 超管白名单判定(决策 A / §5 bootstrap)。
    let is_super = match ensure_app_user(
        &state.pool,
        &username,
        claims.sub.as_str().into(),
        claims.name.as_deref(),
        claims.email.as_deref(),
        &state.config.super_users,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "app_user upsert failed at login");
            return bad("login bookkeeping failed");
        }
    };

    let id = Identity {
        sub: Some(claims.sub),
        username: Some(username),
        name: claims.name,
        email: claims.email,
        is_super,
    };
    let session = auth.issue_session(&id).unwrap_or_default();

    tracing::info!(user = ?id.username, is_super, "browser login");
    Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, flow.ret.as_str())
        .header(SET_COOKIE, set_cookie("cg_session", &session, 8 * 3600))
        .header(SET_COOKIE, clear_cookie("cg_oauth"))
        .body(Body::empty())
        .unwrap()
}

/// /auth/logout → 清会话 cookie 回首页。
///
/// ★顺带把超管模式关掉★(2026-08-09 liaoruili 定的三条之一:「退出登录即失效」)。
/// 模式存在库里(`app_user.admin_mode_until`),而会话在 cookie 里 —— 不显式清的话,
/// 「退出再登进来」会发现自己**还开着超管模式**,而人退出时以为一切都归零了。
/// ⚠ 这条路由在 `/api` 之外、没有 require_auth,所以身份要自己从 cookie 里解一次;
///   解不出来(没登录 / 会话过期)就只清 cookie,不是错误。
pub async fn oidc_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let (Some(auth), Some(tok)) = (state.auth.as_ref(), cookie(&headers, "cg_session")) {
        if let Some(id) = auth.verify_session(&tok) {
            if let Some(u) = id.username.as_deref() {
                let _ = sqlx::query("UPDATE app_user SET admin_mode_until = NULL WHERE username = $1")
                    .bind(u).execute(&state.pool).await;
            }
        }
    }
    Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, "/")
        .header(SET_COOKIE, clear_cookie("cg_session"))
        .body(Body::empty())
        .unwrap()
}

/// /api/me → 当前调用者。is_super 给 SPA 显隐超管入口用,真判权仍在后端。
/// 顺带回 direct_upload_endpoint:前端据此**开局探测**本设备能否信任 s3api 的证书,
/// 能就走预签直传、不能就直接走同源分片——避免每次上传都先撞一次墙再报警告(2026-08-03)。
pub async fn me(State(state): State<AppState>, Extension(id): Extension<Identity>) -> Json<serde_json::Value> {
    // is_super 以库为准(cookie 里那份是登录时快照):撤销后前端的超管入口要立刻消失,
    // 否则用户看得见按钮却处处 403,比藏起来更糟。
    let is_super = crate::perm::is_super_now(&state.pool, &id).await.unwrap_or(id.is_super);
    // ★资格与特权分开回★(超管模式,docs/TECH-DESIGN-admin-mode.md):
    //   · `is_super` 语义**不变** = 此刻有没有超管特权 —— 前端所有「能不能」的判断继续用它;
    //   · `can_super` = 有没有超管资格 —— 只用来决定「超管模式」那个开关画不画出来。
    // 刻意不改 is_super 的含义:它已经散在前端多处,改语义会让「显示」和「能力」错配。
    let (can_super, until): (bool, Option<chrono::DateTime<chrono::Utc>>) = match id.username.as_deref() {
        Some(u) => sqlx::query_as("SELECT is_super, admin_mode_until FROM app_user WHERE username = $1")
            .bind(u).fetch_optional(&state.pool).await.ok().flatten().unwrap_or((id.is_super, None)),
        None => (false, None),
    };
    Json(json!({
        "username": id.username, "name": id.name, "email": id.email, "is_super": is_super,
        "can_super": can_super, "admin_mode_until": until,
        "direct_upload_endpoint": state.config.s3_public_endpoint,
    }))
}

/// 登录/首见即 upsert app_user;白名单命中置 is_super=true(**只置不清**——清白名单
/// 不该吊销已提拔的超管,吊销走 UI/SQL)。返回最终 is_super。
pub async fn ensure_app_user(
    pool: &PgPool,
    username: &str,
    sub: Option<&str>,
    name: Option<&str>,
    email: Option<&str>,
    super_users: &[String],
) -> anyhow::Result<bool> {
    let whitelisted = super_users.iter().any(|u| u == username);
    let is_super: bool = sqlx::query_scalar(
        "INSERT INTO app_user (username, sub, name, email, is_super, last_login)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (username) DO UPDATE SET
           sub = COALESCE(EXCLUDED.sub, app_user.sub),
           name = COALESCE(EXCLUDED.name, app_user.name),
           email = COALESCE(EXCLUDED.email, app_user.email),
           is_super = app_user.is_super OR EXCLUDED.is_super,
           last_login = now()
         RETURNING is_super",
    )
    .bind(username)
    .bind(sub)
    .bind(name)
    .bind(email)
    .bind(whitelisted)
    .fetch_one(pool)
    .await?;
    Ok(is_super)
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn pick(state: &AppState) -> (Option<&Arc<Auth>>, Option<&OidcClient>) {
    match state.auth.as_ref() {
        Some(a) => (Some(a), a.oidc_client.as_ref()),
        None => (None, None),
    }
}

fn no_sso() -> Response {
    (StatusCode::NOT_FOUND, "server-side SSO not configured").into_response()
}
fn bad(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, msg.to_string()).into_response()
}

/// 按请求拼 https://<host>/auth/callback(Keycloak 自动注册的回调是
/// congrove[-dev].sub.ruciah.com/*)。Traefik 后 pod 看到的是 http,信 X-Forwarded-Proto。
fn callback_uri(headers: &HeaderMap) -> String {
    let host = headers.get(HOST).and_then(|v| v.to_str().ok()).unwrap_or("localhost");
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("https");
    format!("{proto}://{host}/auth/callback")
}

static STATE_CTR: AtomicU64 = AtomicU64::new(0);
/// 每次登录的 CSRF state:不可预测(secret 参与)且唯一(时间+计数器)。
fn rand_state(oc: &OidcClient) -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut h = Sha256::new();
    h.update(oc.client_secret.as_bytes());
    h.update(n.to_le_bytes());
    h.update(STATE_CTR.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    hex::encode(h.finalize())
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(COOKIE)?.to_str().ok()?;
    let prefix = format!("{name}=");
    raw.split(';').map(str::trim).find_map(|p| p.strip_prefix(&prefix).map(str::to_string))
}

// Secure + SameSite=Lax:OAuth 重定向的 GET 能带 cookie 回来;HttpOnly 让 SPA 永远碰不到。
fn set_cookie(name: &str, val: &str, max_age: i64) -> String {
    format!("{name}={val}; Path=/; Max-Age={max_age}; SameSite=Lax; Secure; HttpOnly")
}
fn clear_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly")
}

fn now() -> usize {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as usize).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归护栏(2026-08-02 502 事故):jsonwebtoken 11 不开恰好一个后端 feature 时,
    /// 首次 encode/decode 直接 panic(worker 线程死、pod 照样 Running、网关 502)。
    /// 这条 HS256 往返就是当初 /auth/login 第一步炸掉的路径——它跑不过 = feature 又配丢了。
    #[test]
    fn hs256_roundtrip_exercises_crypto_provider() {
        let key = b"congrove-test-key";
        let enc = EncodingKey::from_secret(key);
        let dec = DecodingKey::from_secret(key);
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_aud = false;
        let s = Session {
            username: "tester".into(),
            sub: Some("sub-1".into()),
            name: None,
            email: None,
            is_super: true,
            exp: now() + 60,
        };
        let tok = encode(&Header::new(Algorithm::HS256), &s, &enc).expect("encode 不该炸");
        let back = decode::<Session>(&tok, &dec, &v).expect("decode 不该炸");
        assert_eq!(back.claims.username, "tester");
        assert!(back.claims.is_super);
    }
}
