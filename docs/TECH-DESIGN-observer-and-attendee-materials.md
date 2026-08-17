# 技术设计：旁听白名单 + 参会人对活动材料的读写权

| | |
|---|---|
| 轨 | **轻量轨**（动权限 → 从相位 4 起：技术设计 + 契约 + 实现 + 测试） |
| 上游 | `docs/adr/0006-observer-whitelist-and-attendee-materials.md`（需求已由 liaoruili 逐条拍板） |
| 性质 | ★「权」路径★ —— 按 CODE-QUALITY，技术设计与测试**一律不能省** |
| 签核 | 同行评审。★这份过了才动代码★ |

---

## 1. 现状 grep 盘点：判据散在几处，这正是那个 bug 的成因

### 1.1 读活动材料，今天要过哪些闸

| 入口 | 现在的判据 | 参会人（非项目成员） | 旁听（恰好是项目成员） |
|---|---|---|---|
| `GET /activities/{id}/items` | 「是任一关联项目的成员」 | ❌ 403 | ★✅ 拿得到（漏）★ |
| `GET /items/{id}`（`items::list` 等） | `require_role(pid, Viewer)` | ❌ | ✅（漏） |
| `GET /items/{id}/play`（`media::play`） | `require_role(pid, Viewer)` | ❌ | ✅（漏） |
| `media::analysis` / `media::subtitles` | `require_role(pid, Viewer)` | ❌ | ✅（漏） |

⇒ ★两类人都判错了，而且**方向相反**★：该看的看不到，不该看的看得到。

### 1.2 写活动材料，今天要过哪些闸

| 入口 | 现在的判据 |
|---|---|
| `POST /activities/{id}/materials-project`（算落点） | ★`organizer != me → Forbidden`★ |
| `POST /projects/{pid}/upload`（`items::precheck` 之后） | `require_role(pid, Editor)` |
| `media::begin` / `part` / `complete` / `abort`（大文件直传四步） | `require_role(pid, Editor)` |
| `media::analyze`（手动重跑转写） | `require_role(pid, Editor)` |
| `PUT/DELETE /activities/{mid}/items/{iid}`（改名/删除） | `require_material_owner(pid)` |

⇒ 参会人在**第一步**就被挡（`materials-project` 只认发起人），后面每一步也都挡。

### 1.3 前端那道假闸

```tsx
{d.participants && <MaterialsCard … />}          // 按「是不是参会人」画卡片
{m.online_url && d.participants && <OnlineCard/>} // 线上地址也被同一道挡着
```

★这不是安全边界，是替身判据★ —— 它和后端的「项目成员」判据不同源，于是造出了
「卡片在、列表空、上传失败」这个半截状态。

## 2. 设计：★一个新的单点推导，所有路径必经★

### 2.1 为什么不改 `require_role`

`require_role(pool, id, project_id, need)` **没有活动上下文**，而它有 **12+ 个调用点**横跨
`items.rs` / `media.rs`。给它加参数 = 逐个改调用点 + 每个都要判断该不该传活动上下文。
★ADR-0005 已经论证过这条路不成立★（当时是 `op` 参数，同一形状），不重新论证。

### 2.2 新增：`perm::activity_material_access`

```rust
/// 我对「某一份活动材料」有什么权。★这是活动材料的唯一推导★。
///
/// ⚠ 入参是 **item 的 activity_id**，不是「我正在看哪场活动」——
///   判据必须挂在**材料自己属于哪场活动**上，否则拿 A 活动的身份去读 B 活动的材料就能绕过。
pub enum 材料权 { 无, 只读, 可传, 可管 }

pub async fn activity_material_access(
    pool: &PgPool, id: &Identity, activity_id: i64, item_created_by: Option<&str>,
) -> AppResult<材料权>
```

判定顺序（★顺序本身是设计的一部分★）：

1. **旁听 → `无`，立即返回。**
   ★这一条必须在项目成员判断**之前**★ —— 否则「旁听 + 恰好是项目成员」还是会被放行，
   而那正是今天的漏洞。（与 ADR-0005 材料区「否决在 merge 之前」同一形状。）
2. **是这场活动的参会人（`kind <> 'observer'`）** → 至少 `可传`；
   若 `item_created_by == 我` → `可管`。
3. **是任一关联项目的 editor 及以上** → `可管`；是 viewer → `只读`。
4. **不关联项目的个人活动**：只有发起人（沿用今天 `activity_items` 里那条 UNION）。
5. **超管（`super_now`）**：★只在「有关联项目」的活动上短路★ —— 沿用今天那条限定，
   材料区里是私人内容，J1 承诺的「只有我」不能被超管短路破坏。
6. 其余 → `无`。

### 2.3 各调用点怎么接

| 入口 | 改成 |
|---|---|
| `activity_items` | 先 `activity_view`（决定 404 还是 403），再 `activity_material_access` ≥ `只读` |
| `items::list` / `media::play` / `analysis` / `subtitles` | `require_role(Viewer)` **失败时**，若该 item 有 `activity_id` 则回落到 `activity_material_access ≥ 只读` |
| `materials-project` | 把 `organizer != me` 换成「我是这场活动的参会人（非旁听）」 |
| `items::precheck` + `media::begin/part/complete/abort/analyze` | 同上回落，要求 ≥ `可传`；★并且校验 `activity_id` 指向的活动确实关联着这个 `pid`★ |
| `rename_activity_item` / `delete_activity_item` | 要求 `可管`（= 项目 editor 以上 **或** 这份是我自己传的） |

