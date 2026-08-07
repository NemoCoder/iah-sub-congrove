-- 删掉「临时参会人（guest）」这个分类（2026-08-07 liaoruili 拍板，★推翻 D8★）。
--
-- 原话：「临时人不需要我们邀请，旁听就是临时人……不要再多个临时人的分类了」。
--
-- D8 当初区分了两种「不拿材料的人」：
--   · guest    = 发起人**主动邀**进来的临时参会人；
--   · observer = 公开会议里**自己跑来听**的旁听者（D9）。
-- 两者在权限上**完全一样**（能看时间议程链接、看不到任何材料），
-- 区别只在「谁发起的这段关系」—— 而这个区别不值得让每个用户在名单里多认一个概念，
-- 也不值得让发起人在拉人时先想一遍「他算临时的还是正式的」。
--
-- ★存量 guest 一律并进 observer★：它们的权限本来就相同，合并不改变任何人能看到什么。
UPDATE meeting_participants SET kind = 'observer' WHERE kind = 'guest';

-- CHECK 约束跟着收窄：留着 'guest' 会让它悄悄回来（某个漏改的写路径照样能插进去）。
ALTER TABLE meeting_participants DROP CONSTRAINT IF EXISTS meeting_participants_kind_check;
ALTER TABLE meeting_participants
  ADD CONSTRAINT meeting_participants_kind_check CHECK (kind IN ('attendee','observer'));
