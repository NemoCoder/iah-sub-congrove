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
文件上传(**流式 multipart,单文件不限大小**,v0.3.0)/流式下载、**每空间配额默认 10GiB**(0002 迁移,超管 PUT /api/admin/spaces/{id}/quota 可调)、拉人/按用户授权走平台 users/exists 校验(Keycloak 真相源,可拉未登录用户;registry 不可达降级本地 app_user;拉人/授权投站内信,0094)、审计、超管面;自有 logo(汇流入林,web/src/logo.tsx,
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
**迁移纪律:只增不改**(sqlx::migrate! 校验和,改已应用的文件 = 全部实例启动失败),变更开新文件写 ALTER。
★2026-08-05 重建过一次★:用户把部署连同 PG/OSS 全删后,0001~0009 压成了单个 `0001_init.sql`
(那是唯一能破例的时刻——没有任何实例的 `_sqlx_migrations` 里还有记录)。**从那版起纪律恢复**,
以后一律开新文件写 ALTER,别再想着「反正能重建」。当前:0001 建表 / 0002 分享令牌 /
0003 公开分享(share_links·share_visits)/ 0004 软删除+去重(share_items)/ 0005 sha_verified+upload_key /
0006 提取码失败计数(share_visits.ok)。
sqlx 全用 runtime 查询(无 `query!` 宏):SQL 错误只在运行时炸,加字段后手动核对 FromRow/类型。

## 架构决策(详证据见 DESIGN.md §3,别重新论证)

三条已定案、有平台源码实证的决策,推翻任何一条都要先找到新证据:

1. **身份自建 OIDC 客户端**,消费平台注入的 `OIDC_*` env;`preferred_username` 作用户主键。平台**不注入身份头**。
2. **组/权限必须落自己的 PG 表**(`groups`/`group_members`/`spaces`/`space_grants`),不能靠 Keycloak——
   网关不透传 groups、realm 里根本没配 groups mapper。有效权限 = 直接授权与所有所属组授权取最大值
   (实现在 `src/perm.rs`,超管短路)。真判权在后端,前端隐藏按钮不是安全边界。
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
  ★节奏(2026-08-02 用户定):日常改动**只动第三位**(0.3.1→0.3.2…),第二位(minor)**由用户拍板**才升,
  别自作主张跳 0.4——当前这批功能全程停在 0.3.x。
  ★★改完 Cargo.toml(含只改 version)**必须跑一次 cargo check 再提交**——它刷新 Cargo.lock;
  漏了则 kaniko 的 `cargo build --locked` 直接拒绝(v0.3.1 就这么挂过一次构建,0096)。★★
- 三推 Gitea(内网,主)+ Gitee + GitHub(origin 挂三 push URL,已配好);**push 由仓库所有者做,Claude 只 commit**。
  密钥绝不入库,提交前 `git diff --staged` 扫明文密钥。
- 参考子系统:`../citeroot/`(**主范本**:Rust 栈、auth/storage/Dockerfile/流式代理全在这)、
  `../textleaf/`(UI 与「组织+角色」权限模型参考)。
