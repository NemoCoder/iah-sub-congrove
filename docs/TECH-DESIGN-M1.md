# M1 技术设计 · 权限重构与会议模块

| 项 | 内容 |
|---|---|
| 版本 | v0.1（待评审） |
| 日期 | 2026-08-06 |
| 依据 | [PRD-meetings.md](./PRD-meetings.md) v0.3 · [确认记录](./PRD-decisions-log.md) · [原型](./prototype-m1.html) |
| 范围 | **M1**：权限重构（D0/D3/D12）+ 项目/会议/日历/应答 |

---

## 0. 前提：清库重建，没有历史负担

★**2026-08-06 用户决定：本次完全重构，之前所有数据都不要了，清库重来。**★

这一条把整个技术方案的难度降了一个量级。原本 M1 的 80% 风险集中在一次迁移上
（组授权摊平防静默降权、owner 回填、表改名），**这些全部是为了保住现有数据**。
数据不要了，就不需要迁移——**直接重写初始迁移，表一次建成最终形态**。

### 破例条件（必须先确认）

本仓库的迁移纪律是**只增不改**（`sqlx::migrate!` 校验和，改已应用的文件 = 全部实例启动失败）。
唯一能破例的时刻是 **没有任何实例的 `_sqlx_migrations` 里还有记录**。
CLAUDE.md 记着上一次破例（2026-08-05，0001~0009 压成单个 0001）。这是第二次。

**动手前逐条确认**：

- [ ] **dev 库**已清空（或整个删掉重建）
- [ ] **prod 库**已清空 —— ⚠ prod 上若有还想留的东西，现在是最后的机会
- [ ] **两个 S3 桶**一并清空 —— 否则 PG 清了、对象还在，留下**永久孤儿**（没有任何行引用，
      配额统计也看不见它们，只能靠人工翻桶发现）
- [ ] 确认没有第三个实例（临时部署、别人的分支）还挂着旧库

任何一条不满足，就退回 §2b 的增量迁移方案。

---

## 1. 现状盘点

### 1.1 现有迁移（将全部作废）

`0001_init.sql`（12 表）· `0002_share_token` · `0003_public_share` ·
`0004_soft_delete_and_dedup` · `0005_sha_verified` · `0006_share_code_throttle`

**处置**：删掉 0002~0006，**重写 0001_init.sql**，把六个文件的最终形态 + 本次新增一次性写成一个。
好处不只是省事——新人读一个文件就知道全部表结构，不用在六个文件里拼图。

### 1.2 代码影响面（`grep` 实测）

| 文件 | 引用数 | 处置 |
|---|---|---|
| `src/http/spaces.rs` | 35 | 改名 `projects.rs`，`space_*` → `project_*` |
| `src/http/mod.rs` | 16 | 路由表同步 |
| `src/http/groups.rs` | 15 | ★整个文件删除★（D12） |
| `src/http/items.rs` | 10 | `space_of` → `project_of` |
| `src/http/media.rs` | 5 | 上传路径 |
| `src/perm.rs` | 1 | ★核心：`effective_role` 那条 SQL★ |
| 其它 | 4 | share / admin / media_ai |

前端：API 路径 `/api/spaces/*` → `/api/projects/*`，组件与文案同步。

---

## 2. 新的 `0001_init.sql`（一次建成最终形态）

### 2.1 项目与权限

```sql
-- 项目:组织的基本单位(原「空间」)。
-- visibility 只影响忙闲:public 的会议让成员显示「忙」;private 完全不占忙闲(可多人私下组队)。
-- ⚠ 两者的资料都只有成员能看,项目名与成员名单也都不公开。
CREATE TABLE projects (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  owner        text NOT NULL,                       -- ★唯一主持人★
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  quota_bytes  bigint  NOT NULL DEFAULT 10737418240,
  no_download  boolean NOT NULL DEFAULT false,      -- 只读成员禁下载
  no_share     boolean NOT NULL DEFAULT false,      -- 禁止对外分享
  hotwords     text NOT NULL DEFAULT ''
);

-- 成员:★只到具体的人,没有「组」这一层(D12)★
-- role: admin(管理员/副手) / editor(成员) / viewer(只读成员);owner 在 projects.owner 单列
CREATE TABLE project_members (
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  username   text   NOT NULL,
  role       text   NOT NULL CHECK (role IN ('viewer','editor','admin')),
  added_by   text   NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, username)
  -- ⚠★绝不加「授权生效时间」字段★:那会把 D3 的「当前状态函数」退回「历史累积」,
  --   直接违反 R1「加入即可见全部历史」。
);
CREATE INDEX idx_pm_user ON project_members (username);
```

