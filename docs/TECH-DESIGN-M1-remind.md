# 技术设计 · 活动提醒（PRD F2 / F3）

| 项 | 值 |
|---|---|
| 相位 | **4（技术设计）** —— 相位 0 的 PRD §F2/F3 已签核（2026-08-07） |
| 分轨 | **轻量轨**：动 schema + 新接口面，但不新增数据模型、不改权限 |
| 状态 | ★待评审★。下面「开放问题」一节里的四条要 liaoruili 拍板才能进相位 5 |
| 作者 | bot-congrove，2026-08-11 |

---

## 0. 先说清楚：这件事已经做了一大半

动笔前盘了一遍现状，**PRD F3 的「个人全局默认」那一半是完整的**，别重做：

| 已有 | 在哪 |
|---|---|
| `user_prefs.default_remind_minutes` 列 | `migrations/0001_init.sql` |
| `GET/PUT /api/me/prefs` 读写它 | `src/http/me_quota.rs` |
| 设置页的「默认提前提醒」下拉 | `web/src/me-view.tsx`（注释里写着「投递属 M2」） |
| 「谁该收到通知」的唯一推导 | `src/notify.rs::notify_targets`——参会人 + 记录员 + 发起人，减动作发起人，**旁听者不收**（D9） |
| 站内信外发（best-effort，registry 挂了只 warn） | `src/registry.rs::notify` |
| 后台循环的既有范式 | `lib.rs` 里 `cleanup_stale_uploads` / `media_ai::run` 两条 `tokio::spawn` |
| 活动时区列 | `activities.timezone`（存 IANA 名，不存偏移） |
| 「补录」的事实字段 | `activity_participants.notified_at`（ADR-0003） |

**真正缺的只有三块**：单场覆盖、**定时投递**、页面内弹窗。
★所有难题都在第二块★——剩下两块是几十行的事。

---

## 1. 难在哪：这是本仓第一个「到点要发生一件事」的功能

此前所有写操作都由请求驱动：有人点了按钮，才有事发生。提醒不是——
**没有任何请求，到点就得发出去**。而这条平台有两个硬约束把简单做法全否掉了：

- ★**集群无 PVC，pod 随时重启**★（rebuild / restart / promote / 驱逐）。
  内存里的 `tokio::time::sleep_until` 定时器一重启就全丢，而且**丢得无声无息**——
  没有任何地方会报错，只是那些会没人收到提醒。
- ★**副本数不保证是 1**★。今天是 1，但这是部署参数不是契约。
  两个副本各跑一份循环 = 每人收两遍。

所以：**状态必须落 PG，去重必须由数据库保证，而不是靠「我记得我发过」。**

## 2. 方案：到期扫描 + 唯一索引去重

### 2.1 不建新表，把「发没发过」记在参会人行上

```sql
ALTER TABLE activity_participants ADD COLUMN reminded_at timestamptz;
```

★为什么不建一张 `reminders` 待发队列表★（先想了这个，否掉了）：
队列表要解决「改期之后旧任务怎么办」——要么改期时去删/改队列行（两处写，容易漏），
要么发的时候回查活动确认时间没变（那队列行就只是个索引，白存一份）。
而「这个人这场会提醒过没有」本来就是**参会关系的属性**，记在关系行上，
改期时只要清掉这一列，语义自明、没有第二处要维护。

### 2.2 到期判定：一条 SQL 把「该发给谁」算出来

```sql
SELECT p.activity_id, p.username, m.title, m.starts_at
FROM activity_participants p
JOIN activities m ON m.id = p.activity_id
JOIN activity_types t ON t.id = m.type_id
LEFT JOIN user_prefs u ON u.username = p.username
WHERE p.reminded_at IS NULL
  AND p.kind <> 'observer'                       -- 旁听者不收（D9，与 notify_targets 同源）
  AND p.status <> 'declined'                     -- 拒绝了的人不必再提醒
  AND m.status = 'active'                        -- 取消的会不提醒
  AND p.notified_at IS NOT NULL                  -- ★补录跳过★，见 §3.1
  AND COALESCE(m.remind_minutes, u.default_remind_minutes) IS NOT NULL   -- NULL = 不提醒
  AND m.starts_at - make_interval(mins => COALESCE(m.remind_minutes, u.default_remind_minutes)) <= now()
  AND m.starts_at > now()                        -- ★已经开始的不补发★，见 §3.2
FOR UPDATE SKIP LOCKED
```

