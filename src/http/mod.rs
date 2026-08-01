//! HTTP 面:路由构建 + 共享中间件。结构抄 citeroot http/mod.rs:
//! 探针/auth 开放,/api 整层 route_layer 挂 require_auth(404 不要 token),
//! 超管面用 require_super 叠内层(403 不是 401),SPA 由后端同源托管。

use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::get;
use axum::{middleware, Json, Router};
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::auth;
use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    // 超管面(P1 起装用户管理/全局审计;先占位挂闸)。
    let admin = Router::new()
        .route("/admin/ping", get(|| async { "ok" }))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_super));

    // /api:P0 只有 /me;P1 挂 spaces/groups/items/media。整层 require_auth。
    let api = Router::new()
        .route("/me", get(auth::me))
        .merge(admin)
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_auth));

    let mut app = Router::new()
        // 探针必须免鉴权,401 会打挂 liveness/readiness。
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // 服务端浏览器 SSO——登录入口本身必须开放。
        .route("/auth/login", get(auth::oidc_login))
        .route("/auth/callback", get(auth::oidc_callback))
        .route("/auth/logout", get(auth::oidc_logout))
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(30)));

    // CORS 只在鉴权关闭的本地 dev 开(vite :5180 跨源调 API);线上同源,别开。
    if state.auth.is_none() {
        app = app.layer(CorsLayer::permissive());
    }

    // 同源托管前端构建产物(单镜像单端口契约)。静态开放——先加载 SPA 才能登录;
    // /api 在上面已整层挂闸。未知路径回退 index.html 给前端路由。
    let web_dist = std::env::var("WEB_DIST").unwrap_or_else(|_| "web/dist".into());
    if std::path::Path::new(&web_dist).is_dir() {
        let index = format!("{web_dist}/index.html");
        app = app.fallback_service(ServeDir::new(&web_dist).fallback(ServeFile::new(index)));
    }

    app.with_state(state)
}

/// 存活:进程活着就行,不查依赖(依赖坏了该重启的不是本 pod)。
async fn healthz() -> &'static str {
    "ok"
}

/// 就绪:PG SELECT 1 + S3 head_bucket 都通才算 ready。
async fn readyz(axum::extract::State(state): axum::extract::State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    let pg = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.pool).await.is_ok();
    let s3 = state.storage.healthcheck().await.is_ok();
    let ready = pg && s3;
    let code = if ready { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, Json(json!({ "ready": ready, "pg": pg, "s3": s3 })))
}
