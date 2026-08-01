#!/usr/bin/env bash
# 给本仓库配三推远端:Gitea(内网,主)+ Gitee + GitHub(全局约定,见 ~/.claude/CLAUDE.md)。
# 之后 `git push origin dev` 一条命令推三处。本仓库 2026-08-01 已配好,此脚本供重建时用。
# ⚠ 仓库含内网 IP/拓扑(DESIGN.md 里的 172.10.0.x / *.svc),Gitee/GitHub 是外部仓,必须保持私有。
set -euo pipefail
SLUG="${1:-congrove}"
GITEA="https://git.ruciah.com/liaoruili/iah-sub-${SLUG}.git"
GITEE="https://gitee.com/ampeeg/iah-sub-${SLUG}.git"
GITHUB="https://github.com/NemoCoder/iah-sub-${SLUG}.git"

git remote remove origin 2>/dev/null || true
git remote add origin "$GITEA"
# 关键:给 origin 挂三个 push URL → 一条 push 推三端
git remote set-url --add --push origin "$GITEA"
git remote set-url --add --push origin "$GITEE"
git remote set-url --add --push origin "$GITHUB"

echo "已配三推 origin:"
git remote get-url --all --push origin | sed 's/^/  /'
echo "提交后执行: git push -u origin dev   (一次推 Gitea + Gitee + GitHub)"
