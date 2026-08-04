-- 0001_init:congrove 全量 schema(DESIGN.md §4)。
--
-- ★2026-08-05 重建★:此前是 0001~0009 九个增量文件。用户把平台部署连同 PG 与 OSS 一起删干净后,
-- 没有任何实例的 `_sqlx_migrations` 里还留着记录 —— 这是「只增不改」唯一可以破例的时刻,
-- 于是压成这一份完整 schema(9 个文件的列一个不少,各自的「为什么」保留在下面的注释里)。
--
-- ⚠ 纪律恢复:从这一版起**只增不改**。sqlx::migrate! 按校验和核对,
-- 改动**已经应用过**的文件 = 所有实例启动直接失败(不是跳过、不是告警,是起不来)。
-- 之后任何 schema 变更一律开 0002、0003… 写 ALTER,并在文件头写清「这次加了什么、为解决什么」。

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

-- 小组:用户自助建组、拉人(决策 B:平台/Keycloak 无组概念,组只活在这里)。
CREATE TABLE IF NOT EXISTS groups (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 组成员:manager 可增删本组成员,member 只是成员。
CREATE TABLE IF NOT EXISTS group_members (
  group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  username text   NOT NULL,
  role     text   NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager')),
  added_by text   NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, username)
);
CREATE INDEX IF NOT EXISTS idx_group_members_username ON group_members (username);

-- 空间(库):顶层容器,如「XX 研究组会议」「论文库」。
--   quota_bytes       (原 0002):每空间配额,默认 10GiB;超管 PUT /api/admin/spaces/{id}/quota 可调。
--                     单文件不限大小(2026-08-02 用户定,录屏几百 MB 常见),真正的闸是这个总量。
--   viewer_no_download(原 0003):D4 开关,只拦「下载原件」;在线阅读/播放不拦
--                     (能播就能录屏,拦了只会逼 viewer 什么都干不了)。
--   hotwords          (原 0007):本空间的转写术语表(空格分隔)。落到空间而不是全局——
--                     人名与专业词天然按组不同,也只有空间管理员知道自己组的词。
--                     ⚠ 平台侧是**拼音模糊匹配**的确定性替换,词表乱填会把正常的字改坏。
CREATE TABLE IF NOT EXISTS spaces (
  id                 bigserial PRIMARY KEY,
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  quota_bytes        bigint  NOT NULL DEFAULT 10737418240,
  viewer_no_download boolean NOT NULL DEFAULT false,
  hotwords           text    NOT NULL DEFAULT ''
);

-- ★ ACL:给「空间」授予「组或人」一个角色 —— 「不同小组不同读/编辑权」的唯一落点。
-- grantee_id:group → group_id 字符串化;user → username。
-- 有效权限 = 直接授权 ∪ 所属组授权取 max,超管短路(perm.rs::effective_role 唯一推导,别在别处重写)。
CREATE TABLE IF NOT EXISTS space_grants (
  space_id     bigint NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  grantee_type text   NOT NULL CHECK (grantee_type IN ('group','user')),
  grantee_id   text   NOT NULL,
  role         text   NOT NULL CHECK (role IN ('viewer','editor','admin')),
  granted_by   text   NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, grantee_type, grantee_id)
);

-- 内容项:文件夹/文档/文件/录屏,挂空间下,parent_id 成树。
-- 字节不在这:doc/file/video 的内容都是 S3 对象(内容寻址 spaces/<space_id>/<item_id>/<sha256>),
-- 这里只有元数据 —— 无 PVC 铁律下 PG+S3 是唯一真相(DESIGN.md §2.4)。
--   upload_fp / upload_id(原 0009):断点续传。指纹 = 大小+最后修改时间+文件名,
--   用来认出「你重新拖进来的就是上次那个文件」;upload_id 是 S3 的 multipart id,
--   续传要拿它去 ListParts 并继续 PUT。两列只在**未完成**的行(s3_key IS NULL)上有意义。
--   续传窗口 24h,与 lib.rs 清扫任务对齐(过期的半截上传已被 abort,续也续不上)。
CREATE TABLE IF NOT EXISTS items (
  id         bigserial PRIMARY KEY,
  space_id   bigint NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id  bigint REFERENCES items(id) ON DELETE CASCADE,
  kind       text   NOT NULL CHECK (kind IN ('folder','doc','file','video')),
  name       text   NOT NULL,
  s3_key     text,
  size       bigint,
  mime       text,
  sha256     text,
  created_by text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  upload_fp  text,
  upload_id  text
);
CREATE INDEX IF NOT EXISTS idx_items_space_parent ON items (space_id, parent_id);
-- 找「我上次没传完的那个文件」用:同空间 + 同人 + 未完成 + 指纹。
CREATE INDEX IF NOT EXISTS idx_items_resume ON items (space_id, created_by, upload_fp) WHERE s3_key IS NULL;

-- 文档/文件版本历史:S3 内容寻址按 sha256,旧版本天然免费。
-- ⚠ 同一 sha 可能被多行引用(items 当前版 + 多条 item_versions):删对象前必须查引用计数
-- (citeroot delete_fulltext 的教训,别简化成直接删)。
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

-- 播放进度(原 0004):每人每视频记一条,换设备/清缓存都还在
-- (所以不放 localStorage);独立播放窗与主窗口天然一致。
CREATE TABLE IF NOT EXISTS play_progress (
  username     text   NOT NULL,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position_sec double precision NOT NULL DEFAULT 0,
  duration_sec double precision,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, item_id)
);

-- 录屏分析任务(原 0005)。任务态活在 PG 而不是内存:无 PVC 铁律下 pod 重启即丢内存态,
-- 靠这张表续跑(citeroot 的教训),重启后 reclaim_stale 把 running 打回 queued。
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
-- 同一个视频同时只允许一个在跑的任务(重复点「生成纪要」不会排队堆叠)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_active
  ON media_jobs (item_id) WHERE status IN ('queued','running');

-- 逐字稿(原 0005 + 0006 + 0008)。
--   text         :全文(喂 LLM 用)。★标点位置以它为准★——ASR 的 sentence_info 句界不可信。
--   segments     :ASR 原始细分段 [{start,end,speaker,text}]。
--   char_ts (0006):**字级时间戳** [[start_sec,end_sec], …]。★按 token 给,不是按字★——
--                  英文/数字连写整串算一条(线上实测 16792 条 vs 17338 实字,差 546 全在英文词上),
--                  切 token 必须用**分段文本**(全文里英文之间没空格)。它是 46 秒时间轴漂移的解药。
--   fine    (0008):**重排后**的细分段(realign 的结果)。转写时算一次存这里,
--                  /analysis 与 /subtitles.vtt 直接用;老数据没有则现算。
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

-- 纪要(原 0005):一个视频多种产出(摘要/大纲/决议待办),各存一行,重跑覆盖。
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
