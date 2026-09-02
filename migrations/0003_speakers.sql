-- 主讲人(2026-08-23 liaoruili:纪要模板照团队现用的 Word 格式,里面有「主讲人」一栏)。
--
-- ★为什么新开 0003 而不是并进 0002★:`0002_app_setting.sql` 由 v0.6.0 的热修引入,
--   而 prod 现在跑着 v0.6.3、`gitea/main` 里也确实有那个文件 —— **它已经被 prod 应用过**。
--   改一个已应用的迁移,后果是 prod 下次部署时 pod 起不来
--   (`migration 2 was previously applied but has been modified`)。
--   CLAUDE.md 那条「一轮的 schema 改动合成一份」说的是**同一轮内**;0002 那一轮已经上线了。
--
-- ★可空、无默认值★:主讲人不是每场活动都有(个人日程、读文献显然没有),
--   给默认空串只会让「没填」和「填了空」分不开。存量行一律 NULL,不需要回填。
ALTER TABLE activities ADD COLUMN speakers text;

COMMENT ON COLUMN activities.speakers IS
  '主讲人,自由文本(多人用顿号分隔)。★不是外键也不进参会名单★——它是纪要上的一行署名,
   而「谁来讲」与「谁有权限」是两件事:外请的主讲人未必是平台用户。';
