# Congrove(汇流)· 设计与交接文档

> 本文是**交接材料**,写给将接手开发的 AI / 开发者。你可能没有前序上下文,所以这里把
> **需求、平台集成契约(经实际代码调研的确切事实)、架构决策、数据模型、权限模型、录屏方案、
> 技术栈选型、分阶段计划、必须先验证的风险** 全部写全。读完即可动手。
>
> 阅读顺序建议:先本文 → 再读**主范本 `iah_sub/citeroot/`**(同平台在跑的 Rust 子系统,技术栈已定案
> 照它抄,见 §7)与 `iah_sub/textleaf/`(UI/权限模型参考:多用户 + 角色 + SSO + S3 + PG)
> → 顶层 `iah_k8s_platform/CLAUDE.md` 的「子系统契约」节。

---

## 0. 这是什么

团队自建的知识库 / 资料共享平台,**对标 Confluence**。核心:
- 内容:**会议记录(文档)、会议录屏(视频,GB 级)、论文资料(PDF/文件)**。
- 组织:**空间(Space)** 装内容;**小组(Group)** 是人的集合。
- 权限:**给某空间授予某小组(或某人)一个角色**(viewer 读 / editor 读写 / admin 管理)。不同小组对不同空间有不同读/编辑权。

一句话定位:**「团队版 Confluence + 会议录屏 + 论文库,按小组分权共享」**。

slug = `congrove`;仓库 = `iah-sub-congrove`;一个镜像、监听一个 HTTP 端口。

---

## 1. 需求(功能清单)

**内容管理**
- 空间(Space):顶层容器,如「XX 研究组会议」「论文库」。可含文件夹(树)。
- 内容项:文件夹 / 文档(markdown/富文本,可在线编辑)/ 文件(任意)/ 录屏(视频)。
- 上传、下载、在线预览(PDF 内嵌、视频 `<video>` 播放、markdown 渲染)。
- 文档版本历史(命名快照,可回看/恢复)。

**分组与权限**
- 用户自助建**小组**、往组里拉人(组管理员)。
- 空间授权:给「某组 / 某人」授 viewer / editor / admin。
- 有效权限 = 直接授权与所有所属组授权取最大值;全局超管覆盖。

**其它**
- 搜索(先 PG 全文;可选:用平台 LLM 网关做 embedding 语义搜)。
- 审计日志(谁改了权限、删了什么)。
- 每空间可配上传大小上限 / 录屏保留策略(容量纪律,见 §7)。

---

## 2. 平台集成契约(★ 经 registry-svc 源码实测,确切事实 ★)

平台是内网 RKE2 集群 + 一个控制面(`iah-platform-src/registry-svc`)。子系统接入后**白拿**一批资源,**读环境变量即用**。

### 2.1 白拿 vs 自做

| 白拿(门户点一下注入) | 必须自己做 |
|---|---|
| 域名 + TLS + 入口(`congrove[-dev].sub.ruciah.com`) | 一个 Dockerfile、监听**一个**端口、基础镜像走国内镜像源 |
| 独立 PG 库 + role | **自建 OIDC 客户端**消费 `OIDC_*`(平台只发凭证,**不发身份头**) |
| 独立 Garage S3 桶 + read/write key | S3 用 **AWS 标准 env 名 + path-style**(别自造 key 名) |
| OIDC 机密客户端(自动注册,回调白名单自动配) | **所有状态落 PG/S3**(集群无 PVC,永远不会有) |
| LLM 网关 key、内网 CA、dev 邀请制门禁、构建管道、日志采集 | dev→prod 数据手工 `pg_dump \| psql` 迁移 |

### 2.2 注入的环境变量(确切键名)

**总是注入(显式 env):**
- `PUBLIC_URL` = `https://congrove[-dev].sub.ruciah.com`(本通道对外地址,做 cookie/Origin/回调 base 用)
- `BETTER_AUTH_URL` = 同 `PUBLIC_URL`
- `IAH_BASE_URL` = `http://llm-gateway.platform.svc:8000/v1`(OpenAI 兼容;要 AI 时用)
- `REGISTRY_URL` = `http://subsystem-registry.platform.svc:8000`
- `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` = `/etc/ssl/iah/ca.crt`(内网 CA,调平台 HTTPS 不报证书错;CA 由只读 volume 挂到 `/etc/ssl/iah`)
- `PYTHONUNBUFFERED=1`

