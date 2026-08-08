#!/usr/bin/env bash
# ★改名兜底门禁★：非注释行里不允许再出现 meeting（注释是资产，历史记录要留）。
#
# 用法：scripts/no-meeting.sh --migrations | --backend-core | --backend-all | --frontend | --all
#
# ══════ 三条豁免，各有各的形式 ══════
#
#  ① **外部真实域名**（腾讯会议）—— 改了就是错 URL。
#     处理：★先把这个字面量从行里抹掉，再判剩下的★。同一行里别的残留照样抓得到
#     （v6 那版把整行放过，于是 `e2e/shot.mjs` 里同一行的 `/api/meetings/` 跟着蒙混过关）。
#  ② **冻结的改名前快照**（`e2e/golden/*.json`）—— 它必须保留旧名，
#     `golden-diff.mjs` 的 RENAMES 表才有东西可归一化。JSON 加不了注释，只能按**路径**豁免。
#  ③ **改名映射表本身**（`golden-diff.mjs` / `schema-diff.mjs` 的 RENAMES）——
#     它按定义就是「老名 → 新名」，改了映射就没了。用★行内标记 `no-meeting:allow`★，
#     由作者显式声明、可 grep 出来审计。
#
# ⚠⚠ ★2026-08-08 的教训：机制写进脚本 ≠ 事情做完了★
#    上一版把 ③ 的机制写好了，**却一个文件都没加标记**，于是 `--all` 照样红、
#    M0-7 的门禁照样是坏的。评审一跑就露。**「设计了」和「执行了」是两件事，验收要验后者。**
#    这一版加完标记后实跑 `--all` 验证过。
set -uo pipefail
cd "$(dirname "$0")/.."

# ★自身豁免★：本脚本的实现行必然含 meeting 字样，而其中两行以续行符 `\` 结尾——
#   行内标记在 shell 语法上加不上去（`\` 后面不能跟内容）。所以按**路径**排除自己。
SELF='scripts/no-meeting.sh'
TENCENT='[Mm][Ee][Ee][Tt][Ii][Nn][Gg]\.[Tt][Ee][Nn][Cc][Ee][Nn][Tt]\.[Cc][Oo][Mm]'

scan() {
  local hits
  hits=$(grep -rniE 'meeting' "$@" 2>/dev/null \
    | sed -E "s#${TENCENT}##g" \
    | grep -vE '^[^:]+:[0-9]+: *(//|--|\*|#)' \
    | grep -vE "^(e2e/golden/|${SELF})" \
    | grep -v 'no-meeting:allow' \
    | grep -iE 'meeting') || true
  if [ -n "$hits" ]; then
    echo "$hits"
    echo "★上面这些是非注释、未豁免的 meeting 残留★"
    echo "  （改名映射表这类**确实不能改**的，在那一行加 no-meeting:allow 标记并说明理由）"
    exit 1
  fi
}

case "${1:-}" in
  # ★M0-1 用★：只扫建表脚本。v7 漏了这个模式 —— 于是 M0-1 重写的 0001 改名对不对，
  #   要等到 M0-3 的 --backend-all 才第一次被机械检查，中间隔着两个 PR。
  --migrations)   scan migrations/ ;;
  --backend-core) scan src/ --exclude=mod.rs --exclude=apidoc.rs ;;   # M0-2（路由/清单归 M0-3）
  --backend-all)  scan src/ tests/ migrations/ ;;                     # M0-3
  --frontend)     scan web/src/ ;;                                    # M0-4
  --all)          scan src/ tests/ migrations/ web/src/ e2e/ scripts/ ;;   # M0-7
  # ★兜底：模式名打错必须红★。一个「打错名字就自动通过」的门禁比没有门禁更坏。
  *) echo "用法: $0 --migrations|--backend-core|--backend-all|--frontend|--all" >&2; exit 2 ;;
esac
