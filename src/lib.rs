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
pub mod notify;
pub mod remind;
pub mod tzutil;
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

    // ★超管白名单在**启动时**就种下去,不等谁来登录★。
    //
    // ⚠★2026-08-09 liaoruili:「超管没有显示开发者了吗」——ADR-0001 的清库把超管位清没了★。
    // 原来 `CONGROVE_SUPER_USERS` 只在 `ensure_app_user`(登录路径)里生效,于是清库之后:
    //   · 他的会话 cookie 还没过期 → ★不会再走一次登录★,而 /api/me 的 is_super 是**查库**的
    //     (那是对的:撤销超管要立刻生效),于是超管入口凭空消失;
    //   · 更糟的是 app_user 那一行可能被**非登录路径**先建出来(projects.rs 的
    //     `ensure_platform_user`:把他加进项目成员时就会插一行,is_super 默认 false),
    //     此后就算重新登录也只是 `OR` 上白名单——对,但得等他自己想起来重登。
    // 而 ADR-0001 定的是**每次部署都清库**,所以这不是一次意外,是每次都会复现的。
    // 白名单本来就自称「种子」——那它就该在**能种的最早时刻**种下去,而不是搭登录的顺风车。
    if !cfg.super_users.is_empty() {
        for u in &cfg.super_users {
            sqlx::query(
                "INSERT INTO app_user (username, is_super) VALUES ($1, true)
                 ON CONFLICT (username) DO UPDATE SET is_super = true")
                .bind(u).execute(&pool).await?;
        }
        tracing::info!(users = ?cfg.super_users, "超管白名单已种入 app_user");
    }

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

    // ★dev E2E 免登通道是一条真实的身份旁路,开着就要在日志里看得见★(2026-08-07)。
    // 它不需要本地开关:平台的 dev 网关校验过 X-IAH-E2E-Key 才注入身份头,
    // 而 prod 压根没有那条路由 + is_dev_channel() 门闩 —— 但「无声生效的旁路」本身就是隐患,
    // 所以每次启动都喊一句,免得哪天有人在日志里看到 `e2e` 这个用户名却不知道它从哪来。
    if cfg.is_dev_channel() {
        tracing::warn!(
            "dev E2E 免登通道生效中:带平台注入身份头的请求将以该用户名直接通过鉴权(仅 dev 通道)。\
             prod 无此路由,详见 docs/E2E-CHANNEL.md"
        );
    }

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
    // 活动提醒(PRD F2/F3)。★本仓第一个「没有请求、到点就得发生」的循环★ ——
    // 状态落 PG、去重靠行锁,理由见 remind.rs 头注。
    tokio::spawn(remind::run(state.clone()));

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
        // items-ok: 回收站生命周期 —— 30 天清扫任务,找的**就是**已删超期的行
        let expired: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM items i
              WHERE i.deleted_at IS NOT NULL AND i.deleted_at < now() - interval '30 days'
                AND (i.parent_id IS NULL OR NOT EXISTS (
                      SELECT 1 FROM items p WHERE p.id = i.parent_id AND p.deleted_at IS NOT NULL))
              -- limit-ok: 分批处理 —— 清扫任务每轮取 200 条,下一轮接着来,一条都不会丢。
              LIMIT 200",
        ).fetch_all(&state.pool).await.unwrap_or_default();
        for iid in expired {
            match crate::http::items::purge_subtree(&state, iid).await {
                Ok(n) => tracing::info!(item = iid, objects = n, "cleanup: 回收站满 30 天,已彻底删除"),
                Err(e) => tracing::warn!(error = %format!("{e:?}"), item = iid, "cleanup: 自动 purge 失败"),
            }
        }
        // ★项目回收站也满 30 天就彻底删★(2026-08-09 审计 A5:删项目从硬删改成软删)。
        // 到这一步才 FK CASCADE + 按引用计数删对象 —— 软删期间 S3 一个字节都没动过。
        let dead: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM projects
              WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'
              -- limit-ok: 分批处理 —— 同上,每轮 20 个项目。
              LIMIT 20",
        ).fetch_all(&state.pool).await.unwrap_or_default();
        for pid in dead {
            match crate::http::projects::purge_project(&state, pid).await {
                Ok(n) => tracing::info!(project = pid, objects = n, "cleanup: 项目回收站满 30 天,已彻底删除"),
                Err(e) => tracing::warn!(error = %format!("{e:?}"), project = pid, "cleanup: 项目 purge 失败"),
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
