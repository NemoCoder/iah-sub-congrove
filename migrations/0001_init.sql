-- 0001_init:congrove 全量初始 schema(DESIGN.md §4)。
-- 纪律(抄 citeroot):迁移**只增不改**——sqlx::migrate! 按校验和核对,改动已应用过的文件
-- 会让所有已部署实例启动失败;后续任何 schema 变更一律开新迁移文件写 ALTER。
-- 每个迁移文件头写清「这次加了什么、为解决什么」。

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
CREATE TABLE IF NOT EXISTS spaces (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
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
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_items_space_parent ON items (space_id, parent_id);

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
