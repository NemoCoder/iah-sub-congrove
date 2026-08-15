#!/usr/bin/env bash
# ★时间不许裸格式化★ —— 数据库里存的全是 UTC,直接 `.format(...)` 出来的就是 UTC。
#
# ══ 为什么有这道闸 ══
# 2026-08-15 对抗检查在催办站内信里抓到 `starts.format("%m-%d %H:%M")`:
# 全仓十来处站内信都走 `notify::fmt_when(t, tz)`,只有这一处是自己拼的,
# 于是「将于 02:00 开始」发到收信人手里 —— 那场会其实是北京时间 10:00。
# ★这类错不报任何东西,只会让人错过会★,而且 code review 时它看起来完全正常
# (一个 format 调用,能有什么问题?)。
#
# 判据:`.format("` 之前必须先 `.with_timezone(`。二者写在同一行是本仓库的既有风格,
# 所以逐行判就够;真要拆行写,顺手在行尾加 `// tz-ok: <理由>` 声明。
# ★纯静态扫描,能进 CI。★
# ⚠★变量名只能用 ASCII★:bash 的 identifier 不接受中文,写成 `命中=$(…)` 会变成
#   「找不到命令 命中=」,而脚本照样往下跑、`$命中` 展开成空 —— ★闸会红,但红的理由是假的★。
#   all-gates.sh 头上已经写过这一条,我写这个脚本时又踩了一遍(2026-08-15)。
set -uo pipefail
cd "$(dirname "$0")/.."

# tzutil.rs 是时区换算的**唯一推导**,它内部当然要裸 format —— 整个文件豁免。
HITS=$(grep -rn '\.format("' src/ --include='*.rs' \
        | grep -v '^src/tzutil.rs:' \
        | grep -v 'with_timezone' \
        | grep -v 'tz-ok:' \
        | grep -vE ':[0-9]+: *(//|///|\*)' || true)

if [ -n "$HITS" ]; then
  echo "★有时间被裸格式化(没先 .with_timezone)——那印出来的是 UTC★:"
  printf '%s\n' "$HITS"
  echo
  echo "改法:站内信/文案走 crate::notify::fmt_when(t, crate::tzutil::parse(&tz));"
  echo "     确实要裸格式化(如日志/文件名)就在行尾写 // tz-ok: <理由>。"
  exit 1
fi
echo "★时间格式化门禁通过★:没有绕过时区换算的 .format"
