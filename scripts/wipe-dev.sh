#!/usr/bin/env bash
# ★清库重建★ —— ADR-0001:上线前每次部署都清库,`migrations/` 永远只有一个 0001_init.sql。
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
export PATH="$HOME/bin:$PATH"

echo "★这会清空 dev 库的全部数据★（ADR-0001:dev 没有要保护的数据）"
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
