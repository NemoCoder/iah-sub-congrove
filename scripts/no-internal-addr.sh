#!/usr/bin/env bash
# ★内网地址不许进仓库★ —— 本仓三推 Gitea(内网,主)+ Gitee + GitHub。
#
# ══ 为什么这是一道闸而不是一句约定 ══
# 2026-08-15 的对抗检查数出来:那台专用测试机的 `ws://<内网地址>:9333/congrove`
# 在 **11 个已跟踪文件里写死了 14 遍**,连 `ssh <用户名>@<内网地址>` 都在里面 ——
# ★地址 + 用户名 + 用途,一次给全★。而 Gitee / GitHub 是**外部仓**,推上去就是发出内网。
# 它不是谁疏忽了一次:第一处是「先跑通再说」,后面十三处是照着第一处抄的。
# ⇒ 约定拦不住抄,门禁可以。地址收在 `~/.config/iah/congrove-e2e.env`(见 e2e/pw-endpoint.mjs)。
#
# 判据:RFC1918 私网地址(10/8、172.16-31/12、192.168/16)出现在**已跟踪文件**里就红。
# ⚠ 只扫 git 跟踪的文件:未跟踪的临时脚本本来就不会外推,拦它只会逼人绕过这道闸。
# 真有必须写进仓库的(比如讲解某段历史事故),在同一行写 `addr-ok: <理由>` 声明。
# ★纯静态扫描,能进 CI。★
set -uo pipefail
cd "$(dirname "$0")/.."

# 172.16-31 才是私网;172.10.x 之类不是,但本平台内网正好用它,一并拦下(宁可多拦)。
PAT='(^|[^0-9.])(10\.[0-9]+\.[0-9]+\.[0-9]+|172\.(1[0-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)([^0-9.]|$)'
HITS=$(git grep -nIE "$PAT" -- . 2>/dev/null | grep -v 'addr-ok:' || true)

if [ -n "$HITS" ]; then
  echo "★已跟踪文件里出现内网地址 —— 门禁不通过★(本仓外推 Gitee/GitHub,进仓库=出内网):"
  printf '%s\n' "$HITS"
  echo
  echo "改法:地址进 ~/.config/iah/congrove-e2e.env,代码走 e2e/pw-endpoint.mjs 读;"
  echo "     确有必要写进仓库就在同一行加 // addr-ok: <理由>。"
  exit 1
fi
# ══ ★第二段:扫**提交信息**★(2026-08-17 补) ══
#
# ⚠ 这道闸原来只扫**已跟踪文件** —— 而★提交信息一样跟着外推到 Gitee/GitHub★。
#   2026-08-17 我在写一份事故说明时,把内网网段写进了两个提交信息里,
#   ★十几道门禁一道都没看见★(它们扫的是文件)。发现它的是我顺手 grep 了一遍 git log。
#
# ⚠ 只扫「本分支相对 dev 新增的」而不是全历史:已经推出去的改不了(改写历史 = non-FF,
#   而 push 是仓库所有者做的)。★门禁的职责是不让它**再**发生,不是追溯清洗。★
#
# ⚠★变量名一律 ASCII★:bash 不接受中文标识符。★这是我第五次栽在这上面★——
#   两小时前才在 scripts/no-bypass-effective.sh 的头注里写下同一条警告,然后在这里又犯一次。
#   ★自己写的警告拦不住自己,只有会红的规则拦得住。★
#   上一次的表现是当场炸;那一次更坏 —— 赋值没生效、`$变量` 原样打印,而门禁**照样退 0**,
#   是一个安静的假绿。
BASE=$(git rev-parse --verify -q gitea/dev 2>/dev/null || git rev-parse --verify -q origin/dev 2>/dev/null || true)
if [ -n "$BASE" ]; then
  DIRTY=""
  for H in $(git log --format='%H' "$BASE..HEAD" 2>/dev/null); do
    if git log -1 --format='%B' "$H" \
       | grep -qE '(^|[^0-9.])(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}'; then
      DIRTY="$DIRTY$(git log -1 --format='  %h %s' "$H" | cut -c1-76)
"
    fi
  done
  if [ -n "$DIRTY" ]; then
    echo "★提交信息里出现内网地址 —— 门禁不通过★(提交信息同样会外推到 Gitee/GitHub):"
    printf '%s' "$DIRTY"
    echo '改法:还没推的话 git commit --amend / git rebase -i 改掉那几条信息;'
    echo '     说明网络问题时写「内网网段」「pod 网段」这类描述,别写具体地址。'
    exit 1
  fi
fi

echo "★内网地址门禁通过★:已跟踪文件里零处私网 IP"
