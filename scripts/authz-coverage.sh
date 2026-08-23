#!/usr/bin/env bash
# ★每个写接口都要判权★ —— 纯静态扫描,进 CI。
#
# ══ 为什么值得一道闸 ══
# 「漏判权」是本仓最严重的一类缺陷(2026-08-09 审计的 A1 就是:判的是项目、写的是活动),
# 而它**没有任何现成的东西守着** —— clippy 不管、类型不管、shape-check 只看形状。
# 新加一个 POST/PUT/DELETE 忘了写 require_*,所有门禁照样全绿。
#
# ⚠★这个脚本自己被审计出过一个 bug(2026-08-23)★:初版按**函数名全树搜**,
#   而 `storage.rs` 里也有个 `pub async fn copy(` —— 它先被命中,于是检查的是错的那个函数,
#   `items::copy` 被误报成「没判权」。★一个会漏报的审计工具比没有更坏★:
#   它给的是虚假的安心。现在按路由里的**模块名**定位文件。
set -uo pipefail
cd "$(dirname "$0")/.."
python3 - "$@" <<'PY'
import re, pathlib, sys
mod = pathlib.Path('src/http/mod.rs').read_text(encoding='utf-8')
routes = re.findall(r'\.route\(\s*"([^"]+)"\s*,\s*(.+?)\)\n', mod, re.S)
写 = [(m.upper(), p, fn) for p, spec in routes
      for m, fn in re.findall(r'\b(post|put|delete|patch)\(([\w:]+)\)', spec)]
if not 写:
    print('★一条写接口都没扫到 —— 路由解析失败,不能当成通过★', file=sys.stderr); sys.exit(2)

def 找体(fn):
    if '::' in fn:
        m, name = fn.rsplit('::', 1)
        cands = [pathlib.Path(f'src/http/{m}.rs'), pathlib.Path(f'src/{m}.rs')]
    else:
        name, cands = fn, [pathlib.Path('src/http/mod.rs')]
    for f in cands:
        if not f.exists(): continue
        t = f.read_text(encoding='utf-8')
        for pat in (f'pub async fn {name}(', f'async fn {name}('):
            i = t.find(pat)
            if i < 0: continue
            j, k = t.find('\npub async fn ', i+10), t.find('\nasync fn ', i+10)
            return t[i:min(x for x in (j, k, len(t)) if x > 0)]
    return None

# ★守卫的定义要宽到「有没有把调用者身份纳入判断」这一层★,不能只认 require_role。
#
# ⚠ 初版只认那几个 require_*,结果 12 条**合法**接口被报成漏判权:
#   自建活动类型(判 owner==本人)、标自己的已读、自助旁听……它们都靠
#   `require_username()` 拿到身份、再在 SQL 里按身份过滤。
#   ★一道会误报的门禁会被人忽略,等于没有★ —— 它抓的应该是
#   「**完全没有**任何权限考虑」的接口,不是「没用我列举的那几个函数」。
守卫 = (r'require_role|require_owner|require_activity_host|require_super|is_super_now|'
        r'require_material_owner|require_read_item|activity_material_access|'
        r'check_activity_target|require_participant|activity_view|require_username|_caller')

# ★路由层中间件也算★:`/admin/*` 整组挂了 `route_layer(require_super)`,
#   那些 handler 的签名里连 Identity 都没有 —— 逐个函数看必然误报。
层守卫 = set()
if 'auth::require_super' in mod:
    for p_, _ in routes:
        if p_.startswith('/admin/'): 层守卫.add(p_)
# 豁免:公开访客面靠 token 本身鉴权(share.rs 整章 fail-closed,见它的头注)
豁免 = {'share::pub_open'}
坏, 缺 = [], []
for m, path, fn in 写:
    if fn in 豁免 or path in 层守卫: continue
    body = 找体(fn)
    if body is None: 缺.append(f'{m} {path} → {fn}'); continue
    if not re.search(守卫, body): 坏.append(f'{m} {path} → {fn}')
if 缺:
    print('★这些 handler 定位不到源码 —— 量不到,不能当成通过★', file=sys.stderr)
    for x in 缺: print('  ?', x, file=sys.stderr)
    sys.exit(2)
if 坏:
    print(f'★{len(坏)} 条写接口没有任何权限调用 —— 门禁不通过★', file=sys.stderr)
    for x in 坏: print('  ✗', x, file=sys.stderr)
    print('\n  要么加 require_*,要么(确实该公开的)加进脚本里的「豁免」并写清理由。', file=sys.stderr)
    sys.exit(1)
print(f'★{len(写)} 条写接口全部有权限调用 —— 门禁通过★'
      f'(路由层守卫 {len(层守卫)} 条 / 显式豁免 {len(豁免)} 条)')
PY
