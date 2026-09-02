# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 现状：P0 骨架已落地(2026-08-01),先读 DESIGN.md

本仓库是「汇流 Congrove」——对标 Confluence 的团队知识库(空间 + 小组 + viewer/editor/admin 三档授权),
外加 GB 级会议录屏与论文库。需求、平台契约、数据模型、权限模型、录屏方案(§7.4b 预签名工程六条)、
架构设计、分阶段计划**全部在 `DESIGN.md`**,动手前必须通读,本文只列操作要点。
栈:**Rust(axum 0.8 + sqlx 0.9 + aws-sdk-s3 1.x + jsonwebtoken 11)+ React 19/AntD 6/Vite 8**,
端口 :8030,镜像基座 trixie。主范本 `../citeroot/`——⚠ 抄它的**结构**别抄它的**版本号**
(sqlx 0.8/jwt 9/bookworm 已过时;2026-08-01 联网对抗核查修订,依据见 DESIGN.md §7.1)。

**P0 已有**:服务端 OIDC 登录(auth.rs,自 citeroot 移植)+ HS256 会话 + 超管白名单(`CONGROVE_SUPER_USERS`)、
perm.rs 有效角色判定(**唯一推导**,别在 handler 重写角色合并)、storage.rs 双 S3 client
(内部端点自用 + 外部端点专签预签名,checksum WhenRequired 闸)、0001 迁移(§4 全表)、
/healthz /readyz /api/me、web/ 登录态壳(IAH 品牌页眉在 `web/src/iah-header.tsx`,保留勿删)。
**P1 已上**(v0.2.0):空间/组/成员/授权 CRUD、内容树(防环校验)、文档在线编辑+版本历史+恢复、
文件上传(**流式 multipart,单文件不限大小**,v0.3.0)/流式下载、配额(★M0 起按**人**算,不按项目★:`user_quota`,超管 `PUT /api/admin/users/{username}/quota`)、拉人/按用户授权走平台 users/exists 校验(Keycloak 真相源,可拉未登录用户;registry 不可达降级本地 app_user;拉人/授权投站内信,0094)、审计、超管面;自有 logo(汇流入林,web/src/logo.tsx,
favicon 在 index.html **两处同步**)。**P2 已上**(v0.3.5):>100MB/视频浏览器直传 Garage(begin 签全部 part→分片 PUT 收 ETag→服务端 complete;失败 abort+24h 兜底清扫;501 回退后端流式);video 面板 <video> 播放(/play 判权 302 预签名 GET,Range 拖动)。
**P2 收尾**(v0.3.33):**断点续传**——items 记 `upload_fp`(大小+改动时间+文件名)与 `upload_id`(迁移 0009),
begin 带指纹来就认领「本人 24h 内没传完的同一个文件」,已传分片问 S3 的 ListParts 要、前端只补缺的;
complete 的分片清单**以 ListParts 为准**(续传时前端手里没有旧片的 ETag);
★失败不 abort、只有用户主动取消才 abort★——abort 会把断点一起删掉。
⚠ 续传认领断点时**必须从 `items.upload_key` 读回原 key**,别按 `spaces/{sid}/{iid}/blob` 现拼:
内容寻址之后分片是按 `blobs/<sha>` 建的,拼出来的 key 对不上 → list_parts 永远失败 →
每次都静默走「断点已失效」重传(v0.3.55 审计才发现,此前**对所有上传都没生效过**,因为前端每次都带 sha)。
**P3 进行中**:✅viewer 禁下载开关(0003 迁移,只拦 download 原件,阅读/播放不拦)+✅权限诊断(/api/spaces/{id}/diagnose,判定链与 perm.rs 同一推导);待做:PG 全文搜索(中文 trgm+ILIKE 双路)、语义搜。

**2026-08-05 这批(v0.3.36~0.3.55)**——四个功能,三条纪律:

- **公开分享**(`src/http/share.rs`,迁移 0003/0004/0006):对标百度网盘的提取码 / 有效期 / 次数上限 /
  访问统计,**非空间成员也能访问**,可多选一条链接带 N 项;访客页 `/s/{token}`,「我的分享」页统一管理。
  ★这是全系统**唯一绕过空间授权**的入口★,所以整章 fail-closed:令牌不存在/过期/超次数/撤销
  **一律 404 不区分**(区分即探测工具);创建要 ≥editor;解锁发 2h 签名票(密钥自 AUTH_SECRET 派生,
  域分隔串与会话 cookie 不同);取内容逐次验「是被分享项之一或其后代」;提取码**加盐 sha256 不存明文**
  + 20 次/15 分钟限速(低熵码只能靠限速防在线爆破)。
