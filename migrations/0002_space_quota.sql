-- 0002_space_quota:每空间总容量配额(2026-08-02 用户定):默认 10 GiB,单文件不限大小——
-- 上传改流式后单文件上限没意义,真正要守的是「空间总量吃共享 5TB 池」(DESIGN.md §6 容量纪律)。
-- 配额判定在 items.rs::space_quota_used(items ∪ item_versions 按 s3_key 去重求和);
-- 改配额走超管 API(PUT /api/admin/spaces/{id}/quota)。
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS quota_bytes bigint NOT NULL DEFAULT 10737418240;