**PG(申请后注入,来自 secret `sub-congrove[-dev]-db`):**
| 键 | 值 |
|---|---|
| `DATABASE_URL` | `postgresql://<dbn>:<pwd>@iah-pg-rw.data.svc:5432/<dbn>` |
| `PGHOST` | `iah-pg-rw.data.svc` |
| `PGPORT` | `5432` |
| `PGDATABASE` / `PGUSER` | `<dbn>` = `sub_congrove` (prod) / `sub_congrove_dev` (dev) |
| `PGPASSWORD` | `<pwd>` |
> CNPG 托管的 `iah-pg`,每通道独立库+role。**不申请则 secret 不存在**、pod 照常起但拿不到 `DATABASE_URL`。

**S3 / 对象存储(申请后注入,来自 secret `sub-congrove[-dev]-oss`):**
| 键 | 值 |
|---|---|
| `S3_ENDPOINT` / `AWS_ENDPOINT_URL_S3` | `http://garage.data.svc:3900`(集群内) |
| `S3_BUCKET` | `sub-congrove` / `sub-congrove-dev` |
| `S3_REGION` / `AWS_DEFAULT_REGION` | `garage`(★ 必须是这个字符串,否则 HeadBucket 400 ★) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | read/write 权(不能改配额/删桶) |
> Garage(S3 兼容)**必须 path-style**(`force_path_style=true` / addressing_style=path)。桶无硬配额,吃 ~5TB 共享池。
> 外部端点(浏览器可达):`https://s3api.ruciah.com`(录屏预签名用,见 §6)。

**OIDC / SSO(申请/接入后注入,来自 secret `sub-congrove-oidc`,两通道共用):**
| 键 | 值 |
|---|---|
| `OIDC_ISSUER` | `https://auth.ruciah.com/realms/iah` |
| `OIDC_CLIENT_ID` | `sub-congrove` |
| `OIDC_CLIENT_SECRET` | `<机密客户端 secret>` |
| `AUTH_SECRET` / `BETTER_AUTH_SECRET` | 会话签名密钥(重建保留,不踢登录) |
> 平台自动注册**机密** OIDC client,回调白名单 `https://congrove[-dev].sub.ruciah.com/*` 两通道都写好。子系统零配置接 SSO。

**自定义 env**:门户「环境变量」面板可注入(来自 secret `sub-congrove[-dev]-env`),同名键**不会覆盖**上面平台托管的键。

### 2.2b 声明式接入与自动构建(★ llms.txt 2026-08-01 核对补充 ★)

不必每次进门户手点。**仓库根放 `iah.yaml`**(声明 `port` / `visibility` / `want_db` / `want_oss` /
`llm_groups` / `env`),然后:
- **首次部署**:门户接入表单「从 iah.yaml 读取参数」一键回填;或纯 CLI:
  `POST https://registry.ruciah.com/api/subsystems/congrove/deploy` body `{"repo":"...","ref":"dev","autobuild":true}`(带个人 API 令牌)。
- **push 即构建**:`autobuild:true` 自动挂 Gitea webhook,push 到通道登记分支即构建部署(按通道 ref 匹配,push 别的分支不触发)。
- **构建失败自查**:`GET /api/subsystems/congrove/build-log?channel=dev`(kaniko 全量日志唯一入口,不进 Loki)。
- **dev 库任意 SQL**(改 schema 不必进 pod):`POST /api/subsystems/congrove/db/sql`,只通 dev,prod 403。
- 安全边界:want_* 只增不减(删行绝不 DROP);默认资源档 1 CPU / 512Mi 内存——预签名「pod 不搬字节」的设计正好贴合这个档位,流式代理回退则必须限流防 OOM。
- 日志只写 stdout/stderr(Loki 收,留 60 天),推荐 JSON 结构化(`tracing-subscriber` 的 json 格式即可),别写文件。

### 2.3 dev / prod 双通道
同一子系统两个 channel(不是两个仓库):dev 加 `-dev` 后缀、prod 无后缀。**各通道独立 PG 库 + S3 桶**(OIDC client 两通道共用)。`promote` **复用 dev 镜像不重建**,但 prod 落**空库**,数据要手工迁。dev 通道有邀请制 SSO 门禁,prod 公开。

### 2.4 无 PVC 铁律
集群**没有 PVC,永远不会有**。sqlite / 本地文件在每次 rebuild/restart/promote **清零**。正式数据**必须**落 PG(`iah-pg-rw.data.svc:5432`)+ Garage S3(`garage.data.svc:3900`)。后台任务状态也别放内存(重启即丢)。

---

## 3. 三个关键架构决策(带证据)