- **软删除 / 回收站**(迁移 0004):★所有删除都是软删除★(用户明令)。删只打 `deleted_at` 标记、
  S3 一个字节不动;回收站 30 天后由清理任务 purge;还原**连祖先目录一起还原**(用户纠正过:
  不是挪到空间根)。★还原只还原「与它同一批被删的」行★(按 deleted_at 当批次号)——否则先前
  单独删掉的子项会跟着复活。★配额仍计入回收站★,占着空间就该算。
  purge **只能对回收站里的东西**调,不能拿来跳过软删除。
- **秒传 / 去重**(内容寻址 `blobs/<sha256>` + 引用计数):同内容全库一份。★拆成两件事★——
  「省空间」无条件,「省时间(秒传)」**有条件**:只有调用者本来就能读到同 sha 的内容才免传
  (`readable_blob`),否则就是百度那个「凭哈希认领他人文件」的洞。防投毒:服务端自算哈希、
  `blobs/<sha>` **已存在则另起 `-<rand>` 绝不覆盖**、只认 `sha_verified` 的行当秒传源、后台 `verify_sha` 核验。
- **自动纪要**(`src/media_ai.rs` + `media_jobs`):传完音视频自动排队转写 + 生成纪要,不用再点一次。
  秒传路径同样入队。ASR 端点没注入时**不排队**(排了就是攒一堆必败任务)。

★贯穿三者的一条硬纪律:**凡是读内容的路径,SQL 都必须带 `deleted_at IS NULL`**★。
软删除是后加的,加的时候只有 `tree`/`precheck` 补了过滤,`download`/`content_get`/`/play`/`detail`
以及**整个公开分享面**全漏 —— 结果是「删进回收站的材料,墙外的公开链接照样列得出、下得到」。
v0.3.55 一次补齐 11 处。以后新增任何读 items 的查询,先问这一句加了没有。

## ★v0.5 M0 已上线(2026-08-09,v0.4.59)——「会议」→「活动」重构完成★

**先读 `docs/adr/README.md`,它是决策的索引**(5 份 ADR,每份一到两页)。
实施顺序与各 PR 门禁在 `docs/M0-PLAN.md`;原型对照结论在 `docs/PROTOTYPE-DIFF-M0.md`。
⚠ 老的 `TECH-DESIGN-v0.5-M0.md` 已删 —— 它是那份送审八轮、涨到 1131 行的文档,
教训写在 `docs/adr/README.md` 的「不写什么」一节:★关于代码的断言不写进文档,写成可执行门禁★。

M0 改了什么(全部已上线):

| ADR | 决策 |
|---|---|
| 0001 | ★上线前每次部署清库重建★,`migrations/` 永远只有一个 `0001_init.sql`,可以随便改 |
| 0002 | 「会议」→「活动」;新增 `activity_types` + 三个能力位,★类型决定表单★ |
| 0003 | 「补录」判据存 `notified_at` **事实**,不用会随改期翻转的推导 |
| 0004 | ★配额从项目挪到人★(`user_quota`),用量算 owner 名下所有项目、同 owner 按 blob 去重 |
| 0005 | 项目分 `team`/`materials`;材料区隔离靠 `effective_role` **单点否决** |

★另外两条语义换了定义,读老代码/老文档时注意★:
- `is_private` = **活动自己的** `visibility != 'public'`(不再是「所有关联项目都不 public」);
- 忙闲判据 = **活动自己的 `busy`**(不再是「有没有关联到公开项目」)。
  `projects.visibility` 这一列**已删** —— 它原本兼着「内容给谁看」与「占不占忙闲」两件正交的事。

## ★机械门禁:一条命令跑完,清单只有一份★(改代码前先知道它们存在)

```bash
bash scripts/all-gates.sh          # 全部(缺环境的那几道标「未跑」,★不算绿★)
bash scripts/all-gates.sh --ci     # 只跑不依赖活环境的那些 —— ★CI 调的就是这一条★
```

