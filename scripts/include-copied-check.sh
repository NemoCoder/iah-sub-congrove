#!/usr/bin/env bash
# ★`include_str!` / `include_bytes!` 引用的路径必须被 Dockerfile COPY 进镜像★ —— 纯静态,进 CI。
#
# ══ 为什么要这道闸 ══
# 2026-09-03:`src/minutes_pdf.rs` 用 `include_str!("../assets/minutes.latex")` 把纪要模板
# 编进二进制,而 Dockerfile 里没有 `COPY assets`。后果是:
#   · 本地 `cargo check` 全绿(文件就在工作区);
#   · ★20 道门禁全绿★ —— 它们**全都在本地跑**;
#   · 只有 kaniko 在集群里报 `No such file or directory`,构建失败。
#
# ★「本地有这个文件」和「镜像里有这个文件」是两件事★,而在此之前
# **没有任何一处会指出这件事** —— 只有构建日志,而那要等到部署才看得见。
set -uo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import re, pathlib, sys
docker = pathlib.Path('Dockerfile')
if not docker.exists():
    print('★找不到 Dockerfile —— 不能当成通过★', file=sys.stderr); sys.exit(2)
# 只看 build 阶段 COPY 进来的**本地路径**(跳过 `--from=` 的阶段间拷贝)
copied = set()
for line in docker.read_text(encoding='utf-8').splitlines():
    m = re.match(r'\s*COPY\s+(?!--from=)(.+)', line)
    if not m: continue
    parts = m.group(1).split()
    for p in parts[:-1]:                     # 最后一个是目的地
        copied.add(p.strip().rstrip('/'))

引用 = []
for f in pathlib.Path('src').rglob('*.rs'):
    t = f.read_text(encoding='utf-8')
    for m in re.finditer(r'include_(?:str|bytes)!\s*\(\s*"([^"]+)"', t):
        引用.append((f, m.group(1)))
if not 引用:
    print('★没有 include_str!/include_bytes! —— 无需检查,通过★'); sys.exit(0)

坏 = []
for f, rel in 引用:
    真 = (f.parent / rel).resolve()
    try: 仓内 = 真.relative_to(pathlib.Path.cwd())
    except ValueError:
        坏.append((f, rel, '指到仓库外')); continue
    if not 真.exists(): 坏.append((f, rel, '文件不存在')); continue
    # 它的任一祖先目录(或它自己)被 COPY 了就算数
    顶 = str(仓内).split('/')[0]
    if 顶 not in copied and str(仓内) not in copied:
        坏.append((f, rel, f'`{顶}` 不在 Dockerfile 的 COPY 里'))
if 坏:
    print(f'★{len(坏)} 处 include_ 引用进不了镜像 —— 门禁不通过★', file=sys.stderr)
    for f, rel, why in 坏: print(f'  ✗ {f}: include!("{rel}") —— {why}', file=sys.stderr)
    print('\n  在 Dockerfile 的 build 阶段加一行 `COPY <目录> ./<目录>`。', file=sys.stderr)
    sys.exit(1)
print(f'★{len(引用)} 处 include_ 引用都在 Dockerfile 的 COPY 范围内 —— 门禁通过★')
PY
