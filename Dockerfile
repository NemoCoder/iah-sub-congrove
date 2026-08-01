# congrove —— 单镜像单端口(8030),API + 前端同源。三阶段构建(结构抄 citeroot)。
# 集群在 GFW 后:基础镜像走 docker.m.daocloud.io,npm 走 registry.npmmirror.com,
# cargo 走 rsproxy.cn。改任一源前先读平台根 CLAUDE.md 的「网络前提:一切走镜像源」。
# 基座 trixie(2026-08-01 对抗核查:bookworm 已 oldstable;构建/运行时同底座,glibc 一致,别混)。

# ---- 1) 前端:pnpm build → /web/dist ----
FROM docker.m.daocloud.io/library/node:24-slim AS web
WORKDIR /web
RUN corepack enable && corepack prepare pnpm@11 --activate
ENV npm_config_registry=https://registry.npmmirror.com
COPY web/package.json web/pnpm-lock.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---- 2) 后端:cargo build --release → congrove ----
FROM docker.m.daocloud.io/library/rust:1-slim-trixie AS build
WORKDIR /src
# cargo 走国内镜像(GFW 后 crates.io 不稳);TUNA sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/ 做备胎
RUN printf '[source.crates-io]\nreplace-with = "rsproxy"\n[source.rsproxy]\nregistry = "sparse+https://rsproxy.cn/index/"\n[net]\ngit-fetch-with-cli = true\n' \
    > "${CARGO_HOME:-/usr/local/cargo}/config.toml"
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked

# ---- 3) 运行时(trixie-slim + 二进制 + 前端产物)----
# 二进制是纯 rustls(webpki-roots 编进去,无 libssl 依赖),内网 CA 由平台挂
# /etc/ssl/iah/ca.crt 并注入 SSL_CERT_FILE,auth.rs 运行时追加——所以这层
# **不需要 apt 装任何东西**,比 citeroot 还薄(它要 poppler/rclone,我们没有原生依赖)。
FROM docker.m.daocloud.io/library/debian:trixie-slim AS runtime
WORKDIR /app
COPY --from=build /src/target/release/congrove /app/congrove
COPY --from=web /web/dist /app/web/dist
# 迁移已由 sqlx::migrate! 编进二进制;后端从 WEB_DIST 托管前端(http/mod.rs 的 ServeDir)。
ENV WEB_DIST=/app/web/dist \
    BIND_ADDR=0.0.0.0:8030
EXPOSE 8030
CMD ["/app/congrove"]

# 部署(iah.yaml + 门户/CLI)时平台注入的环境变量:
#   DATABASE_URL                                  —— PG(want_db)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY     —— S3 凭证(标准名,SDK provider chain 直读,
#                                                    别自造 S3_ACCESS_KEY,citeroot 2026-07-24 教训)
#   S3_ENDPOINT / S3_BUCKET / S3_REGION(=garage)  —— Garage(want_oss)
#   OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / AUTH_SECRET —— SSO(自动),缺 = 鉴权关闭+WARN
#   SSL_CERT_FILE=/etc/ssl/iah/ca.crt             —— 内网 CA(自动;⚠ 别改成不存在的路径)
# 自定义 env(iah.yaml 的 env 段):CONGROVE_SUPER_USERS / S3_PUBLIC_ENDPOINT
