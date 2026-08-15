#!/usr/bin/env bash
# ★已应用的迁移不许再改★(2026-08-16,congrove 开出 prod 通道当天加)
#
# ══ 为什么今天才有这道闸 ══
# 在此之前 ADR-0001 说「上线前每次部署清库重建,`migrations/` 永远只有一个 0001_init.sql,
# 它可以随便改」—— 那条纪律**存在的唯一理由**是「还没有任何要保护的数据」。
# 2026-08-16 prod 通道开出来,理由没了,ADR-0001 当场失效,规矩回到 **只增不改**。
#
# 而「改了老迁移」这件事的报应是**延迟且致命**的:sqlx 存着当初那个文件的 sha384,
# 对不上就**拒绝启动** —— `migration N was previously applied but has been modified`。
# 它不在编译期、不在测试里,而是在**部署那一刻**才炸。
# ★2026-08-15 晚上这件事已经在 dev 上真实发生过一次(pod CrashLoop),那次代价是改个校验和;
#   同样的操作从今天起发生在 prod 上就是生产事故。★
#
# 判据:`migrations/*.sql` 的 sha384 必须逐个等于 `migrations/checksums.txt` 里登记的。
#   · 改老文件 → 红(这正是要拦的);
#   · 加新文件 → 红,提示你去登记 —— ★登记是一个**有意识**的动作★,不该顺手发生。
# ★纯静态,不连任何库,能进 CI★(所以它也永远不会碰到 prod 的数据)。
set -uo pipefail
cd "$(dirname "$0")/.."
LIST=migrations/checksums.txt
[ -f "$LIST" ] || { echo "★找不到 $LIST —— 不能当成通过★"; exit 2; }

FAIL=0; SEEN=0
while read -r want name; do
  case "$want" in ''|'#'*) continue;; esac
  SEEN=$((SEEN+1))
  f="migrations/$name"
  if [ ! -f "$f" ]; then
    echo "  ✗ ★登记过的迁移 $name 不见了★ —— 已应用的迁移不能删"; FAIL=1; continue
  fi
  got=$(python3 -c "import hashlib,sys;print(hashlib.sha384(open(sys.argv[1],'rb').read()).hexdigest())" "$f") \
    || { echo "★算不出 $f 的哈希★"; exit 2; }
  if [ "$got" = "$want" ]; then echo "  ✓ $name"
  else
    echo "  ✗ ★$name 被改过了★"; echo "      现在 = $got"; echo "      登记 = $want"; FAIL=1
  fi
done < "$LIST"
[ "$SEEN" -gt 0 ] || { echo "★$LIST 里一条登记都没有 —— 不能当成通过★"; exit 2; }

# 反向:有文件却没登记
for f in migrations/*.sql; do
  n=$(basename "$f")
  grep -q "  $n\$" "$LIST" || { echo "  ✗ ★新迁移 $n 没有登记★"; FAIL=1; }
done

if [ "$FAIL" != 0 ]; then
  cat <<'TXT'

★门禁不通过★:prod 已存在,迁移是**只增不改**的。
  · 要改 schema:新建 `migrations/0002_xxx.sql`(别动老文件),然后把它登记进 checksums.txt:
        python3 - <<'PY'
        import hashlib,pathlib
        p=pathlib.Path('migrations/0002_xxx.sql')
        print(hashlib.sha384(p.read_bytes()).hexdigest()+'  '+p.name)
        PY
    把这一行追加到 migrations/checksums.txt。
  · 如果你**确实**只是想在 dev 上改着玩:那也不行 —— 同一个文件会跟着镜像上 prod。
TXT
  exit 1
fi
echo "★迁移冻结门禁通过★:$SEEN 个已登记迁移内容未变"
