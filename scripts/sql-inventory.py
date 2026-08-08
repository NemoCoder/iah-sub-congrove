#!/usr/bin/env python3
# ★把 src/ 里所有 SQL 字面量抽出来★（2026-08-08）
#
# 用法：`python3 scripts/sql-inventory.py [--json]`，产出 [{file,line,sql}]。
# 它是 `sql-prepare-check.py` 的输入 —— 那道闸把每条 SQL 拿去对**真库** PREPARE。
#
# ══════ 为什么能这么干（这是整道闸成立的前提，先验过再写的）══════
#
# 本仓库 208 处 sqlx 调用**全部是编译期已知的字符串字面量**：
#   AssertSqlSafe 0 处 / QueryBuilder 0 处 / raw_sql 0 处 / format! 拼 SQL 0 处（实测）。
# 所以 SQL 虽然不被 rustc 检查（我们全用 runtime 查询、没有 `sqlx::query!` 宏），
# 却**可以 100% 静态抽取**。★「编译器帮不上忙」和「没法机械检查」是两件事，
# 我一度把它们混成一件，于是得出「只能靠人肉核对清单」的结论 —— 那正是相位 4 卡八轮的根因。★
#
# ══════ 三种间接，一个都不能漏 ══════
#
# ① 直接量：`sqlx::query("SELECT …")`                                  —— 绝大多数
# ② 变量：  `let sql = "WITH mtg AS (…"; sqlx::query_as(sql)`          —— meetings.rs:1324 一处
# ③ 宏拼接：`sqlx::query_as(concat!(mine_cte!(), " SELECT …"))`        —— meetings.rs 两处
#
# 所以**不按调用点抽，按字面量抽**：扫全部字符串字面量，凡是长得像 SQL 的就收。
# ②因此免费拿到（它就是个 SQL 字面量，只是先赋给了变量）。
# ③要特判：`mine_cte!()` 展开出的是 `WITH mine AS (…`，而跟在它后面的那半截
# （`SELECT count(*) …`）单独拿去 PREPARE 必然语法错 —— ★那是**假红**，比漏检更糟，
# 因为假红会让人学会忽略这道闸★。所以识别 `concat!(<宏>!(), "…")` 并把宏体接上去。
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MACRO_BODIES = set()   # 无参宏的体:只当前缀,不当独立 SQL
# ★关键字后面必须还有东西★：apidoc.rs 里 8 个 `"DELETE"` 是 **HTTP 方法**不是 SQL，
# 只按开头关键字判会把它们收进来 → 8 条必然 PREPARE 失败的**假红**。
# 判据补两条：关键字后跟空白、且整体长度 ≥ 15。
SQL_HEAD = re.compile(r'^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s', re.I)
# 形如 `macro_rules! mine_cte { () => { "…" } }` —— 只认无参、体是单个字面量的那种
# ★`$` 必须配 re.M★：不开多行时 `$` 只匹配整个文件末尾，于是这条永远不命中、
# 宏体永远展开 0 个 —— 而症状是「concat! 的那半截 SQL 假红」，看起来像 SQL 有问题，
# 其实是抽取器有问题。第一次跑就踩了，记在这。
# ⚠ 别在末尾加 `\s*$`：本仓库的宏体**和 `=> {` 同一行**（`macro_rules! mine_cte { () => { "WITH mine AS (`），
# 要求行尾则永远不命中 —— 而症状是「concat! 的那半截 SQL 假红」，看起来像 SQL 有问题，其实是抽取器有问题。
MACRO_DEF = re.compile(r'macro_rules!\s+(\w+)\s*\{\s*\(\)\s*=>\s*\{')
# 字面量**之前**紧挨着的东西：`concat!(mine_cte!(),`
CONCAT_PREV = re.compile(r'concat!\(\s*(\w+)!\(\)\s*,\s*$')


