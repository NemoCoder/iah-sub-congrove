-- ★把 public schema 渲染成一份**规范化、可逐行 diff 的 DDL 文本**★（2026-08-08）
--
-- 它是 `scripts/schema-snapshot.py` 的心脏，用来替代 `pg_dump --schema-only` 双库对拍。
--
-- ══════ 为什么不用 pg_dump（不是偷懒，是它在这台机器上根本跑不了）══════
--
-- 服务端是 **PG 18.4**，本机 `pg_dump` 只有 **16.14** —— ★低版本客户端拒绝 dump 高版本服务端★。
-- 本机也没有 PG 服务、没有 congrove dev 库的直连凭据（只能经平台 dev-only 的 `db/sql` 端点）。
-- 换个角度看反而更好：**排序由我显式控制**，不必去赌 pg_dump 的排序稳定性
--（那条 2025-08 才修好、且只在 catalog 未损坏时成立）；也不会踩「加了 --verbose 就把 OID
-- 注进每个对象头、于是两个独立建的库永远对不上」那个坑。
--
-- ══════ 必须覆盖的四个盲区（自制 schema-diff.mjs 的评审结论）══════
--
-- ① **UNIQUE 索引 vs UNIQUE 约束**：用 `pg_get_indexdef` 原样输出 —— 它带 UNIQUE 关键字，
--    也带 partial 索引的 `WHERE`。旧脚本用 `regexp_replace(indexdef,'^.*USING','USING')`
--    把 UNIQUE 一起吃掉了，于是把唯一索引写成普通索引它会全绿。
-- ② **生成列**：`attgenerated` + 生成表达式。旧脚本只取 `data_type`，
--    `GENERATED ALWAYS AS (…) STORED` 与普通列输出逐字节相同。
-- ③ **类型精度**：`format_type(atttypid, atttypmod)` —— 这正是 pg_dump 自己用的函数，
--    `numeric(10,2)` / `varchar(64)` 原样带出来。
-- ④ **列顺序**：`attnum` 显式打印。★这一条对 M0-1 是必看项★ —— 老库的
--    `archived_at/archived_by` 排在最后（0002 的 ALTER ADD COLUMN 加的），
--    而重写的 0001 若把它们写在中间，列序就不同。PG 不支持调整列顺序，
--    所以这是**真实差异**，要看见、然后有意识地放行。
--
-- ⚠ PG 18 把 NOT NULL 挪进了 `pg_constraint`，但 `pg_attribute.attnotnull` 仍然有效，
--    这里继续用它（已在 18.4 上实测）。
WITH t AS (
  SELECT c.oid, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
), lines AS (
  -- 表头
  SELECT t.relname AS obj, 0 AS cat, 0 AS ord, 'TABLE ' || t.relname AS line FROM t
  UNION ALL
  -- 列：序号 / 名 / 精确类型 / NOT NULL / 默认值 / 生成列
  SELECT t.relname, 1, a.attnum,
         '  COL ' || lpad(a.attnum::text, 3) || ' ' || rpad(a.attname, 22) || ' '
           || rpad(format_type(a.atttypid, a.atttypmod), 30)
           || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
           || CASE WHEN a.attgenerated = 's'
                   THEN ' GENERATED ALWAYS AS (' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '?') || ') STORED'
                   WHEN d.adbin IS NOT NULL
                   THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
                   ELSE '' END
                                                                             AS line
    FROM t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
           LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
  UNION ALL
  -- 约束（PK / FK / UNIQUE / CHECK / EXCLUDE）：定义原样带出
  SELECT t.relname, 2, 0, '  CON ' || rpad(k.conname, 34) || ' ' || pg_get_constraintdef(k.oid)
    FROM t JOIN pg_constraint k ON k.conrelid = t.oid
   -- ⚠ PG 18 起 NOT NULL 也在 pg_constraint 里（contype='n'）。列上已经打印过 NOT NULL 了，
   --   这里再打一遍等于**同一个事实出现两次** —— 一次改动会产生两行 diff，读的人以为是两处变化。
   WHERE k.contype <> 'n'
  UNION ALL
  -- 索引：`pg_get_indexdef` 带 UNIQUE、带 partial 的 WHERE、带表达式索引
  SELECT t.relname, 3, 0, '  IDX ' || pg_get_indexdef(i.indexrelid)
    FROM t JOIN pg_index i ON i.indrelid = t.oid
   -- ⚠ 跳过**约束背后的**索引（PK / UNIQUE 约束自动建的那个）：CON 那行已经表达了同一个事实，
   --   两边都打等于一次改名产生两行 diff。PG 保证约束名与其索引名同步改
   --（`ALTER INDEX … RENAME` 连约束一起改），所以二者不可能分叉，跳过不丢信息。
   --   ★但**独立**的 `CREATE UNIQUE INDEX`（我们有两处是 partial 的）必须留★ —— 它没有
   --   对应的 pg_constraint 行，正是盲区①要抓的东西。
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
  UNION ALL
  -- 触发器（不含约束触发器 —— 那是 FK 的实现细节，约束那行已经表达了）
  SELECT t.relname, 4, 0, '  TRG ' || pg_get_triggerdef(g.oid)
    FROM t JOIN pg_trigger g ON g.tgrelid = t.oid AND NOT g.tgisinternal
  UNION ALL
  -- 序列：identity / serial 的归属看得见（改名时最容易漏，见 §坑A）
  SELECT c.relname, 5, 0, 'SEQ ' || c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
  UNION ALL
  -- 视图
  SELECT c.relname, 6, 0, 'VIEW ' || c.relname || ' AS ' || pg_get_viewdef(c.oid, true)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
)
-- ★排序是这份快照的全部价值所在★：obj → cat → ord → line。
-- 同 (obj,cat) 内还要按 line 排，否则同一张表的多个索引/约束顺序随机，diff 全是噪声。
SELECT line FROM lines ORDER BY obj, cat, ord, line;
