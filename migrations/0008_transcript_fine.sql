-- 0008_transcript_fine:缓存**重排后**的细分段(realign 的结果)。
-- 为什么:/analysis 与 /subtitles.vtt 每次请求都要拿全文 + 分段 + 字级时间戳重排一遍
-- (61 分钟的会 = 17338 个字符、1476 段、16792 条时间戳),纯 CPU 活,重复算没有意义
-- (2026-08-04 审计)。转写完成时算一次存这里,读取时直接用;老转写没有这列 → 现算,行为不变。
-- 形状与 segments 相同:[{start,end,text,speaker}, ...],但句界已按全文标点重排、时间来自字级时间戳。
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS fine jsonb;
