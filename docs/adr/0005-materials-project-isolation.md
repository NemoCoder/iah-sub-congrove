# ADR-0005：项目分 `team` / `materials`，隔离靠 `effective_role` 单点否决

**状态**：已定 · **实施**：M0-1（建表）+ M0-2（判定） · **性质**：★「权」路径★

## 决定

1. `projects.kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','materials'))`；
2. 每人至多一个材料区 —— `CREATE UNIQUE INDEX idx_proj_materials ON projects (owner) WHERE kind='materials' AND deleted_at IS NULL`；
3. **隔离在 `perm.rs` 单点否决**：材料区**只有 owner 有任何角色**，别人一律无角色。

## 为什么不是「按操作白名单」

v3 的做法是在 `require_role` 内部按 `op` 走白名单。★它不成立，两个硬理由★：

1. `require_role(pool, id, project_id, need: Role)` **没有 `op` 参数**（39 处调用点）；
   而要放行的「回收站还原」与要拦的「上传 / 建文档 / 改名 / 删除」**在 `need` 上完全一样**（都是 `Editor`）
   —— 用现有签名区分不了；
2. ★7 个项目写入口根本不经 `require_role`★，走的是 `require_owner`（它不查 `kind`）：
   `PUT /projects/{id}`、`DELETE /projects/{id}`、`PUT .../members`、`POST .../transfer`、
   `POST .../transfer/respond`、`DELETE .../transfer`、`POST .../archive`。
   其中 `transfer` 会**把材料区连同配额转给别人**。

**单点否决**避开了这两条：判定放在**所有路径都必经的** `effective_role`，新增入口自动被覆盖。

## 实现上的两个坑（都是评审抓到的，写下来别再犯）

**① 否决必须在 `merge` 之前单独判。**
`merge` 是 `grants.into_iter().flatten().max()` —— ★它设计上就忽略未知值★，
把 `"BLOCK"` 混进 `Role::parse` 的结果里会被静静吃掉：

```rust
if rows.iter().any(|r| r == "BLOCK") { return Ok(None) }   // ← 必须在 merge 之前
Ok(merge(rows.iter().map(|r| Role::parse(r))))
```

**② `require_owner` 的超管短路在 `SELECT` 之前。**
现在是 `if is_super_now(...) { return Ok(()) }` 然后才查 owner —— 材料区判据挂在后面等于没挂。
必须先无条件 `SELECT kind, owner`，把 materials 的判据放在超管短路**之前**。

★同一节里同类错犯了两次★（先是 `merge` 吃掉 BLOCK，再是 `require_owner` 被短路绕过），
所以这两条各配一条单测，改回缺陷前必须变红。

## 2026-08-09 补：写闸也收口了，位置在 `require_role`

M0 只落了「**别人**对材料区零角色」这一半。上线 J0（个人活动的材料落材料区）当天补上另一半：

1. ★写闸★放进 `require_role` 里 `need >= Editor` 的那一段（与 D17 的归档只读并排）：
   `kind='materials'` 一律 Forbidden。这正是本文说的「新增入口自动被覆盖」——
   12 个 `/projects/{id}*` + 16 个 `/items/{id}*` 一次盖住，以后新加的写接口也自动进来。
2. 唯一放行的两条写路径（活动材料的**上传**与**删除**）走新的
   `perm::require_material_write`：普通项目里它就等于 `require_role(Editor)`，
   材料区里判据换成「这是我自己的区」。★例外看得见、数得清★。
3. `decide_owner` 收严成「材料区**谁都不行，连主人也不行**」——
   `require_owner` 管的是改名 / 拉成员 / 转移主持人 / 归档 / 删项目，
   PRD §J1 那张表里这些对材料区全是 ❌（尤其 transfer 会把配额一起带走）。

同期 PRD §J1「不出现在项目列表里」那一行被 liaoruili 改判：**要出现，标「系统 · 只读」**。
理由与做法见 PRD §J1 的「2026-08-09 改判」小节。

## 不管什么

不管材料区的 UI 入口（M1：「我的活动材料」`/api/me/materials`）；
不管跨项目复制（M1）。