★别再在别处另开一份清单★(2026-08-15):此前 `.gitea/workflows/ci.yml` 内联写着一串、
`all-gates.sh` 又写着另一串,**两串各缺对方几道** —— 于是「本地全绿」与「CI 全绿」谁也不覆盖谁,
而没有任何东西会指出这件事。现在 CI 直接调这个脚本,加一道门禁只改一处。

| 闸 | 命令 | 判据 | CI |
|---|---|---|---|
| clippy 零 warning | `cargo clippy --all-targets -- -D warnings` | 一条 warning 都不许 | ✅ |
| 单测 | `cargo test` | perm/时区/类型能力位等纯函数 | ✅ |
| 旧命名 | `scripts/no-meeting.sh --all` | 非注释、未豁免的 `meeting` 残留归零 | ✅ |
| 不许静默截断 | `scripts/no-silent-limit.sh` | 写死 `LIMIT` 必须声明理由 | ✅ |
| 读内容不碰裸 items | `scripts/no-bare-items.sh` | SELECT 走 `items_alive`,否则写 `-- items-ok:` | ✅ |
| 时间不裸格式化 | `scripts/no-naked-time.sh` | `.format("` 前必须 `.with_timezone(` —— 否则印出来是 UTC | ✅ |
| DDL 纪律 | `scripts/ddl-check.sh` | 裸 `CREATE TABLE` + `migrations/` 只有一个文件(ADR-0001) | ✅ |
| 内容寻址 | `scripts/blobkey-check.sh` | 规范 key 只由 `items.rs::blob_key` 产出 | ✅ |
| 内网地址不入库 | `scripts/no-internal-addr.sh` | 跟踪文件**与提交信息**里都不许出现内网网段 | ✅ |
| 取值只走 effective_* | `scripts/effective-check.sh` | 治理项不许直接读常量/env,绕过库里的设置 | ✅ |
| 版本号两处一致 | `scripts/version-sync-check.sh` | `Cargo.toml` == `web/src/version.ts` | ✅ |
| 前端 tsc / test | `cd web && pnpm typecheck` / `pnpm test` | strict 类型 + 单测 | ✅ |
| SQL 对真库 | `scripts/sql-prepare-check.py` | 全部 SQL 通过 `PREPARE`(语义分析但不执行) | ⭕ ★不再直连库★,走平台 `db/sql`;只要令牌 |
| schema | `scripts/schema-check.sh check` | 现库 vs 冻结基线,差异逐字节等于 `schema/expected.diff` | ⭕ 同上 |
| 接口面 | `scripts/api-check.sh check` | breaking 逐条声明在 `docs/openapi-breaking.txt` | ❌ 缺 oasdiff(O4) |
| schema 覆盖率 | `scripts/schema-coverage.sh` | 「响应体没接字段级 schema」的条数**只减不增**;基线 `docs/schema-coverage-baseline.txt` | ✅ |
| 写接口都判权 | `scripts/authz-coverage.sh` | 每个 POST/PUT/DELETE 都要有权限调用(认路由层 `require_super`;公开访客面显式豁免) | ✅ |
| include 的文件进得了镜像 | `scripts/include-copied-check.sh` | `include_str!`/`include_bytes!` 引用的目录必须在 Dockerfile 的 `COPY` 里 —— ★本地全绿而 kaniko 挂的那一类★ | ✅ |
| 响应体形状 | `scripts/shape-check.sh check` | 形状差异逐字节等于 `e2e/golden/shape-expected.diff` | ❌ 要活环境 |
| 已应用的迁移不许改 | `scripts/migration-frozen-check.sh` | `migrations/*.sql` 的 sha384 == `migrations/checksums.txt`(只增不改) | ✅ |
| 迁移校验和 | `scripts/migration-checksum-check.sh` | 同上 == **dev 与 prod 两库** `_sqlx_migrations` 里记的(★只 SELECT★) | ⭕ dev 半边同上;prod 半边要 DSN(不给,永久「未核」) |

⚠★改了 `0001_init.sql` 就必须处理 dev 库★(ADR-0001 的配套纪律,2026-08-15 漏过一次):
sqlx 记着「我跑过的那份」的 sha384,文件一改,pod 启动就
`Error: migration 1 was previously applied but has been modified` —— ★十六道门禁一道都没看见★。
「迁移校验和」那道就是为此加的;红了之后照它打印的两条出路走(清库重建 / 先证明结构等价再改记录)。

