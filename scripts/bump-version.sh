#!/usr/bin/env bash
# 升版本号 —— ★两处同步,而且**改不到就报错**★。
#
# 2026-08-15 踩的:我一直用 `sed -i '3s/0\.4\.158/0.4.159/'` 手改。
# 那天分支是从 0.4.157 拉的(基拉错了),于是这条 sed **一个字符都没匹配到,还退出 0** ——
# ★版本号静默没升,PR 标题写着 v0.4.159、代码里还是旧的,一路过了十一道门禁★。
# 判据要的是「读出来 + 加一 + 写回去 + 验证真的变了」,不是「把某个字面量替换掉」。
#
# ⚠★这个脚本没有、也不该有「调用方」★(2026-08-15 盘点门禁时确认):它是**人手动跑**的工具,
#   而「万一有人绕过它手改版本号」这件事由 `scripts/version-sync-check.sh` 兜底 ——
#   那一道在 all-gates.sh / CI 里,两处版本号对不上就红。
#   ★工具治源头,门禁兜结果;别为了「有人调用」把工具塞进门禁里(那会让每次跑门禁都改文件)。★
set -euo pipefail
cd "$(dirname "$0")/.."
cur=$(grep -m1 -oP '^version = "\K[0-9]+\.[0-9]+\.[0-9]+' Cargo.toml)
[ -n "$cur" ] || { echo "★Cargo.toml 里读不到 version★"; exit 1; }
IFS=. read -r a b c <<< "$cur"
new="${1:-$a.$b.$((c+1))}"
# ★显式传进来的版本号必须是版本号★(2026-09-04 踩的):我照着别的工具的习惯敲了
#   `bump-version.sh patch`,脚本把 "patch" 当**字面版本号**写进了两个文件,
#   而下面那道「核对」只比对「两处是不是都等于 $new」—— 两处确实都成了 `patch`,
#   于是它打印「已核对:两处都是 patch」并退出 0。
#   ★一道只验「我写的和我想写的一样」的闸,验不出「我想写的本身就是错的」★。
#   本脚本不收 major/minor/patch 这类关键字:不带参数就是 patch+1,要别的自己写全。
[[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "★'$new' 不是版本号★ —— 用法:bump-version.sh(patch+1) 或 bump-version.sh 0.7.34"; exit 1; }
# 再挡一次「往回退」:手写时敲错一位就是个静默的降级,而两处仍然「同步」。
[ "$(printf '%s\n%s\n' "$cur" "$new" | sort -V | tail -1)" = "$new" ] && [ "$new" != "$cur" ] || {
  echo "★$new 不比当前的 $cur 新★ —— 版本号只能往前走"; exit 1; }
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
