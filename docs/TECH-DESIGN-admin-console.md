# 技术设计：超管后台（Admin Console）

| | |
|---|---|
| 轨 | **全流程轨**（相位 4 —— 技术设计 + OpenAPI 契约 + 测试计划） |
| 上游 | `PRD-admin-console.md`（相位 0/2/3,#147 已签核;★其中 Q4 已更正,见该文 §7★） |
| 签核 | 同行评审（技术门禁） |
| 前置 | ★这份评审过才动代码★ —— 这一页上每个动作都是「权 / 供给」类,测试不能省（CODE-QUALITY） |

---

## 1. 现状 grep 盘点

### 1.1 后端已有的（四个 API,全挂 `require_super`）

| 位置 | 现状 | 这轮要不要动 |
|---|---|---|
| `admin::users` | `SELECT username,name,email,is_super,created_at,last_login FROM app_user ORDER BY username` | ★要★ —— 补配额两列 |
| `admin::set_super` | 含「不能撤最后一个超管」防锁死 | 不动 |
| `admin::set_quota` | upsert 进 `user_quota` + 审计 `admin.quota` | 不动 |
| `admin::audit_list` | `limit` 默认 200 封顶 2000 | 不动 |
| `admin::effective_llm_model` / `llm_models` / `set_llm_model` | 库 > env > 默认;写入记审计 | ★形状照抄★ |

### 1.2 三项治理配置现在长在哪

| 项 | 代码位置 | ★读取形态★（这决定了改它的后果） |
|---|---|---|
| 建项目白名单 | `config.rs: project_creators`（env）<br>判定在 `projects::create` | 请求时读 `state.config` —— **进程内的值,改 env 要重启** |
| 全站默认配额 | `config.rs: DEFAULT_QUOTA_BYTES`<br>用在 `items::owner_quota_used` | ★**读取时兜底**★：`COALESCE((SELECT … user_quota …), $2)`<br>⇒ 没有 `user_quota` 行的人**每次都现算** |
| 全站默认提醒 | `remind.rs: DEFAULT_REMIND_MIN`<br>用在提醒扫描的 SQL | ★**读取时兜底**★：`COALESCE(m.remind_minutes, u.default_remind_minutes, $1)`<br>⇒ 没设个人默认的人跟着它走 |

⚠ ★后两项都是「读取时兜底」,不是「建行时固化」★ —— 这正是 PRD 里 Q4 答错的那一条。
**实测 dev：108 个用户,0 个单独设过配额** ⇒ 改默认 = 改 100% 的人。

### 1.3 一处已知的重复,这轮不解决但要记住

`0001_init.sql` 里 `user_quota.quota_bytes DEFAULT 10737418240` 和 `config.rs` 的常量是同一个数,
文件里已注明「两处写死,改一处要改两处」。

★但实际上这个列 DEFAULT **从来没被用到过**★：唯一的写入 `set_quota` 是
`INSERT INTO user_quota (username, quota_bytes, updated_by) VALUES ($1,$2,$3)` —— **总是显式给值**。
⇒ 加了「库里可配」之后,它也不会变成第三个真相源(它本来就不是真相源,是个死默认)。
**这轮不动它**（0001 已冻结,而且改它没有任何行为收益）;在 `config.rs` 的注释上补一句说明即可。

## 2. Schema

★**不建新表,不改任何已应用的迁移**★ —— 三项配置全部进 `app_setting`（`0002`,已在 prod）。

| key | 值的格式 | 兜底顺序 |
|---|---|---|
| `llm_model` | 模型名 | 已存在 |
| `project_creators` | ★逗号分隔的用户名★，与 env 同格式；**空串 = 人人可建** | 库 > env `CONGROVE_PROJECT_CREATORS` > 空 |
| `default_quota_bytes` | 十进制整数字符串（字节） | 库 > `DEFAULT_QUOTA_BYTES` |
| `default_remind_minutes` | 十进制整数字符串（分钟） | 库 > `DEFAULT_REMIND_MIN` |

**为什么 `project_creators` 存成逗号分隔而不是 JSON 数组**：和 env 同一种格式,
★「库里存的」和「env 里存的」长得一样,解析用同一段代码★ —— 两种格式就会有两段解析,
而它们迟早会在边界情况上分叉（空串、前后空格、尾逗号）。

⚠ **不做迁移把现有 env 值搬进库**。判据：`env → 库` 的一次性搬运会让「库里没有值」
这个状态永远消失,于是**兜底那条路再也不会被走到,也就再也不会被验证**。
保持「库里没有 = 用 env」是活的,而不是一段死代码。

