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
        // ★所有站内信标题一律以「Congrove」开头★（2026-08-13 liaoruili）。
        //
        // ⚠★挂在这一处,不去改那十几个调用点★:站内信在平台收件箱里是**和别的子系统混在一起**的,
        //   一条「活动时间已改」不说是谁改的,收件人得点开才知道来自哪个系统。
        //   2026-08-09 他就为「项目转移申请」提过一次,当时我只给**那一条**加了前缀 ——
        //   于是十几条里只有一条带产品名,其余照旧。★同一条要求在一处执行 = 没有执行。★
        //   收口在这个唯一出口上,以后新增的任何站内信自动带上,不必再想起这条约定。
        //   已经带前缀的不重复加(那条老的、以及万一有人手写了前缀)。
        let title = 带产品名(title);
        let title = title.as_str();
        let run = async {
            let t = self.token().await?;
            let mut payload = serde_json::json!({ "recipient": recipient, "title": title, "body": body });
            if let Some(u) = url {
                payload["url"] = serde_json::json!(u);
            }
            if let Some(r) = ref_ {
                payload["ref"] = serde_json::json!(r);
            }
            let r = self.http
                .post(format!("{}/api/notifications/send", self.base))
                .bearer_auth(t)
                .json(&payload)
                .send()
                .await?
                .error_for_status()?;
            // ★2xx 不等于「送到了」★(2026-08-16 事故):平台按 `(recipient, ref)` 幂等 ——
            //   撞了已有的 ref 就**跳过插入、回查旧行、照样返 2xx**。
            //   于是「邀请占住 ref → 之后所有关于这个活动的通知全被吞」这件事,
            //   在我们这边**一点痕迹都没有**:日志说「已投递」,收件箱里什么都没有。
            //   平台同日加了 `deduped` 标志(registry v1.4.19),这里读它 ——
            //   ★宁可日志吵一点,也不要一个「成功」是假的★。
            //   (ref 现在按种类分,见 notify::Kind;正常情况下不该再看到这条 WARN,
            //    它出现就说明还有某种通知在复用别人的 ref。)
            let deduped = r.json::<serde_json::Value>().await.ok()
                .and_then(|v| v["deduped"].as_bool()).unwrap_or(false);
            if deduped {
                tracing::warn!(recipient, ref_ = ref_.unwrap_or(""),
                    "★站内信被平台按 ref 去重,实际没有投递★(说明这个 ref 已被同收件人的旧消息占住)");
            }
            anyhow::Ok(())
        };
        if let Err(e) = run.await {
            tracing::warn!(error = %e, recipient, "站内信投递失败(不影响业务)");
        }
    }
}

/// 站内信标题一律以「Congrove」开头 —— ★抽成纯函数是为了能单测★,
/// 也为了这条规则有一个**看得见的名字**:下次有人想在别处拼标题时,会先撞见它。
pub fn 带产品名(title: &str) -> String {
    if title.starts_with("Congrove") { title.to_string() } else { format!("Congrove {title}") }
}

#[cfg(test)]
mod 标题前缀 {
    use super::带产品名;

    #[test]
    fn 没有前缀的补上() {
        assert_eq!(带产品名("会议邀请"), "Congrove 会议邀请");
        assert_eq!(带产品名("活动时间已改"), "Congrove 活动时间已改");
    }

    /// ★已经带了就不重复加★:历史上「项目转移申请」那条是手写前缀的,
    /// 收口之后如果不判这一下,它会变成「Congrove Congrove 项目转移申请」。
    #[test]
    fn 已经带前缀的不重复() {
        assert_eq!(带产品名("Congrove 项目转移申请"), "Congrove 项目转移申请");
    }

    /// 空标题也不该退化成裸产品名后面吊一个空格 —— 但这属于调用方不该发生的输入,
    /// 这里只钉住「不 panic、且仍带前缀」这一条。
    #[test]
    fn 空标题不炸() {
        assert_eq!(带产品名(""), "Congrove ");
    }
}
