# M0 实施计划：七个 PR 与各自的门禁

**决策在 [`adr/`](adr/README.md)，这里只讲顺序和判据。**
分轨：**全流程轨**（新数据模型 + 权限 + 钱）。相位 4 的技术产物 = ADR 集 + 本文。

## 走长期特性分支，不用改一行 CI

全部 PR 打到 `feat/v0.5-m0`：

- `ci.yml` 是 `on: pull_request` —— **对任何目标分支的 PR 都跑门禁**；
- deploy job 条件是 `push && refs/heads/dev` —— **只有合进 dev 才自动部署**。

所以特性分支**有完整门禁、不自动部署 dev**。准确的说法不是「不碰 dev」，而是：
★**不自动部署 dev；但验收时会独占 dev 环境**★（M0-5 起要把特性分支部到 dev 才能跑 E2E）。

⚠ `ci.yml` 自己写着「前提：在 Gitea 仓库设置里把本检查设为分支保护的『必需状态检查』」——
**门禁会跑 ≠ 门禁挡得住合并**。开工前给 `feat/v0.5-m0` 也配上分支保护（liaoruili 做，仓库设置）。

## 七个 PR

| PR | 内容 | 门禁 |
|---|---|---|
| **M0-1** | 重写 `0001_init.sql`（全表 / 新列 / 新索引 / 把 0002~0007 的产物迁进来）＋删 `migrations/0002~0007` 文件＋★删 `projects.visibility` 并同 PR 摘掉受影响的 SQL★ | `schema-check.sh check`（差异逐字节等于 `schema/expected.diff`）＋`sql-prepare-check.py`＋`no-meeting.sh --migrations`＋clippy/test/typecheck |
| **M0-2** | 后端非路由改名＋`notified_at` 读写规则（ADR-0003）＋`recorder` 空值守卫＋`effective_role` 的 materials 单点否决（ADR-0005） | `sql-prepare-check.py`＋`no-meeting.sh --backend-core`＋clippy/test（含 `merge` 吃掉 BLOCK、`require_owner` 被短路这两条的回归单测） |
| **M0-3** | 路由与清单侧：路径改名＋`apidoc.rs`＋`api_cases.rs`＋`activity_types` 用起来＋能力位收口 | ★`api-check.sh check`（19 条 breaking 逐条声明）★＋`cargo test` 的清单比对＋`no-meeting.sh --backend-all` |
| **M0-4** | 前端改名＋类型下拉＋表单按能力位显隐 | `pnpm typecheck`/`pnpm test`＋`no-meeting.sh --frontend`＋★对着 `prototype-v0.5.html` **逐视图并排截图**作为 PR 附件★ |
| **M0-5** | ★首次把特性分支部到 dev★（配合 ADR-0001 的四步清库）＋跑 70 条 E2E＋采 golden 后像 | E2E 全绿（人工）＋`golden-diff.mjs` 差异逐字节等于 `e2e/golden/expected.diff` |
| **M0-6** | 配额换算法（ADR-0004 全部）＋`user_prefs`/`user_quota` 接口＋★先补齐 5 条配额 E2E★ | 配额 E2E 6 条全绿（人工）＋`schema-check.sh`（★`quota_bytes` 真正被删的是**这个** PR★）＋`sql-prepare-check.py` |
| **M0-7** | 收尾：把 `no-meeting.sh` 与 `api-check.sh` 加进 `ci.yml` 的 gate；`feat/v0.5-m0` → dev | 五道闸全绿 = M0 完成 |

★M0-4 那条截图纪律是 2026-08-07 复盘立的★：我只截了原型一个视图就凭需求文档推导写完，
漏了整个「会议」tab，是 liaoruili 对着原型一眼看出来的。**本该是开发自己的验收。**

## 三处中间态断裂（写出来，别踩）

| # | 断裂 | 处置 |
|---|---|---|
| ① | `projects.quota_bytes`：M0-1 删列、M0-6 才改代码 → 中间项目列表/建项目/上传全 500，★而 M0-5 正要拿这个分支部到 dev 跑 E2E★ | **M0-1 保留这一列，M0-6 再删**（按 ADR-0001，`0001` 随时可改，零成本） |
| ② | `projects.visibility` | M0-1 删列 **+ 同 PR 摘掉受影响的 SQL**，不留断裂。影响面由 `sql-prepare-check.py --pre` 穷举，不手数 |
| ③ | `activities.type_id` 是 NOT NULL 无默认，而 `POST` 要到 M0-3 才接受 `type_id` | M0-2 里给 create 临时填「会议」预置类型的 id，M0-3 换成入参。hermetic 的 `cargo test` 看不见它，E2E 要等 M0-5 |

## 门禁的两条使用纪律

1. ★进不了 CI 的闸（要活的 dev 库 / 内网 CA / 个人令牌）必须在 PR 描述里**如实标注为人工验证**，
   不许标成「CI 绿」★。五道闸里只有 `no-meeting.sh` 和 `api-check.sh` 能完全进 CI。
2. ★每道闸都要能证明自己**跑起来了**★。本仓库栽过三次「工具没跑 → 输出为空 → 报绿」：
   PREPARE 闸的 psql 路整条不工作却报 207/207 通过、接口闸的规范化脚本崩了却报无破坏性变更、
   老 `schema-diff.mjs` 被「什么都没做」骗过。**一道会把「什么都没检查」报成绿的门禁，比没有门禁更糟。**

## 评审怎么走（相位 5）

每个 PR 一轮同行评审，**不循环**。阻塞条件只有一条：**会导致错误行为 / 数据损坏 / 权限绕过 / 门禁失效**；
其余（更好的写法、更全的说明）记 issue，照常过闸。多路对抗评审只用在相位 6 的总验收。

## 开放问题（如实列）

| # | 问题 | 归属 | 阻塞什么 |
|---|---|---|---|
| **O2** | CI 挂一个测试 PG | 平台 | 挂上之后 `sql-prepare-check.py --dsn` 与 `schema-check.sh` 都能进 CI，「钱/权/删」的 SQL 语义不必再靠人工门禁 |
| **O3b** | 两个专用 E2E 账号（拉人/授权要过 Keycloak 校验，编的用户名 400） | 平台（已申请） | 「加入即可见 / 离开即失去」等 2 条 E2E 暂跳过 |

**都不阻塞 M0 开工**，但决定了验收是「机械」还是「人工」。

## 不在 M0 范围内

- **M1**：不关联项目的活动、补录 UI、「我的活动材料」、跨项目复制、活动删除三件套（PRD J1b-2）。
- **M2+**：日程身份图标与 hover、凌晨时段压缩、跨时区标注、时间输入手感、影子账户（PRD J1c）。
