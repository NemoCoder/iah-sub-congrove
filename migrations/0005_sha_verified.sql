-- 0005:标记「这个 sha256 是不是服务端自己算的」——**秒传源必须可信**。
--
-- 起因:预签名直传时字节不经过 pod(浏览器直连 Garage),sha256 只能听客户端申报。
-- 若有人申报了别人文件的哈希、传的却是自己的内容,那么后来**真正拥有那份文件**的人做秒传预检时
-- 会命中这条假记录 → 拿到错误的字节。这是静默的数据损坏,比拒绝去重糟得多。
--
-- 所以:sha_verified 为真才可以当秒传源。
--   - 流式上传:服务端边收边算,落库即 true;
--   - 预签名直传:先记 false,随后后台从对象存储**内部读一遍**算真哈希(不占用户带宽)再置 true;
--     算出来与申报不符就以真值为准(并留日志),那条假记录自然再也命中不了。
ALTER TABLE items ADD COLUMN IF NOT EXISTS sha_verified boolean NOT NULL DEFAULT false;

-- 直传期间用的对象 key(内容寻址之后不能再按 sid/iid 现拼:同内容共享一个 key,
-- 而且撞名时会带随机后缀)。complete/part/abort 都从这里读同一个 key。
ALTER TABLE items ADD COLUMN IF NOT EXISTS upload_key text;
