//! 平台 registry 客户端(AI_Talks 0094 接口):用户存在性校验 + 站内信外发。
//! 鉴权 = 子系统渠道令牌:拿 sub-congrove 机密客户端向 Keycloak 走 client_credentials
//! 换 access token(azp=sub-congrove,registry 内省验真),缓存到过期前 60s。
//! **全部 best-effort 降级**:REGISTRY_URL 没注入(本地 dev)或换令牌失败时,调用方退回
//! 本地 app_user 校验——平台抖动不能把「拉人」功能整个打死。

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;

pub struct Registry {
    http: reqwest::Client,
    base: String,   // REGISTRY_URL,如 http://subsystem-registry.platform.svc:8000
    issuer: String, // Keycloak issuer,换 client_credentials 令牌用
    client_id: String,
    client_secret: String,
    tok: tokio::sync::Mutex<Option<(String, Instant)>>,
}

impl Registry {
    pub fn new(base: String, issuer: String, client_id: String, client_secret: String) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            http: crate::auth::build_http_client()?,
            base: base.trim_end_matches('/').to_string(),
            issuer: issuer.trim_end_matches('/').to_string(),
            client_id,
            client_secret,
            tok: tokio::sync::Mutex::new(None),
        }))
    }

    /// client_credentials 令牌,缓存复用(单飞:Mutex 顺带挡住并发重复换)。
    async fn token(&self) -> anyhow::Result<String> {
        let mut g = self.tok.lock().await;
        if let Some((t, deadline)) = &*g {
            if Instant::now() < *deadline {
                return Ok(t.clone());
            }
        }
        #[derive(Deserialize)]
        struct Tok {
            access_token: String,
            #[serde(default)]
            expires_in: Option<u64>,
        }
        let tok: Tok = self
            .http
            .post(format!("{}/protocol/openid-connect/token", self.issuer))
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let ttl = tok.expires_in.unwrap_or(300).saturating_sub(60).max(30);
        *g = Some((tok.access_token.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(tok.access_token)
    }

    /// GET /api/users/exists —— (存在?, 显示名)。Err = 平台不可达/令牌失败,调用方降级。
    pub async fn user_exists(&self, username: &str) -> anyhow::Result<(bool, Option<String>)> {
        #[derive(Deserialize)]
        struct Resp {
            exists: bool,
            #[serde(default)]
            name: Option<String>,
        }
        let t = self.token().await?;
        let r: Resp = self
            .http
            .get(format!("{}/api/users/exists", self.base))
            .query(&[("username", username)])
            .bearer_auth(t)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok((r.exists, r.name))
    }

    /// POST /api/notifications/send —— 投站内信(sender 平台侧固定 sub:congrove,不可伪报)。
    /// `ref_` 幂等:同 recipient+ref 不重复投。失败只记 warn,不影响业务(fire-and-forget 用)。
    pub async fn notify(&self, recipient: &str, title: &str, body: &str, url: Option<&str>, ref_: Option<&str>) {
        let run = async {
            let t = self.token().await?;
            let mut payload = serde_json::json!({ "recipient": recipient, "title": title, "body": body });
            if let Some(u) = url {
                payload["url"] = serde_json::json!(u);
            }
            if let Some(r) = ref_ {
                payload["ref"] = serde_json::json!(r);
            }
            self.http
                .post(format!("{}/api/notifications/send", self.base))
                .bearer_auth(t)
                .json(&payload)
                .send()
                .await?
                .error_for_status()?;
            anyhow::Ok(())
        };
        if let Err(e) = run.await {
            tracing::warn!(error = %e, recipient, "站内信投递失败(不影响业务)");
        }
    }
}
