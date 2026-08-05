//! congrove(汇流)—— 库 crate。模块都在这,binary(main.rs)是 [`run`] 的薄壳,
//! 将来集成测试也从这拿真函数(citeroot 的 lib/bin 拆分纪律)。
//!
//! [`run`] 引导:.env → 配置 → 日志 → PG 池 + 迁移 → S3 → OIDC → 单 axum 服务
//! (一个端口,REST + 静态同源),优雅停机。

pub mod audit;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod http;
pub mod media_ai;
pub mod perm;
pub mod registry;
pub mod state;
pub mod storage;
pub mod telemetry;

use std::sync::Arc;

use tokio::net::TcpListener;

use crate::config::Config;
use crate::state::AppState;

pub async fn run() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv(); // 本地读 .env;线上是平台注入,no-op

    let cfg = Config::from_env()?;
    telemetry::init(&cfg.app_env);
    tracing::info!(env = %cfg.app_env, bind = %cfg.bind_addr, "starting congrove");

    let pool = db::build_pool(&cfg).await?;
    tracing::info!("postgres pool ready");

    // 启动即跑迁移(advisory lock,多副本安全)。只增不改,见 migrations/0001 头注。
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("migrations applied");

    let storage = storage::Storage::build(&cfg).await;
    tracing::info!(bucket = %storage.bucket, "s3 client ready");

    // 鉴权开关 = OIDC_ISSUER 有没有配。没配 = 全开放,只许本地 dev——大声喊。
    let auth = match &cfg.oidc {
        Some(oidc) => {
            let a = auth::Auth::new(oidc).await?;
            tracing::info!(issuer = %oidc.issuer, "OIDC enabled");
            Some(a)
        }
        None => {
            tracing::warn!(
                "OIDC DISABLED (no OIDC_ISSUER) — all endpoints are UNAUTHENTICATED. \
                 Dev only; never expose this build."
            );
            None
        }
    };

    // 平台 registry 客户端:REGISTRY_URL + 机密客户端齐了才建(缺任一 = 本地 dev,降级)。
    let registry = match (&cfg.registry_url, &cfg.oidc) {
        (Some(base), Some(o)) => match (&o.client_id, &o.client_secret) {
            (Some(cid), Some(csec)) => {
                let r = registry::Registry::new(base.clone(), o.issuer.clone(), cid.clone(), csec.clone())?;
                tracing::info!(base = %base, "platform registry client ready(用户校验/站内信)");
                Some(r)
            }
            _ => None,
        },
        _ => {
            tracing::info!("REGISTRY_URL/OIDC 不全 — 用户校验降级到本地 app_user,站内信关闭");
            None
        }
    };

    let state = AppState { pool, storage: Arc::new(storage), config: Arc::new(cfg.clone()), auth, registry };

    // 半截上传清理(P2 直传的兜底):前端崩了/关页没调 abort 的 multipart 在 S3 里**永久占存储**,
    // 每 6h 扫一遍,abort 超过 24h 的,并删对应的孤儿 items 行(s3_key NULL 的未完成行)。
    // 进程内任务,重启即丢、下个 tick 恢复——与平台「任务别只活在内存」的告诫不冲突:这是纯幂等清扫。
    tokio::spawn(cleanup_stale_uploads(state.clone()));

    // 录屏转写+纪要 worker(docs/VIDEO-SUMMARY.md P1):任务态在 PG,重启自动续跑。
    tokio::spawn(media_ai::run(state.clone()));

    let app = http::build_router(state);
    let listener = TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "listening");

    // ★with_connect_info★:分享的访问统计要取访客 IP(ConnectInfo)。不这么起服务的话,
    // ConnectInfo 提取器编译得过但**运行时取不到 → 500**(2026-08-05 加公开分享时补上)。
    // 网关后 peer 是 ingress 的 pod IP,真实来源看 X-Forwarded-For,两者都用得上。
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("shutdown complete");
    Ok(())
}

/// 每 6h:abort 超过 24h 的半截 multipart + 删 24h 前建、始终没完成(s3_key NULL)的 file/video 行。
async fn cleanup_stale_uploads(state: AppState) {
    // 先扫一次再进循环:原来 sleep 在开头,pod 活不满 6 小时(平台构建/滚更频繁)就等于从不清理
    // (2026-08-04 审计)。清扫本身幂等,启动跑一次没有副作用。
    let mut first = true;
    loop {
        if !first { tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await }
        first = false;
        match state.storage.list_multiparts().await {
            Ok(ups) => {
                let now = std::time::SystemTime::now();
                for (key, uid, initiated) in ups {
                    let stale = initiated
                        .and_then(|t| SystemTime::try_from(t).ok())
                        .and_then(|t| now.duration_since(t).ok())
                        .map(|d| d.as_secs() > 24 * 3600)
                        .unwrap_or(true); // 没时间戳的按陈旧处理(反正 abort 幂等)
                    if stale {
                        tracing::info!(key, "cleanup: abort 陈旧半截上传");
                        state.storage.multipart_abort(&key, &uid).await;
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "cleanup: list_multiparts 失败,下轮再试"),
        }
        if let Err(e) = sqlx::query(
            "DELETE FROM items WHERE s3_key IS NULL AND deleted_at IS NULL AND kind IN ('file','video')
               AND created_at < now() - interval '24 hours'",
        )
        .execute(&state.pool)
        .await
        {
            tracing::warn!(error = %e, "cleanup: 孤儿行清理失败");
        }
        // ★回收站保留 30 天★(2026-08-05 软删除):到期的「删除动作根」逐个 purge——
        // 走 purge_subtree 而不是一条 DELETE,因为要按引用计数决定对象删不删
        // (共享对象之后,直接删对象会把别人还引用着的内容清掉)。
        let expired: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM items i
              WHERE i.deleted_at IS NOT NULL AND i.deleted_at < now() - interval '30 days'
                AND (i.parent_id IS NULL OR NOT EXISTS (
                      SELECT 1 FROM items p WHERE p.id = i.parent_id AND p.deleted_at IS NOT NULL))
              LIMIT 200",
        ).fetch_all(&state.pool).await.unwrap_or_default();
        for iid in expired {
            match crate::http::items::purge_subtree(&state, iid).await {
                Ok(n) => tracing::info!(item = iid, objects = n, "cleanup: 回收站满 30 天,已彻底删除"),
                Err(e) => tracing::warn!(error = %format!("{e:?}"), item = iid, "cleanup: 自动 purge 失败"),
            }
        }
    }
}

use std::time::SystemTime;

/// SIGTERM(容器)或 Ctrl-C 触发优雅停机。
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