### 决策 A — 身份:自建 OIDC 客户端,`preferred_username` 作用户主键
平台**不给应用注入身份头**。三个现存子系统(citeroot/textleaf/zendata)全都自己接 Keycloak OIDC,从 token/userinfo 拿 `sub` / `preferred_username` / `name` / `email`。→ 我们照做,用 `preferred_username` 当用户主键(全平台一致)。
> 证据:`iah-platform-src/registry-svc/store.py:136-141` 控制面自己也只认 `X-Forwarded-Preferred-Username`;
> `oauth2-proxy-subdev.yaml:104` 网关只透传 user/preferred_username/email 三个头,给应用的身份点就是「用户名 + 邮箱」。

### 决策 B — 分组权限:★必须自建 PG 模型,不能靠 Keycloak★(本项目最关键结论)
铁证三条:
1. **网关不给组**:`iah_k8s/subsystems/oauth2-proxy-subdev.yaml:46-50,104` —— scope 无 `groups`,无 `--set-xauthrequest-groups`,`authResponseHeaders` 白名单里没有任何 groups 头。
2. **Keycloak 里根本没有组**:realm `iah` 没配 groups mapper、token 无 groups claim。实证:JupyterHub 因请求 groups 而报 `auth_state_groups_key oauth_user.groups does not exist`;全仓库搜不到任何 group protocolMapper(`keycloak.py:16-27` 建 client 时不加任何 group/role mapper)。
3. **平台没有「查组」API**:registry 的 `subsystem_members` 只是「谁能进这个 dev 子系统」的粗门禁(`routes/members.py`),不对子系统开放,不是通用组。

→ **在自己的 PG 库里自建 `用户↔组↔权限`**(参照 textleaf 的做法——它把「项目=组织、成员=角色 owner/editor/viewer」全放自己的表里)。好处:让终端用户在本系统 UI 里自助建组/拉人,不用找运维改 Keycloak。
> 例外:realm 角色(如 citeroot 用的 `citeroot-admin`)可给**全局超管**这种粗粒度用,但前提是自己解 JWT 读 `realm_access.roles`。细粒度「多组×多空间×读/写」的场景角色不适用。本项目超管建议落自建表 + 用户名白名单(见 §5)。

### 决策 C — 存储:PG 存元数据/权限,Garage S3 存二进制,录屏走预签名
- 元数据(谁/什么/权限/版本)→ PG;文档正文/PDF/录屏 → Garage S3。
- **录屏(GB 级)**:浏览器凭**预签名 URL 直传/直取** Garage(经 `s3api.ruciah.com`),pod 只签发 URL 不搬字节;预签名 GET 天然支持 **Range**,视频可拖动流式播放。
- ⚠ 无现存预签名先例(citeroot 全走后端流式代理)→ **§8 的 PoC 必须最先跑通**;跑不通就回退「pod 流式代理 + Range」(citeroot 的 PDF 流式 `src/pdf.rs` 是现成范本:边下边限流、超阈值中止防 OOM、内容寻址 `pdf/{sha256}.pdf`)。

---

## 4. 数据模型(PG,子系统自建)

```sql
-- 身份:登录即 upsert;preferred_username 为主键
app_user(username text PK, name text, email text, is_super bool default false, created_at timestamptz);

-- 小组
groups(id bigserial PK, name text, description text, created_by text, created_at timestamptz);
group_members(group_id bigint, username text, role text check(role in ('member','manager')),
              added_by text, added_at timestamptz, PRIMARY KEY(group_id, username));  -- manager 可增删本组成员

-- 空间(库)
spaces(id bigserial PK, name text, description text, created_by text, created_at timestamptz);

-- ★ ACL:给「空间」授予「组或人」一个角色 —— 就是「不同小组不同读/编辑权」的落点
space_grants(space_id bigint, grantee_type text check(grantee_type in ('group','user')),
             grantee_id text,   -- group: group_id 字符串化;user: username
             role text check(role in ('viewer','editor','admin')),
             granted_by text, granted_at timestamptz,
             PRIMARY KEY(space_id, grantee_type, grantee_id));

-- 内容项:文件夹/文档/文件/录屏;挂空间下,可有父文件夹(树)
items(id bigserial PK, space_id bigint, parent_id bigint null,
      kind text check(kind in ('folder','doc','file','video')),
      name text, s3_key text, size bigint, mime text, sha256 text,
      created_by text, created_at timestamptz, updated_at timestamptz);

-- 文档/文件版本历史(S3 内容寻址,按 sha256)
item_versions(id bigserial PK, item_id bigint, s3_key text, size bigint, sha256 text,
              label text, created_by text, created_at timestamptz);

audit_log(id bigserial PK, ts timestamptz default now(), actor text, action text, target text, detail text);
```
> 建表纪律:参照平台,`CREATE TABLE IF NOT EXISTS` 后接 `ALTER ... ADD COLUMN IF NOT EXISTS`;加字段走 ALTER。
> S3 object key 建议:`spaces/<space_id>/<item_id>/<sha256>`(内容寻址,去重、防覆盖)。

