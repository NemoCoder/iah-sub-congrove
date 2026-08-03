-- 0004_play_progress:记住每人每个视频看到哪(2026-08-03 用户要求)。
-- 存后端不存 localStorage:换设备/清缓存/换浏览器都还在,独立播放窗与主窗口天然一致。
-- 按 (username, item_id) 一行,续播是覆盖写,没有历史价值——不建版本、不进审计。
CREATE TABLE IF NOT EXISTS play_progress (
  username     text   NOT NULL,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position_sec double precision NOT NULL DEFAULT 0,
  duration_sec double precision,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, item_id)
);