⚠★「回落」的写法要小心：先 `require_role`、失败再看活动★ —— 反过来写（先看活动、再看项目）
会让**项目成员**在活动路径上拿到比项目角色更低的权，等于静默降权。

⚠★`activity_id` 与 `pid` 的一致性校验不能省★：不校验的话，
「我是 A 活动的参会人」＋「pid 指向一个我碰不到的项目」就能往任意项目里写东西。
判据：`EXISTS (SELECT 1 FROM activity_projects WHERE activity_id = $1 AND project_id = $2)`。

### 2.4 detail 的两处修补（ADR-0006 决定一的反方向缺口）

- Observer 分支的 `organizer` **如实给**（今天是空串）；`recorder` **仍然置空**
  （记录员是活动内部的分工，不在白名单里）。
- 新增两个由后端算的布尔，供前端直接用，★取代前端那个 `d.participants` 替身判据★：

```jsonc
{ "can_see_items": true, "can_upload_items": true }
```

前端改成 `{d.can_see_items && <MaterialsCard canEdit={d.can_upload_items} …/>}`。
线上地址卡片改成对旁听也显示，但**不给「改动历史」**（那是活动内部的过程信息）。

## 3. 契约（OpenAPI）

| 接口 | 变更 |
|---|---|
| `GET /api/activities/{id}` | 响应加 `can_see_items` / `can_upload_items`；Observer 分支的 `organizer` 由空串改为真实值 |
| `GET /api/activities/{id}/items` | 语义变更：参会人可读、旁听一律 403 |
| `POST /api/activities/{id}/materials-project` | 语义变更：发起人 → 任一非旁听参会人 |
| `PUT/DELETE /api/activities/{mid}/items/{iid}` | 语义变更：项目 editor **或** 自己传的 |

★这几条是**行为**变更、不是形状变更，`api-check` 那道闸看不见★（契约里响应没有 schema）——
所以它们必须靠测试守，见 §5。

## 4. 前端

1. `MaterialsCard` / `OnlineCard` 的显隐改用后端给的布尔。
2. ★材料与录制表格的「名称」列改成可点★（ADR-0006 决定三）：点开走 `openViewer(it.id)` ——
   viewer 页对 `kind === 'video'` 已经是 `<VideoPlayer standalone>`（Range 拖动都有），
   ★能力早就在，这里只是缺一个入口★。
3. 表格的「改名 / 删除」按钮按 `it.created_by === 我 || can_manage` 显隐 ——
   ⚠ 前端隐藏不是安全边界，后端仍要判（老规矩）。

## 5. 测试计划

### 5.1 单元（`cargo test`，纯函数部分）

判定顺序是纯逻辑，抽出来能测：★「旁听 + 项目 admin」必须回 `无`★ —— 这条是本设计的命门。

### 5.2 E2E（`e2e/specs/observer-materials.spec.ts`，自造数据）

| # | 用例 | 判据 |
|---|---|---|
| O1 | ★旁听 + **同时是关联项目的 admin**★ → `items` 403、`play` 403、`minutes` 403、`messages` 403 | 本设计的命门 |
| O2 | 旁听拿到的 detail：有 title/agenda/时间/地点/**organizer**/online_url；**无** participants（连人数字段都没有） | 白名单 |
| O3 | **正向对照**：同一个人**改成参会人**之后，上面全部变成 200 | ★没有这条，O1 全绿也可能只是「他根本看不到这场活动」★ |
| A1 | 参会人（非项目成员）：`items` 200、能上传材料、能上传录制 | 决定二 |
| A2 | 参会人删/改**自己传的** → 204/200；删/改**别人传的** → 403 | 边界 |
| A3 | ★参会人拿 A 活动的身份 + B 项目的 pid 上传 → 403★ | §2.3 那条一致性校验 |
| A4 | **正向对照**：项目 editor 仍能删别人传的 | 别把项目成员一起降权了 |
| D1 | 活动开了禁下载 → 参会人也下不了 | 活动级策略不受影响 |

⚠★每条「拒绝」旁边都要有对应的「放行」★ —— 2026-08-16 刚栽过一次：
只断言「回 400」的用例，在**请求本身就是坏的**时候也会绿。

## 6. 实施顺序

1. `perm::activity_material_access` + 单测（不接线，行为零变化）
2. 读路径接线（`activity_items` / `list` / `play` / `analysis` / `subtitles`）
3. 写路径接线（`materials-project` / `precheck` / `media` 四步 / `analyze` / 改名删除）
4. detail 的两个布尔 + `organizer` 修补
5. 前端：显隐改用布尔、名称列可点、按钮按归属显隐
6. E2E

⚠ 第 2 步和第 3 步之间能停：只放开读、不放开写，是一个自洽的中间态。

## 7. 开放问题

无。（需求侧三条已由 liaoruili 2026-08-16 逐条拍板，记在 ADR-0006。）