---

## 5. 权限模型(简单可解释)

三档空间级角色:`viewer`(读+下载) < `editor`(读写+上传+建文件夹) < `admin`(改成员/权限+删空间)。

```
effective(user U, space S) = max(
    U 在 S 上的直接 user 授权,
    U 所属每个组在 S 上的 group 授权 )
app_user.is_super = true → 全局覆盖(超管)。
```
- 「A 组只读某会议库、B 组可编辑」= 该空间加两条 `space_grants`(A→viewer、B→editor)。
- **v1 权限只到空间级**(够用、好懂);若以后要「空间内某文件夹更严」,加 `item_grants` 做子树覆盖(`items.parent_id` 已支持树)。
- **真判权在后端**;前端按角色隐藏编辑入口只是体验,别当安全边界(参照 textleaf「never rely on UI gating」)。
- **超管 bootstrap**:首批超管用环境变量白名单(如自定义 env `CONGROVE_SUPER_USERS=liaoruili,...`),登录时命中即 `is_super=true`;之后超管可在 UI 里提别人。

---

## 6. 录屏 / 大文件方案

| 环节 | 做法 |
|---|---|
| **上传** | 前端选文件 → 后端校验「该用户对该空间 ≥ editor」→ 后端用注入的 S3 key **签发预签名 PUT**(指向 `s3api.ruciah.com`,大文件 multipart)→ 浏览器直传 Garage → 完成回调后端写 `items` 行 |
| **播放/下载** | 后端校验 ≥ viewer → **签发预签名 GET**(短时效,如 15 分钟)→ `<video src=预签名URL>`;浏览器发 Range 给 Garage,可拖动 |
| **回退**(预签名不通时) | pod 流式代理 `GET /api/items/:id/stream` 透传 Range;范本 citeroot `src/pdf.rs`(流式、限流、防 OOM) |
| **格式** | MVP 只收浏览器可播的 `mp4(H.264)/webm`;转码(ffmpeg,重)放 v2 |
| **容量** | 录屏吃 ~5TB 共享池(citeroot 已占 ~730GB)。每空间可配上传上限 + 老录屏保留/归档策略;内容寻址去重。⚠ 历史上 `/data` 被打满饿垮过 etcd,别把池吃满 |

---

## 7. 技术栈定案(2026-08-01)与架构设计 —— **Rust 后端 + React/AntD 前端,以 citeroot 为主范本**

> 原推荐是 textleaf 栈(Node+Fastify+Better Auth),2026-08-01 经调研**定案改 Rust**。可行性证据:
> `iah_sub/citeroot` 就是同平台在跑的 Rust 子系统,congrove 需要的每个集成点它都已验证——
> 服务端 OIDC 机密客户端登录(`src/auth.rs`,平台零配置 SSO)、AWS 标准凭证接 Garage(`storage.rs`)、
> rustls + 内网 CA(`SSL_CERT_FILE` 追加)、kaniko 构建管道对重型 Rust 的支持(`registry-svc/deploy.py`
> 已为 citeroot 把临时盘抬到 16Gi、内存 8Gi、开 layer cache,0060)。代价:迭代慢于 Node(编译等待、
> kaniko 重建时 `COPY src` 使 cargo 层缓存失效全量重编)。**主参考范本从 textleaf 换成 citeroot**;
> textleaf 降级为 UI / 权限模型(项目=组织+角色)的参考。

### 7.1 选型清单(版本经 2026-08-01 联网对抗核查修订,★别照抄 citeroot 的版本号★)