## 3. 「唯一推导」——★这一节是整个设计的核心★

三项各写**一个** `effective_*` 函数,**任何地方要用这个值都只能走它**。

```rust
/// 全站默认配额。★唯一推导★：库 > 编译期常量。
pub async fn effective_default_quota(pool: &PgPool) -> i64 { … }
pub async fn effective_default_remind(pool: &PgPool) -> i32 { … }
pub async fn effective_project_creators(state: &AppState) -> Vec<String> { … }  // 库 > env
```

⚠★这一条是有代价的,写清楚为什么值得付★：现在这些值是**编译期常量 / 进程内配置**,
取它零开销;换成 `effective_*` 之后每次都多一次 `SELECT`。
其中 `effective_default_quota` 在**每次配额检查**（= 每次上传）上都会走一遍。

**不加缓存**,理由：`app_setting` 是一张只有几行的表、按主键查,PG 会常驻内存;
而★一层缓存意味着「超管改了、有些进程还在用老值」,那正是这套设计要消灭的东西★。
真到了要缓存的那天,再带着实测数字来谈。

★**反面教材已经写在 `effective_llm_model` 头注里**★：
「别在别处直接读 `state.config.llm_model` —— 那样超管改了也不生效,
**而它不报错,只是继续用老模型**」。三项照抄同一形状,并**加一道门禁**（见 §6）。

## 4. OpenAPI 契约（新增 / 变更）

### 4.1 变更：`GET /api/admin/users`

`UserRow` 加两列：

```jsonc
{
  "username": "chenfeng", "name": "陈锋", "email": "…",
  "is_super": false,
  "created_at": "…", "last_login": "…",
  "quota_bytes": 53687091200,   // 生效额度（单独设过就是它,没设过就是全站默认）
  "quota_is_default": true      // ★true = 没有 user_quota 行,跟着全站默认走★
}
```

⚠ `quota_is_default` 不是冗余：只给 `quota_bytes` 的话,
「50 GiB 是他自己的,还是全站默认正好是 50 GiB」在界面上**分不出来** ——
而这恰恰决定了「改全站默认会不会影响他」。

### 4.2 新增：`DELETE /api/admin/users/{username}/quota` —— 恢复为默认

```
204 No Content        删掉 user_quota 行(幂等:本来就没有也回 204)
403                   非超管
```
审计：`admin.quota_reset`。

### 4.3 新增：`GET /api/admin/settings`

```jsonc
{
  "project_creators": { "value": ["liaoruili"], "source": "env" },
  "default_quota_bytes":   { "value": 10737418240, "source": "default" },
  "default_remind_minutes":{ "value": 15,          "source": "db" }
}
```

★`source` 是设计的一部分,不是调试信息★：界面上要能说出「这个值现在是**从哪来的**」。
不然超管看到 10 GiB,不知道它是「有人设成了 10」还是「没人设过,恰好默认是 10」——
而这两种状态在他改 env 或升级版本时表现完全不同。

### 4.4 新增：`PUT /api/admin/settings/{key}`

```jsonc
// 请求
{ "value": "5368709120" }        // 一律字符串,语义由 key 决定(和 app_setting 的存法一致)
// 200
{ "ok": true, "value": "5368709120" }
```

允许的 key **白名单三个**（`project_creators` / `default_quota_bytes` / `default_remind_minutes`）。
★白名单是安全边界不是校验便利★：`app_setting` 是通用 kv,
不设白名单的话这个接口就是「超管可以写任意配置键」,而将来任何一个新 key（哪怕是内部用的）
都会自动变成可被外部写入 —— **权限随新功能自动扩大,是最难发现的一类越权**。

每个 key 各自的校验：

| key | 校验 |
|---|---|
| `project_creators` | 逗号分隔;★每个用户名必须在 `app_user` 里存在★（Q2 的理由：打错了没人报错）;去重;长度上限 |
| `default_quota_bytes` | 正整数;`> 0`;上限 1 PiB（防手滑多打几个 0） |
| `default_remind_minutes` | `1..=10080`（一周）;与 `RemindSelect` 现有档位一致 |

### 4.5 新增：`GET /api/admin/settings/default-quota/impact?bytes=<n>` —— ★改之前先算影响面★

```jsonc
{ "following_default": 108, "would_exceed": 2,
  "exceeding": [ { "username": "…", "used_bytes": 6442450944 } ] }   // 最多 20 个
}
```

