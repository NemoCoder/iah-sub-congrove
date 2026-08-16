-- 系统级设置(超管在后台改的东西)。★第一个 0002 —— prod 已存在,所以只增不改。★
--
-- 为什么需要它:此前「用哪个 LLM 模型」写死在 `CONGROVE_LLM_MODEL` env 里,
-- 改一次要动平台的环境变量 + 重启。而平台的模型是会换的 ——
-- 2026-08-16 prod 上就报了 `LLM 返回 403:无权调用模型 Qwen3.6-35B-A3B`,
-- ★纪要功能整个哑掉,而子系统这边没有任何办法自助恢复★,只能等人去改 env。
-- 配置项该由超管在界面上选,不该是一次部署。
--
-- 刻意做成通用 kv 而不是「llm_model 一个列」:下一个「超管可配」的东西不该再加一张表。
-- 值一律 text,语义由 key 决定(调用方自己解释)。
CREATE TABLE app_setting (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