| | 定案 | 对应 citeroot 先例 / 版本核查修订 |
|---|---|---|
| 后端 | **Rust:axum 0.8 + tokio 1 + sqlx 0.9**(runtime 查询,不用 `query!` 宏) | citeroot 用 sqlx 0.8——★新项目上 **0.9**:0.8 线停更一年(0.8.6=2025-05),仓库已迁 transact-rs;0.9 的 `query*()` 收 `impl SqlSafeStr`,动态 SQL 要包 `AssertSqlSafe`,MSRV 1.86★。axum 0.8.9 现行主线(0.8.2 被 yank 别锁);RUSTSEC-2024-0363 只影响 sqlx ≤0.8.0,与我们无关 |
| 身份 | 自建 OIDC:**服务端授权码 + HS256 会话 cookie**(HttpOnly);签名密钥用平台注入的 `AUTH_SECRET`(重建保留不踢登录);JWT 库 **jsonwebtoken 11**(citeroot 的 9 已是上上代) | `src/auth.rs` 整体移植,换库版本 |
| 数据层 | sqlx + PG;迁移 `sqlx::migrate!` 编进二进制,启动带 advisory lock 跑,**只增不改**;PG18 无已知兼容问题 | `db.rs` + `migrations/` |
| 对象存储 | `aws-config` + `aws-sdk-s3 = "1"`(1.x 稳定无 2.x;provider chain 读 `AWS_ACCESS_KEY_ID/SECRET`,path-style);预签名用 SDK 原生 `.presigned(PresigningConfig)`;★client 必须设 checksum `WhenRequired`,见 §7.4b-3★ | `storage.rs`(预签名部分自己加) |
| 前端 | **React 19 + AntD 6 + Vite 8**(AntD 6 正式版原生支持 React 19,官配;Vite 6 已落后两代,8 内置 Rolldown) | `web/` + `http/mod.rs:161-165` |
| 端口 | **:8030**(静态 + REST 同端口) | citeroot :8123 同模式 |
| 基础镜像 | 构建 `rust:1-slim-trixie`、运行时 `debian:trixie-slim`(★bookworm 2025-08 起已是 oldstable;构建/运行时**同底座别混**,glibc 版本要一致★),前端阶段 `node:24-slim` | citeroot 用 bookworm,是当时的对;镜像源前缀 daocloud 不变 |

### 7.2 代码布局(单 crate,模块切分)

```
src/
  main.rs        # 启动:config → pool+migrate → AppState → router → serve;启动时清理孤儿任务状态
  config.rs      # 全 env 驱动;缺 DATABASE_URL / S3_* 硬失败(citeroot config.rs 的 req() 模式)
  state.rs       # AppState { pool, storage, auth: Option<Arc<Auth>>, cfg }
  auth.rs        # ← citeroot 移植:/auth/login|callback|logout 服务端换码、HS256 会话 cookie、
                 #   require_auth 中间件、ensure_app_user(登录 upsert app_user)、JWKS Bearer 自验(可留可裁)
  perm.rs        # ★ 本项目核心:effective_role(user, space) 一条 SQL 算有效角色;require_role guard
  storage.rs     # S3 封装:put/get/delete + presign_get/presign_put(外部端点)+ 流式代理回退
  audit.rs       # audit_log 写入 helper(权限变更/删除必录)
  http/
    mod.rs       # 路由:/healthz /readyz 开放;/auth/* 开放;/api 全挂 require_auth(route_layer);
                 #   ServeDir(web/dist) SPA 回退;30s TimeoutLayer;上传路由单独放大 body limit
    spaces.rs    # 空间 CRUD + 授权管理(space_grants;admin 才能动)
    groups.rs    # 小组 CRUD + 成员管理(manager 可增删本组成员)
    items.rs     # 内容树:文件夹/文档/文件/录屏 CRUD、移动;文档正文读写(S3)+ 版本(item_versions)
    media.rs     # 上传/下载/播放:预签名签发端点 + 流式代理回退(Range 透传)
    admin.rs     # 超管面板:用户列表、提拔超管、全局审计查询
migrations/      # 0001_init.sql 起,每个文件头写「这次加了什么、为解决什么」
web/             # React 19 + AntD 6 + Vite;vite dev 代理 /api → :8030
```

### 7.3 鉴权与权限判定(两层,别混)

- **第一层「是谁」**:`require_auth`(auth.rs)——会话 cookie 或 Bearer 二选一,产出 `Identity { username, name, email, is_super }` 挂进 request extension。登录回调里 `ensure_app_user` 按 `preferred_username` upsert,并对照 `CONGROVE_SUPER_USERS` 白名单置 `is_super`。
- **第二层「能不能」**:`perm.rs::require_role(pool, &id, space_id, Role::Editor)`——每个 space 作用域的 handler 第一行调它。有效角色一条 SQL 算出(直接授权 ∪ 组授权取 max,超管短路):

```sql
SELECT max(r) FROM (
  SELECT role r FROM space_grants WHERE space_id=$1 AND grantee_type='user' AND grantee_id=$2
  UNION ALL
  SELECT g.role FROM space_grants g JOIN group_members m
    ON g.grantee_type='group' AND g.grantee_id = m.group_id::text
  WHERE g.space_id=$1 AND m.username=$2 ) t;
-- role 排序用 CASE 映射 viewer=1/editor=2/admin=3 后取 max,返回 Option<Role>
```