★**不再有** `groups` / `group_members` / `grantee_type`★——D12 决定权限只到人。
★**角色枚举不变**★（viewer/editor/admin）：PRD 里「成员 / 只读成员」是**展示名**，
`editor → 成员`、`viewer → 只读成员`、`admin → 管理员`。少一套枚举要同步。

### 2.2 内容（沿用现有设计，字段改名）

`items` / `item_versions` / `share_links` / `share_items` / `share_visits` 等
**保持 0001~0006 的最终形态**，只把 `space_id` 改成 `project_id`、加上会议关联列：

```sql
ALTER ... -- 实际写在新 0001 里,此处只列差异
items.project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE
items.meeting_id   bigint REFERENCES meetings(id) ON DELETE SET NULL   -- ★只读会议区标记(D10)★
items.is_recording boolean NOT NULL DEFAULT false  -- ★录制 ≠ 材料(D5 补充)★
```

`is_recording` 那条是原型评审补的：材料里本来就可能有视频，
**只有 `is_recording` 的文件会被转写、并作为会议时长依据**。
判据是「传到哪个入口」，不是文件类型。

### 2.3 会议模块

```sql
CREATE TABLE meetings (
  id           bigserial PRIMARY KEY,
  title        text NOT NULL,
  agenda       text NOT NULL DEFAULT '',      -- 议题与议程(公开会议对所有人可见)
  organizer    text NOT NULL,
  recorder     text NOT NULL,                 -- ★记录员,发起时必填(D14)★
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  timezone     text NOT NULL DEFAULT 'Asia/Shanghai',   -- ★IANA 名,不存偏移★
  location     text NOT NULL DEFAULT '',
  online_url   text NOT NULL DEFAULT '',
  visibility   text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled')),
  rrule        text,                          -- M2 用;M1 恒 NULL,先建列免得 M2 再动表
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE meeting_projects (               -- 一次会可挂多个项目(必须 ≥1,应用层保证)
  meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, project_id)
);

CREATE TABLE meeting_participants (
  meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  username   text NOT NULL,
  kind       text NOT NULL DEFAULT 'attendee'
             CHECK (kind IN ('attendee','guest','observer')),   -- 参会/临时(D8)/旁听(D9)
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','declined','tentative','counter')),
  counter_starts_at timestamptz, counter_ends_at timestamptz, counter_reason text,
  responded_at timestamptz,
  PRIMARY KEY (meeting_id, username)
  -- ⚠ 这张表**不承载任何资料权限**(D3),只管「谁被邀请、答复是什么」
);
CREATE INDEX idx_mp_user ON meeting_participants (username);

CREATE TABLE meeting_messages (               -- 讨论区(D13)
  id bigserial PRIMARY KEY,
  meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sender text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('public','private')),
  peer text,                                  -- private 时的对方
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_link_history (           -- 链接改动历史(④.2)
  id bigserial PRIMARY KEY,
  meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  old_url text, new_url text,
  changed_by text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now()
);

-- M3 起用,M1 先建表(建表比后加便宜)
CREATE TABLE meeting_minutes (                -- 纪要(D14)
  meeting_id bigint PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done')),
  attendees text NOT NULL DEFAULT '',         -- 记录员核对后的实际名单
  observers text NOT NULL DEFAULT '',
  absentees text NOT NULL DEFAULT '',
  agenda_text text NOT NULL DEFAULT '',
  content_md  text NOT NULL DEFAULT '',       -- ★记录员写 Markdown★
  resolutions text NOT NULL DEFAULT '',
  todos       text NOT NULL DEFAULT '',
  pdf_item_id bigint REFERENCES items(id) ON DELETE SET NULL,
  completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
```

