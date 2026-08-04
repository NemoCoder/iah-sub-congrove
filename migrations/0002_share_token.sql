-- 0002_share_token:分享链接改用**不可猜的令牌**,不再暴露自增 id。
--
-- 起因(2026-08-05 用户):分享链接原来是 `/i/{item_id}`,自增整数。虽然每个入口都判权
-- (不是本空间成员一律 404,连存在性都不漏),但**链接长成 /i/1 这个样子本身就是错的**:
--   ① 收到链接的人天然会去试 /i/2、/i/3 —— 同空间内他本来就有权看,但这是在鼓励乱翻;
--   ② 一旦将来做「带链接就能看」的公开分享,自增 id 就是灾难;
--   ③ id 的数量级会漏出「这个系统里大概有多少东西」。
-- 令牌 = 32 位十六进制(128 bit,取自 /dev/urandom),UNIQUE 索引直接当查找键。
-- 懒生成:第一次点「复制链接」才建,没分享过的内容不占这一列。
-- ⚠ 令牌**不是**授权凭证:拿到它仍要登录、仍要是该空间成员才打得开(perm.rs 判权不变)。
ALTER TABLE items ADD COLUMN IF NOT EXISTS share_token text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_share_token ON items (share_token) WHERE share_token IS NOT NULL;
