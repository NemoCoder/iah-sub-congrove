-- 0005_media_ai:录屏自动转写 + 会议纪要(docs/VIDEO-SUMMARY.md 的 P1 落点)。
-- 形态:ASR 转写为主干,摘要走平台 LLM 网关;关键帧 VLM 旁路留到 P3。
-- 任务表活在 PG 而不是内存:无 PVC 铁律下 pod 重启即丢内存态,靠这张表续跑(citeroot 的教训)。

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
-- 同一个视频同时只允许一个在跑的任务(重复点"生成纪要"不会排队堆叠)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_active
  ON media_jobs (item_id) WHERE status IN ('queued','running');

-- 逐字稿:text 是全文(喂 LLM 用),segments 是带时间戳/说话人的分段(UI 点击跳转用)。
CREATE TABLE IF NOT EXISTS transcripts (
  item_id      bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  text         text NOT NULL,
  segments     jsonb,   -- [{start,end,speaker,text}]
  model        text,
  duration_sec double precision,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 纪要:一个视频多种产出(摘要/大纲/决议待办),各存一行,重跑覆盖。
CREATE TABLE IF NOT EXISTS summaries (
  item_id    bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       text   NOT NULL CHECK (kind IN ('brief','outline','decisions')),
  content    text   NOT NULL,
  model      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind)
);