**为什么这是个独立接口而不是前端自己算**：`would_exceed` 要跨 `items` / `item_versions` 求和
（`owner_quota_used` 那段 SQL），前端拿不到也不该拿。
★而没有它,「一键把全站配额调小」就是一个**无法预估后果**的按钮★ ——
点下去之后有人立刻传不了东西,而超管完全不知道自己做了这件事。

## 5. 实施顺序

1. **后端 settings 三件套**（`GET /settings`、`PUT /settings/{key}`、三个 `effective_*`）+ 单测
2. **把三处调用点换成 `effective_*`** + 门禁（§6）—— ★这一步单独一个提交★,
   因为它改的是**已有行为的取值路径**,出问题要能单独回滚
3. **配额两列 + `DELETE .../quota` + impact 接口** + 单测
4. **前端「后台」页**：用户 / 审计 / 治理 / AI 模型 四个 tab;AI 模型从「开发者」页挪过来
5. **E2E**：非超管 403、白名单校验、影响面、恢复为默认

⚠ 第 2 步和第 4 步之间**必须能停**：万一前端来不及,后端已经生效且行为不变（库里没值 = 走 env/常量）。

## 6. ★新门禁：不许绕过 `effective_*` 直接读那三个值★

`scripts/no-bypass-effective.sh`：`src/` 下除了 `effective_*` 自己的定义处,
不许出现 `DEFAULT_QUOTA_BYTES` / `DEFAULT_REMIND_MIN` / `config.project_creators`。

**为什么值得为它专门加一道**：这一类错误的特征是★**不报错**★ ——
超管在界面上改了,某处仍读旧常量,页面显示新值、行为还是旧的。
`effective_llm_model` 的头注已经把这个坑写下来了,但**注释拦不住下一个人**。
和「旧命名」那道门禁同一形状：**把一句注释变成一条会红的规则**。

## 7. 测试计划

### 7.1 单元测试（`cargo test`，对真库）

| # | 用例 | 判据 |
|---|---|---|
| T1 | 库里没值 → `effective_*` 回 env / 常量 | ★兜底那条路必须被真正走到★（§2 不做迁移的理由） |
| T2 | 库里有值 → 回库里的 | 覆盖顺序 |
| T3 | 库里是垃圾字符串（`"abc"`）→ ★回兜底,不 panic★ | 库是可以被人手改的,解析失败不能让服务挂 |
| T4 | `PUT` 一个白名单外的 key → 400 | 白名单是安全边界 |
| T5 | `project_creators` 含不存在的用户名 → 400 | Q2 |
| T6 | `default_quota_bytes` = 0 / 负数 / 超上限 → 400 | |
| T7 | 改默认配额后,**没有 `user_quota` 行的人**额度跟着变 | ★这是 Q4 那条更正的回归测试★ |
| T8 | 改默认配额后,**有行的人**额度不变 | 两套并存 |
| T9 | `DELETE .../quota` 后该用户回到「跟随默认」 | 恢复为默认;幂等再删一次仍 204 |
| T10 | impact 接口的 `would_exceed` 与实际拒绝上传的人一致 | ★算出来的影响面必须等于真实影响面★,否则它是个骗人的确认框 |
| T11 | 非超管访问上述每一个新接口 → 403 | 权限,逐个接口都要有 |
| T12 | 每个写接口都落了审计行 | D3 |

### 7.2 E2E（`e2e/`，真浏览器）

- 非超管看不到「后台」入口;有资格但没开超管模式 → 点进去提示开启（沿用现有形状）
- 治理页改默认配额 → 确认框里的数字与 impact 接口一致 → 保存 → 用户列表上 108 行的额度都变了
- 给某人单独设配额 → 他那行不再显示「（默认）」→ 再改全站默认,他**不动** → 「恢复为默认」→ 他又跟上

⚠★E2E 里必须有正向对照★（2026-08-15 的教训：一个只断言「被拒绝」的用例,
在**请求本身就是坏的**时候也会绿）—— 上面每条「改了之后 X 不变」的旁边,
都要有一条「改了之后 Y 确实变了」。

## 8. 开放问题

无。（相位 2 的五问已在 PRD §7 关闭,其中 Q4 已更正并经 liaoruili 2026-08-16 重新拍板：
「得做成可以修改默认,也可以单独给每个人配额的设置」。）

---

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-08-16 | v1 | 首版。含 Q4 更正带来的「全站默认配额 + 恢复为默认 + 影响面预估」三项 |