配套(不是门禁,是工具):`scripts/bump-version.sh` 升版本(读→加一→写回→**回读核对**);
`scripts/deployed-version-check.sh` 比对线上与代码版本 —— ★`e2e/run.sh` 跑测试前会先调它★,
免得对着旧镜像跑 E2E 拿一堆「关于别人代码的绿」(要故意对旧版本跑就 `SKIP_VERSION_CHECK=1`)。

★2026-08-17 起前三道**不再直连 PG**★:走平台的 `POST /api/subsystems/congrove/db/sql`
(dev-only),取数封装在 `scripts/dbq.py`,输出**刻意与 `psql -At` 同格式**所以基线不用重冻。
令牌从 `IAH_TOKEN` 或 `~/.config/iah/congrove-token` 取 —— ★什么都不用 export 就能跑★。

⚠ 起因值得记:iah101 加入集群成为节点后,它去 `data` 命名空间的 pod 改走 VXLAN overlay,
源 IP 变成 flannel.1 的 **pod 网段**地址,而 `data-tier-isolation` 只放行**内网网段**(不含 pod 网段)——
于是从 iah101 直连 PG 全部超时。★我的第一反应是去请平台改那条 NetworkPolicy,
而 liaoruili 问了一句「你需要实现什么功能」★ —— 一查:没有任何**产品功能**需要它,
只有这几道开发期门禁需要,而平台早就给了合规的接口。请求已在群里撤回。
★教训:遇到「连不上」先问「我到底需不需要这条路」,别直接跳到「怎么把这条路修通」。★

连库(只剩 prod 半边与 `sim-diff` 用):`source ~/.config/iah/congrove-dev.env`(DSN + 口令,**仓库外**)。
prod 那道闸另读 `~/.config/iah/congrove-prod.env` 里的 `CONGROVE_PROD_DSN`
(★建议配只读角色★:脚本只 SELECT);没配则那一格报 **「? 未跑」不算通过** ——
★「我没查」和「查了没问题」是两件事★,汇总行也不会再说「全部通过」。
★`--pre` 是 PREPARE 闸最值钱的用法★:先施加 schema 变更、跑全量检查、最后 ROLLBACK,
于是「这个改动会打断哪些 SQL」由**数据库穷举** —— M0 全程没手数过一次清单。

⚠★★门禁必须有否决权:别把它和提交串在一条命令里★★(2026-09-03 我违过一次)
  写成 `bash scripts/all-gates.sh && git commit …` 或者干脆用 `;` 串起来 ——
  ★门禁报了红,commit 和 push 照样跑完★。它的输出于是成了「事后报告」而不是「准入判据」。
  **先跑门禁 → 读结果 → 绿了再单独提交。** 这两步之间要有人(或你)真的看一眼。

⚠★线上版本连着几轮不动,先去看 build-log,别默认是在排队★(2026-09-03)
  `deployed-version-check` 报「线上不是这个版本」时有两种原因,而它区分不了:
  还在构建 / **构建挂了**。那次是 Dockerfile 漏 COPY 导致 kaniko 失败,
  我等了 4 分钟才去看日志。
      curl -s --cacert $CA -H "Authorization: Bearer $T" \
        "https://registry.ruciah.com/api/subsystems/congrove/build-log?channel=dev"
  里面的 `status` 字段直接说「构建中 / 失败 / 存档」。

⚠★三条使用纪律★:①进不了 CI 的闸(要活库/内网 CA)必须在 PR 里**如实标注人工验证**,
不许标成「CI 绿」;②★每道闸都要能证明自己跑起来了★ —— 本仓库栽过五次
「工具没跑 → 输出为空 → 报绿」,详见 `docs/M0-PLAN.md`;
③★退出码有约定,别分叉★(2026-08-23 统一):

    0 = 通过   1 = 真的不通过   ★2 = 整个量不到★   ★3 = 部分没跑★

  后两种在汇总里显示成「?」而不是「✗」。为什么值得单独立一条:平台的 `db/sql`
  挂了一阵那天,依赖它的四道闸全打了 ✗ —— 其中 `sql-prepare-check.py` 还打印了
  「280/301 条 SQL 对不上 schema」。★一个人看到这行字,第一反应是自己刚才改坏了什么。★
  本仓一直强调「『我没查』和『查了没问题』是两件事」,而这是它对称的另一半:
  ★「我没查」被报成「查出问题了」,和被报成「通过」一样坏,而且更费人。★

## 待平台的三条(卡着才补得上)

