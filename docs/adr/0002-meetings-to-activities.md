# ADR-0002：「会议」→「活动」，引入活动类型与忙闲开关

**状态**：已定 · **来源**：PRD v0.5 A1/A2/A3/A5、O4 · **实施**：M0-1 ~ M0-4

## 决定

1. `meetings` → `activities`（连同 `meeting_*` 全部关联表、API 路径、前端）；
2. 新增 `activity_types`：**一条活动必须有类型**（`type_id NOT NULL`）；
3. 类型带三个能力位：`has_minutes` / `needs_project` / `busy_default`；
4. 活动自己带 `busy`，**由用户逐条控制**，默认取类型的 `busy_default`。

## 为什么

「会议」这个词把两件事绑死了：**必须有纪要**、**必须关联项目**、**必然占忙闲**。
而 v0.5 要装下「个人日程」这类东西 —— 它三条都不该有。
与其加一串布尔开关，不如把「这是哪种活动」提成一等概念，开关挂在类型上。

**预置两个类型**：

| 名字 | has_minutes | needs_project | busy_default |
|---|---|---|---|
| 会议 | true | true | **true** |
| 个人日程 | false | false | ★**false**★ |

★`busy_default=false` 是 liaoruili 2026-08-08 拍板的（O4）★，判据是
**「占忙闲 = 影响别人」，而会议本来就是多人的事、个人日程本来不是**。想占忙闲自己勾。

## 三条约束

- ★**预置行永不 DELETE**★：`activities.type_id` 是 NOT NULL 外键，删了 = 历史活动失去类型名。
  类型下线走**软删**（`deleted_at`），历史照常显示名字（PRD L1）。
- 自建类型的名字不得与预置重名 —— 唯一索引建在 `(COALESCE(owner,''), name) WHERE deleted_at IS NULL`。
- 自建时**只开放 `busy_default` 一个开关**（A3）；`has_minutes` / `needs_project` 是系统语义，不给用户改。

## 否掉的做法

**在 `activities` 上直接加一串布尔**（`is_meeting` / `need_project` / …）。否掉是因为
每加一种活动就要改表和改所有判定分支，而类型表把它变成加一行数据。

## ★活动自己的 `visibility` 保留，项目的删掉★

这两个同名字段是**两回事**，M0 只删项目那个（配额与可见性都挪走了，见 ADR-0004/0005）。
判定影响面**不靠人数**，靠：

```bash
scripts/sql-prepare-check.py --pre <(echo "ALTER TABLE projects DROP COLUMN visibility;")
```

## 不管什么

不管旧路径的兼容层 —— **M0 不留兼容层**（PRD 明确，v0.5 是重构不是演进）。
接口的破坏性变更由 `scripts/api-check.sh` 逐条声明在 `docs/openapi-breaking.txt`（实测 19 条）。
