-- 0006_char_timestamps:存 ASR 的**字级时间戳**(AI_Talks 0136→0137)。
-- 为什么要它:sentence_info 的句界不可信——61 分钟的会,「文字→时间」的对应累计提前 46 秒
-- (末尾几段只剩标点,文字在 3624 秒就用完)。paraformer 原生的字级时间戳是 CIF 权重后处理出来的,
-- 官方报与混合 FA 系统差距 <10ms;平台 asr-funasr v4 起透出(每段一份 + 顶层全局一份)。
-- 形状:[[start_sec,end_sec], ...],**与全文 text 的「实字」(去标点去空白)一一对应**。
-- 可空:老转写没有这列,realign 会退回按分段线性插值(有多准算多准,但不会更差)。
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS char_ts jsonb;
