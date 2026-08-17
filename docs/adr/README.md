# 架构决策记录（ADR）

一个决策一份，**一到两页**。写：**决定了什么 / 为什么 / 否掉了什么 / 不管什么**。

## ★不写什么★（2026-08-08 立，血的教训）

**关于代码的断言一律不写进来** —— 出现次数、逐处引用表、`grep` 盘点结果、文件行号清单。
那类内容和现实之间**没有强制链接**，代码一动就假，于是每轮评审都能挑出一个不对的数字，
而下一轮还会有新的。**这个循环不会自己收敛。**

原来那份 `TECH-DESIGN-v0.5-M0.md` 就是这么从 227 行涨到 1131 行、在相位 4 反复送审**八轮**的
（它描述的对象只有 495 行迁移）。其中最刺眼的一条：`projects.visibility` 的引用面我手数了三版 ——
v6 说「没有语义，直接删」、v7 说「10 处」、v8 说「后端 11 + 前端 7」，**三版全错、三版都没过评审**。

真实答案是 **8 条 SQL**，得到它只要一条命令：

```bash
scripts/sql-prepare-check.py --pre <(echo "ALTER TABLE projects DROP COLUMN visibility;")
```

（它先施加变更、跑全量 `PREPARE`、最后 `ROLLBACK`，对库零影响。含 `visibility` 字样的有 12 条，
另外 4 条是 `meetings.visibility` —— **活动自己的**可见性，要保留。★「项目的」还是「活动的」
这个区分正是我手数时反复弄错的地方，而数据库一秒就分清了。★）

**判据**：一句话若能被脚本验证，就不该由人写进文档、再由人核对。

## 判定力从哪来

ADR 只承载**决策**；「改动到底影响了什么」由五道机械门禁回答：

| 闸 | 命令 | 判据 |
|---|---|---|
| SQL 对真库 | `scripts/sql-prepare-check.py` | 全部 SQL 通过 `PREPARE`（语义分析但不执行） |
| schema | `scripts/schema-check.sh check` | 现库 vs 冻结基线，差异逐字节等于 `schema/expected.diff` |
| 旧命名 | `scripts/no-meeting.sh <模式>` | 非注释、未豁免的旧名残留归零 |
| 响应体 | `node e2e/golden-diff.mjs <before> <after>` | 差异逐字节等于 `e2e/golden/expected.diff` |
| 接口面 | `scripts/api-check.sh check` | breaking 逐条事先声明在 `docs/openapi-breaking.txt` |

★三道用同一个形式★：冻基线 → 变更**逐条事先声明成一个 checked-in 文件** → **双向**必须相符
（「没声明却发生」和「声明了却没发生」都红）。白名单因此是**程序生成的**，不可能与现实脱节。

## 清单

| # | 决策 | 状态 |
|---|---|---|
| [0001](0001-rebuild-db-each-deploy.md) | ~~上线前每次部署清库重建~~ → ★**已失效**★:2026-08-16 开出 prod 通道,回到**只增不改**(门禁 `migration-frozen-check.sh` 看着) | ~~已定 2026-08-08~~ → 已失效 2026-08-16 |
| [0002](0002-meetings-to-activities.md) | 「会议」→「活动」，引入 `activity_types` 与 `busy` | 已定 |
| [0003](0003-backfill-via-notified-at.md) | 「补录」判据存 `notified_at` 事实，不用生成列推导 | 已定（PRD L0b 已回填） |
| [0004](0004-quota-per-user.md) | 配额从项目挪到人；`user_quota` 与 `user_prefs` 拆两张 | 已定（PRD L3/J2 已回填） |
| [0005](0005-materials-project-isolation.md) | 项目分 `team` / `materials`；隔离靠 `effective_role` 单点否决 | 已定 |
| [0006](0006-observer-whitelist-and-attendee-materials.md) | ★旁听只看「活动是什么」(白名单+单点否决)；参会人对活动材料有完整读写权 —— **推翻 D8** | 已定 |

实施顺序与每个 PR 的门禁在 [../M0-PLAN.md](../M0-PLAN.md)。
