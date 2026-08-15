#!/usr/bin/env bash
# 内容寻址的不变量 —— ★写成闸,不写成一句设计说明★（docs/TECH-DESIGN-content-addressing.md D1）。
#
# 要守的一句话:★`blobs/<H>` 这个对象里的字节,哈希必须等于 H★。
# 去重、秒传、引用计数全建在它上面。
#
# ⚠★2026-08-09 全量审计 A2(两路独立视角同时报出)★:预签名直传原来直接拿**客户端申报的 sha**
# 当 key,于是任何人都能先占住 `blobs/<别人文件的哈希>` 塞垃圾 ——
# 真正拥有那份文件的人后来上传时会被「对象已存在就直接引用」静默引用到垃圾,还打上 sha_verified,
# 继续作为秒传源扩散。全程无报错。
#
# 根治的形式是「**谁能往 `blobs/*` 写**」:收敛成唯一一条路径 —— 服务端算完真实哈希之后的归位。
# 这个脚本把那句话变成可执行判据:★除 `items.rs::blob_key` 之外,源码里不得出现字面量 "blobs/"★。
# 少了它,下一个人加一条上传路径时随手拼一个 `format!("blobs/{sha}")` 就能重新打开这个洞,
# 而且不会有任何东西发现 —— 那正是这次审计里反复出现的形状(「注释声称 ≠ 代码实现」)。
set -euo pipefail
cd "$(dirname "$0")/.."

# 只认 Rust 源码;注释里当然可以谈论它(这个仓库的注释就是文档)
hits=$(grep -rn '"blobs/' src/ --include='*.rs' | grep -vE '^\s*src/[a-z_/]*\.rs:[0-9]+:\s*(//|///)' || true)
# 唯一允许的那一处:blob_key 的函数体
allowed=$(grep -n 'format!("blobs/{sha}")' src/http/items.rs || true)
bad=$(echo "$hits" | grep -v 'format!("blobs/{sha}")' || true)

if [ -n "$bad" ]; then
  echo "★内容寻址门禁不通过★:规范 key 只能由 items.rs::blob_key 产出(见 TECH-DESIGN-content-addressing.md D1)。"
  echo "下面这些地方直接拼了 \"blobs/\":"
  echo "$bad"
  exit 1
fi
if [ -z "$allowed" ]; then
  echo "★内容寻址门禁不通过★:找不到 items.rs::blob_key 的定义 —— 它是规范 key 的唯一产出点,别把它改没了。"
  exit 1
fi
echo "★内容寻址门禁通过★:规范 key 只由 items.rs::blob_key 产出,别处零处直接拼 \"blobs/\""
