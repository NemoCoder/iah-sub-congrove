# 全量代码审计 · checkpoint v0.4.84（2026-08-09）

| | |
|---|---|
| 范围 | ★全部代码★，不是 diff（2026-08-09 liaoruili：「审计不是审变动的代码，应该审计所有代码，每个 checkpoint 的完整代码」） |
| 规模 | Rust 9,189 行（24 文件）+ 前端 7,068 行（37 文件）+ 迁移/门禁脚本/e2e 1,687 行 |
| 方法 | **8 路独立视角并行**，互不知道对方在看什么；结论由我逐条回代码复核后才进本文档 |
| 提示词纪律 | 问的是「有没有**会导致错误行为 / 数据损坏 / 权限绕过 / 门禁失效**的缺陷」，★不是「找不足」★（被要求找 gap 的评审者必然报出 gap） |
| 严重度阈值 | **阻塞** = 错误行为 / 数据损坏 / 权限绕过 / 门禁失效；**记 issue** = 其余，记账不卡流程 |

> **本文档是 checkpoint 之间可对比的账本**：下一次审计要能看出「上次遗留的修了没有、新发现是不是在收敛」。
> ★凡是能机械化的发现，当场写成门禁★——那样下一次全量审计里这一类是免费的，
> 否则「每个 checkpoint 重读 18k 行」第三次就会退化成走过场。

---

## 一句话结论

结构性纪律做得好（事务该包的都包了、先查后写都有部分唯一索引兜底、软删过滤在 v0.3.55 那批里补得很干净、
perm.rs 的单点推导与超管模式的「资格 vs 特权」拆分**没有一处用反**）。
**风险高度集中在同一个根因**：

> ★`cargo test` 一个 HTTP handler 都没跑过。★
> `tests/api_cases.rs` 自陈「本文件不发请求」，只做 apidoc↔用例清单的自校验；
> 真正的单测只覆盖纯函数。于是**状态码选择层、请求字段上的一切算术、
> 上传→S3→播放→worker 整条管线、前后端契约**——在五道机械门禁上是**零覆盖**。

七条阻塞里有五条落在这个盲区。这就是平台 **O2（CI 挂测试 PG）** 卡着的代价，现在它具体到条了。

---

## 阻塞（7 条，全部经我回代码复核 CONFIRMED）

### A1 · 上传接口不校验 `activity_id` 归属 —— 可往**任何人的活动**注入材料
`src/http/items.rs:861`（判权）/ `:894`（写入）；读出面 `src/http/activities.rs:981`

判权判的是**路径上的 `pid`**，写进库的却是**请求参数里的 `activity_id`**，两者之间一次一致性校验都没有
（`items.rs` 全文 `activity_projects` 出现 **0** 次）；读出面 `WHERE activity_id = $1` **不带项目过滤**。

**失败场景**：任何登录用户建一个自己的项目 P（自动 admin）→
`POST /api/projects/P/upload?activity_id=<别人组会的 id>&is_recording=true` →
文件出现在对方活动的材料/录制里、署我的名；**对方删不掉也改不了**（那两条接口判的是 item 所属项目，
他们在 P 里没角色 → 404）；`is_recording=true` 时还改写对方的时长统计（`max(duration_sec)` 口径）。
材料区同理——每个人都能从自己的材料区往任意活动注入。

**门禁为什么抓不到**：SQL 完全合法；handler 零测试覆盖。

### A2 · `blobs/<sha>` 可被**客户端申报的哈希**占位 → 静默内容替换 + 秒传投毒
`src/http/media.rs:170`（key 取自申报 sha）/ `:305`（complete 覆盖）/ `:449`（verify_sha 只改行不改对象）；
受害侧 `src/http/items.rs:914`

★两路独立视角分别报出同一条★。直传的 key 直接用客户端申报的 sha；而流式上传写着
「对象已存在就直接引用（哈希是我们自己算的，内容必然一致）」——**这个前提被前一条打破**。

