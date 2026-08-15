//! 运行时配置,启动时从环境变量一次性读入(本地开发由 .env 提供,线上由平台注入)。
//! 纪律(抄 citeroot):缺关键变量硬失败;S3 凭证**不进 Config**——SDK provider chain
//! 直接读标准 env(AWS_ACCESS_KEY_ID/SECRET),既不用手解析也不会出现在 Debug 输出里。

use std::env;

/// 每人的默认配额（ADR-0004）。★没有 `user_quota` 行 = 用这个值，不是 0★ ——
/// 新用户不该一上来就超额。
/// ⚠ 与 `migrations/0001_init.sql` 里 `user_quota.quota_bytes` 的 DEFAULT **必须同步**，
///   两处写死同一个数是已知的重复（改一处要改两处）。
pub const DEFAULT_QUOTA_BYTES: i64 = 10_737_418_240;


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

    /// 建空间白名单(D2 决策,docs/PERMISSIONS.md):CONGROVE_PROJECT_CREATORS 逗号分隔用户名。
    /// **空 = 全员可建**(默认);非空 = 仅名单内 + 超管可建——空间泛滥时随时收紧,不用改码。
    pub project_creators: Vec<String>,

    /// LLM 网关(平台总注入 IAH_BASE_URL / IAH_API_KEY):摘要与将来的 VLM 旁路都走它。
    pub llm_base_url: Option<String>,
    pub llm_api_key: Option<String>,
    /// 摘要用的模型名(网关侧;换模型不改码)。
    pub llm_model: String,
    /// ASR 端点(AI_Talks 0124 定契约):**走 IAH_BASE_URL 同一个网关、同一把 key**,
    /// `POST {base}/audio/transcriptions` multipart(file/model/hotword/speaker)。
    /// 平台选型 = FunASR 一条龙(转写+标点+说话人+热词一个服务出齐,本地模型 cost=0)。
    /// 默认直接复用 LLM 网关;ASR_BASE_URL 只在要单独指别处时才配。
    pub asr_base_url: Option<String>,
    pub asr_api_key: Option<String>,
    pub asr_model: String,
    /// 是否要说话人分离(FunASR 侧 speaker 参数;默认 true)。
    pub asr_speaker: bool,

    /// 平台 registry(总注入):用户存在性校验 + 站内信外发(AI_Talks 0094)。
    /// 缺(本地 dev)= 拉人校验降级到本地 app_user、不投站内信。
    pub registry_url: Option<String>,
    /// 本通道对外地址(总注入),站内信回跳链接用。
    pub public_url: Option<String>,
}

impl Config {
    /// 本进程跑在 **dev 通道**吗?判据是平台注入的 `PUBLIC_URL`
    /// (`https://congrove-dev.sub.…` vs `https://congrove.sub.…`)。
    ///
    /// ★为什么必须用 PUBLIC_URL,不能用 APP_ENV 或 iah.yaml 里的任何值★:
    /// promote 是**复用同一个 dev 镜像**上 prod 的,凡是编译进二进制、或写死在 iah.yaml 里的东西
    /// (两个通道共用同一份)都会**原样跟到 prod**——版本号 `.dev` 后缀就这么跟过去过
    /// (用户在 congrove.sub.ruciah.com 上看到 v0.3.42.dev)。
    /// 而 `PUBLIC_URL` 是平台**按通道注入的 env**,promote 时它会跟着变,这才是可靠的通道判据。
    ///
    /// **唯一推导**:要判通道的地方都问它,别各自解析域名(反漂移)。
    pub fn is_dev_channel(&self) -> bool {
        is_dev_url(self.public_url.as_deref())
    }

    /// 本进程是**跑在平台上**(dev 或 prod 通道),还是有人在自己机器上 `cargo run`?
    /// 判据同上:`PUBLIC_URL` 是平台注入的,本地 `.env.example` 里没有这一项。
    pub fn is_deployed(&self) -> bool {
        deployed(self.public_url.as_deref())
    }
}

/// 「跑在平台上吗」的判据本体。★fail-closed 的方向和 `is_dev_url` **相反**★:
/// 这一条拿不准时要判**是**部署环境 —— 它把关的是「没配 OIDC 就别启动」,
/// 猜错成「本地」的代价是**线上全员超管**,猜错成「线上」的代价只是本地要多设一个 env。
fn deployed(public_url: Option<&str>) -> bool {
    public_url.is_some_and(|u| !u.trim().is_empty())
}

/// 判据本体拆成纯函数,好单测(同 perm.rs 的做法:判权逻辑纯函数化 + 单测覆盖)。
/// ★fail-closed★:拿不到 PUBLIC_URL 就当**不是** dev —— 宁可本地用不了旁路,也不能反过来。
fn is_dev_url(public_url: Option<&str>) -> bool {
    public_url.is_some_and(|u| u.contains("-dev."))
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

            project_creators: opt("CONGROVE_PROJECT_CREATORS")
                .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
                .unwrap_or_default(),

            llm_base_url: opt("IAH_BASE_URL").map(|u| u.trim_end_matches('/').to_string()),
            llm_api_key: opt("IAH_API_KEY"),
            llm_model: opt("CONGROVE_LLM_MODEL").unwrap_or_else(|| "Qwen3.6-35B-A3B".into()),
            // 默认就走 LLM 网关(0124:同端点同 key),不必额外配 env。
            asr_base_url: opt("ASR_BASE_URL")
                .or_else(|| opt("IAH_BASE_URL"))
                .map(|u| u.trim_end_matches('/').to_string()),
            asr_api_key: opt("ASR_API_KEY").or_else(|| opt("IAH_API_KEY")),
            asr_model: opt("ASR_MODEL").unwrap_or_else(|| "funasr".into()),
            asr_speaker: opt("ASR_SPEAKER").map(|v| v != "false" && v != "0").unwrap_or(true),

            registry_url: opt("REGISTRY_URL"),
            public_url: opt("PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// ★这个判据错了就是 prod 上的免登后门★,两个通道的真实取值都要钉住
    /// (取值来自 DESIGN.md §2.2:平台按通道注入 PUBLIC_URL)。
    #[test]
    fn dev通道认得出() {
        assert!(is_dev_url(Some("https://congrove-dev.sub.ruciah.com")));
    }

    #[test]
    fn prod通道绝不能误判成dev() {
        // ★promote 复用同一个 dev 镜像★——这条断言就是防「E2E 旁路跟着镜像上 prod」的那道闸。
        assert!(!is_dev_url(Some("https://congrove.sub.ruciah.com")));
    }

    /// ★没配 OIDC = 全员超管★,所以「这是不是线上」这个判据本身就是一道安全闸。
    #[test]
    fn 部署环境认得出() {
        assert!(deployed(Some("https://congrove-dev.sub.ruciah.com")));
        assert!(deployed(Some("https://congrove.sub.ruciah.com")));
    }

    #[test]
    fn 本地没有public_url() {
        // 本地 `cargo run` 不注入 PUBLIC_URL —— 只有这种情况才允许鉴权关闭。
        assert!(!deployed(None));
        assert!(!deployed(Some("")));
        assert!(!deployed(Some("   ")));
    }

    #[test]
    fn 拿不到通道信息时按非dev处理() {
        // fail-closed:宁可本地 dev 用不了旁路,也不能反过来。
        assert!(!is_dev_url(None));
        assert!(!is_dev_url(Some("")));
    }
}
