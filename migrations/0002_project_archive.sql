-- 项目归档(2026-08-07 用户拍板,决策记为 D17)。
--
-- ★归档 ≠ 删除★:
--   · 删除 = 「不要了」→ 软删除进回收站,30 天后连对象一起清;
--   · 归档 = 「做完了,留着备查」→ ★只读存档★:材料/会议/纪要全部保留、可查可下载,
--     但不能再上传、建会议、改内容。配额仍然占着(东西还在盘上)。
--
-- 为什么不复用 deleted_at:两者会同时存在(归档的项目照样可以被删除),
-- 而且语义相反 —— 一个是留着,一个是准备清掉。挤进一个字段迟早要拆。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by text;

-- 日常查的都是「进行中」,给部分索引;归档的走全表扫也无所谓(数量少且不常查)。
CREATE INDEX IF NOT EXISTS idx_projects_active
  ON projects (id) WHERE archived_at IS NULL AND deleted_at IS NULL;
