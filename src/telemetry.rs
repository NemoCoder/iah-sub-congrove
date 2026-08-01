//! 日志初始化。平台规范:只写 stdout/stderr(Loki 收,留 60 天),线上 JSON 结构化。
//! dev 用人读格式,非 dev 一律 JSON——判据是 APP_ENV(平台部署不注入 APP_ENV=dev)。

use tracing_subscriber::{fmt, EnvFilter};

pub fn init(app_env: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,congrove=debug"));
    if app_env == "dev" {
        fmt().with_env_filter(filter).init();
    } else {
        fmt().with_env_filter(filter).json().init();
    }
}
