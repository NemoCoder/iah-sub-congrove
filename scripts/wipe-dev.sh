#!/usr/bin/env bash
# ★重置 **dev** 库★ —— ⚠ 这是全仓唯一会销毁数据的脚本,读完这段再往下敲。
#
# ══════ 2026-08-16:它的定位变了,而且变得更危险 ══════
# 原来它是**部署流程的一步**(ADR-0001:上线前每次部署都清库)。那条 ADR 在 prod 通道开出来
# 的那一刻**已经失效** —— 现在的纪律是「已应用的迁移只增不改」,而 ★prod 有真实数据,必须保住★
# (2026-08-16 liaoruili 强调)。
# 所以它现在只是**开发时重置 dev 的工具**,不再是任何流程的一环。
#
# ══════ 它原来只靠「变量名叫 DEV」来保证不打错库 ══════
# `: "${CONGROVE_DEV_DSN:?}"` —— ★变量名不是证据★。同时 source 过几个 env 文件、
# 复制粘贴串行、临时改一下配置……任何一次都足以让这条 `DROP SCHEMA public CASCADE`
# 落在 prod 上。而它没有确认、没有目标校验,敲下去就没了。
# ⇒ 现在**判据取自库自己**(`current_database()` / `current_user`),不取自变量名;
#   并且要求显式确认。★一个能销毁数据的脚本,必须自己证明它打的是哪个库。★
#
# ══════ 为什么要有这个脚本 ══════
# 这五条 SQL 已经手敲过五六次,而★少敲一条 pod 就起不来★,且报错文案指着错的方向:
#   `no schema has been selected to create in` —— 听起来像 search_path,真凶是 ACL。
# 清库用的是 `_cli` 角色,`CREATE SCHEMA` 会让新 schema 归它所有,app 角色一点权限都没有
# → sqlx 跑迁移时建不了表 → CrashLoopBackOff。后两条(OWNER TO / GRANT TO _cli)是承重的。
#
# 顺带把「清完必须重启 pod」也做进来:清库会把 `app_user.is_super` 一起清掉,
# 而超管位现在是**启动时**种进去的(lib.rs),不重启就没人是超管 —— 而当事人的会话还没过期,
# 他不会再走一次登录,于是超管入口凭空消失。
#
# 用法:source ~/.config/iah/congrove-dev.env && bash scripts/wipe-dev.sh
set -euo pipefail
: "${CONGROVE_DEV_DSN:?先 source ~/.config/iah/congrove-dev.env}"
# `--dry-run`:两道闸照走,到真正 DROP 之前停下。★销毁性脚本必须有一条能演练的路径★ ——
# 否则「闸放行之后会怎样」这件事,只能靠真删一次来验证。
DRY=${1:-}
export PATH="$HOME/bin:$PATH"

# ── ★闸一:问库自己是谁★ ────────────────────────────────────────────────
# 不信变量名,连上去问 `current_database()` / `current_user`。两者都必须带 dev 标记。
WHO=$(psql "$CONGROVE_DEV_DSN" -tAc "SELECT current_database() || '|' || current_user") \
  || { echo "★连不上目标库 —— 中止(连不上就更不该往下走)★"; exit 2; }
DB=${WHO%%|*}; USR=${WHO##*|}
echo "目标库:$DB   连接角色:$USR"
case "$DB" in
  *_dev) ;;                     # 只认库名以 _dev 结尾
  *) echo "★拒绝执行★:目标库是「$DB」,不以 _dev 结尾。"
     echo "  这个脚本只能重置 dev。★prod 有真实数据,永远不许清★(2026-08-16 liaoruili)。"
     exit 1 ;;
esac
case "$USR" in
  *_dev|*_dev_cli) ;;
  *) echo "★拒绝执行★:连接角色是「$USR」,不像 dev 的角色。"; exit 1 ;;
esac

# ── ★闸二:让人把库名打出来★ ────────────────────────────────────────────
# 销毁性操作不接受「顺手回车」。非交互场景(脚本里调)用 WIPE_YES=<库名> 显式表态。
echo "★这会清空「$DB」的全部数据(DROP SCHEMA public CASCADE)★"
if [ "${WIPE_YES:-}" = "$DB" ]; then
  echo "  (WIPE_YES 已显式指定为 $DB,跳过交互确认)"
else
  printf '  确认请完整输入库名 [%s]: ' "$DB"
  # ⚠★变量名只能 ASCII★:写成 `read -r 回答` 会报 `not a valid identifier`,
  #   于是**输对了也中止** —— 又一道「永远失败的闸」。今晚这是第三次栽在中文变量名上
  #   (no-naked-time.sh 头注里就写着这条,我照样又犯)。
  read -r ANS || true
  [ "$ANS" = "$DB" ] || { echo "★输入不符,已中止(什么都没做)★"; exit 1; }
fi
if [ "$DRY" = "--dry-run" ]; then
  echo "✓ 两道闸都通过(目标 $DB / 角色 $USR)—— --dry-run,到此为止,一个字节都没动"
  exit 0
fi
psql "$CONGROVE_DEV_DSN" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO sub_congrove_dev;      -- app 角色
ALTER SCHEMA public OWNER TO sub_congrove_dev;       -- ★交回去★,否则 app 建不了表
GRANT ALL ON SCHEMA public TO sub_congrove_dev_cli;  -- 门禁脚本还要连
SQL
echo "✓ 库已清空"

# 重启 pod:让 sqlx 重跑迁移 + lib.rs 重新种超管位
kubectl -n subsystems rollout restart deploy/sub-congrove-dev
kubectl -n subsystems rollout status deploy/sub-congrove-dev --timeout=180s
echo "✓ pod 已重启并就绪"

# ★验它真的建起来了★ —— 「跑完没报错」不等于「表建出来了」,本仓库栽过五次「没跑→空输出→报绿」。
#
# ⚠★别只数一次★(2026-08-10 踩到):`rollout status` 返回时迁移事务可能还没提交,
# 而**未提交的 DDL 对另一个会话不可见** —— 第一次实测就读到「1 张表 / 2 个视图」这种
# 自相矛盾的快照(两个数字取自同一个事务的两侧),脚本当场报了个假警报。
# 轮询到稳定为止:这不是「多等等碰运气」,是★把判据从某个瞬间的读数换成收敛后的状态★。
for i in $(seq 1 20); do
  n=$(psql "$CONGROVE_DEV_DSN" -tAc "SELECT count(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null || echo 0)
  [ "${n:-0}" -ge 20 ] && break
  sleep 2
done
v=$(psql "$CONGROVE_DEV_DSN" -tAc "SELECT count(*) FROM information_schema.views WHERE table_schema='public'")
echo "public 里有 $n 张表 / $v 个视图"
[ "${n:-0}" -ge 20 ] || { echo "★表太少,迁移多半没跑成★"; exit 1; }
# 视图是判据的载体,少一个就会有一整条路径静默走错版本 —— 单独点名核对。
psql "$CONGROVE_DEV_DSN" -tAc "SELECT table_name FROM information_schema.views
  WHERE table_schema='public' ORDER BY 1" | sed 's/^/  视图: /'