- 角色不足返回 403(不是 404);未登录 401。**真判权只在这一处**,前端按角色藏按钮只是体验。
- 纯函数部分(角色偏序、max 合并、超管短路)写成无 IO 的单元测试(`cargo test`,citeroot 模式:不连网不连库)。

### 7.4 存储流(元数据 PG,字节 S3,录屏预签名)

- **S3 key**:`spaces/<space_id>/<item_id>/<sha256>`(内容寻址;版本历史天然免费,`item_versions` 指旧 sha)。
  同 sha 可能被多行引用,**删对象前先查引用计数**(citeroot `delete_fulltext` 的教训,别简化)。
- **小文件/文档**(≤ 阈值,如 50MB):走后端 multipart 直传直取,handler 挂大 body limit(axum 默认 2MB,
  citeroot 放大到 100MB 的写法照抄)。文档 markdown 正文也是 S3 对象,保存 = 写新 sha + 更新 items.s3_key + 插 item_versions。
- **录屏(GB 级)**:预签名直传直取。⚠ SDK 有个双端点细节:pod 内部操作用 `S3_ENDPOINT`
  (`garage.data.svc:3900`),**预签名必须用外部端点**(`https://s3api.ruciah.com`,浏览器可达;
  llms.txt 已确认该端点存在、SigV4 原生鉴权不经 SSO,但内网直连是内网 CA 签的证书,信任链问题见 §8-1)——
  做法是建**两个 S3 client**,签名用的那个 endpoint 配成外部域名(自定义 env `S3_PUBLIC_ENDPOINT` 注入)。
  上传:后端验 ≥editor → `create_multipart_upload` → 逐 part 签预签名 PUT 给前端 → 前端直传 →
  后端 `complete_multipart_upload` + 落 items 行。播放:验 ≥viewer → 签 15 分钟预签名 GET →
  `<video src>`,Range 由 Garage 处理,可拖动。
- **回退**(§8 PoC 不通时):`GET /api/items/{id}/stream` 流式代理透传 Range,范本 citeroot `src/pdf.rs`
  (边下边限流、超阈值中止防 OOM)。media.rs 里把「签 URL」抽成接口,两种实现可切换,PoC 结果只影响配置不重写代码。

### 7.4b 预签名直传的工程细节(★2026-08-01 联网对抗核查产出,每条都有出处,别凭感觉改★)

