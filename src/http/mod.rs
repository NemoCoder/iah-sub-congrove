//! HTTP 面:路由构建 + 共享中间件。结构抄 citeroot http/mod.rs:
//! 探针/auth 开放,/api 整层 route_layer 挂 require_auth(404 不要 token),
//! 超管面用 require_super 叠内层(403 不是 401),SPA 由后端同源托管。

pub mod admin;   // pub:media_ai 要用 effective_llm_model(★模型的唯一推导★)
/// ★pub 是给集成测试用的★:`tests/api_cases.rs` 要读 `APIS` 逐条核对「每个接口都有测试用例」。
pub mod dto;
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
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::auth;
use crate::state::AppState;

/// ★分页参数(`?page=1&size=20`)★ —— 2026-08-13 liaoruili:「为啥要写死 limit 500。。。
/// 以后不要再出这种建议！！！！这是业务逻辑问题！！！」
///
/// ★这条纪律值钱在它区分了两种「列表很长」★:
///   · **写死 LIMIT** = 第 501 条起**悄悄消失**。库里还在、还占配额,界面上没有、也不提示。
///     人看到的是「回收站空了」,而真相是「回收站还有 300 条」——★这是数据正确性问题,不是体验问题★。
///   · **不分页** = 一长串滚不完。难看,但**东西都在**,人至少知道自己看到的是全部。
/// 后者可以晚点改,前者不能存在。所以:★凡是要限量,就必须同时给出 total 和翻页;
/// 只给 LIMIT 不给 total,等于让界面替数据库撒谎。★
#[derive(serde::Deserialize)]
pub struct Page {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub size: Option<i64>,
}
impl Page {
    /// 返回 (limit, offset)。size 有上限只是防一次拉爆内存 —— ★它不会让数据消失★,
    /// 因为 total 照实返回、翻页翻得到。这和写死 LIMIT 500 的区别就在这一句。
    pub fn slice(&self) -> (i64, i64) {
        let size = self.size.unwrap_or(20).clamp(1, 200);
        let page = self.page.unwrap_or(1).max(1);
        (size, (page - 1) * size)
    }
}

