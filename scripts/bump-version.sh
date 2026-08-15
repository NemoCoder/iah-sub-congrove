#!/usr/bin/env bash
# 升版本号 —— ★两处同步,而且**改不到就报错**★。
#
# 2026-08-15 踩的:我一直用 `sed -i '3s/0\.4\.158/0.4.159/'` 手改。
# 那天分支是从 0.4.157 拉的(基拉错了),于是这条 sed **一个字符都没匹配到,还退出 0** ——
# ★版本号静默没升,PR 标题写着 v0.4.159、代码里还是旧的,一路过了十一道门禁★。
# 判据要的是「读出来 + 加一 + 写回去 + 验证真的变了」,不是「把某个字面量替换掉」。
set -euo pipefail
cd "$(dirname "$0")/.."
cur=$(grep -m1 -oP '^version = "\K[0-9]+\.[0-9]+\.[0-9]+' Cargo.toml)
[ -n "$cur" ] || { echo "★Cargo.toml 里读不到 version★"; exit 1; }
IFS=. read -r a b c <<< "$cur"
new="${1:-$a.$b.$((c+1))}"
python3 - "$new" <<'PY'
import pathlib, re, sys
new = sys.argv[1]
for f, pat, rep in [
    ('Cargo.toml', r'^version = "\d+\.\d+\.\d+"', f'version = "{new}"'),
    ('web/src/version.ts', r"VERSION = 'v\d+\.\d+\.\d+'", f"VERSION = 'v{new}'"),
]:
    p = pathlib.Path(f); s = p.read_text(encoding='utf-8')
    s2, n = re.subn(pat, rep, s, count=1, flags=re.M)
    if n != 1:                       # ★改不到就炸,别静默放过★
        print(f"★{f} 里没匹配到版本号 —— 中止(不能让它静默不升)★"); sys.exit(1)
    p.write_text(s2, encoding='utf-8')
print(f"两处已同步到 {new}")
PY
# ★验证真的写进去了★:本仓的规矩是「每道闸都要能证明自己跑起来了」
grep -q "^version = \"$new\"" Cargo.toml && grep -q "VERSION = 'v$new'" web/src/version.ts \
  && echo "已核对:Cargo.toml 与 version.ts 都是 $new" \
  || { echo "★写回后核对失败★"; exit 1; }
echo "⚠ 别忘了 cargo check 刷新 Cargo.lock —— 漏了 kaniko 的 --locked 会直接拒绝构建。"
