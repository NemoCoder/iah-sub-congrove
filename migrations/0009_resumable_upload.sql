-- 0009_resumable_upload:断点续传(P2 收尾)。
-- 直传是「begin 建行 + create_multipart_upload → 逐片 PUT → complete」,断在中间时
-- S3 里那些**已经传好的片还在**(半截 multipart 24h 后才被清扫任务 abort),
-- 但我们没记住 upload_id 与「这是哪个文件」,所以只能从头再传一遍——GB 级录屏上这很致命。
--
-- 加两列即可续:
--   upload_fp —— 文件指纹(前端给:大小+修改时间+文件名),用来认出「你重新拖进来的就是上次那个文件」;
--   upload_id —— S3 的 multipart upload id,续传要拿它去 ListParts 和继续 PUT。
-- 两列只在**未完成**的行上有意义(s3_key IS NULL);完成后留着无害,当作痕迹。
-- 续传窗口 = 24h(与 lib.rs 清理任务的窗口对齐,过期后那半截上传已被 abort,续也续不上)。
ALTER TABLE items ADD COLUMN IF NOT EXISTS upload_fp text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS upload_id text;
-- 找「我上次没传完的那个文件」用:同空间 + 同人 + 未完成 + 指纹。
CREATE INDEX IF NOT EXISTS idx_items_resume ON items (space_id, created_by, upload_fp) WHERE s3_key IS NULL;
