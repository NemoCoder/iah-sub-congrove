#!/usr/bin/env bash
# ★门禁:响应体形状对拍★（2026-08-14）
#
#   scripts/shape-check.sh baseline   # 把当前响应体形状冻成基线(第一次跑)
#   scripts/shape-check.sh check      # 现状 vs 基线,差异必须**逐字节等于** shape-expected.diff
#   scripts/shape-check.sh freeze     # 把当前差异冻成「预期变更」(逐行读一遍再提交)
#   scripts/shape-check.sh render     # 只渲染形状,打到 stdout
#
# ══════ 它补的是哪个洞 ══════
# 2026-08-13 把两个接口的响应体从 `[...]` 改成 `{total, items}` —— ★破坏性变更,
# 而八道门禁一道都没红★。接口面那道(oasdiff)只守路径/参数/鉴权档位:
# 生成的契约里响应写的是 `{"description":"成功"}`,**没有 schema**,它看不见字段。
#
# ⚠★别指望在 openapi-breaking.txt 里手写一行来「登记」★:那个文件只收 oasdiff
#   真实检出的行,两个方向都验 —— 我手写了两行,闸子当场报「声明了却没发生」。
#   ★登记本不接受编造,这是对的★,所以只能补一道**真的看得见响应体**的闸,就是这一道。
#
# ══════ 判据取「形状」不取「数值」 ══════
# 直接拿 golden 指纹当基线试过,不行:`shares.mine` 永远累积(撤销的、内容已删的
# 分享仍然列出,没有 purge),同一份代码连跑两次指纹就差 32 行。
# ★天生 flaky 的闸子等于教所有人忽略它。★ 形状不受残留影响 —— 实测两次跑逐字节相同。
#
# ⚠★这道闸进不了 CI★:它要真实 dev 环境(IAH_E2E_KEY + 内网 CA),和 SQL PREPARE / schema
#   对拍同一类。PR 里必须**如实标注人工验证**,不许标成「CI 绿」。
set -uo pipefail
cd "$(dirname "$0")/.."
DIR=e2e/golden; BASE=$DIR/shape-baseline.json; EXP=$DIR/shape-expected.diff
: "${IAH_E2E_KEY:?缺 IAH_E2E_KEY}"

# golden.mjs 打指纹到 stdout;api-shape.mjs 归约成形状。
# ★golden.mjs 失败必须当红,不能把空输出当成「形状是空的」★（本仓栽过五次「工具没跑→报绿」）。
# ⚠ $1 给基线路径时,api-shape.mjs 会把「本轮没采到样本」的格子**沿用基线的值**
#   —— 「这轮没数据」不是「形状变了」的证据(见 api-shape.mjs 里那段长注释)。
#   冻基线(baseline / freeze)时**不传**,让哨兵原样落进基线。
render() {
  local t rc
  t=$(mktemp)
  NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/.config/iah/IAH-Internal-CA-new.crt}" \
    node e2e/golden.mjs > "$t" 2>/dev/null; rc=$?
  if [ $rc -ne 0 ] || [ ! -s "$t" ]; then
    echo "★golden.mjs 没跑成(exit=$rc,输出 $(stat -c%s "$t" 2>/dev/null || echo 0) 字节)—— 中止★" >&2
    rm -f "$t"; return 1
  fi
  node e2e/api-shape.mjs "$t" ${1:+"$1"}; rc=$?
  rm -f "$t"; return $rc
}

case "${1:-check}" in
render) render ;;
baseline)
  render > "$BASE" || exit 1
  echo "★形状基线已冻结★ $BASE（$(wc -l < "$BASE") 行）"
  echo "→ 提交它。之后任何接口的响应体字段变动,都要在 $EXP 里有对应的几行。" ;;
freeze)
  [ -f "$BASE" ] || { echo "没有基线,先跑 $0 baseline"; exit 2; }
  # ★freeze 必须和 check **用同一种渲染**★(2026-08-15 修):这里原来是 `render`(不传基线),
  #   而 check 用的是 `render "$BASE"`(带「没样本就沿用基线」的填空)。两边渲染方式不同 ⇒
  #   ★freeze 冻下来的差异,check 永远对不上★ —— 我刚 freeze 完立刻 check,当场红,
  #   而中间一行代码都没改。冻进去的还是 `by_project` 空/非空、`revoked_at` null/非 null
  #   这些**天生随数据抖**的格子,正是填空要滤掉的东西。
  T=$(mktemp); render "$BASE" > "$T" || { rm -f "$T"; exit 1; }
  diff -u --label baseline --label current "$BASE" "$T" > "$EXP"; rm -f "$T"
  echo "★已冻结 $(grep -c '^[+-][^+-]' "$EXP") 处预期变更 → $EXP★"
  echo "→ ★逐行读一遍★:每一行都该是你**打算**造成的响应体变化。" ;;
check)
  [ -f "$BASE" ] || { echo "没有基线,先跑 $0 baseline"; exit 2; }
  T=$(mktemp); render "$BASE" > "$T" || { rm -f "$T"; exit 1; }
  A=$(mktemp); diff -u --label baseline --label current "$BASE" "$T" > "$A"; rm -f "$T"
  if [ ! -s "$A" ]; then
    # ★「你什么都没做」不能是全绿★:声明了预期变更却一处差异都没有 = 改动没部署,或声明是陈的
    if [ -s "$EXP" ]; then
      echo "★响应体形状与基线**毫无差异**,但 $EXP 声明了预期变更 —— 门禁不通过★"
      echo "→ 要么改动还没部署到 dev,要么 $EXP 是陈的。"
      rm -f "$A"; exit 1
    fi
    echo "★响应体形状与基线一致 —— 门禁通过★"; rm -f "$A"; exit 0
  fi
  if [ ! -f "$EXP" ]; then
    echo "★出现 $(grep -c '^[+-][^+-]' "$A") 处响应体形状变动,但没有 $EXP —— 门禁不通过★"
    echo "→ 逐行看一遍下面的差异,确认每一条都是**有意为之**,再执行:  $0 freeze"
    cat "$A"; rm -f "$A"; exit 1
  fi
  if diff -q "$EXP" "$A" >/dev/null; then
    echo "★形状差异逐字节等于 $EXP（$(grep -c '^[+-][^+-]' "$EXP") 处,全部事先声明）—— 门禁通过★"
    rm -f "$A"; exit 0
  fi
  echo "★实际差异与 $EXP 对不上 —— 门禁不通过★"
  echo "（下面是「预期的差异」与「实际的差异」之间的差异;- 是预期里有而实际没有,+ 是冒出来的）"
  diff -u "$EXP" "$A" | tail -n +3
  rm -f "$A"; exit 1 ;;
*) echo "用法: $0 {baseline|check|freeze|render}"; exit 2 ;;
esac
