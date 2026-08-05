-- 0006:提取码失败尝试计数 —— 堵住公开分享的**在线爆破**(v0.3.55 第三轮审计)。
--
-- 原先 pub_open 只在提取码**正确**时才写 share_visits,失败的尝试不留痕、也不限速。
-- 提取码本身是低熵的(用户实际只会设 4 位,10^4 种),脚本几秒钟就能把一条链接的码试穿。
-- 加盐 sha256 防的是「库被拖走之后离线爆破」,防不了在线爆破 —— 在线只能靠限速。
--
-- 复用 share_visits 而不另起一张表:失败尝试和成功访问本来就是同一件事的两面,
-- 放一起既能限速,也让「这条链接被人试过多少次码」在审计时看得见。
ALTER TABLE share_visits ADD COLUMN IF NOT EXISTS ok boolean NOT NULL DEFAULT true;

-- 限速查的是「最近 15 分钟内某 token 的失败数」,建部分索引只覆盖失败行(占比极小)。
CREATE INDEX IF NOT EXISTS idx_share_visits_fail ON share_visits (token, at DESC) WHERE NOT ok;
