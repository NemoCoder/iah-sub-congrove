#!/usr/bin/env bash
# ★第十七道:代码里的迁移文件,和 dev 库记着的「我跑过的那份」还是同一份吗★(2026-08-15)
#
# ══ 它补的是哪一格 ══
# 现有十六道闸全都在问「代码自己对不对」,★没有一道在问「代码和**运行环境的状态**还对得上吗」★。
# 2026-08-15 当晚就掉进这一格:v0.4.165 往 `0001_init.sql` 里加了一个视图
# (ADR-0001 允许随便改这个文件,**但配套纪律是每次部署清库重建**,我漏了那一步)。
# 十六道全绿、CI 全绿、PR 合并、部署 —— 一路没有任何一处提到「dev 库还不知道你改了它」,
# 直到 pod 起不来:`Error: migration 1 was previously applied but has been modified`。
# ★唯一会发现问题的东西是生产环境本身,而那是最贵的发现方式。★
#
# 判据:sqlx 在 `_sqlx_migrations` 里存的是当时那个文件的 **SHA-384**。这里把同一个比对**提前**到本地。
#
# ⚠ 进不了 CI(要连活库),和 SQL PREPARE / schema 对拍 / 响应体形状同一类 ——
#   PR 里如实标「人工验证」,别标成 CI 绿。
# ⚠ 「量不到」不算通过:连不上库 / 读不到文件一律 exit 2;prod 没配 DSN 则 **exit 3 = 未跑**
#   (all-gates 会把 3 显示成「? 未跑」,既不算绿也不算红)。
#
# ★★这个脚本对库**只做 SELECT**,一个字节都不写★★(2026-08-16 liaoruili:「prod 里面禁止动任何数据」)。
#   它读的只有 `_sqlx_migrations` 一张表的 checksum 列。要修不一致,那是**人**的动作,
#   脚本只负责告诉你哪儿不一致 + 打印两条出路,绝不代劳。
#
# ══ ★[prod] 那一行会**永远**显示「未核」,这是定下来的,不是待办★ ══
#   2026-08-16 逐条过需求时问过 liaoruili:「要不要给一个只读 DSN,让这格真有人守?」
#   ——★他选了「不给,保持现状」★:congrove 的开发侧完全不碰 prod 库,连只读也不连。
#   所以别再看见这行「? 未核」就去找 DSN、去申请账号、或者把它当成配置漏了。
#   ⚠ 随之而来的**已知缺口**,写在这儿免得被忘记:
#     「已应用到 prod 的迁移文件被改过」这件事,**没有任何机械门禁拦得住**。
#     还在守的只有两样:① `migrations/checksums.txt`(守文件内容不变,见上一道门禁)、
#     ② 部署时 sqlx 自己会拒(代价是 pod 起不来 —— 也就是本文件开头那种最贵的发现方式)。
#   要改这个决定,得先有 prod 的只读账号;那是 liaoruili 的决定,不是脚本能自己补的。
set -uo pipefail
cd "$(dirname "$0")/.."
# ★dev 侧不再需要 DSN★:走 db/sql 接口(dbq.py)。prod 侧仍用 DSN(那个接口 prod 是 403)。
CONGROVE_DEV_DSN="${CONGROVE_DEV_DSN:-（走 db/sql 接口，不用 DSN）}"

FAIL=0; FOUND=0; PROD_SKIPPED=0

