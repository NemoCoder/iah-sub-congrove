#!/usr/bin/env bash
# ★版本号两处必须一致★ —— Cargo.toml 与 web/src/version.ts。
#
# 2026-08-08 踩的:用 `sed -i 's/version = "0.4.56"/…/'` 升版本,而分支基于更早的点(0.4.55),
# **无匹配、sed 退出 0**、版本就没升 —— 代码合进去了,线上版本号还是旧的,全程零报错。
# `scripts/bump-version.sh` 从源头治(读→加一→写回→回读核对),这一道是**事后兜底**:
# 不管你用什么方式改的版本号,两处对不上就红。★纯静态,能进 CI。★
set -uo pipefail
cd "$(dirname "$0")/.."
# ⚠ 不用 `grep -oP`:PCRE 不是所有 grep 都带(CI runner 的镜像换过一次基座),
#   而这道闸一旦因为「grep 不认 -P」而红,红的理由是假的。sed 到处都一样。
CUR=$(sed -n 's/^version = "\([0-9][0-9.]*\)".*/\1/p' Cargo.toml | head -1)
# ⚠ 只认 `export const VERSION` 那一行:文件头注释里有 `v0.3.42.dev` 这类举例,
#   笼统 grep 会先命中它(CI 里第一版就是这么把好版本判成不一致的)。
WEB=$(sed -n "s/^export const VERSION = 'v\(.*\)'.*/\1/p" web/src/version.ts)
if [ -z "$CUR" ] || [ -z "$WEB" ]; then
  echo "★读不到版本号(Cargo.toml='$CUR' version.ts='$WEB')—— 门禁不通过★"; exit 1
fi
if [ "$CUR" != "$WEB" ]; then
  echo "★两处版本号不一致:Cargo.toml=$CUR  web/src/version.ts=$WEB —— 门禁不通过★"
  echo "→ 用 scripts/bump-version.sh 升版本(它会回读核对),别手写 sed。"; exit 1
fi
echo "★版本号门禁通过★:两处都是 $CUR"