**失败场景**：先 `begin` 申报某份文件的 sha=H（此时 `blobs/H` 不存在）→ 传任意字节 → complete。
之后真正拥有该文件的人流式上传（服务端自算得 H）→ `exists(blobs/H)` 为真 → **跳过复制直接引用** →
落成 `sha_verified=true` → 成为合格秒传源继续扩散。全链路无报错。
`verify_sha` 拦不住：它只把攻击者**自己那一行**的 sha 改成真值，对象不动、不改名、不打标记。

⚠ 同族第二半：complete 只对**字节数**，`verify_sha` 发现哈希不符时只 `warn!` 然后照样
`SET sha_verified = true` ——★把「内容和客户端算的不一样」这个强信号改写成「已核验」★。

### A3 · 旁听者打开公开活动 → 详情页**整页白屏**
`src/http/activities.rs:280`（Observer 返回扁平对象，无 `activity` 外层）vs `web/src/activity-detail.tsx:120`

`const m = d.activity` 下一行即 `m.status` → TypeError。上方 `if (err || !d)` 拦不住（`d` 是真对象）。
触发路径：日程页「公开活动」广场点标题、站内信 `?activity=` 深链、旁听后从日历点进去。
**门禁为什么抓不到**：E2E 断言的是扁平形状（把契约钉成了扁平），`tsc` 认定 `activity` 必存在。

### A4 · 「占忙闲」复选框**必然 422** —— A3 说的「自建类型唯一的开关」从来没工作过
`web/src/activity-types-view.tsx:69`（只送 `busy_default`）vs `src/http/activity_types.rs:87`（`name: String` 不是 Option）

axum 的 `Json` 提取器在进 handler 之前就 422，响应体是纯文本 → 用户看到裸的「422」。
前端注释写着「后端 name 是 COALESCE 更新，不传就保留」——那描述的是 SQL，而 serde 在 SQL 之前就把请求毙了。

### A5 · 删项目是**硬删除**，而契约、文档、20+ 处 SQL 都在声称软删除 ★需 liaoruili 拍板★
`src/http/projects.rs:310` = `DELETE FROM projects`（FK 级联清掉 items/版本/成员/分享/纪要/转写，S3 对象也删）

`projects.deleted_at` 这一列**全仓从没被写过一次**（0 处），却有 20+ 处 SQL 在过滤它；
`apidoc.rs:79` 与 `docs/openapi.json` 对外宣称「删项目(**软删除**)」。**不是回归，是从没实现**。
没有回收站、没有 30 天窗口、没有还原入口。★两种语义各写了一半，本身就是下一次事故的许可证。★

**两条路二选一**：① 补上真软删 + 项目回收站（连带修 A5b）；② 承认硬删，把契约文案 + 那两列 + 20 处过滤一起清掉。

> **A5b（依附 A5）**：`perm.rs:116` 的三支里，只有**否决**那一支带 `projects.deleted_at IS NULL`，
> 两条**授权**支（super_now、成员表）都不带；`require_role` 的归档闸也是「查不到行就整段跳过」。
> 方向是 **fail-open**：A5 一旦改成真软删，项目删进回收站后成员照常读写，
> 且材料区的 BLOCK 消失 → 超管拿到别人「我的活动材料」的完整读权限（正是 §J1c 要防的）。
> 同族的 `require_owner` / `require_material_write` 是 fail-closed —— **两种写法并存本身就是坑**。

### A6 · D10「活动只读区」的**写入方向**没有执行者 —— 可以往活动文件夹里塞东西
`src/http/items.rs:350`（`check_parent`）/ `:368` create / `:850` upload / `:437` move

`check_parent` 只验「存在 / 是 folder / 同项目 / 未软删」，**从不问父节点是不是活动文件夹**；
`items.rs` 里 `activity_id` 的守卫只有 2 处（`:433` 改名移动、`:491` 删除），**都只看被操作项自己**。

