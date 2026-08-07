-- 会议实际时长的手工录入（D5 三级回退的第 2 级）。
--
-- D5 定的口径是**优先级回退**，不是三选一：
--   1. 录制时长（转写流程算出来的真实时长，最可信）
--   2. **手工录入**（发起人会后填的实际时长）  ← 本迁移补的就是这一级
--   3. 排程时长（ends_at − starts_at，兜底）
--
-- ★为什么必须有手工这一级★：绝大多数会**不会录屏**（组会、讨论会没人会去录），
-- 而排程时长常常离谱——排了 2 小时、20 分钟讲完就散了。
-- 只有第 1、3 级的话，统计出来的数字要么没有、要么系统性偏高，
-- 而这个数字是**要拿去做季度汇报**的（D5 原话），偏高的汇报数字比没有数字更糟。
--
-- ⚠ 存**分钟**不存秒：手工录入的精度本来就是「大概一个半小时」，
-- 存秒会造出一种精确的假象。（录制那一级存的是秒，因为那是真测出来的。）
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS actual_minutes integer
  CHECK (actual_minutes IS NULL OR (actual_minutes > 0 AND actual_minutes <= 24 * 60));
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS actual_by text;
