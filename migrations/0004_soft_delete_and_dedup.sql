-- 0004:① 全面软删除 + 回收站  ② 内容寻址去重(秒传)
--
-- ① 软删除(2026-08-05 用户:「所有的删除都是软删除」)
--    items / spaces 加 deleted_at + deleted_by。删除 = 打标记,对象一个字节都不动;
--    彻底删除(purge)只在「空间 admin 手动清空回收站」或「进回收站满 30 天」时发生。
--    ⚠ 配额**仍然计入**回收站里的东西 —— 和网盘一致:占着空间就该算钱,这也是清空回收站的动力。
--
-- ② 去重:S3 key 从「一物一 key」(spaces/<sid>/<iid>/blob)改成**内容寻址** blobs/<sha256>。
--    同样内容全库只存一份,谁删都不影响别人(purge 时按 s3_key 引用计数,含**软删除**的行)。
--    ★秒传的安全闸(百度那个著名的坑:知道哈希就能认领别人的私有文件)★:
--      - **省空间**是无条件的:任何人真传完字节,都指向同一个对象 —— 他确实拥有这份文件,安全;
--      - **省时间(秒传)有条件**:只有当调用者**本来就能读到**同 sha256 的内容时才跳过传输。
--        否则「凭一串哈希认领」就等于免密下载别人的东西。
ALTER TABLE items  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE items  ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS deleted_by text;

-- 列表只查活的,给个部分索引;回收站按删除时间倒序翻。
CREATE INDEX IF NOT EXISTS idx_items_live  ON items (space_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_trash ON items (space_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
-- 秒传查同内容:按 sha256 找「已存在且我能读」的那一份。
CREATE INDEX IF NOT EXISTS idx_items_sha   ON items (sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL;
-- purge 时按对象 key 数引用(含软删除行,否则清空回收站会把别人还在用的对象删掉)。
CREATE INDEX IF NOT EXISTS idx_items_s3key ON items (s3_key) WHERE s3_key IS NOT NULL;

-- ③ 多选分享(2026-08-05 用户:「也可以多选分享」):一条链接带多份内容。
--    share_links.item_id 保留为「主项」(单选分享时就是它,访客页的标题/根目录也用它);
--    多选时额外把每一项写进 share_items,访客页列的是这张表。
--    ⚠ 取内容仍逐项验「是被分享项之一或其后代」——多选只是把「根」从 1 个变成 N 个。
CREATE TABLE IF NOT EXISTS share_items (
  token   text   NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (token, item_id)
);
