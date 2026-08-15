#!/usr/bin/env bash
# 跑 congrove 的 E2E。★凭证只从 ~/.config/iah 读,不入库★
set -euo pipefail
cd "$(dirname "$0")"
# 内网自签 CA:不装它 TLS 直接失败(*.ruciah.com 全是内网 CA 签的)
export NODE_EXTRA_CA_CERTS="${IAH_CA:-$HOME/.config/iah/IAH-Internal-CA-new.crt}"
[ -f "$NODE_EXTRA_CA_CERTS" ] || { echo "找不到内网 CA: $NODE_EXTRA_CA_CERTS"; exit 1; }
# E2E key(可选):没有它只能跑 gate 那组(验门禁),功能测试会被 302 拦住
[ -f "$HOME/.config/iah/congrove-e2e-key" ] && export IAH_E2E_KEY="$(cat "$HOME/.config/iah/congrove-e2e-key")"
export CONGROVE_BASE="${CONGROVE_BASE:-https://congrove-dev.sub.ruciah.com}"
# ★2026-08-08 修:这行原来会把 key 明文打出来★。原写法是
#   `${IAH_E2E_KEY:+已加载}${IAH_E2E_KEY:-未配置(...)}`
# —— 第二段 `${VAR:-默认}` 在 VAR **有值时展开成值本身**(不是默认值),
# 于是 key 设了的时候屏幕上出现「已加载e2e_xxxxx」,凭证进了终端回滚与 CI 日志。
# ★凭证绝不进 stdout★:分支判断写全,别用参数展开图省事。
if [ -n "${IAH_E2E_KEY:-}" ]; then KEY_STATE="已加载"; else KEY_STATE="未配置(只能跑 gate 组)"; fi
echo "目标: $CONGROVE_BASE | E2E key: $KEY_STATE"

# ★跑之前先证明线上跑的就是这份代码★(2026-08-15 接线)。
# `scripts/deployed-version-check.sh` 写好了却**一个调用方都没有** —— 而它要防的事
# 恰恰只在这一刻发生:对着**旧镜像**跑 E2E,拿到的绿是关于别人代码的绿。
# 本仓栽过一次「部署记录里的 ref 不是 dev,每次合并都在构建过期分支,全程零报红」。
# ⚠ 拿不到线上版本时脚本 exit 2(「量不到」不算通过),这里同样当红处理。
# 真要对着旧版本跑(比如复现一个已修的 bug),显式 SKIP_VERSION_CHECK=1。
if [ "${SKIP_VERSION_CHECK:-}" != 1 ]; then
  bash ../scripts/deployed-version-check.sh || {
    echo "★线上版本与代码对不上 —— 先部署,或 SKIP_VERSION_CHECK=1 明确表示你就是要对着旧版本跑★"
    exit 1
  }
fi

npx playwright test "$@"