**索引要点**：忙闲是最热路径，靠 `idx_mp_user` +
`CREATE INDEX idx_meetings_time ON meetings (starts_at, ends_at) WHERE status='active'`。

### 2b. 退路：若清库条件不满足

若 §0 的四条确认里有任何一条不成立，则**不能重写 0001**，改走增量迁移 `0007`。
那条路最危险的一步是**组授权摊平**（现有用户可能只通过组拿到权限，
直接删组 = 静默降权，且不报错）。摊平 SQL 与迁移前后的对拍脚本另行给出。
**本文档按「清库」这条主路径写。**

---

## 3. `perm.rs` 重构

### 3.1 有效角色：三条来源 → 一条

```rust
// 旧:超管 UNION 直接授权 UNION 组授权(要 JOIN group_members)
// 新:超管 UNION 成员表 —— 少一次 JOIN、少一处分支
pub async fn effective_role(pool: &PgPool, id: &Identity, project_id: i64)
    -> AppResult<Option<Role>>
{
    let username = id.require_username()?;
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT 'admin'::text FROM app_user WHERE username = $2 AND is_super
         UNION ALL
         SELECT role FROM project_members WHERE project_id = $1 AND username = $2",
    ).bind(project_id).bind(username).fetch_all(pool).await?;
    Ok(merge(rows.iter().map(|r| Role::parse(r))))
}
```

★保留的三条性质★（都是既有审计换来的，不能因为简化而丢）：

1. **超管位查库**，不信 cookie 快照（2026-08-04 审计）
2. **无授权 → 404，有授权但档位不够 → 403**（防 id 枚举的存在性预言机）
3. **唯一推导**：任何 handler 不得重写角色比较

### 3.2 owner 的判定

`owner` 不进 `Role` 枚举——它是**项目上的一个字段**，与角色正交：

```rust
/// 只有主持人能做的事:指定/撤销管理员、转移主持人、删除项目。
pub async fn require_owner(pool: &PgPool, id: &Identity, project_id: i64) -> AppResult<()> {
    if is_super_now(pool, id).await? { return Ok(()) }
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT owner FROM projects WHERE id = $1").bind(project_id)
        .fetch_optional(pool).await?;
    match owner.as_deref() == id.username.as_deref() {
        true => Ok(()),
        false => Err(AppError::Forbidden),
    }
}
```

### 3.3 忙闲查询（D1 的落点）

★**私密项目的会议不进忙闲**，这是一条 `WHERE` 就能表达的规则★：

```sql
-- 查 users 在 [from,to) 的忙闲。只回时间区间,★绝不回标题/项目/参与人★
SELECT p.username, m.starts_at, m.ends_at
  FROM meeting_participants p
  JOIN meetings m ON m.id = p.meeting_id AND m.status = 'active'
 WHERE p.username = ANY($1) AND m.ends_at > $2 AND m.starts_at < $3
   AND p.status <> 'declined'
   AND EXISTS (                      -- ★至少挂在一个 public 项目下才产生忙闲★
     SELECT 1 FROM meeting_projects mp JOIN projects pr ON pr.id = mp.project_id
      WHERE mp.meeting_id = m.id AND pr.visibility = 'public');
```

⚠ **接口级测试要钉死返回字段**：响应体里出现任何标题/项目名/参与人字段即失败。
D1 的整个隐私承诺就靠这一条，将来有人"顺手加个字段方便前端"就破了。

---

