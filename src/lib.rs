//! congrove(汇流)—— 库 crate。模块都在这,binary(main.rs)是 [`run`] 的薄壳,
//! 将来集成测试也从这拿真函数(citeroot 的 lib/bin 拆分纪律)。
//!
//! [`run`] 引导:.env → 配置 → 日志 → PG 池 + 迁移 → S3 → OIDC → 单 axum 服务
//! (一个端口,REST + 静态同源),优雅停机。

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod http;
pub mod perm;
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

    let state = AppState { pool, storage: Arc::new(storage), config: Arc::new(cfg.clone()), auth };

    let app = http::build_router(state);
    let listener = TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!(addr = %cfg.bind_addr, "listening");

    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    tracing::info!("shutdown complete");
    Ok(())
}

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
