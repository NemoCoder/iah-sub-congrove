#!/usr/bin/env bash
# ★门禁二：schema 差异逐条确认★（2026-08-08）
#
#   scripts/schema-check.sh baseline        # 把当前库的 schema 冻成基线（改造前跑一次）
#   scripts/schema-check.sh check           # 现库 vs 基线，差异必须**逐字节等于** expected.diff
#   scripts/schema-check.sh render          # 只渲染，打到 stdout
#
# 连接从环境变量 `CONGROVE_DEV_DSN` 取（★口令绝不入库★，放 ~/.config/iah/congrove-dev.env）。
#
# ══════ 为什么白名单是一个 **diff 文件** 而不是一张清单 ══════
#
# 老的 `schema-diff.mjs` 用「人写的 EXPECTED_ADDS 清单」核销差异 —— 于是评审得核对
# 「清单」和「代码」是否一致，而清单会随代码前进自动过期。★这正是相位 4 卡八轮的根因。★
# 这里改成：**预期差异本身就是一个 checked-in 的 diff 文件**，由程序生成、评审直接读差异。
# 它不可能和现实不符 —— 不符就是红。
#
# ══════ 三个它比老脚本强的地方 ══════
#
# ① ★「你什么都没做」不再是全绿★：老脚本实测能被「把 0001~0007 原样 cat 成一个 0001、
#    一处不改名」骗过（exit 0）。这里如果 expected.diff 非空而实际 diff 为空，两者不等 → 红。
# ② 覆盖四个盲区（UNIQUE 索引 / 生成列 / 类型精度 / 列顺序）—— 见 schema_ddl.sql 头注。
# ③ 不依赖 `pg_dump`：服务端 PG 18.4，本机 pg_dump 只有 16.14，★低版本客户端拒绝 dump
#    高版本服务端★（实测 `aborting because of server version mismatch`）。目录查询没有这个耦合。
set -uo pipefail
cd "$(dirname "$0")/.."
DIR=schema; BASE=$DIR/baseline.sql; EXP=$DIR/expected.diff
# ★不再需要 DSN★:走 db/sql 接口(dbq.py)。sim-diff 那条路仍用 psql(要在一个事务里跑迁移再回滚)。
CONGROVE_DEV_DSN="${CONGROVE_DEV_DSN:-（走 db/sql 接口，不用 DSN）}"

# ★不直连库,走平台的 db/sql 接口★(2026-08-17,理由见 scripts/dbq.py 头注)。
# dbq.py 的输出刻意与 `psql -At` 同格式(无表头 / 列间 TAB / NULL 印空串),
# 所以基线不用重冻 —— ★换了取数通道但没换输出格式,这是刻意的★。
render() { IAH_TOKEN="${IAH_TOKEN:-$(cat "$HOME/.config/iah/congrove-token" 2>/dev/null)}" \
           python3 scripts/dbq.py -f scripts/schema_ddl.sql; }

# ★在事务里模拟「清库 + 跑新迁移」,渲染出它会建成什么样,然后回滚★
#
# 为什么需要它:重写 `0001_init.sql`(ADR-0001)之后,要在**部署之前**知道它建出来的 schema
# 和现状差在哪。否则只能「部了再看」,而按纪律部署要先 DROP SCHEMA —— 错了就得重来一轮。
# PG 的 DDL 是事务性的,所以整段 BEGIN…ROLLBACK,★对库零影响★(已实测)。
#
# ⚠ 它会在事务期间锁住 public 下的一切,dev 上的服务会短暂阻塞。只在 dev 用。
simulate() {
  local f=$1 out rc
  # ★-q 不能省★:不加的话 psql 会把 `CREATE TABLE` / `BEGIN` 这类**命令标签**打到 stdout,
  # 和渲染出来的 DDL 混在一起 —— 一眼看去像是「多了几十张表」。
  out=$(psql "$CONGROVE_DEV_DSN" -Atq -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SET client_min_messages = warning;   -- 压掉 DROP CASCADE 的几十行 NOTICE
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
\i $f
\i scripts/schema_ddl.sql
ROLLBACK;
SQL
  ); rc=$?
  # ★没跑 ≠ 全过★:迁移脚本报错时 psql 非零退出,绝不能把空输出当成「建出了个空 schema」
  [ $rc -ne 0 ] && { echo "$out" >&2; echo "★迁移脚本执行失败(见上),模拟中止★" >&2; return 1; }
  printf '%s\n' "$out"
}