def scan_literals(src):
    """扫出 (起始行, 内容, 该字面量之前的最后 80 个字符)。

    ★手写扫描器而不是正则★：SQL 里全是引号和反斜杠，正则一定会咬错边界。
    需要认的 Rust 字面量形态：`"…"`（带 \\ 转义）、`r"…"`、`r#"…"#`（任意个 #）。
    要跳过的：`//` 行注释、`/* */` 块注释、`'x'` 字符字面量（`'` 在 SQL 里也是引号，
    但它在 Rust 源码层面出现在字符串**内部**，扫描器不会走到那里，所以只需管源码层面的）。
    """
    out, i, n, line = [], 0, len(src), 1
    while i < n:
        c = src[i]
        if c == '\n':
            line += 1; i += 1; continue
        if src.startswith('//', i):
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2); j = n if j < 0 else j + 2
            line += src.count('\n', i, j); i = j; continue
        # 原始字符串 r"…" / r#"…"#（前一个字符不能是标识符字符，否则是 `xr"` 这种）
        if c == 'r' and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == '_')):
            k = i + 1
            while k < n and src[k] == '#': k += 1
            if k < n and src[k] == '"':
                hashes = '#' * (k - i - 1); term = '"' + hashes
                j = src.find(term, k + 1); j = n if j < 0 else j
                out.append((line, src[k + 1:j], src[max(0, i - 80):i]))
                line += src.count('\n', i, j); i = j + len(term); continue
        if c == '"':
            j, buf = i + 1, []
            while j < n:
                if src[j] == '\\': buf.append(src[j:j + 2]); j += 2; continue
                if src[j] == '"': break
                buf.append(src[j]); j += 1
            raw = ''.join(buf)
            out.append((line, raw.encode().decode('unicode_escape') if '\\' in raw else raw,
                        src[max(0, i - 80):i]))
            line += src.count('\n', i, j); i = j + 1; continue
        i += 1
    return out


# ★动态拼 SQL 的四种形态 —— 出现任何一种，这道闸的前提就塌了★
#
# 抽取器只认字面量。一旦有人写 `QueryBuilder` 或 `format!` 拼 SQL，那条 SQL
# **抽不到、也就永远不会被 PREPARE**，而闸照样全绿 —— ★覆盖率悄悄掉下去，门禁却说没事★。
# 这正是我在 `schema-diff.mjs` 上栽过的那个坑（「你什么都没做」原本也是全绿）。
# 所以：发现任一形态就**红**，逼作者要么改回字面量，要么显式扩展这个抽取器。
DYNAMIC = [('AssertSqlSafe', '绕过 SqlSafeStr 的逃生舱'), ('QueryBuilder', '运行期拼 SQL'),
           ('raw_sql', '整段裸 SQL'), ('sqlx::query', None)]  # 末条特判见下


def guard_static(files):
    """确认「全部 SQL 都是编译期字面量」这个前提仍然成立，不成立就报出来。"""
    bad = []
    for f in files:
        for ln, line in enumerate(f.read_text(encoding='utf-8').split('\n'), 1):
            if line.lstrip().startswith('//'): continue
            for name, why in DYNAMIC[:3]:
                if name in line: bad.append(f'{f.name}:{ln} 出现 {name}（{why}）')
            if 'sqlx::query' in line and 'format!' in line:
                bad.append(f'{f.name}:{ln} 用 format! 拼 SQL')
    return bad


def main():
    macros, items = {}, []
    files = sorted(ROOT.joinpath('src').rglob('*.rs'))
    if bad := guard_static(files):
        print('★前提已被打破：不是所有 SQL 都是编译期字面量了★', file=sys.stderr)
        for b in bad: print('  ✗ ' + b, file=sys.stderr)
        print('→ 这些 SQL 抽不到、也就永远不会被 PREPARE。要么改回字面量，要么扩展本脚本。', file=sys.stderr)
        sys.exit(2)
    for f in files:
        text = f.read_text(encoding='utf-8')
        # 先收无参宏的体（`mine_cte!()` 这种），下一轮拼接要用
        for m in MACRO_DEF.finditer(text):
            tail = scan_literals(text[m.end():])
            # ★宏体本身要排除在清单外★:`WITH mine AS (…)` 缺尾部 SELECT,单独 PREPARE 必然
            # 「syntax error at end of input」——那是**假红**。它只作为前缀参与拼接。
            if tail: macros[m.group(1)] = tail[0][1]; MACRO_BODIES.add(tail[0][1])
    for f in files:
        rel = str(f.relative_to(ROOT))
        for ln, body, prev in scan_literals(f.read_text(encoding='utf-8')):
            pm = CONCAT_PREV.search(prev.rstrip())
            if pm and pm.group(1) in macros:
                body = macros[pm.group(1)] + body          # ③ 接上宏体，别让半截 SQL 假红
            elif body in MACRO_BODIES or not (SQL_HEAD.match(body) and len(body.strip()) >= 15):
                continue
            items.append({'file': rel, 'line': ln, 'sql': body.strip()})
    if '--json' in sys.argv:
        json.dump(items, sys.stdout, ensure_ascii=False, indent=1)
    else:
        for it in items: print(f"{it['file']}:{it['line']}\t{' '.join(it['sql'].split())[:110]}")
        print(f"\n共 {len(items)} 条 SQL（宏体已展开 {len(macros)} 个：{', '.join(macros) or '无'}）", file=sys.stderr)


if __name__ == '__main__':
    main()
