//! 共享应用状态,克隆进每个 handler。PgPool / S3 Client 内部都是 Arc,克隆廉价。

use std::sync::Arc;

use sqlx::PgPool;

use crate::auth::Auth;
use crate::config::Config;
use crate::storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub storage: Arc<Storage>,
    pub config: Arc<Config>,
    /// OIDC 验证器。None = 鉴权关闭(本地 dev,main.rs 大声 WARN)。
    pub auth: Option<Arc<Auth>>,
}
