#!/usr/bin/env bash
# 给当前子系统仓库配 Gitea(内网) + Gitee(外部) 双远端。
# 之后 `git push origin main` 会一次推到两端。
# 用法: ./setup-remotes.sh <标识>
# 前提: 已 git init；并在 Gitea / Gitee 各建好私有仓库 iah-sub-<标识>（token 找管理员要）。
set -euo pipefail
SLUG="${1:?用法: ./setup-remotes.sh <标识>}"
GITEA="https://git.ruciah.com/liaoruili/iah-sub-${SLUG}.git"   # 内网 Gitea（git.iahdev.com 已弃），按需改 owner
GITEE="https://gitee.com/ampeeg/iah-sub-${SLUG}.git"           # 外部备份，按需改 owner

git remote remove origin 2>/dev/null || true
git remote add origin "$GITEA"
# 关键：给 origin 配两个 push URL → 一条 push 命令推两端
git remote set-url --add --push origin "$GITEA"
git remote set-url --add --push origin "$GITEE"

echo "已配双远端 origin:"
git remote -v | sed 's/^/  /'
echo "提交后执行: git push -u origin main   (一次推 Gitea + Gitee)"