pub fn build_router(state: AppState) -> Router {
    // 超管面:用户治理 + 配额 + 全局审计。require_super 叠在 require_auth 里层(403 不是 401)。
    let admin = Router::new()
        .route("/admin/users", get(admin::users))
        .route("/admin/users/{username}/super", put(admin::set_super))
        .route("/admin/users/{username}/quota", put(admin::set_quota).delete(admin::reset_quota))
        .route("/admin/audit", get(admin::audit_list))
        // ★AI 模型由超管在后台选★(2026-08-16 热修):平台换模型后 congrove 还在调老模型 →
        //   `403 无权调用模型` → 纪要功能整个哑掉,而子系统没有自助恢复的办法。
        // ★治理配置★(2026-08-16):谁能建项目 / 全站默认配额 / 全站默认提醒提前量。
        //   取值的唯一推导在 settings.rs;这里只是它的 HTTP 面。
        .route("/admin/settings", get(admin::settings_get))
        .route("/admin/settings/default-quota/impact", get(admin::default_quota_impact))
        .route("/admin/settings/{key}", put(admin::settings_put))
        .route("/admin/llm/models", get(admin::llm_models))
        .route("/admin/llm/model", put(admin::set_llm_model))
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
        .route("/projects/{id}/archive-blockers", get(projects::archive_blockers))
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
        .route("/me/reminders", get(activities::my_reminders))
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
        .route("/items/{id}/copy", post(items::copy))
        .route("/items/{id}/progress", get(items::progress_get).put(items::progress_put))
        .route("/items/{id}/content", get(items::content_get).put(items::content_put))
        // 公开分享的**管理面**(建/列/撤销;建与列要 ≥editor,见 share.rs 头注)
        .route("/items/{id}/shares", get(share::list).post(share::create))
        .route("/shares/mine", get(share::mine))
        .route("/shares/{token}", axum::routing::delete(share::revoke))
        .route("/items/{id}/versions", get(items::versions))
        .route("/items/{id}/restore/{version_id}", post(items::restore))
        // P2 预签名直传:begin/complete/abort 都是快 API(字节不经 pod)。
        .route("/projects/{id}/media/begin", post(media::begin))
        .route("/items/{id}/media/complete", post(media::complete))
        .route("/items/{id}/media/abort", post(media::abort))
        // ★`/play` 留在 fast 组 —— 哪怕它禁下载时会推整个视频★
        //
        // ⚠★这里我先搞错过一次,而且很自信地写了一大段论证,现在把真相记下来★(2026-08-16):
        //   `/play` 2026-08-15 多了一条「禁下载 → 同源 Range 代理」的分支,我据此判定
        //   「30 秒超时会把视频掐断」、把它挪进了 slow 组,还给了三层理由。★那个判断是假的。★
        //
        //   查 tower-http 0.6.11 的 `timeout::ResponseFuture::poll`:
        //       if this.sleep.poll(cx).is_ready() { …超时… }
        //       this.inner.poll(cx)          // ← race 的是 **inner service future**
        //   而 `inner` 在 **handler 返回 Response 的那一刻**就 resolve 了 ——
        //   那时 body 只是一个还没被读的流对象。★之后的流式传输完全不受这个 layer 约束。★
        //   要约束响应体得用**另一个** layer(`ResponseBodyTimeoutLayer`,把 body 包成
        //   `TimeoutBody`)—— 本仓没有用。
        //
        // ⇒ 所以 fast/slow 的真实含义是「**handler 自己**能跑多久」,不是「响应有多大」:
        //   · slow 组真正需要它的是 `upload` / `media/part` —— 那两个的 handler **要读完整个请求体**,
        //     那是在 inner future 里面,确实被 layer 管着;
        //   · `download` / `play` 的 handler 只是**打开** S3 流就返回了,毫秒级,fast 组绰绰有余。
        //   (顺带:`download` 现在还在 slow 组。没动它 —— 无害,而且改它属于另一件事;
        //    但别再把它当成「因为要流式所以放 slow」的先例,那个理由是不成立的。)
        //
        // ★教训记在这儿★:一个改动的理由一旦被证伪,改动本身就该跟着撤 ——
        //   否则留下的是「一段自信但错误的论证」,下一个人会照着它推理。
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
        // ★纪要导出 PDF★(2026-08-17,走平台共享 latex-svc):★放这里不放 fast★——
        //   实测一份小纪要 3.2s,但 LaTeX 是 CPU 密集的,大纪要可能顶到十几秒,
        //   而 fast 组 30s 超时会把它拦腰掐断(与上传/下载同一个理由)。
        //   ⚠ 我第一版就写在 fast 组里、注释却写着「放 slow 组」——★断言和代码对不上,
        //     而两者不一致时没有任何东西会报错★。是核了一遍位置才发现的。
        .route("/activities/{id}/minutes/pdf", post(activities::minutes_pdf))
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
        // ★后端自报版本★(2026-08-22):`scripts/deployed-version-check.sh` 原来**只量前端 bundle**,
        //   于是纯后端的改动它完全是瞎的 —— v0.7.9/v0.7.10 都是纯后端,那道闸对它们等于没跑。
        //   2026-08-22 我因此花了很多轮怀疑「是不是没部署」,而它一直在报绿。
        //   ⚠ 这里**不做 congrove 自己的鉴权**:版本号本来就印在前端 bundle 里,不是秘密。
        //   ★但它并不「免鉴权」——2026-08-23 更正★:dev 通道的网关对**整个域名**做 SSO 门禁
        //     (`/healthz` 也一样被 302),所以量它仍然要带 E2E key。
        //     我当初在这儿写「免鉴权是有意的…否则在 CI 里会变成假绿」,那个前提是错的,
        //     而错误的后果是那道闸连着几天报「问不到后端版本」——★一个自己造的假红★。
        .route("/version", get(version))
        // 服务端浏览器 SSO——登录入口本身必须开放(换码走 Keycloak,给 60s)。
        .merge(
            Router::new()
                .route("/auth/login", get(auth::oidc_login))
                .route("/auth/callback", get(auth::oidc_callback))
                .route("/auth/logout", get(auth::oidc_logout))
                .route_layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(60))),
        )
        // ★不存在的 /api 路径必须 404,不能掉进 SPA 兜底★(2026-09-05 发现)。
        //
        // axum 的 `nest` 里没匹配上的路径会一路掉到**外层的 fallback** ——
        // 而外层兜底是 `index.html`(给前端路由用的)。于是:
        //   `GET /api/随便什么不存在的` → ★HTTP 200 + text/html★,不是 404。
        //
        // 这不只是难看:
        //   · 前端 `res.ok` 为真却拿到一坨 HTML,`res.json()` 抛一个牛头不对马嘴的解析错,
        //     人会去查 JSON 解析而不是查「这个接口根本不存在」;
        //   · ★接口被删掉或改名时不报 404,反而「成功」★ —— 任何按 404 率做的监控看不见它,
        //     而这正是本仓 2026-08-13 那次「响应体从数组改成对象、八道门禁一道没红」的同族:
        //     ★错误被表达成了成功,于是所有守卫都失去了判据。★
        //   · 我自己就是这么撞上的:猜了个不存在的 `minutes.pdf` 路径,curl 回 200,
        //     差点当成「接口在、只是内容不对」去查生成逻辑。
        //
        // ⇒ 给 /api 这一层自己的 fallback。用 `AppError::NotFound` 而不是手写一个 404,
        //   这样它的响应体形状和其余所有 404 完全一致(`{"error":"not found"}`)。
        .nest("/api", api.fallback(|| async { crate::error::AppError::NotFound }))
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
        //
        // ★请求日志必须显式抬到 INFO★(2026-08-16):`TraceLayer::new_for_http()` 是**装了等于没装** ——
        //   它的 on_request / on_response 默认发在 **DEBUG**,而线上过滤器是 `info,congrove=debug`
        //   (`tower_http` 只到 info)⇒ ★每个请求的方法/路径/状态码,一条都不记★。
        //
        // 这件事的代价当天就付了:一条 E2E 拿到 **500 而不是 403**,重跑就绿。查根因时发现
        //   · 应用层没记(`error.rs` 对 Db/Other 都 error!,而 Loki 里那 20 分钟**两个 pod 合起来 0 条 ERROR**
        //     —— 所以那个 500 根本不是应用返回的);
        //   · 网关也没记(Traefik 没开 accessLog,只有它自己的 WRN);
        //   ⇒ ★一个非应用产生的 5xx,在全链路上不留任何痕迹★,而它偏偏是最需要痕迹的那种错。
        // ⚠ 别指望 `on_failure`(它确实是 ERROR)兜住:它只在**应用返回 5xx** 时触发,
        //   而这次的 500 压根没走到应用。要能分辨「谁返回的」,就得每个请求都留一行。
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        );

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

/// 后端自报版本 —— ★给部署闸用的,别让它只能量前端★(见路由处的注释)。
/// `GET /version` 的响应体。★定成结构体而不是 `json!{}`★——
/// 这样 OpenAPI 契约里的字段是从它**现推**的,加字段自动进契约,不会静默过期。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct VersionOut {
    /// 后端二进制的版本,等于 Cargo.toml 的 `version`。
    pub version: &'static str,
}

async fn version() -> Json<VersionOut> {
    Json(VersionOut { version: env!("CARGO_PKG_VERSION") })
}

/// `GET /readyz` 的响应体。
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ReadyOut {
    /// pg && s3。false 时整个响应是 503 —— k8s 据此摘流量。
    pub ready: bool,
    pub pg: bool,
    pub s3: bool,
}

/// 就绪:PG SELECT 1 + S3 head_bucket 都通才算 ready。
async fn readyz(axum::extract::State(state): axum::extract::State<AppState>) -> (StatusCode, Json<ReadyOut>) {
    let pg = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.pool).await.is_ok();
    let s3 = state.storage.healthcheck().await.is_ok();
    let ready = pg && s3;
    let code = if ready { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, Json(ReadyOut { ready, pg, s3 }))
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
