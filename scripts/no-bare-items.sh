#!/usr/bin/env bash
# ★门禁:读内容不许碰裸 items 表★（2026-08-14，v0.4.144 视图那一半的**强制**部分）
#
#   scripts/no-bare-items.sh
#
# ══════ 它守的是哪次事故 ══════
# 「凡是读内容的路径,SQL 都必须带 `deleted_at IS NULL`」是 CLAUDE.md 里的硬纪律。
# 它被违反过两轮:
#   · v0.3.55:download / content / play / detail **以及整个公开分享面**全漏 ——
#     「删进回收站的材料,墙外的公开链接照样列得出、下得到」,一次补齐 11 处;
#   · 2026-08-14 软删矩阵又抓到 5 处(/versions /progress /subtitles.vtt /analysis
#     items/{id}/shares),★其中两处漏的是内容正文★(字幕、AI 摘要)。
# ★两次都不是因为有人不知道这条规矩,而是因为它要靠每个人每次都记得。★
#
# v0.4.144 建了 `items_alive` 视图(= items WHERE deleted_at IS NULL),
# 把规矩收到一处。但★视图只是「让正确的路更好走」,不构成强制★ ——
# 谁照旧写 `FROM items` 也没人拦。这道闸补上那一半:
#   **读(SELECT)一律走 `items_alive`;真要读已删行,就把理由写下来。**
#
# ══════ 怎么豁免 ══════
# ★标记写成 **Rust 注释**(`// items-ok: <理由>`),放在那条 SQL 上方 15 行以内★。
# ⚠ 第一版我把它写进 SQL 里(`-- items-ok: …`),**两个坑一起中**:
#   ① 放在 SQL **末尾** → 调用方追加的语句(PREPARE 闸的 `; ROLLBACK`)被那个 `--` 整行吞掉
#      → 35 条 SQL 当场语法错;
#   ② 那放开头行不行?★更糟★ —— `sql-inventory.py` 认 SQL 的判据是「以 SELECT/INSERT/… 开头」,
#      带前导注释的字面量会**整条从清单里消失**,连带从 271 条 PREPARE 覆盖里消失 ——
#      ★一个让覆盖率静默下降的豁免机制,比没有豁免机制坏得多。★
#   Rust 注释两个坑都没有:它永远到不了数据库,也不影响字面量本身。(`no-meeting.sh` 同一做法。)
# 合法理由就这几类:
#   ① **回收站生命周期**:列回收站 / undelete / purge —— 它们的对象**就是**已删的行;
#   ② **引用计数**:不数上回收站里的引用,purge 会删掉别处还引用着的 blob = ★数据丢失★;
#   ③ **配额**:「回收站里的内容仍占用项目配额」是明写的规矩,不算就漏算;
#   ④ **上传中的占位行**:`s3_key IS NULL` 的半成品,还没成为"内容";
#   ⑤ **纯归属解析**:只取 project_id/activity_id 用来判权,后续真正的读仍走视图
#      (见 `project_of` 与 `project_of_alive` 的分工)。
# ★写不出属于哪一类,基本就说明它该换成 items_alive。★
#
# ⚠ 写语句(INSERT/UPDATE/DELETE)本来就该打在表上,不在本闸范围。
# ⚠ 纯静态扫描,**能进 CI**:不连库、不要内网 CA。
set -uo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, re, subprocess, sys

d = json.loads(subprocess.run(['python3', 'scripts/sql-inventory.py', '--json'],
                              capture_output=True, text=True).stdout)

_缓存 = {}
def 源码(f):
    if f not in _缓存:
        _缓存[f] = open(f, encoding='utf-8').read().split('\n')
    return _缓存[f]
# ★`\bitems\b` 会同时命中 items_alive / item_versions 吗★ —— 不会:
#   `items_alive` 里 `items` 后面紧跟 `_`,`\b` 不成立;`item_versions` 根本不含 `items`。
#   但为保险起见显式写成「后面不是下划线」。
裸 = re.compile(r'\b(FROM|JOIN)\s+items(?!_)\b', re.I)
写 = re.compile(r'^\s*(INSERT|UPDATE|DELETE)\b', re.I)
坏 = []
for x in d:
    净 = '\n'.join(l for l in x['sql'].split('\n') if not l.strip().startswith('--'))
    if 写.match(净):
        continue                      # 写语句打在表上是对的
    if not 裸.search(净):
        continue
    # ★在**源码**里找标记,不在 SQL 里找★(见文件头注)。
    # ⚠ 窗口是 **15 行**,不是拍脑袋的 5 行:`share::mine` 的返回类型是个 16 元组、
    #   光类型声明就占 4 行,标记落在 SQL 上方第 9 行 —— 5 行窗口够不着,
    #   ★于是「写了理由」和「没写理由」长得一模一样,人会以为标记语法不对而反复试★。
    #   放宽到 15 行的代价是「可能蹭到上一条查询的标记」,但那要求两条查询挨得极近
    #   且前一条恰好带标记 —— 比「够不着」这个失败模式罕见得多,也更容易在 review 里看出来。
    src = 源码(x['file'])
    起 = max(0, x['line'] - 16)
    if any('items-ok' in l for l in src[起:x['line']]):
        continue
    坏.append((x['file'], x['line'], ' '.join(净.split())[:88]))

if not 坏:
    print('★读内容的 SQL 都走 items_alive(或已声明理由)—— 门禁通过★')
    sys.exit(0)

print(f'★发现 {len(坏)} 处读裸 items 表、且没声明理由 —— 门禁不通过★\n')
for f, ln, sql in 坏:
    print(f'  ✗ {f}:{ln}')
    print(f'      {sql}')
print('''
→ 每一处二选一:
   ① 它是读内容 → 改成 `FROM items_alive`(规矩就写在视图里,不必再手抄 deleted_at IS NULL);
   ② 它确实要读已删的行 → 在那条 SQL **上方**加一行 Rust 注释 `// items-ok: <理由>`,说清属于哪一类:
        回收站生命周期 / 引用计数 / 配额 / 上传占位行 / 纯归属解析。
   ★写不出属于哪一类,基本就说明它该换成 items_alive。★''')
sys.exit(1)
PY
