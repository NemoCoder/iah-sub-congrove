//! HTTP 面:路由构建 + 共享中间件。结构抄 citeroot http/mod.rs:
//! 探针/auth 开放,/api 整层 route_layer 挂 require_auth(404 不要 token),
//! 超管面用 require_super 叠内层(403 不是 401),SPA 由后端同源托管。

mod admin;
/// ★pub 是给集成测试用的★:`tests/api_cases.rs` 要读 `APIS` 逐条核对「每个接口都有测试用例」。
pub mod apidoc;
pub(crate) mod items;
mod media;
mod activities;
mod activity_types;
mod me_quota;
mod share;
pub(crate) mod projects;

use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, StatusCode};
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
        .route("/admin/users/{username}/quota", put(admin::set_quota))
        .route("/admin/audit", get(admin::audit_list))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_super));

    // 快路由:30s 超时。上传/下载**不能**在这层(2026-08-02 单文件不限大小后,几百 MB 的
    // 录屏传输远超 30s,超时层会把流拦腰掐断)——它们单独进 slow,给 2h。
    let fast = Router::new()
        .route("/me", get(auth::me))
        .route("/users", get(admin::user_options))
        // 项目与成员
        .route("/projects", get(projects::list).post(projects::create))
        .route("/projects/{id}", get(projects::detail).put(projects::update).delete(projects::remove))
        .route("/projects/{id}/members", get(projects::members).put(projects::member_put).delete(projects::member_delete))
        // 转移主持人★需对方接受★(PRD ⑨.5;docs/TECH-DESIGN-M1-owner-transfer.md):
        // 发起 / 答复 / 撤回三个动作,待接受期间原主持人仍是主持人(否则空档期无主)
        .route("/projects/{id}/transfer", post(projects::transfer).delete(projects::transfer_cancel))
        .route("/projects/{id}/transfer/respond", post(projects::transfer_respond))
        // 归档/恢复(D17):★走 require_owner 不走 require_role★——
        // 后者对归档项目拒绝一切写操作,那样归档之后就再也解不开了
        .route("/projects/{id}/archive", post(projects::archive))
        // ★项目回收站★(2026-08-09 审计 A5:删项目改成真软删除,liaoruili 拍板)。
        // ⚠ trash 必须排在 `/projects/{id}` 之前吗?——不必:axum 的路由匹配静态段优先于
        //   `{id}` 通配,`/projects/trash` 不会被吃成 id="trash"。
        .route("/projects/trash", get(projects::trash))
        .route("/projects/{id}/undelete", post(projects::undelete))
        .route("/projects/{id}/diagnose", get(projects::diagnose))
        // 项目统计(PRD 6.5.2 + D6)。★时长口径与个人统计同一套★(D5 三级回退):
        // 两处各写一套的话,同一场会在个人页和项目页会显示不同时长,而没人说得清该信哪个
        .route("/projects/{id}/stats", get(activities::project_stats))
        // 开发者:全部 API 清单(超管可见)。数据源是 apidoc::APIS,
        // ★它与本文件的路由表由 apidoc 里的测试逐条比对,漏写/多写都会让 cargo test 红★
        .route("/_dev/apis", get(apidoc::list))
        // OpenAPI 3.1 契约:★从 APIS 生成★,继承「路由改了不同步就 cargo test 红」那条保证
        .route("/_dev/openapi.json", get(apidoc::openapi))
        // 活动与日程(M1)。★活动参与 ≠ 资料权限★:这些接口只管活动元信息,
        // 材料一律走上面项目那套 require_role(D3/D8/D9,详见 activities.rs 头注)。
        .route("/activities", get(activities::list).post(activities::create))
        // 活动类型（ADR-0002）：预置两条 + 每人自建
        // 我的配额与偏好（ADR-0004）
        .route("/me/quota", get(me_quota::get_quota))
        .route("/me/prefs", get(me_quota::get_prefs).put(me_quota::put_prefs))
        // ★超管模式★(docs/TECH-DESIGN-admin-mode.md):超管平时就是普通用户,
        // 要用特权得刻意开一下,2 小时自动关、退出登录也关
        .route("/me/admin-mode", post(me_quota::set_admin_mode))
        .route("/activity-types", get(activity_types::list).post(activity_types::create))
        .route("/activity-types/{id}", put(activity_types::update).delete(activity_types::remove))
        .route("/activities/{id}", get(activities::detail).put(activities::update).delete(activities::cancel))
        .route("/activities/{id}/participants", put(activities::invite).delete(activities::uninvite))
        .route("/activities/{id}/respond", post(activities::respond))
        .route("/activities/{id}/messages", get(activities::messages).post(activities::send_message))
        // 纪要(D14):★AI 转写只是原材料,记录员才是作者★,两者刻意不打通
        .route("/activities/{id}/minutes", get(activities::minutes_get).put(activities::minutes_put))
        // 活动详情页要的几块(docs/UI-GAP.md):材料与录制 / 线上链接改动历史 / 催办 / 采纳改期
        .route("/activities/{id}/items", get(activities::activity_items))
        // ★删活动材料走这条,不走通用的 DELETE /items/{id}★:入口不同,接口就不同 ——
        // 通用那条会拒绝带 activity_id 的 item(D10 的只读区,靠后端而不是靠前端藏按钮)。
        .route("/activities/{mid}/items/{iid}", put(activities::rename_activity_item).delete(activities::delete_activity_item))
        // 不关联项目的个人活动,材料落发起人的「我的活动材料」(PRD §J0)
        .route("/activities/{id}/materials-project", post(activities::materials_project))
        .route("/activities/{id}/link-history", get(activities::link_history))
        .route("/activities/{id}/remind", post(activities::remind))
        .route("/activities/{id}/accept-counter", post(activities::accept_counter))
        .route("/activities/{id}/reject-counter", post(activities::reject_counter))
        // 忙闲(D1):只回时间段不回内容;私密项目的会完全隐形。
        .route("/freebusy", get(activities::freebusy))
        // ★公开活动广场 + 自助旁听(D9)★:公开活动没有列表页的话,「全平台可旁听」就是空话
        .route("/activities/public", get(activities::public_list))
        .route("/activities/{id}/observe", post(activities::observe))
        // 个人面板「我的投入」(原型 me 视图):口径写在 handler 注释里,前端不自己算
        .route("/me/stats", get(activities::my_stats))
        // 「待我处理」里的私聊未读(原型 🔔 卡):★只算 private 且 peer 是我的★,
        // 公开讨论区的新消息不进 —— 天天有红点就等于没有红点
        // 等我答复的主持人转移。★不放项目页里★:被转让人可能压根不打开那个项目,
        // 只在项目内部可见的请求多半永远不会被答复 —— 归到「待我处理」那张卡
        .route("/me/transfers", get(projects::my_transfers))
        .route("/me/unread", get(activities::my_unread))
        // 等我整理的纪要(2026-08-10)。★记录员是被系统指派的角色,却曾是唯一不提醒的一路★
        .route("/me/minutes-todo", get(activities::my_minutes_todo))
        .route("/me/unread/read", post(activities::mark_read))


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
    //
    // ⚠★2026-08-11 liaoruili:「我打不开 dev 的 web 端」——整页空白、标题却是对的★
    //
    // 根因在缓存头:此前静态文件**一个 Cache-Control 都不发**,只有 last-modified,
    // 于是浏览器按启发式规则自己决定缓存多久,把 SPA 外壳(index.html)也缓存住了。
    // 三件事凑一起就空白:
    //   ① 浏览器拿**缓存里的旧 index.html**(所以标题「Congrove·汇流」是对的 ——
    //      那是 index.html 里的静态 <title>,★它出现只证明 HTML 到了,不证明应用启动了★);
    //   ② 部署换了版本 → JS 文件名哈希变了 → 新那个**不在缓存里**,必须现取;
    //   ③ 会话过期 → 网关把这个 JS 请求 302 成登录页的 HTML(实测 397 字节 text/html)。
    // 浏览器拿到 HTML 当模块加载 → 静默失败 → ★空白页,不报错也不跳登录★。
    //
    // 修法是 SPA 的标准做法,两类文件两种策略:
    //   · `/assets/*` 是**内容寻址**的(文件名带哈希,内容一变名字就变)→ 可以永久缓存;
    //   · `index.html` 是**指针**(指向当前那套 assets)→ ★必须每次回源校验★,
    //     否则它一旦被缓存住,就成了一个「指向已不存在的资源、又活得比会话久」的僵尸外壳。
    let web_dist = std::env::var("WEB_DIST").unwrap_or_else(|_| "web/dist".into());
    if std::path::Path::new(&web_dist).is_dir() {
        let index = format!("{web_dist}/index.html");
        let static_svc = ServeDir::new(&web_dist).fallback(ServeFile::new(index));
        app = app.fallback_service(
            axum::routing::any_service(static_svc).layer(axum::middleware::from_fn(cache_headers)),
        );
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

/// 静态资源的缓存策略(见 fallback_service 处的长注释)。
///
/// ★判据是「这个 URL 的内容会不会变」,不是文件类型★:
/// · `/assets/index-CGGytgSG.js` —— 名字里带内容哈希,同名文件的内容**永远不变** → 存一年、immutable;
/// · `/`、`/index.html`、以及所有回退到 index.html 的前端路由 —— 同一个 URL 内容会随部署变
///   → `no-cache`(可以存,但**每次必须回源校验**,304 依然省流量)。
///
/// ⚠ 用 `no-cache` 而不是 `no-store`:后者连 304 协商都不给,每次都全量重下;
///   而我们要的只是「别拿旧的当新的」,不是「别存」。
async fn cache_headers(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let hashed = req.uri().path().starts_with("/assets/");
    let mut resp = next.run(req).await;
    let v = if hashed { "public, max-age=31536000, immutable" } else { "no-cache" };
    resp.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static(v));
    resp
}
