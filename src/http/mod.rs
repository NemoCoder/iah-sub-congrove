//! HTTP 面:路由构建 + 共享中间件。结构抄 citeroot http/mod.rs:
//! 探针/auth 开放,/api 整层 route_layer 挂 require_auth(404 不要 token),
//! 超管面用 require_super 叠内层(403 不是 401),SPA 由后端同源托管。

mod admin;
mod groups;
mod items;
mod spaces;

use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{middleware, Json, Router};
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::auth;
use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    // 超管面:用户治理 + 全局审计。require_super 叠在 require_auth 里层(403 不是 401)。
    let admin = Router::new()
        .route("/admin/users", get(admin::users))
        .route("/admin/users/{username}/super", put(admin::set_super))
        .route("/admin/audit", get(admin::audit_list))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_super));

    let api = Router::new()
        .route("/me", get(auth::me))
        // 空间 + 授权
        .route("/spaces", get(spaces::list).post(spaces::create))
        .route("/spaces/{id}", get(spaces::detail).put(spaces::update).delete(spaces::remove))
        .route("/spaces/{id}/grants", get(spaces::grants).put(spaces::grant_put).delete(spaces::grant_delete))
        // 小组
        .route("/groups", get(groups::list).post(groups::create))
        .route("/groups/{id}", put(groups::update).delete(groups::remove))
        .route("/groups/{id}/members", get(groups::members).post(groups::member_put))
        .route("/groups/{id}/members/{username}", axum::routing::delete(groups::member_delete))
        // 内容树
        .route("/spaces/{id}/items", get(items::list).post(items::create))
        // 上传单独放大 body limit(axum 默认 2MB;60MB 业务闸在 items::UPLOAD_MAX,这里再留点 multipart 头部余量)
        .route(
            "/spaces/{id}/upload",
            post(items::upload).layer(DefaultBodyLimit::max(items::UPLOAD_MAX + 1024 * 1024)),
        )
        .route("/items/{id}", put(items::update).delete(items::remove))
        .route("/items/{id}/content", get(items::content_get).put(items::content_put))
        .route("/items/{id}/versions", get(items::versions))
        .route("/items/{id}/restore/{version_id}", post(items::restore))
        .route("/items/{id}/download", get(items::download))
        .merge(admin)
        // 每个 /api 端点都要认证(route_layer:404 不要 token);探针 + /auth/* 开放。
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
