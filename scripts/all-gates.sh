#!/usr/bin/env bash
# 一条命令跑完所有门禁 —— ★提交前跑它,别再手拼一串 &&★。
#
# ══ 为什么有这个脚本 ══
# 2026-08-13 我把一条**编译不过**的提交推进了 PR:那次是把 `pnpm typecheck` 和 `git commit`
# 写成了两行,前者失败拦不住后者。改用 `&&` 串起来之后又踩第二个坑 ——
# ★`grep -c` 在计数为 0 时退出码是 1，而 0 正是「没有 warning」这个好结果★,
# 于是整条链在「全绿」的那一刻断掉。
#
# ⇒ 两个教训写进这个脚本:
#   ① ★门禁的通过/失败不能靠管道里最后一个命令的退出码猜★,每道闸各自明确判定;
#   ② ★一道闸「没跑成」必须算红,不能算绿★ —— 本仓库栽过五次「工具没跑 → 输出为空 → 报绿」。
#
# 用法:
#   bash scripts/all-gates.sh          # 全部(要 CONGROVE_DEV_DSN 的那两道自动跳过并**标记为未跑**)
#   bash scripts/all-gates.sh --ci     # 只跑 CI 里那几道(不连库)
set -uo pipefail
cd "$(dirname "$0")/.."
CI_ONLY=${1:-}
# ⚠★变量名只能用 ASCII★:bash 的 identifier 不接受中文(和 TS/Rust 不一样,那两处我一直在用中文名),
#   写成 `declare -a 结果=()` 会直接 `syntax error near unexpected token '('` —— 我刚踩过。
declare -a RESULTS=()
FAILED=0

gate() {   # gate <名字> <命令...>
  local name=$1; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then RESULTS+=("  ✓ $name")
  else RESULTS+=("  ✗ ★$name★"); FAILED=1
       printf '%s\n' "── $name 的输出 ──" "$out" | tail -25; fi
}

gate "cargo clippy(零 warning)" cargo clippy --all-targets --locked -- -D warnings
gate "cargo test"               cargo test --locked
gate "旧命名(改名残留)"          bash scripts/no-meeting.sh --all   # no-meeting:allow —— 这一行是**调用那个门禁脚本本身**,文件名里就带这个词,改不了
# ★不许静默截断★(2026-08-14 新增):一周撞了三次「写死 LIMIT 又不给总数」——
#   回收站/我的分享 500、提醒 20、广场 200、待写纪要 50。★纯静态扫描,能进 CI。★
gate "不许静默截断(LIMIT)"       bash scripts/no-silent-limit.sh
# ★读内容不许碰裸 items★(2026-08-14):v0.4.144 建了 items_alive 视图把「软删过滤」收到一处,
#   但视图只是**让正确的路更好走**,不构成强制 —— 这道闸补上那一半:
#   读(SELECT)一律走视图,真要读已删行就在 SQL 里写 `-- items-ok: <理由>`。★纯静态,能进 CI。★
gate "读内容不碰裸 items"         bash scripts/no-bare-items.sh
# ★时间不许裸格式化★(2026-08-15 新增):库里存的全是 UTC,`.format()` 直接印出来就差 8 小时,
#   而且不报任何错(催办站内信这么错了不知道多久)。★纯静态,能进 CI。★
gate "时间不裸格式化(时区)"       bash scripts/no-naked-time.sh
gate "前端 tsc"                  bash -c 'cd web && pnpm typecheck'
gate "前端 test"                 bash -c 'cd web && pnpm test'

if [ "$CI_ONLY" != "--ci" ]; then
  if [ -n "${CONGROVE_DEV_DSN:-}" ]; then
    gate "SQL 对真库 PREPARE" python3 scripts/sql-prepare-check.py
    gate "schema 对拍"        bash scripts/schema-check.sh check
  else
    # ★没跑 ≠ 通过★:缺 DSN 时明确标出来,免得看报告的人以为这两道也绿了
    RESULTS+=("  ? 未跑:SQL PREPARE / schema 对拍（缺 CONGROVE_DEV_DSN，source ~/.config/iah/congrove-dev.env）")
  fi
  gate "接口面 api-check" bash scripts/api-check.sh check
  # ★响应体形状★(2026-08-14 新增):补的是 api-check 看不见的那一半 ——
  #   生成的契约里响应只写 `{"description":"成功"}`、没有 schema,于是把响应体
  #   从 `[...]` 改成 `{total, items}`(2026-08-13,货真价实的破坏性变更)时,
  #   ★八道门禁一道都没红★。这一道直接对着**真实响应**比形状,那次改动实测会被它抓住。
  #   ⚠ 它要跑 golden.mjs 打真实请求,比别的闸慢(约 40s),且同样进不了 CI。
  if [ -n "${IAH_E2E_KEY:-}" ]; then
    gate "响应体形状对拍" bash scripts/shape-check.sh check
  else
    RESULTS+=("  ? 未跑:响应体形状对拍（缺 IAH_E2E_KEY）")
  fi
fi

printf '\n══ 门禁汇总 ══\n'
printf '%s\n' "${RESULTS[@]}"
[ $FAILED -eq 0 ] && echo "★全部通过★" || echo "★有门禁未通过 —— 不要提交★"
exit $FAILED