| # | 问题 | 挡住什么 |
|---|---|---|
| O2 | CI 挂一个测试 PG | ~~PREPARE 闸与 schema 闸进不了 CI~~ ★2026-08-17 起这两道改走平台 `db/sql`,**不再需要测试 PG**★ —— 只要 CI 有令牌就能跑,这条阻塞基本解掉了(待在 CI 里实测) |
| O4 | 共享 runner 装 `oasdiff` | 接口面闸**本来就能进 CI**(离线生成契约、不连库),卡在没这个二进制。★2026-08-23 起这条的价值大了一截★:字段级 schema 补完之后,这道闸从「只看路径/参数」变成**看得见响应体结构** —— 「数组变对象」这类改动现在它抓得到,而以前抓不到 |
| O3b | 两个专用 E2E 账号 | 「加入即可见/离开即失去」等 2 条 E2E 暂跳过 |

## 命令

```bash
cp .env.example .env      # 必须,缺 DATABASE_URL / S3_* 硬失败(config.rs)
cargo run                 # :8030,启动自动跑迁移;不配 OIDC_ISSUER = 鉴权关闭 + WARN(dev 超管假身份)
cargo test                # perm.rs 纯函数单测;改完照常 cargo check
cd web && pnpm install && pnpm dev   # vite :5180,/api /auth 代理到 :8030
cd web && pnpm build                 # 产物 dist/,线上由后端 ServeDir 同源托管
cd web && pnpm typecheck             # ⚠ 平台构建管道零类型检查,改完 TS 必须手跑
```

**正式部署走声明式**(DESIGN.md §2.2b):配置在根 `iah.yaml`,
`POST registry.ruciah.com/api/subsystems/congrove/deploy` 首次部署 + `autobuild:true` 挂 webhook,
之后 push 到通道分支即自动构建。构建失败唯一入口 `GET .../build-log?channel=dev`(不进 Loki);
dev 库改 schema 可走 `POST .../db/sql`(dev-only,prod 403)。API 都带个人令牌(门户「日志」页生成)。
★★迁移纪律:**只增不改**(2026-08-16 起)★★ —— 当晚打上 v0.5.0 并 promote 出 **prod 通道**
(`congrove.sub.ruciah.com`),★ADR-0001 当场失效★(它文末写的「推翻它的条件」就是这一条)。
现在 `migrations/` 里**已应用的文件内容冻结**,改 schema 一律**新建** `0002_xxx.sql`
并把哈希登记进 `migrations/checksums.txt`。

⚠★这条不靠人记,有两道闸★:`scripts/migration-frozen-check.sh`(纯静态,进 CI)
与 `scripts/migration-checksum-check.sh`(对 **dev 与 prod 两个库**核 sqlx 记的校验和,只 SELECT 不写)。
⚠★为什么值得两道闸★:2026-08-15 晚上我改了 `0001_init.sql` 却漏了配套清库 ——
十六道门禁全绿、CI 全绿、合并、部署,**一路零提醒**,直到 pod CrashLoop 在
`migration 1 was previously applied but has been modified`。那次代价是「改一条记录」,
★从 2026-08-16 起同样的操作发生在 prod 上就是生产事故★。

★★prod 有真实数据,必须保住★★(2026-08-16 liaoruili 强调,我一度说反过)。
所以「后续迁移可以是破坏性的」指的是 **schema 层面**:删列、改类型、拆表都行,
★但必须带着 prod 已有的数据走★ —— 要删一列就得先想清楚那列现有的值去哪;
要拆表就得先 `INSERT INTO 新表 SELECT … FROM 旧表` 再 DROP。**绝不清库、绝不「反正重建一次」。**
⚠★冻结的判据是「prod 跑过它没有」,不是「文件存不存在」★(2026-08-16 liaoruili 订正我):
  prod 冻在 v0.5.0、到 0.6 才 promote,所以**在那之前 `0002` 是一个工作文件** ——
  可以反复改、dev 清库重建(`scripts/wipe-dev.sh`,已加两道闸),因为 prod 还没见过它。
  ★「到 0.6 的时候应该只有一个 0002」★:这一轮的 schema 改动合成**一份**,
  不要攒成 0002/0003/0004(散成几份会让「这一轮到底改了什么」查起来要拼)。
  等它 promote 上 prod,才把哈希登记进 `migrations/checksums.txt` 冻住,下一轮开新的。
  ⇒ 所以「按真实数据写迁移」这件事的时点是**在它上 prod 的那一版**,不是每次动它的时候。