于是普通 editor 可以在项目树里进入 `📁 2026-08-09 组会` 直接上传/新建，或把任意文件移进去。
产生的行 `activity_id = NULL` → 不受那两道守卫约束（可继续改名删除），却坐在活动的只读区里；
活动页按 `activity_id` 过滤看不到它们，项目树里看得到。
前端也没兜住（`readOnly` 只看 `archived_at || kind==='materials'`，与当前目录无关；移动目标树只防环）。

★这是 2026-08-09 那次修复没修完的另一半：我堵了「把材料拿出去」，没堵「把东西塞进来」。★

### A7 · 19 处 `CREATE TABLE IF NOT EXISTS`，直接违反 ADR-0001 写死的 DDL 要求
`migrations/0001_init.sql`（24 个建表里 19 个是 `IF NOT EXISTS`）vs `docs/adr/0001-...:52`

ADR 原文：「★新的 `0001_init.sql` **不许用** `CREATE TABLE IF NOT EXISTS`★，一律裸 `CREATE TABLE`。
`IF NOT EXISTS` 会在「库没清干净」时**静默建出错误 schema**，裸写则**响亮失败**」。
只有 ADR 之后新加的 5 张是裸写——**规则被理解过，只是没回头改存量**。
清库五条只要漏一条（首次部署就漏过），迁移仍报成功、pod 起得来，而 schema 是错的。
这道「响亮失败」的保险现在 19/24 是关着的。

---

## 记 issue（按价值排序，节选）

