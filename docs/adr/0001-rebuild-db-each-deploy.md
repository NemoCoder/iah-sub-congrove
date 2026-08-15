# ADR-0001：上线前每次部署清库重建，不写迁移脚本

> # ★★已失效（2026-08-16）★★
> **触发时点**：当晚 congrove 打上 v0.5.0 并 **promote 出 prod 通道**（`congrove.sub.ruciah.com`）。
> 本 ADR 文末「推翻它的条件」写的就是这一条，它已经发生 —— ★条件达成的那一刻它自动失效，不需要再开一次会★。
>
> **现在的规矩：只增不改。** `migrations/` 里已应用的文件**内容冻结**，改 schema 一律**新建** `0002_xxx.sql`。
> 理由没变过：这条纪律**存在的唯一理由**是保护已有实例的数据 —— 以前没有数据要保护，现在 prod 有了。
>
> **它现在由门禁看着，不靠人记**：
> - `scripts/migration-frozen-check.sh` —— 已应用的迁移哈希必须等于 `migrations/checksums.txt`（★纯静态，进 CI★）
> - `scripts/migration-checksum-check.sh` —— 代码里的迁移 vs **dev 与 prod 两个库**里 sqlx 记的校验和（要连库，进不了 CI）
>
> ⚠★这不是理论风险★：2026-08-15 晚上,我在 dev 上改了 `0001_init.sql`(那时本 ADR 还有效、允许改),
> 却漏了配套的清库重建 —— 十六道门禁全绿、CI 全绿、PR 合并、部署,一路没有任何一处提醒,
> 直到 pod CrashLoop 在 `migration 1 was previously applied but has been modified`。
> ★那次的代价是「改一条记录」;同样的操作从 2026-08-16 起发生在 prod 上,就是生产事故。★
>
> 下面的原文保留，读它是为了理解**当初为什么这么定**，不是为了照着做。

**状态**：~~已定（liaoruili 2026-08-08）~~ → **已失效（2026-08-16，prod 通道开通）** · **影响**：M0 全程

## 决定

v0.5 上线之前，**每次部署都先清库再建**，`migrations/` 里**永远只有一个 `0001_init.sql`**，
它可以随便改。不写 `0002`、不写 ALTER。

## 为什么（不是图省事）

- congrove **还没有 prod 通道**，dev 库里 0 个项目、0 份材料、2 个用户 —— ★没有任何要保护的数据★；
- `sqlx::migrate!` 启动即校验校验和，「只增不改」这条纪律**存在的唯一理由**是保护已有实例的数据。
  没有数据要保护时，它换来的只有摩擦：M0 的七个 PR 每改一次表结构就多一个 ALTER 文件，
  最后「`0001` + 七个补丁拼出来的东西」**和直接读 `0001` 看到的不是一回事** —— 那正是反漂移要避免的。

## 怎么做（四步，一步都不能省）

| 步 | 做什么 | 为什么不能省 |
|---|---|---|
| 1 | ★四条一起，缺一不可★（见下） | ★只清 `_sqlx_migrations` 不够★：现行 `0001` 全是 `CREATE TABLE IF NOT EXISTS`，只清账本会让**老结构活下来**，而且一声不响 |
| 2 | 部署（`POST .../deploy` 带 `ref`，`autobuild:false`） | `sqlx::migrate!` 启动即校验校验和，必须先清后部 |
| 3 | 已部署过则 `rollout restart` | 迁移只在**启动时**跑一次；清了库不重启，跑的还是老进程、面对空库 |
| 4 | 窗口内挡住 dev 的 auto-deploy | `ci.yml` 的 deploy 条件是 `push && refs/heads/dev` —— 期间任何热修都会把 dev 通道刷回旧代码，撞上新 schema |

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- ★下面两条不能省★（2026-08-08 首次部署就栽在这）：
GRANT ALL ON SCHEMA public TO <app 角色>;          -- 例：sub_congrove_dev
ALTER SCHEMA public OWNER TO <app 角色>;           -- 交回去，与平台供给出来的初态一致
GRANT ALL ON SCHEMA public TO <cli 角色>;          -- 门禁脚本还要连
```

⚠⚠ ★为什么后两条是承重的★：清库用的是平台发给开发者的**第二个角色** `<slug>_cli`，
而 app 连库用的是 `<slug>`。`CREATE SCHEMA public` 会让新 schema **归 CLI 角色所有**，
ACL 变成 `{..._cli=UC/..._cli}` —— app 角色一点权限都没有，于是它的 `CREATE TABLE`
找不到任何可写 schema，pod CrashLoopBackOff，报的是：

```
Error: while executing migrations: no schema has been selected to create in
```

★这条报错文案指向 `search_path`，真凶却是 ACL★，很容易被诊断成「你没重建 public」——
实际 public 一直在。判据看 `select nspacl from pg_namespace where nspname='public'`。
（也因此，「在迁移开头加 `CREATE SCHEMA IF NOT EXISTS public`」**治不了这一种**：
schema 本来就在，那是空操作。）

**门禁**：`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'` 必须 = 0，
且 `nspacl` 里必须有 app 角色。

连带一条 DDL 要求：★新的 `0001_init.sql` 不许用 `CREATE TABLE IF NOT EXISTS`★，一律裸 `CREATE TABLE`。
理由同步骤 1 —— `IF NOT EXISTS` 会在「库没清干净」时**静默建出错误 schema**，裸写则**响亮失败**。

## ⚠★用特性分支部 dev 之后，必须把 ref 改回 `dev`★（2026-08-08 踩的）

`POST /deploy {"channel":"dev","ref":"<特性分支>"}` 会把子系统记录里的 **ref 改掉并留在那里**。
之后 CI 的 `ci-deploy?channel=dev` 不带 ref、沿用记录值 ——
★每次合并到 dev，构建的都是那个早已过期的特性分支。★

**它完全静默**：gate 绿、deploy job 绿、构建成功、日志无异常，
唯一的症状是「线上版本没变」，而那需要有人专门去看。

M0 上线时就中了：合并后线上停在 v0.4.58 一动不动，bundle 哈希都没变。
在门户把 ref 改回 `dev` 后重新构建，立刻 v0.4.59。

**判据要落在能直接观察到的东西上**：验证部署链路时不要用空提交（线上看不出变没变），
★升一位版本号★ —— 「线上出现 v0.4.59 = 链路通」是一句话就能判的。

（已在群 #5 msg 194 建议平台从根上改：`ci-deploy` 显式带 ref，或 `POST /deploy` 的 ref 不落库。）

## ★两条边界，写死★

1. **清库是操作者的显式动作，绝不能做进镜像的启动逻辑。**
   dev 与 prod 是**同一个镜像** promote 上去的（平台硬约束），把「启动就 DROP SCHEMA」写进代码，
   等于给 prod 装了一颗定时炸弹。
2. **prod 通道一旦开出来，这条规矩当场失效**，立刻回到「只增不改」。

## 顺带消掉的一个风险

v3/v4 初稿把「不可逆」列成重风险，要绑时间窗 + 事先通告。★这条已经不成立★：
既然每次部署都清库重建，切回旧分支也只是「清库 + 部旧分支」，旧代码配旧 `0001`，一样干净。
**没有单向门，就不需要窗口，也不需要通告。** 唯一还成立的是「同一时刻 dev 只能跑一个分支」——
那是**占用**，不是不可逆。

## 不管什么

不管 prod 的数据迁移策略（那时这条 ADR 已失效）；不管 dev 数据的备份（按定义就是可丢的）。
