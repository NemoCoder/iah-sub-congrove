#!/usr/bin/env bash
# ★改名兜底门禁★：非注释行里不允许再出现 meeting（注释是资产，历史记录要留）。
#
# 用法：scripts/no-meeting.sh --backend-core | --backend-all | --frontend | --all
#
# ══════ 三条豁免，各有各的理由，★形式也各不相同★ ══════
#
# 这一节是踩出来的。第一版把三类混成一条 `grep -vE 'e2e/golden/|meeting\.tencent\.com'`，
# 作用在整行 `路径:行号:内容` 上，于是**同一行里只要出现豁免串，这一行的其它残留一起被放过**。
# 仓库里现成就有一例：
#   e2e/shot.mjs:59: … call('/api/meetings/' + m.id, … online_url: 'https://meeting.tencent.com/…')
# ★那个 `/api/meetings/` 忘了改，门禁照样绿。★ 所以三类要分开处理：
#
#  ① **外部真实域名**（`meeting.tencent.com`）—— 改了就是错 URL。
#     处理：★先把这个字面量从行里抹掉，再判剩下的★。同一行里别的残留照样会被抓到。
#  ② **冻结的改名前快照**（`e2e/golden/*.json`）—— 它必须保留旧名，
#     `golden-diff.mjs` 的 RENAMES 表才有东西可归一化；改了 = 毁掉唯一的机械对照物。
#     处理：按**路径**豁免（JSON 里加不了注释，只能这样）。
#  ③ **改名映射表本身**（`golden-diff.mjs` / `schema-diff.mjs` 的 RENAMES）——
#     它按定义就是「老名 → 新名」，改了映射就没了。
#     处理：★行内标记 `no-meeting:allow`★ —— 由作者显式声明、可 grep 出来审计，
#     比在门禁脚本里维护一张越来越长的特例清单强。
set -uo pipefail
cd "$(dirname "$0")/.."

scan() {
  local hits
  hits=$(grep -rniE 'meeting' "$@" 2>/dev/null \
    | sed 's#meeting\.tencent\.com##g' `# ① 抹掉外部域名字面量本身，不放过整行` \
    | grep -vE '^[^:]+:[0-9]+: *(//|--|\*|#)' `# 行首注释：注释是资产` \
    | grep -vE '^e2e/golden/' `# ② 冻结的基线快照` \
    | grep -v 'no-meeting:allow' `# ③ 作者显式声明的改名映射表` \
    | grep -iE 'meeting') || true
  if [ -n "$hits" ]; then
    echo "$hits"
    echo "★上面这些是非注释、未豁免的 meeting 残留★"
    exit 1
  fi
}

case "${1:-}" in
  # M0-2 只改后端非路由部分；mod.rs / apidoc.rs 归 M0-3
  --backend-core) scan src/ --exclude=mod.rs --exclude=apidoc.rs ;;
  --backend-all)  scan src/ tests/ migrations/ ;;
  --frontend)     scan web/src/ ;;
  --all)          scan src/ tests/ migrations/ web/src/ e2e/ scripts/ ;;
  # ★兜底：模式名打错必须红★。一个「打错名字就自动通过」的门禁比没有门禁更坏。
  *) echo "用法: $0 --backend-core|--backend-all|--frontend|--all" >&2; exit 2 ;;
esac