| # | 位置 | 问题 |
|---|---|---|
| I1 | `media.rs:526/572/472` | **转写稿 / AI 摘要 / 字幕**三条读路径漏 `deleted_at IS NULL` —— 删进回收站的录音，逐字稿全文照样读得到（v0.3.55 补 11 处之后新增的面） |
| I2 | `perm.rs:228` + `items.rs:511/535/583` | **材料区回收站完全不可达**：删得掉、看不见、还不了、配额还占着，30 天内既拿不回也腾不出 |
| I3 | `auth.rs:492` | `/auth/login?return=//evil.com` **开放重定向**（过滤只挡了控制字符，没挡协议相对 URL）。一行能修 |
| I4 | `activities.rs:391` | 活动级 `no_share` 打开**不撤销存量链接**——项目级那条有连带撤销，活动级一条都没有，开关是空的 |
| I5 | `share.rs:359` | 公开分享面**完全不看** `no_download`——`items::download` 说它「对所有角色生效」，而非成员反而下得到 |
| I6 | `items.rs:943` | 非录制的视频材料也被自动排队转写（`is_recording` 根本没看），违反 D5，还排在真录屏前面 |
| I7 | `media.rs:406` | `/play` 的 **6 小时预签名直链**可转发给任何人，不随踢出项目/删除/`no_download` 失效 |
| I8 | `media_ai.rs:94` | `reclaim_stale` 无条件回收 `running` → 滚更时同一录屏**转写两遍**（双份 GPU/LLM + 通知两次） |
| I9 | `media_ai.rs:66/496` | worker 单线程串行且 `run_ffmpeg` 无超时 → 一个卡住的任务**堵死整个队列**，只有重启能恢复 |
| I10 | `media_ai.rs:641` | 长会（>8000 字 ≈ 25 分钟）走 `condense`，而 map 提示词**没要求保留时间戳** → 「分段大纲」时间戳被抹掉后由模型编造，前端还渲染成**可点的跳转** |
| I11 | `media.rs:244` | `/media/part` 把 32MiB body **再拷一份** → 峰值 ≈64MiB/请求，无并发上限，512Mi 档下可被打到 OOM |
| I12 | `media.rs:424` 等 6 处 | 用户输入错误回 **500 而不是 400**（重复点 complete、非法 part_number、`expires_days` 溢出…） |
| I13 | `require_owner` / `activity_types.rs:180` | 完全无授权回 **403 而不是 404** → 按自增 id 扫一遍就是**存在性预言机**，破的是 perm.rs 自己立的口径 |
| I14 | `projects-view.tsx:974` | 「转主持人」文案承诺「随时可撤回」，**撤回入口全仓不存在**（后端接口有）→ 转错人只能求对方拒绝 |
| I15 | `activity-detail.tsx:316` | 项目 viewer 在活动页看到上传/改名/删除/分享四个入口，点了全 403（判据用了「有没有关联项目」） |
| I16 | `activity-detail.tsx:616` | 「临时参会人（能参会、看不到材料）」这个选项**后端恒忽略**（`kind` 写死 attendee）——界面承诺的权限约束不存在 |
| I17 | `activities.rs:1204` | 采纳改期改了时间，**没同步活动材料文件夹名**（`update` 那条有）→ 名字永久错着且谁都改不了 |
| I18 | `activities.rs:1459` | 「我主持的项目」把系统建的「我的活动材料」算成一个项目（缺 `kind <> 'materials'`） |
| I19 | 14 处注释 + `apidoc.rs:195` | 「忙闲按**项目可见性**分流」这条已被 ADR-0002/A4 推翻的前提还在断言，**其中一处在对外契约里**（用户以为私有项目的会不占别人忙闲，实际占） |
| I20 | `items.rs:3` / `projects.rs:287` | 内容寻址**之前**的模型仍写在文件头注与 doc comment 里——正是造成三次数据损坏事故的那句原话，代码全修了，源头那句还在 |
| I21 | `me_quota.rs:63` + `apidoc.rs:58` | 注释与**对外契约**都说「没传的字段保留」，代码是**整对象替换** → 按契约只送一个字段的客户端会静默清空另一个 |
| I22 | `PERMISSIONS.md` / `DESIGN.md` / `README.md` | 整篇建立在已删除的「组」模型上，且教人配一个**已不被读取**的变量名（`CONGROVE_SPACE_CREATORS`）→ 照文档配 = 静默 fail-open |
| I23 | `perm.rs:192` | 归档闸自称「覆盖了全部写入路径」，而**整个活动模块**（10 个写接口）走 `require_activity_host` 不经 `require_role` → 归档项目仍可改时间、拉人、写纪要、发言 |
| I24 | `apidoc.rs:381` | 「少写一条多写一条就红」这条断言**弱于宣称**：`registered()` 只抽路径不抽方法，已有路径上加一个方法不补文档，测试不会红（今天 95↔95 无漂移） |

---

## ★发现即门禁★：本轮可机械化的

| 发现 | 变成什么闸 | 成本 |
|---|---|---|
| A7 | `grep -c "CREATE TABLE IF NOT EXISTS" migrations/` 必须为 0 | 一行，可进 CI |
| A2 / A1 | 集成用例（要 O2 的测试 PG）：①complete 后真实 sha ≠ 申报 sha 必须报错；②`blobs/X` 已被引用时第二个 begin 不得落同一 key；③`activity_id` 必须属于本项目 | 卡 O2 |
| I1 | 「读 items/transcripts/summaries 的 SQL 必须带 `deleted_at IS NULL`」静态检查 | 半天，可进 CI |
| I24 | `registered()` 改成按 `method+path` 比对 | 十分钟，已在 cargo test 里 |
| 特权侧不许直接读 `is_super` | `--pre` 里 `RENAME COLUMN is_super` 跑 PREPARE，报红的必须全是资格型 | 已验证可行，脚本化即可 |

---

## 下一个 checkpoint 要带着看的

- 本轮**阻塞 7 条**的修复状态（修了 / 没修 / 变成了门禁）
- 记 issue 里未处理的是否在增长（增长 = 在欠债，不增长 = 在收敛）
- ★人工审计的部分有没有变小★——这是判断这套做法有没有退化的唯一硬指标
