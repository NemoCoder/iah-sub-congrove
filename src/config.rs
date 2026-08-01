//! 运行时配置,启动时从环境变量一次性读入(本地开发由 .env 提供,线上由平台注入)。
//! 纪律(抄 citeroot):缺关键变量硬失败;S3 凭证**不进 Config**——SDK provider chain
//! 直接读标准 env(AWS_ACCESS_KEY_ID/SECRET),既不用手解析也不会出现在 Debug 输出里。

use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub app_env: String,
    pub bind_addr: String,

    pub database_url: String,
    pub db_max_connections: u32,
    /// 每连接 statement_timeout(ms):共享 iah-pg 上平台故意不设 role 级超时,应用自管。
    pub db_statement_timeout_ms: u64,

    /// 集群内 S3 端点(garage.data.svc:3900)——pod 自己的读写走它。
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_region: String,
    /// 预签名专用外部端点(https://s3api.ruciah.com,浏览器可达)。签名把 Host 算进
    /// SigV4,所以要用它单独建一个签名 client(DESIGN.md §7.4b-2)。未设 = 预签名不可用,
    /// media 走后端流式代理回退。
    pub s3_public_endpoint: Option<String>,

    /// OIDC(Keycloak)。未设 OIDC_ISSUER = 鉴权关闭(仅本地 dev,main.rs 大声 WARN)。
    pub oidc: Option<OidcConfig>,

    /// 超管 bootstrap 白名单(自定义 env CONGROVE_SUPER_USERS=liaoruili,...):
    /// 登录时命中即置 is_super=true。之后超管可在 UI 提别人(只置不清,白名单是种子)。
    pub super_users: Vec<String>,
}

#[derive(Clone)]
pub struct OidcConfig {
    /// 如 https://auth.ruciah.com/realms/iah,同时是 iss 校验值。
    pub issuer: String,
    /// JWKS 端点,默认 {issuer}/protocol/openid-connect/certs(内网 CA 已由 auth.rs 追加)。
    pub jwks_url: String,
    /// 机密客户端 sub-congrove + secret(平台自动注入)。都在才开服务端浏览器 SSO(/auth/*)。
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    /// 会话 cookie 签名密钥源:优先平台注入的 AUTH_SECRET(重建保留,不踢登录),
    /// 缺省回退到 client_secret 派生(它同样重建保留)。
    pub auth_secret: Option<String>,
}

/// Debug 手写:secret 一律打码(同 citeroot SemanticConfig 的密钥卫生)。
impl std::fmt::Debug for OidcConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OidcConfig")
            .field("issuer", &self.issuer)
            .field("jwks_url", &self.jwks_url)
            .field("client_id", &self.client_id)
            .field("client_secret", &self.client_secret.as_ref().map(|_| "<redacted>"))
            .field("auth_secret", &self.auth_secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            app_env: opt("APP_ENV").unwrap_or_else(|| "dev".into()),
            bind_addr: opt("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8030".into()),

            database_url: req("DATABASE_URL")?,
            db_max_connections: opt("DB_MAX_CONNECTIONS").and_then(|v| v.parse().ok()).unwrap_or(8),
            db_statement_timeout_ms: opt("DB_STATEMENT_TIMEOUT_MS").and_then(|v| v.parse().ok()).unwrap_or(60_000),

            // 端点/region 认平台注入的 AWS 标准名,本地 .env 可用 S3_* 名。
            s3_endpoint: opt("AWS_ENDPOINT_URL_S3")
                .or_else(|| opt("S3_ENDPOINT"))
                .ok_or_else(|| anyhow::anyhow!("missing required env var: S3_ENDPOINT (or AWS_ENDPOINT_URL_S3)"))?,
            s3_bucket: req("S3_BUCKET")?,
            // ★ region 必须是字符串 "garage",否则 HeadBucket 400(平台注入即此值)★
            s3_region: opt("AWS_DEFAULT_REGION").or_else(|| opt("S3_REGION")).unwrap_or_else(|| "garage".into()),
            s3_public_endpoint: opt("S3_PUBLIC_ENDPOINT").map(|u| u.trim_end_matches('/').to_string()),

            oidc: opt("OIDC_ISSUER").map(|issuer| {
                let jwks_url = opt("OIDC_JWKS_URL")
                    .unwrap_or_else(|| format!("{}/protocol/openid-connect/certs", issuer.trim_end_matches('/')));
                OidcConfig {
                    issuer,
                    jwks_url,
                    client_id: opt("OIDC_CLIENT_ID"),
                    client_secret: opt("OIDC_CLIENT_SECRET"),
                    auth_secret: opt("AUTH_SECRET").or_else(|| opt("BETTER_AUTH_SECRET")),
                }
            }),

            super_users: opt("CONGROVE_SUPER_USERS")
                .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),
        })
    }
}

fn req(key: &str) -> anyhow::Result<String> {
    env::var(key).map_err(|_| anyhow::anyhow!("missing required env var: {key}"))
}

fn opt(key: &str) -> Option<String> {
    match env::var(key) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}