下面这段清库流程**只对 dev 有效,prod 永远不许清**(★2026-08-16 liaoruili:「prod 里面禁止动任何数据」★)。
清库是**五条**不是两条,少一条 pod 起不来:

```sql
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO sub_congrove_dev;      -- ★app 角色★
ALTER SCHEMA public OWNER TO sub_congrove_dev;       -- ★交回去★
GRANT ALL ON SCHEMA public TO sub_congrove_dev_cli;  -- 门禁脚本还要连
```
⚠ 后两条是承重的:清库用的是 `_cli` 角色,`CREATE SCHEMA` 会让新 schema 归它所有,
app 角色一点权限都没有 → `no schema has been selected to create in` → CrashLoopBackOff。
★报错文案指向 search_path,真凶是 ACL。★

⚠★清库会把超管位一起清掉★(2026-08-09 踩到):`app_user.is_super` 是库里的状态,
而 `/api/me` **查库**判超管(cookie 里那份是登录快照,撤销要立刻生效)——于是清库之后
超管入口凭空消失,而当事人的会话还没过期、不会再走一次登录。
★已在 `lib.rs` 里治本★:`CONGROVE_SUPER_USERS` 现在在**启动时**(跑完迁移就)种进 app_user,
不再搭登录的顺风车。所以清完库**重启一次 pod** 就好,不必手动 UPDATE。

## ★超管模式:`is_super` 那一列不再等于「他现在能看到一切」★(2026-08-09)

liaoruili 也是日常用户,而超管默认能看到所有人的内容 —— 照 GitLab Admin Mode 拆成两件事
(`docs/TECH-DESIGN-admin-mode.md`):

| | 判据 | 谁用 |
|---|---|---|
| **资格** | `app_user.is_super` 列 | 授/撤超管、用户列表、启动种子、登录 upsert、开关自己的准入 |
| **特权** | ★`super_now` 视图★ | **所有判权、所有「比别人多看到东西」的 SQL** |

`super_now = is_super AND admin_mode_until > now()`,2 小时自动关、退出登录也关,进出都进 audit_log。
⚠★写新的超管路径时用视图,别用那一列★ —— 用错的后果是**反的**:
资格处误用视图 → 关掉模式就撤不了别人的超管;特权处漏用视图 → 那条路永远是超管视角,
而它**不报错、只默默多给**。想验完整性:`sql-prepare-check.py --pre` 里
`ALTER TABLE app_user RENAME COLUMN is_super TO x` 跑一遍,报红的必须全是资格型。

⚠★用特性分支部 dev 之后必须把 ref 改回 `dev`★:`POST /deploy {ref:...}` 会把记录里的 ref
改掉并留在那里,之后 CI 的 `ci-deploy` 沿用它 —— **每次合并到 dev 构建的都是那个过期分支**,
而且完全静默(gate 绿、deploy 绿、构建成功,只有线上版本不变)。

~~★prod 通道一旦开出来,ADR-0001 当场失效★,立刻回到「只增不改」。~~ → **已发生(2026-08-16)**,见上。

sqlx 全用 runtime 查询(无 `query!` 宏)→ **改 SQL 编译器不报错**。
★但这已经不是「只能靠人肉核对」了★:`scripts/sql-prepare-check.py` 把全部 SQL 字面量
抽出来逐条对真库 `PREPARE`,覆盖率 100% 且不依赖测试覆盖到哪些路径。改完 SQL 跑它。
⚠ 它**抓不到** Rust 侧解码类型与列类型不匹配(`query_as::<_, (String,String)>` 拿到 int8
仍会运行时炸)—— 加字段后 FromRow/元组元数仍要手工核对。

## ★接口契约:schema 从 Rust 类型现推,不是手写的★(2026-08-23 补完)

109 条接口的响应体**全部**有字段级 schema。写新接口时按这个来:

```rust
// src/http/apidoc.rs 的 APIS 里
api!("GET", "/api/x", "组", "登录", "说明", "",  res: crate::http::x::XOut)
api!("PUT", "/api/x", "组", "登录", "说明", "",  req: XIn, res: XOut)
api!("GET", "/api/y", "组", "登录", "说明", "",  raw: "文件字节流")  // 本来就不回 JSON
```

