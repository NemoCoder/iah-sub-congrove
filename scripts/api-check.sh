#!/usr/bin/env bash
# ★门禁五：接口面只在预期处变★（2026-08-08，用 oasdiff v1.28）
#
#   scripts/api-check.sh baseline   # 冻结当前契约 → docs/openapi.json
#   scripts/api-check.sh check      # 现契约 vs 基线，breaking 必须逐条事先声明
#   scripts/api-check.sh freeze     # 把当前的 breaking 全部写进声明文件（★写完逐行读一遍★）
#   scripts/api-check.sh dump       # 只打印当前契约
#
# ══════ 三件让这道闸能进 CI 的事 ══════
#
# ① ★契约离线生成★：`cargo run --bin openapi-dump` 直接调 `apidoc::build_openapi()`，
#    **不连库、不起服务器、不要凭据**。服务器上那条 `GET /api/_dev/openapi.json`（要超管）
#    共用同一个纯函数，所以两者不可能漂。
#    —— 这是本仓库五道闸里**唯一一道能完全进 CI 的**（其余要活的 dev 库 + 内网 CA）。
# ② **只管 breaking**：新增端点是安全的，不要求声明。收窄判定面是有意的 ——
#    一道什么都管的闸，最后会因为噪声太多而被人无视。
# ③ 版本号不误报：实测 `info.version` 从 0.4.44 改成 9.9.9，oasdiff 判 0 breaking。
#
# ══════ 声明的粒度：★逐个端点，不许一句话通杀★（实测过）══════
#
#   ✅ `in api get /api/meetings api path removed without deprecation`   ← 逐条，有效
#   ❌ `api path removed without deprecation`                             ← 通杀，**无效**
#
# 这正是想要的：M0 把 `/api/meetings` 改成 `/api/activities` 会产生 19 条 breaking，
# 每一条都得白纸黑字写下来，而不是一行字把「所有路径移除」全放过。
#
# ══════ 双向必须相符（和另外两道闸同一个形式）══════
#
# 只用 oasdiff 自己的 `--err-ignore` 会留一个洞：**声明了却没发生**的条目它不吭声。
# 于是「改动漏做了」和「声明是陈的」都查不出来 —— 那正是老 `schema-diff.mjs`
# 被评审实测骗过的那一格。所以这里自己做集合比对，两个方向都要求相等。
set -uo pipefail
cd "$(dirname "$0")/.."
BASE=docs/openapi.json; DECL=docs/openapi-breaking.txt
command -v oasdiff >/dev/null || { echo "缺 oasdiff（~/bin/oasdiff，v1.28+）"; exit 2; }

dump() { cargo run -q --bin openapi-dump; }

# 把 oasdiff 的 JSON 输出压成可比对的规范行（与 --err-ignore 的匹配串同形）
lines() {
  # ★两段都要判退出码★：oasdiff 崩了、或规范化脚本崩了，输出都会是空 ——
  # 而空输出会被下游读成「无破坏性变更」。这就是「没跑 ≠ 全过」，本仓库已栽三次。
  local raw
  raw=$(oasdiff breaking "$BASE" "$1" -f json) || { echo "★oasdiff 执行失败★" >&2; return 1; }
  printf '%s' "$raw" | python3 scripts/oasdiff-lines.py || { echo "★规范化脚本执行失败★" >&2; return 1; }
}

case "${1:-check}" in
dump) dump ;;
baseline)
  # ⚠★推进基线会让已声明的 breaking 全部归零 —— 证据就此消失★（2026-08-08 踩过两次：
  #   M0-1 与 M0-2 都因为先跑了 baseline 再 freeze，`openapi-breaking.txt` 提交上去是空的，
  #   于是「这 20 个端点被移除」在 PR 里一点痕迹都没有）。
  #   纪律：**一个里程碑内基线只冻一次**，期间靠 `$DECL` 累积；里程碑收尾时才推进。
  if [ -s "$DECL" ]; then
    echo "★拒绝推进基线★：$DECL 里还有 $(grep -c . "$DECL") 条已声明的破坏性变更。"
    echo "→ 推进基线会把它们清零，PR 里就再也看不到本次到底破坏了什么。"
    echo "  确实要推进（里程碑收尾）：先 rm $DECL 并在提交信息里说明。"
    exit 2
  fi
  mkdir -p docs && dump > "$BASE" || exit 1
  echo "★契约基线已冻结★ $BASE（$(python3 -c "import json;print(len(json.load(open('$BASE'))['paths']))") 条路径）" ;;
freeze|check)
  [ -f "$BASE" ] || { echo "没有基线，先跑 $0 baseline"; exit 2; }
  T=$(mktemp --suffix=.json); dump > "$T" || exit 1
  ACT=$(lines "$T") || { rm -f "$T"; exit 2; }; rm -f "$T"
  if [ "${1}" = freeze ]; then
    printf '%s\n' "$ACT" | sed '/^$/d' > "$DECL"
    echo "★已声明 $(grep -c . "$DECL" 2>/dev/null || echo 0) 条 breaking → $DECL★"
    echo "→ ★逐行读一遍★：每一条都该是你**打算**造成的破坏性变更。"; exit 0
  fi
  DEC=$([ -f "$DECL" ] && grep -v '^\s*\(#\|$\)' "$DECL" || true)
  # 未声明却发生了 / 声明了却没发生 —— 两个方向都是红
  NEW=$(comm -23 <(printf '%s\n' "$ACT" | sed '/^$/d' | sort) <(printf '%s\n' "$DEC" | sed '/^$/d' | sort))
  OLD=$(comm -13 <(printf '%s\n' "$ACT" | sed '/^$/d' | sort) <(printf '%s\n' "$DEC" | sed '/^$/d' | sort))
  if [ -z "$NEW" ] && [ -z "$OLD" ]; then
    n=$(printf '%s\n' "$ACT" | grep -c . || true)
    [ "$n" = 0 ] && echo "★接口面无破坏性变更 —— 门禁通过★" \
                 || echo "★$n 条破坏性变更全部事先声明过（$DECL）—— 门禁通过★"
    exit 0
  fi
  echo "★接口面门禁不通过★"
  [ -n "$NEW" ] && { echo; echo "没声明却发生了 —— 真实的破坏性变更，或者你忘了重新 freeze："; echo "$NEW" | sed 's/^/  + /'; }
  [ -n "$OLD" ] && { echo; echo "声明了却没发生 —— 这条改动是不是漏做了？或者声明是陈的："; echo "$OLD" | sed 's/^/  - /'; }
  exit 1 ;;
*) echo "用法: $0 {baseline|check|freeze|dump}"; exit 2 ;;
esac
