-- 两件事（PRD 6.1.2 与 6.3.2），合一次迁移。
--
-- ── ① 参会人分「必参 / 选参」（PRD 6.1.2）───────────────────────────────
--
-- ★为什么值得分★：冲突提示只有在**分了档**之后才有用。
-- 一场 10 人的会，总有人撞车；如果每个人的冲突都标红，发起人看到的永远是「N 人时间冲突」，
-- 那个红色就变成了背景噪音，最终没人再看它。
-- 只标**必参人**的冲突，红色才重新有意义 —— 它说的是「这个时间开不成」，而不是「有人不方便」。
--
-- 默认 true（必参）：★邀请一个人的默认含义就是「希望你来」★。
-- 反过来默认选参的话，发起人不点一遍就等于把所有冲突都静音了。
ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;

-- ── ② 会议粒度的材料权限（PRD 6.3.2）─────────────────────────────────
--
-- 项目上已经有 no_download / no_share（P3 做的），但 PRD 要的是**作用在会议粒度**：
-- 「这次会涉及敏感内容，我想让大家能看但不能下载」—— 说的是**这一次会**，
-- 不是把整个项目锁上。项目级那个太钝：为一次会把项目设成禁下载，
-- 会连带影响项目里所有跟这次会无关的材料。
--
-- ⚠ 语义是**叠加不是覆盖**：项目禁了，会议这里放开也没用（取两者的严格值）。
-- 否则就成了「在会议上开个口子绕过项目策略」，那是权限模型里最容易被利用的那种缝。
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS no_download boolean NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS no_share boolean NOT NULL DEFAULT false;