核一个库() {   # 核一个库() <通道名> <DSN>
  local ch=$1 dsn=$2 f ver mine theirs
  for f in migrations/*.sql; do
    [ -e "$f" ] || continue
    [ "$ch" = dev ] && FOUND=$((FOUND + 1))
    ver=$(basename "$f" | sed -E 's/^0*([0-9]+).*/\1/')
    mine=$(python3 -c "import hashlib,sys;print(hashlib.sha384(open(sys.argv[1],'rb').read()).hexdigest())" "$f") || { echo "★算不出 $f 的校验和★"; exit 2; }
    # ★只读★:整个脚本对库的全部操作就是下面这一条 SELECT
    # ★不直连库,走平台的 db/sql 接口★(2026-08-17,见 scripts/dbq.py 头注):
    #   iah101 成为集群节点后直连 PG 被 data-tier NP 挡掉;而这几道闸本来就不需要直连。
    #   dbq.py 的输出刻意与 `psql -At` 同格式,所以这里除了换个命令什么都没变。
    #   ⚠ prod 通道这个接口是 403(dev-only),所以 prod 那半仍旧只能靠 DSN —— 而 liaoruili
    #     2026-08-16 定了「不给 prod DSN」,于是 [prod] 那行照旧「未核」(见下面头注那一节)。
    if [ "$ch" = dev ]; then
      theirs=$(IAH_TOKEN="${IAH_TOKEN:-$(cat "$HOME/.config/iah/congrove-token" 2>/dev/null)}" \
        python3 scripts/dbq.py -c \
        "SELECT encode(checksum,'hex') FROM _sqlx_migrations WHERE version = $ver") \
        || { echo "★读不到 dev 的 _sqlx_migrations —— 不能当成通过★"; exit 2; }
    else
      theirs=$(psql "$dsn" -Atc \
        "SELECT encode(checksum,'hex') FROM _sqlx_migrations WHERE version = $ver") \
        || { echo "★连不上 $ch 库,查不到 _sqlx_migrations —— 不能当成通过★"; exit 2; }
    fi
    if [ -z "$theirs" ]; then
      # 库里没这一条 = 这个库还没跑过它(全新库),启动时会正常跑一遍,不是问题。
      echo "  · [$ch] $f:该库还没跑过它(启动时会跑)—— 跳过"
      continue
    fi
    if [ "$mine" = "$theirs" ]; then
      echo "  ✓ [$ch] $f 与库记录一致"
    else
      echo "  ✗ ★[$ch] $f 改过了,而库里记的还是老的★"
      echo "      文件 = $mine"
      echo "      库里 = $theirs"
      FAIL=1
    fi
  done
}

核一个库 dev "$CONGROVE_DEV_DSN"

# ★prod 才是从今天起真正不能出错的那个★(2026-08-16 开通道):dev 上对不上只是「改个记录」,
#   prod 上对不上是**生产 pod 起不来**。所以这道闸必须也看 prod。
#   ⚠ prod 的 DSN 不放在 dev 那份配置里 —— 单独放 `~/.config/iah/congrove-prod.env`(仓库外,600),
#     里面一行 `CONGROVE_PROD_DSN=postgresql://…`(★建议用只读角色★:这个脚本只 SELECT)。
#   ⚠ 没配就 **exit 3 = 未跑**,★绝不当成通过★ —— 「我没查」和「查了没问题」是两件事。
if [ -z "${CONGROVE_PROD_DSN:-}" ] && [ -f "$HOME/.config/iah/congrove-prod.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$HOME/.config/iah/congrove-prod.env"; set +a
fi
if [ -n "${CONGROVE_PROD_DSN:-}" ]; then
  核一个库 prod "$CONGROVE_PROD_DSN"
else
  echo "  ? [prod] 未核:缺 CONGROVE_PROD_DSN(见本脚本头注)"
  PROD_SKIPPED=1
fi

[ "$FOUND" -gt 0 ] || { echo "★migrations/ 下一个文件都没有 —— 不能当成通过★"; exit 2; }

if [ "$FAIL" != 0 ]; then
  cat <<'TXT'

★门禁不通过★:这样部上去,pod 会 CrashLoop 在
    Error: migration N was previously applied but has been modified
⚠★prod 已开,ADR-0001 失效:已应用的迁移只增不改★。真要改 schema 是**新建** 0002_xxx.sql。
下面两条只适用于 **dev**(prod 上不要做第 ①、第 ② 也只有在你确认过结构等价时才由**人**执行):
  ① 清库重建(CLAUDE.md 里那五条 SQL)—— 干净,但清掉 dev 全部数据;
  ② 先证明「现库结构已等于新迁移建出来的样子」:
       bash scripts/schema-check.sh sim-diff migrations/0001_init.sql   # 差异必须为 0
     确认之后再把记录改成实话:
       UPDATE _sqlx_migrations SET checksum = decode('<文件的 sha384>','hex') WHERE version = 1;
★别反过来做★:先改记录再看结构,那是把「对不上」这件事盖掉,不是解决它。
TXT
  exit 1
fi
if [ "$PROD_SKIPPED" = 1 ]; then
  echo "★dev 一致,但 prod 未核 —— 标记为「未跑」,不算通过★"
  exit 3
fi
echo "★迁移校验和门禁通过★:代码里的迁移与 dev / prod 两个库的记录都一致"
