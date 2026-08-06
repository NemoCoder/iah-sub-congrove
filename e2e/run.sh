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
echo "目标: $CONGROVE_BASE | E2E key: ${IAH_E2E_KEY:+已加载}${IAH_E2E_KEY:-未配置(只能跑 gate 组)}"
npx playwright test "$@"
