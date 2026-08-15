#!/usr/bin/env bash
# ★门禁:不许静默截断★（2026-08-14；liaoruili「为啥又莫名其妙使用 limit！！！！！！！！」）
#
#   scripts/no-silent-limit.sh          # 扫全部 SQL,发现没声明理由的写死 LIMIT 就红
#
# ══════ 它守什么 ══════
# 一周之内撞了三次同一个形状:
#   · 回收站 / 我的分享 `LIMIT 500` —— 第 501 条起在界面上**凭空消失**,而它还在库里、还占配额;
#   · `/api/me/reminders` `LIMIT 20` **且没排除已开始的活动** —— 早就开完的把名额吃光,
#     真正「马上要开始」的被挤出去,★症状是「提醒失灵」,没有任何报错★;
#   · 公开活动广场 `LIMIT 200`、待写纪要 `LIMIT 50` —— 同族。
#
# ★「写死 LIMIT」和「分页」是两件事★:
#   · 分页 = 限量 **且** 告诉你总数、给你翻页 → 人知道自己看到的是不是全部;
#   · 写死 LIMIT 不给总数 = **让接口替数据库撒谎** → 人以为看到的就是全部。
# 所以这道闸不禁止 LIMIT,它禁止的是**没说理由的 LIMIT**。
#
# ══════ 怎么豁免 ══════
# 在那条 SQL 里写一行 `-- limit-ok: <理由>`。合法理由就三类:
#   ① **分批处理**:后台清扫/投递每轮取 N 条,下一轮接着来 —— 一条都不会丢;
#   ② **输入即搜的候选**:typeahead 取前 N 个,人再敲一个字就换一批;
#   ③ **刻意举例**:报错文案里列几条示意 —— ★但必须同时给出总数★(见 projects.rs 的归档)。
# 除此之外都该改成真分页。★写理由的过程本身就是那道闸★:
# 写不出属于哪一类,基本就说明它是个洞。
#
# ⚠ 这道闸**能进 CI**:纯静态扫描,不连库、不要内网 CA。
set -uo pipefail
cd "$(dirname "$0")/.."

python3 - "$@" <<'PY'
import json, re, subprocess, sys

d = json.loads(subprocess.run(['python3', 'scripts/sql-inventory.py', '--json'],
                              capture_output=True, text=True).stdout)
LIM = re.compile(r'\bLIMIT\s+(\d+)\b', re.I)
坏 = []
for x in d:
    # ★把 SQL 里的 `--` 注释行剔掉再找★:注释里引用「原来写的是 LIMIT 20」会被误判成代码。
    #   (这不是假设 —— 我给 my_reminders 写完事故注释之后,自己的扫描当场误报了一次。)
    净 = '\n'.join(l for l in x['sql'].split('\n') if not l.strip().startswith('--'))
    豁免 = 'limit-ok' in x['sql'].lower()
    for m in LIM.finditer(净):
        n = int(m.group(1))
        if n <= 1:        # `LIMIT 1` = 「取一行」,不是截断
            continue
        if 豁免:
            continue
        坏.append((x['file'], x['line'], n, ' '.join(净.split())[:90]))

if not 坏:
    print('★没有未声明理由的写死 LIMIT —— 门禁通过★')
    sys.exit(0)

print(f'★发现 {len(坏)} 处没声明理由的写死 LIMIT —— 门禁不通过★\n')
for f, ln, n, sql in 坏:
    print(f'  ✗ {f}:{ln}  LIMIT {n}')
    print(f'      {sql}')
print('''
→ 每一处二选一:
   ① 它其实是个洞 → 改成真分页(带 total),或者干脆去掉 LIMIT;
   ② 它确实合理 → 在这条 SQL 里加一行 `-- limit-ok: <理由>`,理由要说清属于哪一类:
        分批处理 / 输入即搜的候选 / 刻意举例(且已给出总数)。
   ★写不出属于哪一类,基本就说明它是个洞。★''')
sys.exit(1)
PY
