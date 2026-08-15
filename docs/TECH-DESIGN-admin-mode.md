# 技术设计：超管模式（Admin Mode）

| | |
|---|---|
| 轨 | **轻量轨**（动权限 → 从相位 4 起：技术设计 + 契约 + 测试计划） |
| 起因 | liaoruili 2026-08-09：「我自己也要使用这个系统，但我默认能看到所有人的内容，这对日常使用带来困扰」 |
| 参照 | GitLab **Admin Mode**（管理员平时就是普通用户，要管理才刻意进模式，6h 自动失效）。<br>GitHub 的 sudo mode 只挡**敏感动作**、不改**可见性**，治不了这个问题，不抄。 |
| 拍板 | 2026-08-09 liaoruili 同意三条建议：**① 不要求重新认证 ② 2 小时自动关 + 退出登录即失效 ③ 入口留着，点了提示开启** |

## 决定

1. `app_user` 加一列 `admin_mode_until timestamptz`（NULL = 没开）；
2. ★判据收敛成一个视图★ `super_now`，**所有特权路径只认它**：

```sql
CREATE VIEW super_now AS
  SELECT username FROM app_user WHERE is_super AND admin_mode_until > now();
```

3. 开关：`POST /api/me/admin-mode {on}` → 置 `now() + 2h` 或 `NULL`，两个方向都进 `audit_log`；
4. 退出登录时清掉它（`/auth/logout`）；
5. **过期不需要任何定时任务** —— `admin_mode_until > now()` 每次查询自带判定。

## ★「资格」与「特权」必须分开★

这是这份设计唯一容易做错的地方。`is_super` 这一列现在同时兼着两件事，拆开之后：

| | 判据 | 含义 |
|---|---|---|
| **资格** | `app_user.is_super` 列 | 这个人**有没有**超管身份。授/撤、列表显示、启动种子、登录 upsert 用它 |
| **特权** | `super_now` 视图 | 这个人**此刻**有没有超管权力。所有判权、所有「多看到东西」的 SQL 用它 |

★用错一边的后果是反的★：资格处误用视图 → 模式一关就撤不了别人的超管、启动种子失效；
特权处漏用视图 → 那条路径永远是超管视角，而它不会报错、只会**默默多给**。

### 点位清单（★不是我手数的，是 `--pre` 让数据库穷举的★）

`python3 scripts/sql-prepare-check.py --pre <(echo "ALTER TABLE app_user DROP COLUMN is_super;")`
→ 13 处直接引用，逐条分类：

**特权（换成 `super_now`）—— 7 处**

| 位置 | 它让超管多看到什么 |
|---|---|
| `perm.rs::effective_role` | **所有项目**的内容 |
| `perm.rs::is_super_now` | 中枢：`require_owner` / `require_activity_host` / `require_super` / `/api/me` 全走它 |
| `perm.rs::activity_view` | **所有活动**的详情与讨论区 |
| `activities.rs::list`（日历 SQL） | **所有人的活动**进我的日历 |
| `activities.rs::update`（改 visibility 的授权） | 改任何一场活动的公开性 |
| `activities.rs::activity_items` | 活动材料（★已按 §J1c 排除了别人的材料区★，那条更严，保留） |
| `projects.rs::diagnose` | 诊断链 —— ★它必须与 perm.rs 同一推导★，否则会报「他是超管所以看得到」而实际看不到 |

**资格（保持读 `is_super` 列）—— 6 处**

`admin.rs` 的用户列表 / 「不能撤销最后一个超管」的计数 / 读被改人的当前值 / `UPDATE set_super`；
`lib.rs` 启动种子；`auth.rs::ensure_app_user` 登录 upsert。

⚠ 启动种子**只种资格，不种模式** —— 默认关着才是这件事的全部意义。

## 契约

```
POST /api/me/admin-mode        {on: bool} → {admin_mode: bool, until: string|null}
   403 如果这个人根本没有超管资格（判据是**资格**不是特权，否则关掉就再也开不回来）
GET  /api/me                   → 多两个字段
   is_super   : bool           ★语义不变 = 此刻有没有超管特权★（前端所有"能不能"的判断继续用它）
   can_super  : bool           有没有超管资格 → 决定「超管模式」这个开关给不给看
   admin_mode_until: string|null
```

★`is_super` 的语义刻意不改★：它已经散在前端多处，改语义会把「显示」和「能力」错配；
新增 `can_super` 只服务于「要不要画那个开关」。

## 测试计划

- `api_cases`：① 模式关着 → 非成员项目 404 ② 开着 → 看得到 ③ 没资格的人调开关 403 ④ 关着调 `/admin/*` → 403
- 单测：`decide_role` / `decide_view` 是纯函数、收的是 SQL 结果行，**不用改** —— 视图换在 SQL 侧，这正是当初把判定抽成纯函数换来的
- 机械门禁：`--pre` 再跑一次，特权侧应当**一条不剩**地不再直接引用 `is_super`

## 不管什么

不管**影子账户**（§J1c，「以某个人的视角查看」）—— 那是另一件事：
★这条是「关掉我自己的特权」，那条是「借用别人的视角」★。两者互补，影子账户仍在 M1。
