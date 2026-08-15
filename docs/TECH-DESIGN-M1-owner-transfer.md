# 技术设计：转移主持人需对方接受（M1 收口②）

| 项 | 值 |
|---|---|
| 版本 | v1（2026-08-07） |
| 分轨 | **轻量轨**（动 schema + 动权限 → 从相位 4 起，跳 PRD/故事图/原型） |
| 依据 | PRD ⑨.5「转移主持人需对方接受才生效」；代码里 `projects.rs::transfer` 的 TODO |
| 签核 | 需求口径 liaoruili 已拍板（2026-08-07 会话）；技术侧自查 + CI |

## 1. 现状与问题

`POST /api/projects/{id}/transfer` 现在是**直接转移**：调用即改 `projects.owner`，对方毫不知情。

两个后果：

1. **可以把项目甩给不知情的人**——主持人是有责任的位置（纪要欠账、成员治理都挂在他名下），
   单方面塞给别人不合适；
2. 甩给一个**已经不活跃的人**之后，项目实际上无人负责，而系统显示它有主持人——
   比明确无主更糟，因为没人会去管它。

代码里我自己标过这个 TODO：「本版是直接转移……排在 M1 收尾，先留 TODO 免得阻塞主线」。现在是那个收尾时刻。

## 2. 模型

```sql
CREATE TABLE owner_transfers (
  id         bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_user  text NOT NULL,
  to_user    text NOT NULL,
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','declined','canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
-- ★同一项目同时只允许一条 pending★：并发两条会造成「两个人都以为自己接手了」。
CREATE UNIQUE INDEX ON owner_transfers (project_id) WHERE status = 'pending';
```

**为什么留全部历史而不是只存当前那条**：谁在什么时候想把项目甩给谁、对方拒没拒，
是治理事实，和会议「取消不是删除」同一条道理——真删掉之后没人说得清当时发生过什么。

## 3. 关键决策

| # | 决策 | 为什么不选另一个 |
|---|---|---|
| T1 | **待接受期间原主持人仍是主持人** | 若发起即卸任，项目在空档期无主：没人能加人、没人能改设置，而对方可能永远不点 |
| T2 | 发起人可**撤回**（canceled） | 手滑转错人的唯一退路；不给撤回就只能求对方点「拒绝」 |
| T3 | 只能转给**现有成员**（沿用现行校验） | 转给非成员 = 他接受的瞬间成了一个自己都进不去的项目的主持人 |
| T4 | 接受时**原主持人降为 admin 而不是移出** | 现行行为，保持不变：交棒不是逐出，他通常还要继续参与 |
| T5 | 接受前对方**离开了项目**则该请求失效 | 权限是「当前成员身份的函数」（D3）；接受时重新校验一次，不信发起时的快照 |
| T6 | **归档项目不能发起转移** | 归档 = 只读存档（D17）。⚠ 但**已 pending 的可以接受**——否则归档会把请求永久卡住 |

## 4. 接口契约

```
POST /api/projects/{id}/transfer            发起转移（现任主持人 / 超管）
  body: { "to": "username" }
  → 200 { "ok": true, "transfer_id": 12 }
  → 400 对方不是成员 / 已有一条 pending / 转给自己 / 项目已归档
  → 403 非主持人

POST /api/projects/{id}/transfer/respond    答复（★仅 to_user 本人★）
  body: { "accept": true|false }
  → 200 { "ok": true, "owner": "新主持人" }（accept=false 时 owner 不变）
  → 400 没有待答复的转移 / 我已不是本项目成员（T5）
  → 403 我不是被转让人

DELETE /api/projects/{id}/transfer          撤回（发起人 / 超管）
  → 200 { "ok": true }
  → 400 没有待撤回的转移

GET /api/projects/{id}                      详情里带出 pending 转移
  → 新增字段 "pending_transfer": { "id", "from", "to", "created_at" } | null
```

**为什么把 pending 挂在项目详情里而不是新开一个「我的待办」接口**：
被转让人必然是本项目成员（T3），他打开项目就该看到——不必为一条极低频的东西再加一次请求。

## 5. 通知

复用 v0.4.26 那套 best-effort 站内信：

| 事件 | 收信人 | 正文要点 |
|---|---|---|
| 发起 | 被转让人 | 「X 想把项目「P」的主持人转给你」+ 项目直达链接 |
| 接受 | 原主持人 | 「Y 已接受，你已交出主持人」 |
| 拒绝 | 原主持人 | 「Y 拒绝了」——不说他不会知道，请求会静静躺着 |
| 撤回 | 被转让人 | 「X 撤回了转移」——否则他点进去发现按钮没了，以为是坏了 |

## 6. 测试计划

**Rust 单测/契约**（`tests/api_cases.rs`，钉行为而非实现）：

- 待接受期间 owner 不变（T1）
- 同一项目第二条 pending 被拒（唯一索引）
- 非被转让人调 respond → 403；被转让人**离开项目后**再 accept → 400（T5）
- 归档项目不能发起，但已 pending 的能接受（T6）
- 接受后原主持人仍是 admin（T4）

**E2E**：归相位 6 验收那一批，不进合并门禁。

## 7. 不做什么

- **不做「转移给多个候选、谁先点谁得」**：主持人只有一个，多候选只会制造抢椅子；
- **不做超时自动失效**：一条躺着的 pending 不产生任何伤害（owner 没变），
  加个定时任务反而多一处会坏的东西。真嫌烦，发起人撤回即可。