响应类型要 `#[derive(serde::Serialize, schemars::JsonSchema)]`。
★doc 注释自动变成契约里的 description★ —— 注释照常写就行,不用另写一份文档。

⚠★为什么不手写 JSON schema★:那正是 `docs/adr/README.md` 禁止的
「关于代码的断言写进文档」—— 手写的不跟着类型变,**结构体改了它不报错、只是悄悄过期**,
而过期的契约比没有契约更坏(它让人以为已经对齐了)。

⚠★`raw:` 是给「本来就不回 JSON」的★(流 / 302 / 纯文本 / 204),**不是**「还没接」的挡箭牌。
两者留空的话长得一样,于是覆盖率闸的数字永远归不了零 ——
★一个到不了零的进度条,等于没有进度条。★

⚠★别在 handler 里用 `json!` 拼响应★:全树已经一处都没有了(六个模块的
`use serde_json::json` 都因为 unused 被删掉)。用 `json!` 意味着这条接口在契约里是空白,
而且**没有任何东西会拦住你** —— 只有 `schema-coverage.sh` 的数字会涨。

★这件事真正买到的是什么★:补的过程里,类型系统当场接住了四处
「我以为是这样、其实不是」——`remind` 少了个 `sent` 字段、`observe` 其实是切换、
`reminded_at` 恒非空、`accept_rate` 是 0.0 不是 null。
`json!` 里塞什么都合法,所以**从来没人问过这些问题**。

## 架构决策(详证据见 DESIGN.md §3,别重新论证)

三条已定案、有平台源码实证的决策,推翻任何一条都要先找到新证据:

1. **身份自建 OIDC 客户端**,消费平台注入的 `OIDC_*` env;`preferred_username` 作用户主键。平台**不注入身份头**。
2. **权限必须落自己的 PG 表**,不能靠 Keycloak——网关不透传 groups、realm 里根本没配 groups mapper。
   实现在 `src/perm.rs`(**唯一推导**,超管短路);真判权在后端,前端隐藏按钮不是安全边界。
   ⚠ **这条的后半段已被 D12 推翻**:原本是 `max(直接授权, 所属各组授权)`,
   会议模块起**删掉 `groups`/`group_members`,权限只到具体的人**,推导简化为一次成员表查询。
   「不能靠 Keycloak」这个前提仍然成立。
3. **PG 存元数据、Garage S3 存二进制**;录屏走浏览器预签名直传/直取(`s3api.ruciah.com`)。
   ⚠ **预签名 PoC 是命门,必须最先验证**(DESIGN.md §8-1 检查单,含桶 CORS 由平台 provisioner 配的前置
   依赖——pod 的 key 无 owner 位自己配不了);不通则回退 pod 流式代理(范本 `../citeroot/src/pdf.rs`)。

## 平台硬约束(违反即事故)

- **一个镜像、监听一个端口**(静态 + REST 同端口);不写任何 K8s 清单,域名/TLS/PG/S3/OIDC 全由平台注入 env。
- **集群无 PVC,永远不会有**:sqlite/本地文件每次 rebuild/restart/promote 清零,正式数据只能落
  PG(`iah-pg-rw.data.svc:5432`)+ Garage S3(`garage.data.svc:3900`)。「重启后数据还在」才算测试通过。
- S3 必须 **path-style** + **AWS 标准 env 名**(`AWS_ACCESS_KEY_ID` 等,别自造 key 名)+ region 必须是
  字符串 `garage`(否则 HeadBucket 400)。注入的确切 env 键名清单在 DESIGN.md §2.2。
- dev/prod 是同一仓库的两个 channel,各有独立 PG 库和 S3 桶;promote 复用 dev 镜像不重建,但落**空库**,
  数据手工 `pg_dump dev | psql prod` 迁。
- Dockerfile 基础镜像走 `docker.m.daocloud.io`,npm/cargo 走国内镜像源(集群在 GFW 后,不走必挂)。
- **保留 IAH 品牌页眉**(◆IAH 在上、子系统名在下、点击回 `hub.ruciah.com`),实现在 `web/src/iah-header.tsx`。

## 风格与 Git

