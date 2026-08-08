-- 0001_init:congrove 全量 schema。
--
-- ★2026-08-06 第二次重建★:用户决定本版完全重构(知识库 → 项目 + 活动协同),
-- 并把 dev/prod 的库与 S3 桶一起删干净下线 —— 没有任何实例的 `_sqlx_migrations` 里还留着记录,
-- 这是「只增不改」唯一可以破例的时刻。于是把 0001~0006 六个文件连同本次重构压成这一份完整 schema
-- (列一个不少,各自的「为什么」都保留在下面的注释里)。上一次破例是 2026-08-05。
--
-- ⚠ 纪律恢复:从这一版起**只增不改**。sqlx::migrate! 按校验和核对,
-- 改动**已经应用过**的文件 = 所有实例启动直接失败(不是跳过、不是告警,是起不来)。
-- 之后任何 schema 变更一律开 0002、0003… 写 ALTER,并在文件头写清「这次加了什么、为解决什么」。
--
-- 本版相对上一版的三条结构性变化(依据 docs/PRD-activities.md 的 D0/D3/D12):
--   ① 「空间」重构为「项目」:spaces → projects,新增唯一主持人 owner 与 visibility。
--   ② ★删掉 groups / group_members★:权限**只到具体的人**,不再有「按组授权」这一层。
--      有效权限因此从 max(直接授权, 所属各组授权) 简化为「查一次成员表」。
--   ③ 新增活动模块:activities / 参与关系 / 讨论 / 纪要。

-- 身份:登录即 upsert;preferred_username 为主键(决策 A:全平台一致的用户标识,
-- citeroot/textleaf/registry 全都认它)。sub 仅记录备查,不作键。
CREATE TABLE IF NOT EXISTS app_user (
  username   text PRIMARY KEY,
  sub        text,
  name       text,
  email      text,
  is_super   boolean NOT NULL DEFAULT false,   -- 全局超管;bootstrap 走 CONGROVE_SUPER_USERS 白名单
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz
);

-- ── 项目(原「空间」)与成员 ──────────────────────────────────────────────
-- 项目是组织的基本单位:资料、活动、权限全挂在它下面。
--
-- ★可见性规则(D3/R1)★:**此刻是成员 ⟺ 看得到本项目全部资料**(含他加入之前的历史);
-- 移出即失去全部(**含他本人参与过的活动**)。权限是「当前状态的函数」而非「历史事件的累积」。
--
--   ★项目没有 visibility★(M0-1 删):它原本兼着两件**正交**的事 ——「内容给谁看」与
--   「会不会占别人的忙闲」。后者已挪到**活动自己的** `busy`(PRD A4,用户逐条可控);
--   前者由成员身份唯一决定(D3)——资料、项目名、成员名单一律只有成员能看,本来就没有第二档。
--   合在一个字段里的后果是「私密项目的会不占忙闲」成了默认,而「我这个时段没空」
--   本来就不泄露任何内容。
--                    ★不叫「团队/个人」★:那个命名把人数与隐私绑死,表达不了「多人但不公开」。
--   owner       (D0):唯一主持人。只有他能指定/撤销管理员、转移主持人、删除项目。
--                    转移需**对方接受**才生效;主持人须先转移才能退出;销号则自动转最早的管理员。
--   quota_bytes     :每项目配额,默认 10GiB;超管可调。单文件不限大小,真正的闸是这个总量。
--   no_download     :只读成员禁止下载原件;在线阅读/播放不拦(能播就能录屏,拦了只会逼人什么都干不了)。
--   no_share        :禁止对外分享。★开启时须连带撤销本项目已有的公开链接★,否则这个开关是空的。
--   hotwords        :本项目的转写术语表(空格分隔)。落到项目而不是全局——人名与专业词天然按组不同。
--                    ⚠ 平台侧是拼音模糊匹配的确定性替换,词表乱填会把正常的字改坏。
CREATE TABLE IF NOT EXISTS projects (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- ⚠★没有 visibility★（M0-1 删）：它原本兼着两件正交的事 ——「内容给谁看」与「会不会占忙闲」，
  --   而后者已经挪到活动自己的 `busy`（PRD A4）。内容可见性由项目成员身份唯一决定（D3）。
  owner        text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  quota_bytes  bigint  NOT NULL DEFAULT 10737418240,
  no_download  boolean NOT NULL DEFAULT false,
  no_share     boolean NOT NULL DEFAULT false,
  hotwords     text    NOT NULL DEFAULT '',
  deleted_at   timestamptz,
  deleted_by   text,
  -- 项目分两类(ADR-0005):team = 正常协作项目;materials = ★每人一个的私人材料区★。
  -- 材料区**只有 owner 有任何角色**,别人一律无角色 —— 隔离在 perm.rs 单点否决,不靠逐个入口设防。
  kind         text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','materials')),
  -- 归档(原 0002):归档 = 只读封存,不是删除。★排在最后是有意的★——
  -- 老库里这两列是 ALTER ADD COLUMN 加的,PG 只能加在表尾且不支持调列序,
  -- 写在中间会让新旧库列序不同(schema 门禁看得见)。
  archived_at  timestamptz,
  archived_by  text
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner);
-- 列表默认只看「活着且没归档」的(原 0002)
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects (id) WHERE archived_at IS NULL AND deleted_at IS NULL;
-- ★每人至多一个材料区★:在**库里**堵死,不靠应用层先查后插(那中间有并发窗口)。
-- ⚠ 必须是**部分唯一索引**(带 WHERE),不能写成 UNIQUE 约束 —— 约束不支持 partial,
--   而不带 WHERE 的话每人就只能有一个项目了。
CREATE UNIQUE INDEX idx_proj_materials ON projects (owner) WHERE kind = 'materials' AND deleted_at IS NULL;

