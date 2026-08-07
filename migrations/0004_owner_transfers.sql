-- 转移主持人需对方接受（PRD ⑨.5；设计见 docs/TECH-DESIGN-M1-owner-transfer.md）。
--
-- 在这之前 transfer 是**直接转**：调用即改 projects.owner，对方毫不知情。
-- 主持人是有责任的位置（纪要欠账、成员治理都挂他名下），单方面塞给别人不合适；
-- 更糟的是甩给一个已经不活跃的人之后，项目实际无人负责而系统显示它有主持人 ——
-- ★比明确无主更糟，因为没人会去管它★。
--
-- ★留全部历史而不是只存当前那条★：谁在什么时候想把项目甩给谁、对方拒没拒，是治理事实。
-- 和会议「取消不是删除」同一条道理 —— 真删掉之后没人说得清当时发生过什么。
CREATE TABLE IF NOT EXISTS owner_transfers (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_ot_one_pending
  ON owner_transfers (project_id) WHERE status = 'pending';
-- 被转让人打开项目时要查「有没有等我答复的」
CREATE INDEX IF NOT EXISTS idx_ot_to ON owner_transfers (to_user) WHERE status = 'pending';