- 代码/注释/提交信息用**中文**,匹配全树风格(极密一行流 + 长中文注释,注释是文档,别精简)。
- 每完成一个功能升版本号,**两处同步**:`Cargo.toml` + `web/src/version.ts`(语义化 vX.Y.Z)。
  ★**别再往版本号里写 `.dev`**(2026-08-05 修正):promote 是**复用 dev 镜像**上 prod 的,
  编进字符串的通道标记会原样跟到 prod(用户在 congrove.sub.ruciah.com 上看到 `v0.3.42.dev`)。
  通道靠**运行时域名**判——`iah-header.tsx` 的 `IS_DEV` 认 `<slug>-dev.sub.*`,只在 dev 上挂黄色小标。★
  ★节奏(2026-08-02 用户定):日常改动**只动第三位**(0.3.1→0.3.2…),第二位(minor)**由用户拍板**才升。
  ★**2026-08-16 liaoruili 拍板:打 `0.5.0`**★ —— v0.5 的 M0–M4 全部完成、相位 6 验收
  于 2026-08-13 通过(六条闭环判据落在 `e2e/specs/acceptance-v05.spec.ts`,全量套件里跟着跑)。
  在此之前功能上早已是 v0.5,版本串却一路停在 0.4.x(0.4.0 是 2026-08-06 拍给会议模块 M1 的那版,
  之后 169 个补丁版)—— ★「功能到了」和「版本号到了」是两件事,后者只有产品负责人能拍。★
  下一个 minor 同样等拍板;M5(周期性活动 RRULE / `.ics` 导出 / 项目树只读活动区 / 导出 CSV)
  **不在 v0.5 范围**,要做另起一轮走相位 0。
  ★★改完 Cargo.toml(含只改 version)**必须跑一次 cargo check 再提交**——它刷新 Cargo.lock;
  漏了则 kaniko 的 `cargo build --locked` 直接拒绝(v0.3.1 就这么挂过一次构建,0096)。★★
### ★prod 每个版本打 tag★(2026-08-23 liaoruili 定)

**上 prod 的每个版本号都打一个 annotated tag 并 push;dev 不打。**

```bash
git tag -a v0.6.4 <main 上那个合并提交> -m "v0.6.4 —— 一句话说明"
# push 由 liaoruili 做
```

⚠ tag 指向 **main 上的合并提交**,不是特性分支上那条内容提交 ——
  只有前者 checkout 出来是**完整的 prod 树**。

★为什么值得一条规矩★:2026-08-23 要确认「prod 到底跑没跑过 `0002` 这个迁移」时,
只能靠 `git log --diff-filter=A` + `git ls-tree gitea/main` 拼出来。
**有 tag 的话 `git checkout v0.6.3` 一步就能看** —— 而这个问题的答案决定了
「能不能改那个迁移」,猜错就是 prod 的 pod 起不来。

已补齐历史:v0.5.0 / v0.5.6 / v0.6.0 / v0.6.1 / v0.6.2 / v0.6.3。

### 分支纪律(2026-08-09 定,★按业界通用做法★)

一度攒到 **23 条远端分支 / 45 条本地分支**,清理时才发现除 dev/main 外全是已合并的僵尸。规矩:

| | |
|---|---|
| **一件事一条分支** | 命名 `<type>/<简述>`:`feat/` `fix/` `docs/` `chore/` `test/` |
| **短命** | 目标 < 1 天。★分支活得越久,「合的时候已经不是当初那回事」越贵★ |
| **合并即删** | 仓库设置 `default_delete_branch_after_merge` **已打开** —— 不靠人记得 |
| **不复用** | ★别拿一条长期分支反复开 PR★:那会让多个 PR 互相污染、review 范围说不清、revert 时拆不开。合并后作废,下一件事开新的 |

⚠ 清理前先**证明**安全:`git merge-base --is-ancestor <分支> gitea/dev` —— 是祖先才删,
并先存一份 SHA(恢复只需 `git push gitea <sha>:refs/heads/<名字>`)。
⚠ Gitea 一次删多个 ref 会被 pre-receive hook 拒,**逐条删**。
⚠ 受保护的分支删不掉(`feat/v0.5-m0` 就是),要先去仓库设置取消保护。

- 三推 Gitea(内网,主)+ Gitee + GitHub(origin 挂三 push URL,已配好);**push 由仓库所有者做,Claude 只 commit**。
  密钥绝不入库,提交前 `git diff --staged` 扫明文密钥。
- 参考子系统:`../citeroot/`(**主范本**:Rust 栈、auth/storage/Dockerfile/流式代理全在这)、
  `../textleaf/`(UI 与「组织+角色」权限模型参考)。
