# ADR-0001：上线前每次部署清库重建，不写迁移脚本

**状态**：已定（liaoruili 2026-08-08） · **影响**：M0 全程 · **推翻它的条件**：见文末

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