可行性已源码级证实:Garage 兼容表预签名/multipart 全 ✅,CORS preflight 在 `src/api/common/cors.rs`
(`handle_options_api`,**preflight 不鉴权**——这对预签名场景是必要条件)且作用于 S3 API 端点;线上
Garage v2.1.0(`iah_k8s/data/garage.yaml`),远高于「实请求响应缺 CORS 头」的 v0.8.5 修复红线。
Rust SDK 侧 `get_object`/`put_object`/`upload_part` 三个 builder 全支持 `.presigned()`(awslabs #475 已 Done),
7 天上限在 `PresigningConfig::build()` 硬拦。但有六条工程约束:

1. **★桶 CORS 必须配,且 congrove 自己配不了★**:跨源 PUT 无条件触发 preflight;multipart 直传时 JS 要读
   每个 part 响应的 `ETag`(跨源默认读不到)→ CORS 规则必须含 `ExposeHeaders:["ETag"]`,否则 complete 一步必死。
   而 Garage 里 `PutBucketCors` 要 key 带 **owner 位**,平台注入的 key 只有 read/write → **CORS 配置是
   平台 provisioner 侧的活**(与「高权 API 放 provisioner」纪律一致):开桶时一次性写入
   `AllowedOrigins=[dev+prod 两域名], AllowedMethods=[GET,PUT,POST,DELETE], ExposeHeaders=[ETag]`。
   **P0 就要给平台提这个需求**,别拖到 P2。
2. **签名把 Host 算进 SigV4** → 公网域名单独建一个签名用 client(§7.4 的双 client)是必须项;且
   `s3api.ruciah.com` 前的反代必须**原样透传 Host、路径、全部 query**,改写任何一样签名即失效。
   endpoint 用代码 `endpoint_url()` 显式设,别依赖 `AWS_ENDPOINT_URL` env(SDK 曾忽略它,#932)。
3. **★checksum 默认行为是地雷★**:aws-sdk-s3 ≥1.69.0 默认给 Put 类操作加 CRC32 校验头(2025-01 曾炸翻
   B2/R2 等一片第三方存储)。两个 S3 client 统一设
   `request_checksum_calculation(WhenRequired)` + `response_checksum_validation(WhenRequired)`;
   **别在预签名请求上显式配 checksum**(#1103:签进去的是空 body 的 checksum,URL 直接不可用);
   PoC 必须断言签出的 URL query/headers 无 `x-amz-checksum-*`,且 `PresignedRequest.headers()` 为空
   (非空则浏览器必须原样带上,纯 `<video src>` 场景带不了)。
4. **complete 放后端**:前端只传 part;`CreateMultipartUpload`/`CompleteMultipartUpload`/`ListParts` 全走
   服务端 `.send()`,ETag 由前端收集后交回。断点续传 = 存 uploadId,中断后 `ListParts` 对比跳过已完成 part。
   **必须做半截上传的定期清理**(Abort 超过 N 天的 incomplete upload,否则永久占存储)。
   Presigned POST(表单直传、可限 content-length-range)Rust SDK 不支持(#863)→ part 大小/配额靠业务闸。
5. **前端**:进度条用 XHR `upload.onprogress`(fetch 至今无标准上传进度);`file.slice()` 是磁盘句柄
   不进内存,GB 级安全;**别在前端算全文件哈希**(会整个读进内存)——sha256 由后端在 complete 后
   异步补(或版本先记 size+etag)。preflight 响应无 `Max-Age` → 每 part 多一次 OPTIONS,内网可忍。
6. **视频播放**:`<video>` **不带** `crossorigin` 属性 = no-cors 请求,播放和 Range 拖动都不需要 CORS
   (代价:canvas 截帧/WebAudio 会被污染,以后要做封面截图就得加 `crossorigin` 走 CORS);
   **Safari 硬性要求 206**(先探前 2 字节,拿不到正确 `Content-Range` 直接不渲染)→ 网关对该域要
   透传 Range、关压缩和响应缓冲;Garage 只支持**单 range**(多 range 回整对象),播放器都是单 range,无碍。

### 7.5 前端(React 19 + AntD 6 + Vite)

- 布局:AntD `Layout`——左侧空间/文件树(`Tree`),顶部 IAH 品牌页眉(按 `app/main.py` 占位页样式复刻),
  主区按 item.kind 分发:markdown 渲染/编辑器、PDF `<embed>`、`<video>`、文件下载卡。
- 身份:SPA 不碰 token(citeroot 模式)。启动 `GET /api/me`,401 就整页跳 `/auth/login`;
  角色信息由空间列表 API 一并返回,前端只做显隐。
- 构建:`pnpm build` → `web/dist`,Dockerfile 阶段一构建、运行时由后端托管。
  ⚠ 平台构建期零类型检查,改完 TS 手跑 `pnpm typecheck`(tsc --noEmit)。

### 7.6 sqlx 两个已知陷阱(citeroot 踩过,提前避)

1. runtime 查询 SQL 错误**只在运行时炸**——加字段后手动核对 `FromRow` 字段名/类型;关键路径起服务打一遍。
2. 若用 citext 列必须 `::text` 强转才能读进 `String`(本项目 username 等直接用 text 即可,尽量别引入 citext)。

### 7.7 Dockerfile 与本地开发

- **三阶段 Dockerfile 照抄 citeroot 的结构、但基座换 trixie**:①node:24-slim pnpm build 前端
  ②rust:1-slim-**trixie** cargo build(cargo 镜像源 `rsproxy.cn` 的 config.toml 写法照抄,TUNA
  `mirrors.tuna.tsinghua.edu.cn/crates.io-index` 做备胎)③debian:**trixie**-slim 运行时(构建/运行时
  同底座,glibc 一致;纯 rustls 二进制无需装 libssl;congrove 无 pdftoppm/rclone 之类原生依赖,
  运行时层比 citeroot 更薄)。
- 本地:`cp .env.example .env && cargo run`;**鉴权开关 = `OIDC_ISSUER` 有没有配**,没配则关闭 + 启动大声
  WARN(本地裸连验证用),配了即开——citeroot 模式。前端 `pnpm dev`(vite,/api 代理到 :8030)。

---

## 8. 风险 / 必须先验证(动手前 & 关键路径)

1. **★预签名 PoC(录屏方案命门,最先做)★**:写一小段脚本用注入的 `sub-congrove-oss` key 对 `s3api.ruciah.com`
   签一个预签名 GET/PUT,验证:① 该 key 能对外部端点签出可用 URL——llms.txt(2026-08-01 核对)已确认
   `s3api.ruciah.com` 真实存在且 **SigV4 原生鉴权、不经 SSO**(「外部 CLI 密钥」一节就靠它 rclone 直连),
   可行性大增;② 真实用户浏览器能到达且 **TLS 信任链成立**——⚠ 新发现的坑:内网直连时 `s3api.ruciah.com`
   由「IAH Internal CA」签(非公共根),**没装内网 CA 的浏览器上 `<video src=预签名URL>` 会静默失败**;
   公网路径经云服务器中转是真证书无此问题。PoC 必须分「装了 CA / 没装 CA、内网 / 公网」四象限实测,
   结论写回本节。PoC 检查单(结合 §7.4b 的对抗核查结论):① 签出的 URL query/headers 无
   `x-amz-checksum-*` 且 `PresignedRequest.headers()` 为空;② 桶 CORS 已由平台配好(preflight OPTIONS
   能过、PUT 响应能读到 ETag)——**这项要先给平台提需求,pod 的 key 无 owner 位自己配不了**;
   ③ 反代原样透传 Host/路径/query(签名有效)与 Range/206(Safari 能播);④ 四象限 TLS。
   任一不成 → 走 §6 回退(pod 流式代理,同源域名无跨域/CA/CORS 问题)。**别等做到 P2 才发现。**
2. **视频容量**:5TB 共享池、和 citeroot 数据共用;必须有上传上限 + 保留策略。
3. **视频格式**:非 mp4/webm 浏览器播不了;MVP 明确只收这俩。
4. **无 PVC**:任何本地写盘/sqlite 上线即丢;测试到「重启后数据还在」才算数。
5. **S3 key 名别自造**:必须用 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 标准名 + path-style(citeroot 自造 `S3_ACCESS_KEY` 导致 pod crash-loop,2026-07-24)。

---

## 9. 分阶段实施

- **P0 骨架**:cargo init 单 crate + axum 单端口 :8030;移植 citeroot `auth.rs`(OIDC 登录跑通);
  sqlx 连 PG + 0001 迁移建表(§4 全部表);`/healthz` `/readyz` + `/api/me`;web/ 起 Vite+AntD 壳。
  门户接入 dev、申请 PG + S3。
- **P1 核心**:perm.rs 权限判定 + 空间/组/成员/授权 CRUD;文档(markdown)与小文件上传下载(先走后端);列表/文件树 UI。
- **P2 录屏**:先做 §8 预签名 PoC;通了就预签名直传/直取 + `<video>`;不通走流式代理回退。
- **P3 打磨**:版本历史、审计、搜索(PG 全文——中文注意 citeroot 的教训:`to_tsvector('english')` 切不动中文,
  要 trgm + ILIKE 双路;语义搜可在自己库 `CREATE EXTENSION vector`(平台 PG18 + pgvector 可用)+
  `IAH_API_KEY` 调 `Qwen3-Embedding-8B/0.6B`,本地模型免费不限)、每空间容量上限、录屏保留策略。
  ⚠ 若语义搜要**按登录用户**计 LLM 用量:得用该用户的 Keycloak access token 换每用户 key
  (`POST {REGISTRY_URL}/api/llm/me/key`)——而 auth.rs 的 HS256 会话 cookie 默认**不保留** access token,
  届时要在会话里存(或续期)Keycloak token,P0 移植 auth.rs 时留好这个扩展点(渠道 key 记子系统名下则无此需求)。
- **上 prod**:复用 dev 镜像 promote;prod 空库,手工 `pg_dump dev | psql prod` 迁数据。

---

## 10. 关键约定速查

- 只监听**一个** HTTP 端口(静态 + REST 同端口,不用 80);**定 :8030**(当前 Python 占位页仍是 8000,起真骨架时换掉)。
- **保留 IAH 品牌页眉**(见 `app/main.py` 的实现:◆IAH 在上、子系统名在下、点击回 `hub.ruciah.com`;换 Node/前端后要在页面顶部复刻这个页眉)。
- 代码/注释/提交信息用**中文**,匹配全树风格(极密一行流 + 长中文注释,注释是文档)。
- 双远端 Gitea(内网,主)+ Gitee(外部备份);**push 由仓库所有者做**;密钥绝不入库,提交前 `git diff --staged` 扫明文密钥。
- 参考子系统:**citeroot**(主范本:Rust 栈、auth.rs/storage.rs/Dockerfile 直接抄,2026-08-01 定案)、
  textleaf(UI 与「组织+角色」权限模型参考)。
