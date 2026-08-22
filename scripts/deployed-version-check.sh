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
# ★脚本必须自己 cd 到仓库根★(2026-08-15 当天就踩了):它原来直接 `grep … Cargo.toml`,
# 也就是**默认调用方的工作目录正好是仓库根**。而 `e2e/run.sh` 先 `cd e2e/` 再调它 ——
# 于是 `grep: Cargo.toml: No such file or directory`、`want` 为空、比对**永远不相等**。
# ⚠★它「红」了,但红的理由是假的★:我接线那次只核了退出码是 1,没核那行「期望 vX 线上 vY」
#   里的 X 是不是真读出来了(输出被我 `tail -4` 截掉了)。一道永远红的闸,
#   结果是所有人都学会加 SKIP_VERSION_CHECK=1 绕过去 —— 比没有这道闸更坏。
cd "$(dirname "$0")/.."
want="${1:-v$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"(.*)".*/\1/')}"

# ══ 前端:bundle 里编进去的版本串 ══
js=$(curl -sS --max-time 20 --cacert "$CA" -H "X-IAH-E2E-Key: $KEY" "$B/" \
     | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [ -z "$js" ]; then echo "★取不到线上 bundle —— 不能当成通过★"; exit 2; fi
got=$(curl -sS --max-time 40 --cacert "$CA" -H "X-IAH-E2E-Key: $KEY" "$B$js" \
      | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -u | tr '\n' ' ')

# ══ ★后端:问它自己★(2026-08-22 加)══
#
# ⚠★这道闸原来只量前端 bundle★ —— 于是**纯后端的改动它完全是瞎的**:
#   v0.7.9(latex 文件名改 ASCII)、v0.7.10(名单顿号)都是纯后端,那道闸对它们等于没跑,
#   却照样打印「★线上版本与代码一致 —— 通过★」。
#   2026-08-22 我为此花了很多轮怀疑「是不是没部署、是不是构建缓存、是不是连错库」,
#   而真凶另有其人 —— 但这道闸在整个过程中**一次有用的信息都没给过**。
#   ★一道只检查一半、却报「一致」的闸,比没有闸更坏:它让人以为这一项已经有人守了。★
back=$(curl -sS --max-time 20 --cacert "$CA" "$B/version" \
       | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -z "$back" ]; then
  # 拿不到 = 量不到,不是通过。老版本后端没有 /version 这个端点,升上去一次之后就有了。
  echo "期望 $want   前端 [$got]   后端 [取不到]"
  echo "★问不到后端版本(GET /version)—— 不能当成通过★"
  echo "  若线上还是 v0.7.12 及更早,那是它还没有这个端点:先把本次改动部署上去。"
  exit 2
fi
echo "期望 $want   前端 [$got]   后端 [v$back]"
case " $got " in
  *" $want "*)
    if [ "v$back" = "$want" ]; then echo "★前后端版本都与代码一致 —— 通过★"; exit 0; fi
    echo "★前端是 $want,但**后端**是 v$back —— 门禁不通过★"
    echo "  同一个镜像里前后端版本不一致,通常意味着构建复用了旧的编译产物。"
    exit 1 ;;
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
