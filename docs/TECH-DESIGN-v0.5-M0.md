# 技术设计 · v0.5 M0（地基）+ M1（能记录）

| 项 | 值 |
|---|---|
| 相位 | **4（技术设计）** —— 前置 `PRD-v0.5.md`、`STORY-MAP-v0.5.md`、`prototype-v0.5.html` |
| 门禁 | schema + **OpenAPI 契约**写全并评审、测试计划、开放问题关闭 |
| 签核 | 同行评审 + CI |

---

## 1. 现状盘点（量出来的，不是估的）

| 项 | 现状 |
|---|---|
| 后端 Rust | **7806 行**（`src/*.rs` + `src/http/*.rs`），其中 `meetings.rs` 最大 |
| 数据表 | **21 张**（0001~0007 迁移累计） |
| API | **84 个**（`apidoc.rs` 的 `APIS` 表，与路由表由测试逐条比对） |
| 前端 | **5561 行**（`web/src/*.tsx` + `*.ts`） |
| `meeting` 字面量出现 | 后端 348 处（meetings.rs 254 / mod.rs 40 / apidoc.rs 23 / perm.rs 14 / items.rs 9 / notify.rs 8）；前端 64 处 |
| 测试 | 后端 40 条（含 api_cases 契约表）、前端单测 20 条、E2E 50 条 |

**结论**：M0 的工作量集中在**机械改名**（400+ 处）与**新表**，
风险不在于难，而在于**改漏**——所以 M0 的验收判据是「老 E2E 全绿」而不是「看起来对」。

---

## 2. 数据模型（`migrations/0001_init.sql` 全量重写）

> ★不写任何 ALTER★：库已清空，0001~0007 作废，压成一个干净的建表脚本。

### 2.1 新增表

