#!/usr/bin/env bash
# 「线上版本 == dev 上的版本」—— ★专门防那个「构建绿、部署绿、只有版本不动」的陷阱★。
#
# 2026-08-15 实地踩到:PR 合进 dev、webhook 触发了构建、镜像也部署到 pod 了,
# **但构建的是一个过期分支的代码** —— 因为部署记录里的 `ref` 早先被某次
# `POST /deploy {ref:<特性分支>}` 改掉后就留在那儿了(CLAUDE.md 里记着这个陷阱)。
# ★这个失败模式每一环都报绿★:门禁绿、构建成功、部署成功、pod Running,
# 唯一的症状只有「线上版本号不动」—— 而没人会盯着版本号看。
#
# 判据:合并 + 构建之后,`Cargo.toml` 的版本必须等于线上前端 bundle 里的版本。
# 用法:  scripts/deployed-version-check.sh          # 比当前分支的版本
#        scripts/deployed-version-check.sh v0.4.159 # 比指定版本
set -u
CA="${IAH_CA:-$HOME/.config/iah/IAH-Internal-CA.crt}"
KEY="$(cat "${IAH_E2E_KEY_FILE:-$HOME/.config/iah/congrove-e2e-key}" 2>/dev/null)"
B="${CONGROVE_BASE:-https://congrove-dev.sub.ruciah.com}"
want="${1:-v$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"(.*)".*/\1/')}"

js=$(curl -sS --max-time 20 --cacert "$CA" -H "X-IAH-E2E-Key: $KEY" "$B/" \
     | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [ -z "$js" ]; then echo "★取不到线上 bundle —— 不能当成通过★"; exit 2; fi
got=$(curl -sS --max-time 40 --cacert "$CA" -H "X-IAH-E2E-Key: $KEY" "$B$js" \
      | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -u | tr '\n' ' ')
echo "期望 $want   线上 [$got]"
case " $got " in
  *" $want "*) echo "★线上版本与代码一致 —— 通过★"; exit 0 ;;
esac
cat <<TIP
★线上跑的不是这个版本 —— 门禁不通过★
最常见的原因(CLAUDE.md 记过):**部署记录里的 ref 不是 dev**,
于是每次合并 dev 都在构建一个过期分支,而全程没有任何一处报红。
修法(会顺手把 ref 掰回 dev):
  curl -sS --cacert "$CA" -X POST -H "Authorization: Bearer \$(cat ~/.config/iah/congrove-token)" \\
    -H 'Content-Type: application/json' -d '{"channel":"dev","ref":"dev"}' \\
    https://registry.ruciah.com/api/subsystems/congrove/deploy
返回里 "updated":true 就说明 ref 之前确实被改过。
TIP
exit 1