-- 项目成员:★只到具体的人,没有「组」这一层(D12)★。
-- 角色展示名:admin=管理员(副手) / editor=成员 / viewer=只读成员;主持人在 projects.owner 单列。
-- ⚠★绝不加「授权生效时间」之类的字段★:那会把 D3 的「当前状态函数」退回「历史累积」,
--   直接违反 R1「加入即可见全部历史」。
CREATE TABLE IF NOT EXISTS project_members (
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  username   text   NOT NULL,
  role       text   NOT NULL CHECK (role IN ('viewer','editor','admin')),
  added_by   text   NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, username)
);
CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members (username);

-- ── 活动 ────────────────────────────────────────────────────────────────
-- ★活动必须关联至少一个项目★(应用层保证):材料权限来自项目成员身份(D3),
-- 没有项目就没人管得了它的材料。
CREATE TABLE IF NOT EXISTS activities (
  id         bigserial PRIMARY KEY,
  title      text NOT NULL,
  -- 议题与议程。★公开活动时这段对全平台所有人可见(D9)★,所以它是**文本字段**而不是上传的文件
  -- ——传成文件的议程属于「材料」,旁听者看不到,与「旁听者能看议程」的要求相悖。
  agenda     text NOT NULL DEFAULT '',
  organizer  text NOT NULL,
  -- ★记录员:发起活动时必填(D14)★。正式纪要由他按固定模板整理;
  --   AI 转写/摘要只是**给他的原材料**,不是成品。
  recorder   text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  -- ★存 IANA 名而不是固定偏移★:周期活动按偏移展开会在 DST 之后整体漂一小时。
  --   中国无夏令时,但一旦有跨时区参会人就会踩到。
  timezone   text NOT NULL DEFAULT 'Asia/Shanghai',
  location   text NOT NULL DEFAULT '',          -- 线下地点
  online_url text NOT NULL DEFAULT '',          -- 线上活动链接
  -- private=仅被邀请者知道这个会存在;public=全平台可见、可旁听(D9)。
  -- ⚠ 公开**只放开活动元信息**(标题/议程/地点/链接),★材料一律 404★,不因公开而放宽。
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  status     text NOT NULL DEFAULT 'active'    CHECK (status IN ('active','canceled')),
  -- M2 的周期活动(RFC5545 RRULE)。M1 恒 NULL —— 先建列,免得 M2 再动表。
  rrule      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 占不占忙闲（PRD A4，M0-1 加）：★由活动自己决定，用户逐条可改★。
  -- 以前的判据是「有没有关联到公开项目」—— 那把「内容可见」和「时间可见」绑成了一件事，
  -- 于是「私密项目的会不占别人忙闲」这种明显错的行为成了默认。
  -- 默认 true 与旧行为里的「活动」一致；M0-2 起由活动类型的 busy_default 决定初值。
  busy       boolean NOT NULL DEFAULT true,
  -- 实际时长(原 0006):排期是计划,这是事实。统计按事实算。
  actual_minutes integer CHECK (actual_minutes IS NULL OR (actual_minutes > 0 AND actual_minutes <= 24 * 60)),
  actual_by      text,
  -- 活动粒度的材料策略(原 0007):「这次会涉及敏感内容,想让大家能看但不能下载」。
  -- ⚠ 与项目级是**叠加不是覆盖**:两处任一禁了就禁。
  no_download boolean NOT NULL DEFAULT false,
  no_share    boolean NOT NULL DEFAULT false,
  CHECK (ends_at > starts_at)
);
-- 忙闲与日历都按时间窗查,且只关心未取消的。
CREATE INDEX IF NOT EXISTS idx_activities_time ON activities (starts_at, ends_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_activities_organizer ON activities (organizer, starts_at DESC);

-- 活动 × 项目(多对多):一次会可同时讨论多个项目,材料整份进每个关联项目。
CREATE TABLE IF NOT EXISTS activity_projects (
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_mpj_project ON activity_projects (project_id);

-- 参与关系。⚠★这张表不承载任何资料权限(D3)★——它只管「谁被邀请、答复是什么」。
--   kind  : attendee=参会人 / guest=临时参会人(D8,能看时间议程链接,**看不到任何材料**)
--           / observer=旁听者(D9,公开活动的路人,同样看不到材料)
--   status: 四态并列 —— 待定 / 接受 / 拒绝 / **建议改期**。
--           ★「建议改期」不是便利功能★:private 项目的日程对发起人完全隐形,他根本不知道我忙,
--           所以这是私事冲突**唯一的结构化出口**。
CREATE TABLE IF NOT EXISTS activity_participants (
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  username   text NOT NULL,
  -- ⚠ ★没有 guest 档★(原 0005 删掉的):它和 observer 的可见面完全一样,
  --   两个名字装同一件事,只会让判权的人以为有区别。
  kind       text NOT NULL DEFAULT 'attendee' CHECK (kind IN ('attendee','observer')),
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','declined','tentative','counter')),
  counter_starts_at timestamptz,
  counter_ends_at   timestamptz,
  counter_reason    text,
  responded_at timestamptz,
  invited_at   timestamptz NOT NULL DEFAULT now(),
  -- 必到 / 可选(原 0007):冲突检测只对必到的人报警。
  required     boolean NOT NULL DEFAULT true,
  -- ★「这个人有没有被通知过」——存事实,不推导★(ADR-0003)。
  -- NULL = 从没通知过 = 他对这场活动**自始至终不知情**(补录场景,PRD L0b)。
  -- 为什么不用「created_at > starts_at」那种推导:★它会随改期翻转★ ——
  -- 建一场未来的会(不是补录)→ 改到昨天 → 判据翻成「是补录」,而那个人早就被通知过、
  -- 也确实参加了。缺陷在判据本身,不在实现方式,即使「现算不存」也一样翻转。
  notified_at  timestamptz,
  PRIMARY KEY (activity_id, username)
);
-- 忙闲是最热路径:按人 + 时间窗查。
CREATE INDEX IF NOT EXISTS idx_mp_user ON activity_participants (username);

-- 活动讨论区(D13)。两个频道:public(参会人可见)/ private(仅双方)。
-- ★私聊对象只限发起人与项目主持人★,不做任意点对点——否则会长成一个 IM。
-- 聊天记录留在活动详情页,**不进材料**(不占项目目录,权限跟活动走)。
CREATE TABLE IF NOT EXISTS activity_messages (
  id         bigserial PRIMARY KEY,
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  sender     text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('public','private')),
  peer       text,                              -- channel='private' 时的对方
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (channel = 'public' OR peer IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mm_activity ON activity_messages (activity_id, created_at);

-- 线上链接改动历史:开会前十分钟改链接是真实场景,要能追溯「谁何时改成什么」。
CREATE TABLE IF NOT EXISTS activity_link_history (
  id         bigserial PRIMARY KEY,
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  old_url    text NOT NULL DEFAULT '',
  new_url    text NOT NULL DEFAULT '',
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlh_activity ON activity_link_history (activity_id, changed_at DESC);

-- ── 内容 ────────────────────────────────────────────────────────────────
-- 内容项:文件夹/文档/文件/录屏,挂项目下,parent_id 成树。
-- 字节不在这:内容都是 S3 对象(内容寻址 blobs/<sha256>),这里只有元数据
-- —— 无 PVC 铁律下 PG+S3 是唯一真相(DESIGN.md §2.4)。
--   deleted_at/by :★所有删除都是软删除★。删只打标记、S3 一个字节不动;
--                  回收站 30 天后由清理任务 purge。★配额仍计入回收站★,占着空间就该算。
--                  ⚠ 凡是**读内容**的 SQL 都必须带 `deleted_at IS NULL`
--                    (2026-08-06 审计一次补齐 11 处:删进回收站的材料曾能从公开链接下载)。
--   sha256/sha_verified:内容寻址与秒传。★只认 sha_verified 的行当秒传源★——
--                  客户端申报的哈希不可信,否则「申报别人文件的哈希、传自己的内容」
--                  会让真正拥有那份文件的人秒传到错误字节。
--   upload_fp/upload_id:断点续传。指纹 = 大小+改动时间+文件名;upload_id 是 S3 multipart id。
--                  两列只在**未完成**的行(s3_key IS NULL)上有意义,窗口 24h 与清扫任务对齐。
--   upload_key    :★直传期间该用哪个 key★。内容寻址后不能再按 项目/条目 现拼——
--                  分片是按 blobs/<sha> 建的,拼错 key 会让 ListParts 永远失败,
--                  表现为「断点续传每次都静默重传」(v0.3.55 才查出来,此前对所有上传都没生效过)。
--   activity_id    :非空表示这是某次活动的**只读区**文件夹或其中的材料(D10)。
--                  ★只读★:不允许在项目树里对它上传/改名/移动/删除,唯一写入口是活动详情页;
--                  可做的只有 看/下载/复制到自由区/分享。复制出去的副本 activity_id 置空(独立)。
--   is_recording  :★录制 ≠ 材料★。只有它为真的文件会被**转写**、并作为**活动时长**的依据(D5)。
--                  ★判据是「传到哪个入口」,不是「是不是视频文件」★——同一个 mp4,
--                  传进「录制」是这场会的记录,传进「材料」是会上讨论的素材。
--                  不做这个区分,系统就分不清 1.8G 的录屏和 200M 的演示视频哪个代表活动长度。
CREATE TABLE IF NOT EXISTS items (
  id           bigserial PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    bigint REFERENCES items(id) ON DELETE CASCADE,
  kind         text   NOT NULL CHECK (kind IN ('folder','doc','file','video')),
  name         text   NOT NULL,
  s3_key       text,
  size         bigint,
  mime         text,
  sha256       text,
  sha_verified boolean NOT NULL DEFAULT false,
  created_by   text   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  upload_fp    text,
  upload_id    text,
  upload_key   text,
  activity_id   bigint REFERENCES activities(id) ON DELETE SET NULL,
  is_recording boolean NOT NULL DEFAULT false,
  deleted_at   timestamptz,
  deleted_by   text
);
CREATE INDEX IF NOT EXISTS idx_items_live  ON items (project_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_trash ON items (project_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
-- 秒传按 sha 找可读的源;引用计数与孤儿清理按 s3_key 找。
CREATE INDEX IF NOT EXISTS idx_items_sha   ON items (sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_s3key ON items (s3_key) WHERE s3_key IS NOT NULL;
-- 找「我上次没传完的那个文件」:同项目 + 同人 + 未完成 + 指纹。
CREATE INDEX IF NOT EXISTS idx_items_resume ON items (project_id, created_by, upload_fp) WHERE s3_key IS NULL;
-- 活动只读区:按活动列它的材料。
CREATE INDEX IF NOT EXISTS idx_items_activity ON items (activity_id) WHERE activity_id IS NOT NULL;

-- 文档/文件版本历史:S3 内容寻址按 sha256,旧版本天然免费。
-- ⚠ 同一 sha 可能被多行引用(items 当前版 + 多条 item_versions):删对象前必须查引用计数,
--   ★且引用计数要把**软删除的行**也算上★——回收站里的东西还指着同一个对象,
--   现在删掉它,回收站里那份还原出来就是个空壳。
CREATE TABLE IF NOT EXISTS item_versions (
  id         bigserial PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  s3_key     text   NOT NULL,
  size       bigint,
  sha256     text,
  label      text,
  created_by text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_item_versions_item ON item_versions (item_id);

-- 活动纪要(D14)。M3 起用,M1 先建表——建表比事后加列便宜。
-- ★正式纪要是人写的★:记录员对照录制与 AI 参考稿,按**唯一一种通用模板**整理。
-- 字段要通用到能覆盖各类活动,用不上的留空即可,**不为某类活动做特化**(否则第二种模板很快被逼出来)。
--   attendees/observers/absentees:系统带出邀请名单,**记录员核对修改**——这就是「补录实际到场」。
--   todos    :★先当普通文本★,不做结构化任务系统(一旦做成任务就要跟踪/提醒/统计完成率,是另一个产品)。
--   pdf_item_id:点「完成」时经 LaTeX 生成 PDF 存档为一条 items(可下载/分享/进版本历史)。
--              ★内容冻结★:事后改纪要不会悄悄改变已经发出去的那份 PDF。
CREATE TABLE IF NOT EXISTS activity_minutes (
  activity_id  bigint PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done')),
  attendees   text NOT NULL DEFAULT '',
  observers   text NOT NULL DEFAULT '',
  absentees   text NOT NULL DEFAULT '',
  agenda_text text NOT NULL DEFAULT '',
  content_md  text NOT NULL DEFAULT '',        -- 记录员写 Markdown,出 PDF 时转 LaTeX
  resolutions text NOT NULL DEFAULT '',
  todos       text NOT NULL DEFAULT '',
  pdf_item_id bigint REFERENCES items(id) ON DELETE SET NULL,
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);


-- 播放进度:每人每视频记一条,换设备/清缓存都还在(所以不放 localStorage);
-- 独立播放窗与主窗口天然一致。
CREATE TABLE IF NOT EXISTS play_progress (
  username     text   NOT NULL,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position_sec double precision NOT NULL DEFAULT 0,
  duration_sec double precision,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, item_id)
);

-- ── 公开分享 ────────────────────────────────────────────────────────────
-- ★这是全系统唯一绕过项目成员身份的入口★,所以整章 fail-closed:
-- 令牌不存在/过期/超次数/撤销/主项已删 —— **一律 404 不区分**(区分了就成了探测工具)。
CREATE TABLE IF NOT EXISTS share_links (
  token          text PRIMARY KEY,                    -- 32 位十六进制(128 bit,/dev/urandom)
  item_id        bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  -- 提取码存**加盐 sha256**,不存明文。NULL = 不要提取码,链接即可访问。
  -- ⚠ 加盐哈希只防「库被拖走后离线爆破」;提取码本身低熵(常见只设 4 位 = 10^4 种),
  --   ★在线爆破只能靠限速★ —— 见 share_visits.ok 与 20 次/15 分钟的闸。
  code_salt      text,
  code_hash      text,
  expires_at     timestamptz,                         -- NULL = 永不过期
  max_visits     int,                                 -- NULL = 不限次数
  visits         int    NOT NULL DEFAULT 0,           -- 已访问次数(解锁成功才计)
  allow_download boolean NOT NULL DEFAULT true,       -- 关掉就只能在线看,不给原件
  created_by     text   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,                         -- 撤销即失效(保留行,便于审计与统计)
  last_visit_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_share_links_item ON share_links (item_id);
CREATE INDEX IF NOT EXISTS idx_share_links_creator ON share_links (created_by, created_at DESC);

-- 多选分享:一条链接带 N 份内容。主项(share_links.item_id)决定访客页的标题与根目录;
-- ⚠ 取内容仍逐项验「是被分享项之一或其后代」——多选只是把「根」从 1 个变成 N 个。
CREATE TABLE IF NOT EXISTS share_items (
  token   text   NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (token, item_id)
);

-- 访问明细。★只留粗粒度★:IP 只存 /24(v4)或 /48(v6) 前缀、UA 只存 sha256 前 16 位 ——
-- 够看「有多少不同的人访问过」,又不至于把访客的可识别信息攒成一个数据库。
--   ok=false 的行是**提取码输错**的记录,用于限速(20 次/15 分钟)。
CREATE TABLE IF NOT EXISTS share_visits (
  id        bigserial PRIMARY KEY,
  token     text NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  ip_prefix text,
  ua_hash   text,
  ok        boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_share_visits_token ON share_visits (token, at DESC);
CREATE INDEX IF NOT EXISTS idx_share_visits_fail  ON share_visits (token, at DESC) WHERE NOT ok;

-- ── 转写与纪要产出 ──────────────────────────────────────────────────────
-- 录屏分析任务。任务态活在 PG 而不是内存:无 PVC 铁律下 pod 重启即丢内存态,
-- 靠这张表续跑,重启后 reclaim_stale 把 running 打回 queued。
CREATE TABLE IF NOT EXISTS media_jobs (
  id           bigserial PRIMARY KEY,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  stage        text NOT NULL DEFAULT '',   -- 当前阶段中文名,直接给 UI 显示
  progress     int  NOT NULL DEFAULT 0,
  error        text,
  requested_by text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- 同一个视频同时只允许一个在跑的任务(重复点「生成」不会排队堆叠)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_active
  ON media_jobs (item_id) WHERE status IN ('queued','running');

-- 逐字稿。
--   text    :全文(喂 LLM 用)。★标点位置以它为准★——ASR 的 sentence_info 句界不可信。
--   segments:ASR 原始细分段 [{start,end,speaker,text}]。
--   char_ts :**字级时间戳** [[start_sec,end_sec], …]。★按 token 给,不是按字★——
--            英文/数字连写整串算一条(线上实测 16792 条 vs 17338 实字,差 546 全在英文词上),
--            切 token 必须用**分段文本**(全文里英文之间没空格)。它是 46 秒时间轴漂移的解药。
--            ⚠ 平台 asr-funasr v5 起另有 words 字段(逐词 + 秒),边界由模型给、不用反推,
--              接上之后 media_ai 的 token 反推逻辑可以退役。
--   fine    :**重排后**的细分段(realign 的结果)。转写时算一次存这里,
--            /analysis 与 /subtitles.vtt 直接用。
CREATE TABLE IF NOT EXISTS transcripts (
  item_id      bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  text         text NOT NULL,
  segments     jsonb,
  model        text,
  duration_sec double precision,
  created_at   timestamptz NOT NULL DEFAULT now(),
  char_ts      jsonb,
  fine         jsonb
);

-- AI 参考稿:一个录制多种产出(摘要/大纲/决议待办),各存一行,重跑覆盖。
-- ⚠★这不是正式纪要★(D14):它是**给记录员核对整理用的原材料**。
--   正式纪要在 activity_minutes,由记录员按模板写、有明确责任人。
CREATE TABLE IF NOT EXISTS summaries (
  item_id    bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       text   NOT NULL CHECK (kind IN ('brief','outline','decisions')),
  content    text   NOT NULL,
  model      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind)
);

-- 审计:谁改了权限、删了什么。权限变更/删除类操作必录(audit.rs helper)。
CREATE TABLE IF NOT EXISTS audit_log (
  id     bigserial PRIMARY KEY,
  ts     timestamptz NOT NULL DEFAULT now(),
  actor  text NOT NULL,
  action text NOT NULL,
  target text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts);

-- ══════ 讨论区已读位（原 0003）══════
-- ★存「读到哪儿」而不是逐条已读标记★：逐条要为每人 × 每条消息写一行，一场会几百条讨论
--   就是几百行 × 人数，而它唯一的用途是「有没有我还没看的」—— 一个时间戳就答得了。
-- ⚠ 没有记录 = 一条都没读过（而不是全读过）：新人加入项目后能看到历史讨论，
--   若默认全读过，那些讨论就悄悄地永远不会提醒他了。
CREATE TABLE activity_reads (
  activity_id bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  username   text   NOT NULL,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, username)
);
CREATE INDEX idx_mr_user ON activity_reads (username);

-- ══════ 主持人转移（原 0004）══════
-- ★留全部历史而不是只存当前那条★：谁在什么时候想把项目甩给谁、对方拒没拒，是治理事实。
-- 和活动「取消不是删除」同一条道理 —— 真删掉之后没人说得清当时发生过什么。
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
-- ★同一项目同时只允许一条 pending★：并发发起两条会造成「两个人都以为自己接手了」，
-- 而 owner 只有一个 —— 后点的那个人会莫名其妙地什么都不是。
-- 用部分唯一索引在**库里**堵死，不靠应用层先查后插（那中间有窗口）。
CREATE UNIQUE INDEX idx_ot_one_pending ON owner_transfers (project_id) WHERE status = 'pending';
-- 被转让人打开项目时要查「有没有等我答复的」
CREATE INDEX idx_ot_to ON owner_transfers (to_user) WHERE status = 'pending';
