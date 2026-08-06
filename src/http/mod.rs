//! HTTP 面:路由构建 + 共享中间件。结构抄 citeroot http/mod.rs:
//! 探针/auth 开放,/api 整层 route_layer 挂 require_auth(404 不要 token),
//! 超管面用 require_super 叠内层(403 不是 401),SPA 由后端同源托管。

mod admin;
pub(crate) mod items;
mod media;
mod share;
mod projects;

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
    // 超管面:用户治理 + 配额 + 全局审计。require_super 叠在 require_auth 里层(403 不是 401)。
    let admin = Router::new()
        .route("/admin/users", get(admin::users))
        .route("/admin/users/{username}/super", put(admin::set_super))
        .route("/admin/projects/{id}/quota", put(admin::set_quota))
        .route("/admin/audit", get(admin::audit_list))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_super));

    // 快路由:30s 超时。上传/下载**不能**在这层(2026-08-02 单文件不限大小后,几百 MB 的
    // 录屏传输远超 30s,超时层会把流拦腰掐断)——它们单独进 slow,给 2h。
    let fast = Router::new()
        .route("/me", get(auth::me))
        .route("/users", get(admin::user_options))
        // 空间 + 授权
        .route("/projects", get(projects::list).post(projects::create))
        .route("/projects/{id}", get(projects::detail).put(projects::update).delete(projects::remove))
        .route("/projects/{id}/members", get(projects::members).put(projects::member_put).delete(projects::member_delete))
        .route("/projects/{id}/transfer", post(projects::transfer))
        .route("/projects/{id}/diagnose", get(projects::diagnose))
        // 小组



        // 内容树(文档正文小,留在快路由)
        .route("/projects/{id}/items", get(items::list).post(items::create))
        // 秒传预检(内容寻址去重):命中且**我本来就能读到**才免传,见 items::readable_blob
        .route("/projects/{id}/precheck", post(items::precheck))
        // 回收站:软删除的东西在这里还原 / 彻底删除(purge 要空间 admin)
        .route("/projects/{id}/trash", get(items::trash))
        .route("/items/{id}/undelete", post(items::undelete))
        .route("/items/{id}/purge", axum::routing::delete(items::purge))
        .route("/items/{id}", get(items::detail).put(items::update).delete(items::remove))
        .route("/items/{id}/progress", get(items::progress_get).put(items::progress_put))
        .route("/items/{id}/content", get(items::content_get).put(items::content_put))
        // 公开分享的**管理面**(建/列/撤销;建与列要 ≥editor,见 share.rs 头注)
        .route("/items/{id}/shares", get(share::list).post(share::create))
        .route("/shares/mine", get(share::mine))
        .route("/shares/{token}", axum::routing::delete(share::revoke))
        .route("/items/{id}/versions", get(items::versions))
        .route("/items/{id}/restore/{version_id}", post(items::restore))
        // P2 预签名直传:begin/complete/abort 都是快 API(字节不经 pod);play 判权后 302 预签名 GET。
        .route("/projects/{id}/media/begin", post(media::begin))
        .route("/items/{id}/media/complete", post(media::complete))
        .route("/items/{id}/media/abort", post(media::abort))
        .route("/items/{id}/play", get(media::play))
        // 录屏分析:排任务 + 查结果(实际跑在后台 worker,见 media_ai.rs)
        .route("/items/{id}/analyze", post(media::analyze))
        .route("/items/{id}/analysis", get(media::analysis))
        .route("/items/{id}/subtitles.vtt", get(media::subtitles))
        .merge(admin)
        .route_layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(30)));

    // 慢路由:流式上传/下载 + 代理分片。body limit 整个解除(单文件不限大小,真闸是空间配额),超时 2h。
    let slow = Router::new()
        .route("/projects/{id}/upload", post(items::upload).layer(DefaultBodyLimit::disable()))
        // 代理分片:单片 8MiB,上限给 32MiB 余量(防前端换算/编码开销顶格)。
        .route(
            "/items/{id}/media/part",
            put(media::part).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/items/{id}/download", get(items::download))
        .route_layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(2 * 3600)));

    // 每个 /api 端点都要认证(route_layer:404 不要 token);探针 + /auth/* 开放。
    let api = fast
        .merge(slow)
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_auth));

    let mut app = Router::new()
        // 探针必须免鉴权,401 会打挂 liveness/readiness。
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // 服务端浏览器 SSO——登录入口本身必须开放(换码走 Keycloak,给 60s)。
        .merge(
            Router::new()
                .route("/auth/login", get(auth::oidc_login))
                .route("/auth/callback", get(auth::oidc_callback))
                .route("/auth/logout", get(auth::oidc_logout))
                .route_layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(60))),
        )
        .nest("/api", api)
        // ★公开分享面:**不挂 require_auth**★(访客没有会话)。它只认「令牌 + 提取码 + 短命票」,
        // 拿不到任何空间级能力;过期/超次数/撤销一律 404。超时给 2h(大文件下载走这条)。
        .nest(
            "/pub",
            Router::new()
                .route("/share/{token}", get(share::pub_meta))
                .route("/share/{token}/open", post(share::pub_open))
                .route("/share/{token}/list", get(share::pub_list))
                .route("/share/{token}/file/{item_id}", get(share::pub_file))
                .route_layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(2 * 3600))),
        )
        // ⚠ 全局层只有 Trace,**没有** TimeoutLayer——超时按路由组分层(fast 30s / slow 2h / auth 60s),
        // 放回全局会把慢路由重新掐回 30s。
        .layer(TraceLayer::new_for_http());

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
