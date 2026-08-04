-- 0003_public_share:公开分享链接(带提取码 / 有效期 / 次数上限),**非空间成员也能访问**。
--
-- ⚠ 这是本系统第一个「绕过空间授权」的入口,所以每一条都是 fail-closed:
--   过期、超次数、被撤销、令牌不存在 —— 一律 404(不区分,免得成为探测工具)。
--   创建权限要 **≥editor**:viewer 只能看,不该有把内容捅到墙外的能力。
--
-- 0002 的 items.share_token 被这张表取代(它只是「成员间直达链接」,能力是本表的子集):
-- 那一版上线只有几分钟、库刚重建,没有任何真实令牌,直接删列比留着两套省事。
ALTER TABLE items DROP COLUMN IF EXISTS share_token;
DROP INDEX IF EXISTS idx_items_share_token;

CREATE TABLE IF NOT EXISTS share_links (
  token          text PRIMARY KEY,                    -- 32 位十六进制(128 bit,/dev/urandom)
  item_id        bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  -- 提取码:存**加盐 sha256**,不存明文。NULL = 不要提取码,链接即可访问。
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

-- 访问明细:谁(IP 前缀/UA 摘要)在什么时候打开了哪条分享。
-- ★只留粗粒度★:IP 只存 /24(v4)或 /48(v6) 前缀、UA 只存 sha256 前 16 位 ——
-- 够看「有多少不同的人访问过」,又不至于把访客的可识别信息攒成一个数据库。
CREATE TABLE IF NOT EXISTS share_visits (
  id        bigserial PRIMARY KEY,
  token     text NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  ip_prefix text,
  ua_hash   text
);
CREATE INDEX IF NOT EXISTS idx_share_visits_token ON share_visits (token, at DESC);
