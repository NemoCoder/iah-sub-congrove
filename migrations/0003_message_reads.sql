-- 讨论区已读位（2026-08-07，为原型「🔔 待我处理」里的私聊未读项）。
--
-- ★存「读到哪儿」而不是逐条已读标记★：
--   逐条标记要为每人 × 每条消息写一行，一场会几百条讨论就是几百行 × N 人，
--   而它唯一的用途是「有没有我还没看的」—— 一个时间戳就答得了。
--   代价是没法做「单条标为未读」，那个需求也没人提过。
--
-- ⚠ 没有记录 = 一条都没读过（而不是全读过）：新人加入项目后能看到历史讨论（D3），
--   若默认全读过，那些讨论就悄悄地永远不会提醒他了。
CREATE TABLE IF NOT EXISTS meeting_reads (
  meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  username   text   NOT NULL,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, username)
);
CREATE INDEX IF NOT EXISTS idx_mr_user ON meeting_reads (username);
