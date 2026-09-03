-- ★会议主题★(2026-09-03 liaoruili)。★它不是标题的别名★:
--   `title`   = 这场活动**叫什么**(「未来史学家(AI 组)文献 Agent 部署会议」),印在纪要大标题;
--   `subject` = 这次**要推进什么**(「文献 Agent 项目推进」),印在纪要表格第一行。
--   一个是名字、一个是这次的议题焦点。团队现用的 Word 格式里两个都有。
--
-- ══ ★为什么新开 0004 而不是并进 0003 —— 一次真实事故换来的★ ══
-- 我起初把它并进了 `0003_speakers.sql`(理由:0003 还没上 prod,按「一轮合成一份」该并),
-- 并同步改了 dev 库里 `_sqlx_migrations` 的 checksum。★三分钟后 dev pod 起不来★:
--     Error: migration 3 was previously applied but has been modified
-- 因为**线上那一刻跑的还是旧版本镜像**,它带的 0003 是旧内容 —— 库里的 checksum 一改,
-- 正在跑的那个版本就再也起不来了。CrashLoopBackOff 6 次。
--
-- ★「prod 还没见过它」不等于「可以随便改」★:判据里少了一个 —— **dev 线上正在跑它**。
--   一个迁移只要**任何一个还在运行的实例应用过**,它的内容就已经冻结了,
--   哪怕它还没上 prod、哪怕它才写了十分钟。
-- ⇒ 加列一律新开一个文件。多一个文件的代价,远小于一次线上不可用。
-- ★`IF NOT EXISTS` 是有意的★:开发期要先把列加到 dev 库上,否则
--   `sql-prepare-check` 与 `schema 对拍`两道闸必红(SQL 引用了一个库里还没有的列),
--   而「代码没问题、只是环境没跟上」和「代码真有问题」在门禁上长得一样。
--   ⚠ 但**不能顺手把 `_sqlx_migrations` 也补一条 version 4** ——
--     线上那一刻跑的镜像里没有 0004 文件,sqlx 会报
--     `migration 4 ... is missing in the resolved migrations` 而起不来
--     (今天刚用 0003 换了一次 CrashLoop,同一个死结的另一面)。
--   ⇒ 只加列、不记账;部署时 sqlx 正常跑这个文件,幂等 DDL 不会二次失败。
ALTER TABLE activities ADD COLUMN IF NOT EXISTS subject text;

COMMENT ON COLUMN activities.subject IS
  '会议主题:这次要推进什么(一句话)。与 title(活动叫什么)是两个东西,别互相顶替。';
