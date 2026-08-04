-- 0007_space_hotwords:每个空间自己的**转写术语表**(热词)。
-- 为什么落到空间而不是全局:人名与专业词天然按组不同(思想史组的「柯老师」与 CS 组的「benchmark」
-- 互不相干),而且只有空间管理员知道自己组的词。全局兜底仍走 env CONGROVE_ASR_HOTWORDS。
-- 用法:平台 ASR 收 `hotword`(空格分隔),服务端内部转 postprocess_hotwords(拼音模糊匹配的
-- 确定性文本替换,AI_Talks 0128→0130)。⚠ 词表填错会把正常的字改坏,所以由空间管理员自己维护。
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS hotwords text NOT NULL DEFAULT '';