`FOR UPDATE SKIP LOCKED` 是多副本安全的关键：两个循环同时扫，各自锁到不同的行，
**不会同一行发两遍**，也不会互相阻塞。发完在同一个事务里 `UPDATE … SET reminded_at = now()`。

⚠ 单靠 `reminded_at IS NULL` 不够——那是「读时判断」，两个副本可能同时读到 NULL。
所以判据是**行锁**，不是列值。

### 2.3 循环挂在哪

照 `media_ai::run` 的样子，`lib.rs` 里 `tokio::spawn(remind::run(state))`，
**每 30 秒**扫一次。

★为什么是 30 秒而不是更密★：提醒的精度需求是分钟级（「提前 15 分钟」误差 30 秒无感），
而每次扫描是一条带索引的 SQL。更密只是徒增无谓查询。
★为什么不是更疏★：60 秒会让「提前 5 分钟」这档的相对误差到 20%。

配套索引（不加的话每 30 秒全表扫参会人）：

```sql
CREATE INDEX idx_ap_pending_remind ON activity_participants (activity_id)
  WHERE reminded_at IS NULL AND kind <> 'observer';
```

---

## 3. 四个判据（写代码前必须先定死）

### 3.1 补录不发提醒 —— ★它是 §3.2 免费给的，不需要单独一条判据★

> ⚠ 本节初稿写的是「判据用 `notified_at`」。**核过代码之后发现那个理由不成立，已订正**——
> 记在这里而不是删掉，因为下一个人很可能想到同一条错路上去。

PRD 要求「补录的活动不发提醒，实现时要显式跳过，否则批量补录会一次炸出一堆无意义的站内信」。

★补录按定义就是「录一件已经发生过的事」，`starts_at` 必然在过去★——
而 §3.2 的 `m.starts_at > now()` 已经把所有过去的活动排除了。所以这条要求**自动满足**，
不需要第二条判据。（F0 也印证：会议根本不许排过去，能补录的只有其他类型。）

那 `p.notified_at IS NOT NULL` 还留不留？**留，但理由是另一个**：

> ★没被通知过的人，不该收到「你的会 15 分钟后开始」★——他自始至终不知道有这场会，
> 突然收到提醒只会让他困惑「什么会？」。这与 ADR-0003 在忙闲那条上的判据同源
> （`activities.rs` 的 freebusy：「没通知过的人不进忙闲，那是凭空占用他的时间」）。

已核实（2026-08-11，不是推测）：
- 写入点两处——建活动时给**发起人**置上（他自己定的时间，不存在不知情）、
  `mark_notified` 在邀请通知**真的发出去之后**给被邀请者置上；
- dev 库现状 10/10 行有值，说明这条路径是活的、不是死字段。

### 3.2 错过的窗口不补发

pod 停了两小时再起来，那两小时内该发的怎么办？**不发**（`m.starts_at > now()` 那一条）。

理由：提醒的价值全在「提前」。会已经开始了再收到「15 分钟后开会」，
不只是没用，是**误导**。宁可漏，不可错。

### 3.3 改期要清掉提醒记录

`activities.rs::update` 里已经有「改了时间就把所有人的答复清回 pending」那段，
提醒重置**加在同一处**：

```sql
UPDATE activity_participants SET reminded_at = NULL WHERE activity_id = $1
```

★放在同一处不是省事，是因为它们是同一件事的两面★：时间变了，之前基于旧时间做出的
一切（答复、提醒）都作废。分开写迟早有一处漏掉。

### 3.4 时区：★不需要参与运算★

`starts_at` 是 `timestamptz`，`now()` 也是，两者相减得到的间隔与时区无关。
`activities.timezone` 只在**显示**时用（E1/E2 那批的事）。
★这里显式写下来，是因为「提醒 + 时区」看起来像个坑，而它其实不是——
下一个读这段代码的人不必再想一遍。★

---

## 4. 接口面变更

| 方法 | 路径 | 变更 |
|---|---|---|
| POST | `/api/activities` | 请求体新增可选 `remind_minutes: int \| null` |
| PUT | `/api/activities/{id}` | 同上 |
| GET | `/api/activities/{id}` | 响应新增 `remind_minutes` |

★非破坏性★（新增可选字段），`scripts/api-check.sh` 应当直接通过，不必进
`docs/openapi-breaking.txt`。

