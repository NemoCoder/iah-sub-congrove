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
# ══ ★判据是「prod 跑过它没有」,不是「文件存不存在」★(2026-08-16 订正) ══
# 第一版我把判据写成「**所有**迁移文件都必须登记且内容不变」—— 而那会挡住正确的做法:
# prod 冻在 v0.5.0、到 0.6 才 promote,★在那之前 `0002` 是一个**工作文件**★:
# 可以反复改、dev 清库重建,等它真上了 prod 才该冻住。
# ⇒ 我加这道闸时脑子里的模型就是错的,和前一天刚拆掉的 `ddl-check`「只能有一个迁移文件」
#   **是同一个毛病**:★一道编码着过期规则的门禁,拦的不是错误,是正确的做法。★
#
# 现在:
#   · `checksums.txt` 里登记的 = **prod 已应用**的 → 内容必须一字不变(改了 → 红);
#   · 没登记的 = **工作中、还没上 prod** → 随便改,不管;
#   · ★但工作中的最多只能有一个★ —— liaoruili 2026-08-16:「到 0.6 的时候应该只有一个 0002」。
#     攒成 0002/0003/0004 会让「这一轮到底改了什么」散在几个文件里,而它们本可以是一份。
#   · 登记过的文件被删 → 红(prod 跑过的迁移不能凭空消失)。
# promote 到 prod 之后:把那个工作文件的哈希追加进 checksums.txt(★一个有意识的动作★),
# 它就冻住了,下一轮开新的。
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

# ★没登记的还要再分两档★(2026-09-03,一次真实事故换来的):
#
#   ⚠ 原来这里只问「上没上 prod」,没上就算「工作中、随便改」。
#     ★那个判据少了一半★:0003 确实没上 prod,但它**已经进了 dev 分支、
#     被 dev 线上正在跑的实例应用过** —— 我改了它的内容并同步了 dev 库的 checksum,
#     三分钟后 dev pod 就起不来了(`migration 3 was previously applied but has been modified`),
#     CrashLoopBackOff 6 次。因为**线上那一刻跑的还是旧镜像**,它带的是旧内容。
#
#   ⇒ 真正的判据是「★有没有任何还在运行的实例应用过它★」,而不是「上没上 prod」。
#     静态可判的近似:**这个文件在不在 dev 分支上** —— 进了 dev 就意味着
#     dev 环境早晚(通常是立刻)会跑它。
#
#   · 已登记          → prod 跑过,冻死;
#   · 未登记但在 dev  → ★dev 跑过,同样冻死★,加列请新开一个文件;
#   · 未登记且不在 dev→ 真·工作文件,随便改,而且**只能有一个**(合成一份)。
DEVREF=""
for r in gitea/dev origin/dev dev; do git rev-parse --verify -q "$r" >/dev/null 2>&1 && { DEVREF=$r; break; }; done
# ⚠★拿不到 dev ref 就别猜★(2026-09-03):没有它就判不出「哪些迁移 dev 已经应用过」,
#   而**静默退化回旧判据**会给出一个危险的结论 ——「0003 还是工作文件,可以随便改」,
#   那正是今天把 dev 弄挂的那句话。CI 里第一次跑就撞上了(它只 fetch 当前 ref)。
#   ★判不了要说判不了(exit 2 = 量不到),不能替换成一个更宽松的判据。★
if [ -z "$DEVREF" ]; then
  echo "★取不到 dev ref(gitea/dev / origin/dev / dev)—— 判不出哪些迁移 dev 已应用★" >&2
  echo "  这道闸的一半判据依赖它,量不到就不算通过。" >&2
  echo "  CI 里请先: git fetch --depth=1 <repo> dev:refs/remotes/gitea/dev" >&2
  exit 2
fi
WORKING=""
for f in migrations/*.sql; do
  n=$(basename "$f")
  grep -q "  $n\$" "$LIST" && continue
  if [ -n "$DEVREF" ] && git cat-file -e "$DEVREF:migrations/$n" 2>/dev/null; then
    # 在 dev 分支上 = dev 环境已经应用过 → 内容也必须冻住
    got=$(python3 -c "import hashlib,sys;print(hashlib.sha384(open(sys.argv[1],'rb').read()).hexdigest())" "$f")
    want=$(git show "$DEVREF:migrations/$n" | python3 -c "import hashlib,sys;print(hashlib.sha384(sys.stdin.buffer.read()).hexdigest())")
    if [ "$got" = "$want" ]; then
      echo "  ✓ $n(未上 prod,但 dev 已应用 —— 内容同样冻住)"
    else
      echo "  ✗ ★$n 已经在 dev 上跑过了,不许改内容★"
      echo "      改它会让**正在跑旧镜像的实例**起不来:"
      echo "        Error: migration N was previously applied but has been modified"
      echo "      ⇒ 加列请**新开一个迁移文件**。(2026-09-03 已经这么炸过一次。)"
      FAIL=1
    fi
    continue
  fi
  echo "  ~ $n(真·工作中:既没上 prod、也不在 $DEVREF 上,可以随便改)"
  WORKING="$WORKING $n"
done
CNT=$(printf '%s' "$WORKING" | wc -w)
if [ "$CNT" -gt 1 ]; then
  echo "  ✗ ★同时有 $CNT 个真·工作中的迁移:$WORKING★"
  echo "      liaoruili 2026-08-16:「到 0.6 的时候应该只有一个 0002」——"
  echo "      这些都还没被任何环境应用过,本可以合成一份。"
  FAIL=1
fi

if [ "$FAIL" != 0 ]; then
  cat <<'TXT'

★门禁不通过★:**已经上过 prod 的迁移**不许改(没上过的那个随便改)。
  · 要改 schema:改**工作中**那个迁移(现在是 0002);没有就新建一个,★别动已登记的★。
  · 等它 promote 到 prod 之后,再把哈希登记进 checksums.txt 冻住它:
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
