//! PostgreSQL 连接池。小池 + 短 acquire 超时 + 每连接 statement_timeout
//! (共享 iah-pg 上平台故意不设 role 级超时,应用自管;真正的长操作在事务内
//! `SET LOCAL statement_timeout=0` 自行豁免)。

use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

use crate::config::Config;

pub async fn build_pool(cfg: &Config) -> anyhow::Result<PgPool> {
    let connect_opts: PgConnectOptions = cfg
        .database_url
        .parse::<PgConnectOptions>()?
        .options([("statement_timeout", cfg.db_statement_timeout_ms.to_string())]);

    let pool = PgPoolOptions::new()
        .max_connections(cfg.db_max_connections)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(8))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect_with(connect_opts)
        .await?;

    Ok(pool)
}