值域与 PRD F3 一致：`不提醒 / 5 / 15 / 30 / 60 / 1440`，另加「自定义」。
`NULL` = 跟随个人默认；**显式的「不提醒」怎么表达见开放问题 ①**。

## 5. 页面内弹窗（F2 的后半截）

前端每 60 秒轮询一次新接口 `GET /api/me/reminders?since=<ts>`，回「刚发给我的提醒」，
有则 `notification.open()` 弹一个。

★不做 SSE/WebSocket★：为一个分钟级、低频的提醒拉一条长连接不划算，
而且长连接在网关后面还要处理重连、心跳、pod 重启断流——那是比这个功能本身更大的工程。

## 6. 测试计划

**纯函数**（`node --test`）：无——这次的逻辑几乎全在 SQL 里。
★这本身是个信号★：判据在 SQL 里意味着**只有 PREPARE 闸和真库集成测试挡得住它**，
而这正好撞上 O2（CI 还没有测试 PG）——所以下面这几条要如实标注为人工验证。

| # | 用例 | 期望 |
|---|---|---|
| 1 | 会在 20 分钟后开始，我的默认是 15 分钟 | 5 分钟后才发；此刻不发 |
| 2 | 同一场会连扫两轮 | ★只发一次★（`reminded_at` 已写） |
| 3 | 两个副本同时扫 | 只发一次（`SKIP LOCKED`） |
| 4 | 补录：`notified_at IS NULL` | 一条都不发 |
| 5 | 改期到更晚 | `reminded_at` 被清，新时间到点重新发 |
| 6 | 活动取消 | 不发 |
| 7 | 旁听者 | 不发（与 `notify_targets` 一致） |
| 8 | 已 declined 的人 | 不发 |
| 9 | 单场设了 `remind_minutes`，个人默认不同 | ★按单场的★ |
| 10 | 单场 NULL、个人默认也 NULL | 不发 |
| 11 | pod 停 2 小时后重启，期间有该发的 | ★不补发★（§3.2） |

★用例 2/3/11 是这个功能真正的风险所在★——它们全是「不该发却发了」或
「发了两遍」，而这类错误**用户会直接看到**，不像漏发那样悄无声息。

---

## 7. 开放问题（★这四条不关闭，不进相位 5★）

1. **「不提醒」和「跟随默认」怎么区分？**
   两者在 `remind_minutes` 上都想用 NULL。三个选项：
   (a) 用 `0` 表示不提醒；(b) 加一个 `remind_off boolean`；(c) 不支持单场关闭，
   要关就把个人默认关掉。
   ★我倾向 (a)★——`0` 读作「提前 0 分钟提醒」本来就无意义，拿它当哨兵不会和真实值撞；
   (b) 多一列多一处要同步，(c) 会让「明天那场我不想被吵」做不到。

2. **默认值该是多少？** 现在 `default_remind_minutes` 没有行 = 不提醒，
   于是**所有存量用户默认收不到任何提醒**——功能上线等于没上线。
   要不要给新用户一个默认（如 15 分钟）？★这是产品判断，不是技术判断。★

3. **一场会只提醒一次，还是允许多档？**（手机日历常见「提前 1 天 + 提前 15 分钟」）
   本设计按**一次**做。多档要把 `remind_minutes` 变成数组、`reminded_at` 变成
   「已发过哪几档」，复杂度上一个台阶。PRD 没要求，我按一次做，**但先问一句**。

4. ~~`notified_at` 到底在哪些路径上写入？~~ ★已自行核实并关闭★（见 §3.1）：
   写入点两处、dev 库 10/10 行有值。核的过程顺带推翻了初稿里「补录靠 notified_at 跳过」
   这个说法——**它其实是 §3.2 免费给的**。留档在 §3.1，因为那是条很自然的错路。

---

## 8. 实施顺序

1. ~~先核 `notified_at`~~ ✅ 已在相位 4 内核完（见 §3.1），并因此订正了一条判据；
2. schema：加 `remind_minutes` + `reminded_at` + 索引，`--pre` 跑 PREPARE 闸看影响面；
3. 后端：`src/remind.rs` + `lib.rs` 挂循环 + 改期处清 `reminded_at`；
4. 接口：三处加字段 + apidoc + 用例；
5. 前端：发起/编辑表单的单场下拉、轮询弹窗；
6. 人工验收：上表 11 条，★逐条标注「人工验证」而不是「CI 绿」★（O2 未解决）。