## 4. API（M1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/projects` | 列表 / 新建（建者自动 owner + admin 成员） |
| GET/PUT/DELETE | `/api/projects/{id}` | 详情 / 改名与可见性 / 删除（owner） |
| GET/POST/DELETE | `/api/projects/{id}/members` | 成员管理，POST 支持**批量** |
| POST | `/api/projects/{id}/transfer` | 转移主持人（**需对方接受**，⑨.5） |
| GET/POST | `/api/meetings` | 我的会议 / 发起（**必带 ≥1 项目 + 记录员**） |
| GET/PUT/DELETE | `/api/meetings/{id}` | 详情 / 修改 / 取消 |
| POST | `/api/meetings/{id}/respond` | 应答四态（含 counter） |
| POST | `/api/meetings/{id}/counter/{user}/accept` | 采纳改期（发起人） |
| POST | `/api/meetings/{id}/remind/{user}` | 催办 |
| PUT | `/api/meetings/{id}/link` | 改链接（写 history + 通知全员） |
| GET/POST | `/api/meetings/{id}/messages` | 讨论区（public/private） |
| **GET** | **`/api/freebusy?users=&from=&to=`** | ★忙闲，只回时间区间★ |
| GET | `/api/calendar?from=&to=` | 我的日历（会议 + 私密项目日程） |

**路径从 `/api/spaces/*` 改为 `/api/projects/*`**，不保留旧路径别名——
留了就是永久的两套术语（同 D0 的理由）。前端同批改完。

---

## 5. 实施顺序

清库之后没有迁移风险，顺序按**依赖关系**而不是按风险排：

| # | 步骤 | 验证 |
|---|---|---|
| 1 | 重写 `0001_init.sql`，删 0002~0006 | 本地 `cargo run` 起一个空库跑通 |
| 2 | `perm.rs`：删组授权分支、加 `require_owner` | `cargo test`（保留现有 3 个单测 + 补 owner 判定） |
| 3 | 删 `groups.rs`，`spaces.rs` → `projects.rs`（35 处） | `cargo check` + 全局 `grep -i space` 应只剩注释 |
| 4 | 会议模块后端（表已建，写 API） | 逐个 handler 手测 |
| 5 | 前端：路径 `/api/spaces` → `/api/projects`、术语、新页面 | `pnpm typecheck && pnpm build` |
| 6 | dev 部署 → 按原型逐页对 | 真人走一遍「建项目 → 拉人 → 发会 → 应答」 |

### 5.1 唯一的硬约束

★**清库、迁移、代码必须同一次上线**★——新 `0001` 与旧库的 `_sqlx_migrations` 校验和对不上，
**旧库不清空，服务根本起不来**（sqlx 会拒绝启动）。所以：

1. 先停 dev → 清 dev 库与桶 → 部署新代码 → 验证
2. dev 验证通过后，同样的顺序做 prod

### 5.2 不需要做的事（清库带来的红利）

- ~~组授权摊平~~ ~~owner 回填~~ ~~表改名 ALTER~~ ~~迁移前后对拍~~ ~~PITR 点位确认~~
- ~~S3 key 前缀兼容~~ —— 桶也清空，新对象一律 `blobs/<sha256>`，
  历史上的 `spaces/{sid}/{iid}/blob` 这条兼容分支**可以从代码里删掉**

最后一条值得单独说：`upload_key_of()` 里那个「老行没有 upload_key 就退回旧规则」的兼容分支，
是为历史数据留的。清库后**没有历史数据**，这个分支可以删——**少一条永远不会被执行、
却要被每个读代码的人理解一遍的规则**。

---

## 6. 开放问题

1. ~~S3 key 前缀兼容~~ → **清库同时清桶，不存在历史对象**。新对象一律内容寻址 `blobs/<sha256>`，
   `upload_key_of()` 里的旧规则回退分支可以删掉。
2. **`meeting_participants.kind='guest'`（临时参会人）在 M1 是否需要**？
   D8 定了它的语义，但 M1 没有公开会议（M2 才有旁听）。建议 M1 建表就带上这个枚举、
   前端先不暴露入口——**加枚举值比加列便宜**。
3. **周期会议（M2）** 的 `rrule` 列 M1 先建但恒 NULL，避免 M2 时再动表。