case "${1:-check}" in
render) render ;;
simulate)
  [ -n "${2:-}" ] || { echo "用法: $0 simulate <迁移文件>"; exit 2; }
  simulate "$2" || exit 1 ;;
sim-diff)
  # 新迁移建出来的 schema vs 冻结基线 —— 部署之前就能逐行看差异
  [ -n "${2:-}" ] || { echo "用法: $0 sim-diff <迁移文件>"; exit 2; }
  T=$(mktemp); simulate "$2" > "$T" || { rm -f "$T"; exit 1; }
  diff -u --label baseline --label simulated $BASE "$T"; rc=$?; rm -f "$T"
  [ $rc -eq 0 ] && echo "★与基线逐行相同★"; exit 0 ;;
freeze)
  # ★把当前差异冻成预期★（M0-5 真部署那次才做，见 M0-PLAN）
  [ -f $BASE ] || { echo "没有基线，先跑 $0 baseline"; exit 2; }
  T=$(mktemp); render > "$T" || exit 1
  diff -u --label baseline --label current $BASE "$T" > $EXP; rm -f "$T"
  echo "★已冻结 $(grep -c '^[+-][^+-]' $EXP) 处预期变更 → $EXP★"
  echo "→ ★逐行读一遍★：每一行都该是你**打算**造成的 schema 变化。"; exit 0 ;;
baseline)
  mkdir -p $DIR && render > $BASE || exit 1
  echo "★基线已冻结★ $BASE（$(wc -l < $BASE) 行 / $(grep -c '^TABLE ' $BASE) 张表）"
  echo "→ 提交它。之后 schema 的每一处变动都要在 $EXP 里有对应的一行。" ;;
check)
  [ -f $BASE ] || { echo "没有基线，先跑 $0 baseline"; exit 2; }
  T=$(mktemp); render > "$T" || exit 1
  A=$(mktemp); diff -u --label baseline --label current $BASE "$T" > "$A"; rm -f "$T"
  if [ ! -s "$A" ]; then
    # 无差异：只有在「本来就不该有差异」时才算过
    if [ -s $EXP ]; then
      echo "★现库与基线**毫无差异**，但 $EXP 声明了预期变更 —— 门禁不通过★"
      echo "→ 要么改动还没部署上去（清库 + 部署 + rollout restart 三步做全了吗），"
      echo "  要么 $EXP 是陈的。★这一格就是老脚本「你什么都没做也全绿」的那个洞。★"
      rm -f "$A"; exit 1
    fi
    echo "★schema 与基线一致 —— 门禁通过★"; rm -f "$A"; exit 0
  fi
  if [ ! -f $EXP ]; then
    echo "★出现 $(grep -c '^[+-][^+-]' "$A") 处 schema 变动，但没有 $EXP —— 门禁不通过★"
    echo "→ 看一遍下面的差异，确认每一条都是**有意为之**，再执行："
    echo "    diff -u $BASE <($0 render) > $EXP && git add $EXP"
    cat "$A"; rm -f "$A"; exit 1
  fi
  if diff -q $EXP "$A" >/dev/null; then
    echo "★schema 差异逐字节等于 $EXP（$(grep -c '^[+-][^+-]' $EXP) 处，全部事先声明）—— 门禁通过★"
    rm -f "$A"; exit 0
  fi
  echo "★实际差异与 $EXP 对不上 —— 门禁不通过★"
  echo "（下面是「预期的差异」与「实际的差异」之间的差异；- 是预期里有而实际没有，+ 是冒出来的）"
  diff -u $EXP "$A" | tail -n +3
  rm -f "$A"; exit 1 ;;
*) echo "用法: $0 {baseline|check|freeze|render|simulate <f>|sim-diff <f>}"; exit 2 ;;
esac