```sql
-- ── 活动类型：★能力位是「一个活动能做什么」的唯一真相源★（PRD A1）──
CREATE TABLE activity_types (
  id          bigserial PRIMARY KEY,
  -- NULL = 系统预置（会议 / 个人日程）；否则是这个人自建的（A2：每人一套）
  owner       text,
  name        text NOT NULL,
  -- ★只有三个能力位★（2026-08-07 精简）：参与人/材料/补录对所有类型统一开放，
  --   判据是「时间过没过」而不是类型（L0）。留下的这三个各有硬后果：
  has_minutes   boolean NOT NULL DEFAULT false,  -- 决定 recorder 是否必填
  needs_project boolean NOT NULL DEFAULT false,  -- 决定材料有没有权限归属（D3）
  busy_default  boolean NOT NULL DEFAULT true,   -- 决定别人看不看得到你忙（自建时唯一可选的开关 A3）
  -- 预置行不可改不可删；自建行可改名、可软删（L1：历史照常显示类型名，统计不断档）
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 同一个人不能建两个同名类型；预置行（owner IS NULL）之间同理
CREATE UNIQUE INDEX idx_atype_name ON activity_types (COALESCE(owner,''), name) WHERE deleted_at IS NULL;
CREATE INDEX idx_atype_owner ON activity_types (owner) WHERE deleted_at IS NULL;

-- ── 每人的偏好（PRD E0 / F3 / L3）──
CREATE TABLE user_prefs (
  username    text PRIMARY KEY,
  timezone    text NOT NULL DEFAULT 'Asia/Shanghai',   -- ★IANA 名★，不设默认北京（E0）
  default_remind_minutes int,                          -- NULL=不提醒；默认建号时写 15
  -- ★配额按人算不按项目算★（L3）：谁传的算谁的，不管落在哪个项目
  quota_bytes bigint NOT NULL DEFAULT 10737418240,     -- 10 GiB，超管可单人调
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 2.2 `meetings` → `activities`（改名 + 加列 + 删列）

```sql
CREATE TABLE activities (
  id          bigserial PRIMARY KEY,
  type_id     bigint NOT NULL REFERENCES activity_types(id),   -- ★NOT NULL★：不留「无类型」状态
  title       text NOT NULL,
  agenda      text NOT NULL DEFAULT '',      -- 会议叫「议程」，个人活动界面上叫「备注」，同一列
  organizer   text NOT NULL,
  recorder    text NOT NULL DEFAULT '',      -- ★仅 has_minutes 的类型必填★（原来无条件必填）
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Shanghai',  -- ★活动自己的时区★（E1）
  busy        boolean NOT NULL DEFAULT true,          -- 建时取类型的 busy_default，之后可改
  location    text NOT NULL DEFAULT '',
  online_url  text NOT NULL DEFAULT '',
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled')),
  remind_minutes int,                        -- NULL=用个人默认；0=不提醒
  reminded_at    timestamptz,                -- ★已发提醒的时刻，防重复★
  actual_minutes int CHECK (actual_minutes IS NULL OR (actual_minutes > 0 AND actual_minutes <= 1440)),
  actual_by      text,
  no_download boolean NOT NULL DEFAULT false,
  no_share    boolean NOT NULL DEFAULT false,
  rrule       text,                          -- M5 的周期规则，本轮恒 NULL
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
-- ★热路径索引带 status 过滤★：忙闲与日历是最热的两条查询
CREATE INDEX idx_act_time ON activities (starts_at, ends_at) WHERE status = 'active';
CREATE INDEX idx_act_organizer ON activities (organizer, starts_at DESC);
-- 提醒扫描：只看「还没发过、时间快到了」的
CREATE INDEX idx_act_remind ON activities (starts_at) WHERE status='active' AND reminded_at IS NULL;
```

**去掉的列**：`is_private`（改为从 `visibility` 直接读，J4——少一层推导就少一处能悄悄错掉的地方）。

### 2.3 其余表改名（结构不变）

`meeting_projects/participants/messages/link_history/minutes/reads` → `activity_*`；
`items.meeting_id` → `items.activity_id`。

⚠ `activity_participants.status` **仍是四态**（pending/accepted/declined/counter）——
★不为补录另造状态★，发不发通知只看 `activities.starts_at` 过没过（L0）。

### 2.4 `projects` 去掉 `quota_bytes`

配额挪到 `user_prefs.quota_bytes`（L3）。★这是个只减不加的改动★，
但牵动 7 处（见 STORY-MAP §7），实施顺序里单列一步。

### 2.5 预置数据（建表脚本末尾）

```sql
INSERT INTO activity_types (owner, name, has_minutes, needs_project, busy_default) VALUES
  (NULL, '会议',     true,  true,  true),
  (NULL, '个人日程', false, false, true);
```

---

## 3. OpenAPI 契约（新增 / 改动的部分）

> 现有 84 个接口中 23 个属于「会议」标签，全部改路径；下面只列**新增**与**语义变化**的。
> 完整契约由 `apidoc.rs` 的 `APIS` 表生成（`GET /api/_dev/openapi.json`），
> ★那张表与路由表由测试逐条比对，漏写多写都会让 cargo test 红★。

### 3.1 新增

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/activity-types` | 登录 | 我能用的类型 = 预置 + 我自建的（未软删的） |
| POST | `/api/activity-types` | 登录 | 建自建类型：`{name, busy_default}`。★只有这两个字段★（A3） |
| PUT | `/api/activity-types/{id}` | 本人 | 改名 / 改 busy_default。★预置行 403★ |
| DELETE | `/api/activity-types/{id}` | 本人 | 软删（L1）。★预置行 403★ |
| GET | `/api/me/prefs` | 登录 | 时区 / 默认提醒 / 配额与已用量 |
| PUT | `/api/me/prefs` | 登录 | 改时区、默认提醒（★配额不可自改★） |
| PUT | `/api/admin/users/{u}/quota` | 超管 | 单人升降配额（替代原 `/admin/projects/{id}/quota`） |
| GET | `/api/my-materials` | 登录 | 「我的活动材料」按活动分组（J0b：★虚拟分组，不是真实目录★） |
| POST | `/api/items/{id}/copy` | 目标项目 ≥editor | 跨项目复制（J2：内容寻址，存储不增加） |

### 3.2 语义变化（路径改名之外）

| 接口 | 变化 |
|---|---|
| `POST /api/activities` | `type_id` 必填；`recorder` **仅 has_minutes 时必填**；`project_ids` **仅 needs_project 时必填**；★去掉「不能排过去时间」的校验★（F0） |
| `PUT /api/activities/{id}` | ★不接受 `type_id`★——不提供改类型（L2） |
| `PUT /api/activities/{id}/participants` | ★活动已开始则不发通知★（L0），其余不变 |
| `GET /api/activities` | 归档项目的活动**照常返回**，带 `archived` 标记（B0/B1）；不再返回 `is_private` |
| `POST /api/projects/{id}/archive` | ★有未开始且未取消的活动则 400★，错误信息**列出是哪几场**（B2） |
| `GET /api/me/stats` | 新增**按类型**分组（K）；口径仍是 D5 三级回退 |
| 上传相关 | 配额预检改为**按 `created_by` 汇总**（L3） |

### 3.3 一个契约细节：能力位怎么下发给前端

`GET /api/activity-types` 返回的每一行都带三个能力位。
★前端不硬编码任何类型名★——表单显示什么、校验什么，全部读这三个布尔值。

```json
{ "id": 1, "name": "会议", "system": true,
  "has_minutes": true, "needs_project": true, "busy_default": true }
```

---

## 4. 实施顺序（M0 → M1）

每一步都能独立跑通、独立提交，**不留半截状态**：

| # | 步骤 | 验收 |
|---|---|---|
| 1 | 重写 `0001_init.sql`（删 0002~0007），本地起服务建库 | 服务能启动、迁移不报错 |
| 2 | 后端改名：`meetings.rs`→`activities.rs`，348 处字面量 | `cargo check` 过 |
| 3 | `activity_types` + 能力位判定（`perm.rs` 旁边加 `caps.rs`，★唯一推导★） | 单测：三个能力位各自的判定 |
| 4 | API 路径改名 + `apidoc.rs` 同步 | ★`cargo test` 的接口比对全绿★ |
| 5 | 前端改名（64 处）+ 类型下拉 + 表单按能力位显隐 | `pnpm typecheck` + `npm test` |
| 6 | **配额挪到用户**（7 处，见 STORY-MAP §7） | 单测：上传预检按人汇总 |
| 7 | 老 E2E 改名跑一遍 | ★50 条全绿 = M0 完成★ |
| 8 | M1：不关联项目的活动 + 补录 + 我的活动材料 + 跨项目复制 | 新 E2E |

★第 7 步是 M0 的唯一门禁★：行为不变是它的全部目标。

---

## 5. 测试计划

### 5.1 必须有测试的（CODE-QUALITY 的「钱/权/删/供给」）

| 路径 | 为什么必须 |
|---|---|
| **能力位判定** | 它决定「记录员填不填」「材料有没有归属」——错了会静默放行 |
| **配额按人汇总** | 钱。算错要么挡住正常用户，要么让人无限传 |
| **归档拒绝条件** | 含「不含已取消」这个刚定的边界，容易写反 |
| **发不发通知的判据** | ★L0 的核心★：写反了会给一屋子人发「你被邀请参加昨天的会」 |
| **跨项目复制的权限** | 要目标项目 editor；写漏就是越权写入 |
| **「我的活动材料」的可见性** | 只有自己能看，写漏就是隐私事故 |

### 5.2 契约表（`tests/api_cases.rs`）

现有 160+ 条用例**逐条过一遍**：改名的改名，语义变了的重写。
★三道自检不能关★（每个接口都有用例 / 需要权限的有越权用例 / 描述里有可观测事实）。

### 5.3 E2E

- **M0**：老 50 条改名后全绿（唯一门禁）；
- **M1** 新增：建自建类型 → 建不关联项目的活动 → 传材料 → 在「我的活动材料」里看到 → 复制到项目 → 原件删除后副本还在。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| ★改名改漏★（400+ 处） | 机械替换后 **grep 兜底**：`grep -ri meeting src/ web/src/` 应当只剩注释里的历史记录 |
| 能力位散落到各处判断 | ★收口到一个 `caps.rs`★，与 `perm.rs` 同样是「唯一推导」；handler 里不重写 |
| 配额改动漏一处 | STORY-MAP §7 那张 7 行的表逐条打勾 |
| `deleted_at IS NULL` 又漏 | ★建表时就把它写进每个读路径的模板★——这条 v0.3.55 补过 11 处、v0.4.28 补过 5 处 |
| 前端类型名硬编码 | 只读能力位、**不写 `if (type.name === '会议')`**；code review 专门看这一条 |

---

## 7. 开放问题

无。（PRD 的 6 条与故事地图的 6 条均已关闭。）
