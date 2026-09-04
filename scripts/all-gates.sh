#!/usr/bin/env bash
# 一条命令跑完所有门禁 —— ★提交前跑它,别再手拼一串 &&★。
#
# ══ 为什么有这个脚本 ══
# 2026-08-13 我把一条**编译不过**的提交推进了 PR:那次是把 `pnpm typecheck` 和 `git commit`
# 写成了两行,前者失败拦不住后者。改用 `&&` 串起来之后又踩第二个坑 ——
# ★`grep -c` 在计数为 0 时退出码是 1，而 0 正是「没有 warning」这个好结果★,
# 于是整条链在「全绿」的那一刻断掉。
#
# ⇒ 两个教训写进这个脚本:
#   ① ★门禁的通过/失败不能靠管道里最后一个命令的退出码猜★,每道闸各自明确判定;
#   ② ★一道闸「没跑成」必须算红,不能算绿★ —— 本仓库栽过五次「工具没跑 → 输出为空 → 报绿」。
#
# ══ ★这份清单是唯一的一份★(2026-08-15) ══
# 在此之前有两份:本仓 CI(.gitea/workflows/ci.yml)内联写了一串,本脚本又写了一串,
# 两串**各缺对方几道** —— CI 有 ddl-check / blobkey-check / 版本号一致而本地没有,
# 本地有 no-silent-limit / no-bare-items / no-naked-time 而 CI 没有。
# 于是「十一道全绿」「CI 全绿」这两句话谁也不覆盖谁,而没有任何东西会指出这件事。
# ⇒ CI 现在直接 `bash scripts/all-gates.sh --ci`,清单只剩这一份,加一道两边同时生效。
#
# 用法:
#   bash scripts/all-gates.sh          # 全部(要活库/内网 CA 的那几道缺环境时**标记为未跑**,不算绿)
#   bash scripts/all-gates.sh --ci     # 只跑不依赖活环境的那些(CI 用这个)
set -uo pipefail
cd "$(dirname "$0")/.."
CI_ONLY=${1:-}
# ⚠★变量名只能用 ASCII★:bash 的 identifier 不接受中文(和 TS/Rust 不一样,那两处我一直在用中文名),
#   写成 `declare -a 结果=()` 会直接 `syntax error near unexpected token '('` —— 我刚踩过。
declare -a RESULTS=()
FAILED=0
SKIPPED=0

# ★退出码 3 = 「这道闸没跑成」,既不算绿也不算红★(2026-08-16 加):
#   有些闸只能覆盖一部分环境(比如迁移校验和要连 prod 库,而 prod DSN 未必配了)。
#   把「没查」显示成绿是本仓栽过五次的那个坑;显示成红又会逼人去绕过它。
#   所以给它第三种结果,在汇总里明确写「? 未跑」——★看报告的人一眼知道这一格没有守护★。
gate() {   # gate <名字> <命令...>
  local name=$1; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  # 退出码约定(全树一致,别再分叉):
  #   0 = 通过 / 1 = 真的不通过 / ★2 = 整个量不到★ / ★3 = 部分没跑★
  # ⚠★2 以前落到 else 被显示成红★(2026-08-23 修):平台的 `db/sql` 接口 500 那天,
  #   依赖它的四道闸(PREPARE / schema 对拍 / 迁移校验和 / …)全打了 ✗ ——
  #   ★于是「环境挂了」长得和「你的代码有问题」一模一样,人会先去 debug 自己的改动。★
  #   `dbq.py` 的头注早就写明「exit 2 = 量不到」,而这里只认 3 —— 一个说了没人听的约定。
  #   ★「我没查」被报成「查出问题了」,和被报成「通过」一样坏,甚至更费人。★
  if [ $rc -eq 0 ]; then RESULTS+=("  ✓ $name")
  elif [ $rc -eq 2 ]; then RESULTS+=("  ? $name（★量不到,不算通过★,见下）"); SKIPPED=1
       printf '%s\n' "── $name 的输出 ──" "$out" | tail -12
  elif [ $rc -eq 3 ]; then RESULTS+=("  ? $name（部分未跑,见下）"); SKIPPED=1
       printf '%s\n' "── $name 的输出 ──" "$out" | tail -12
  else RESULTS+=("  ✗ ★$name★"); FAILED=1
       printf '%s\n' "── $name 的输出 ──" "$out" | tail -25; fi
}

gate "cargo clippy(零 warning)" cargo clippy --all-targets --locked -- -D warnings
gate "cargo test"               cargo test --locked
gate "旧命名(改名残留)"          bash scripts/no-meeting.sh --all   # no-meeting:allow —— 这一行是**调用那个门禁脚本本身**,文件名里就带这个词,改不了
# ★不许静默截断★(2026-08-14 新增):一周撞了三次「写死 LIMIT 又不给总数」——
#   回收站/我的分享 500、提醒 20、广场 200、待写纪要 50。★纯静态扫描,能进 CI。★
gate "不许静默截断(LIMIT)"       bash scripts/no-silent-limit.sh
# ★读内容不许碰裸 items★(2026-08-14):v0.4.144 建了 items_alive 视图把「软删过滤」收到一处,
#   但视图只是**让正确的路更好走**,不构成强制 —— 这道闸补上那一半:
#   读(SELECT)一律走视图,真要读已删行就在 SQL 里写 `-- items-ok: <理由>`。★纯静态,能进 CI。★
gate "读内容不碰裸 items"         bash scripts/no-bare-items.sh
# ★时间不许裸格式化★(2026-08-15 新增):库里存的全是 UTC,`.format()` 直接印出来就差 8 小时,
#   而且不报任何错(催办站内信这么错了不知道多久)。★纯静态,能进 CI。★
gate "时间不裸格式化(时区)"       bash scripts/no-naked-time.sh
# ★DDL 纪律(ADR-0001)★与★内容寻址不变量★:这两道**一直只在 CI 里跑**,本地这份漏了 ——
#   于是「本地十一道全绿」这句话从来都不是全部,而两边各有各的清单这件事本身
#   就是漂移源(2026-08-15 对抗检查数出来的)。★现在 CI 直接调本脚本 --ci,清单只有这一份。★
gate "DDL 纪律(裸 CREATE TABLE)"  bash scripts/ddl-check.sh
gate "内容寻址(A2/D1)"           bash scripts/blobkey-check.sh
# 版本号两处一致:CI 里原来是内联的 shell,抽成脚本才能两边共用(逻辑一字不改,含那条
# 「只认 export const VERSION 那一行」的坑注)。
# ★内网地址不许进仓库★(2026-08-15 新增):本仓外推 Gitee/GitHub,进仓库=出内网。
#   一台测试机的地址曾在 11 个已跟踪文件里写死 14 遍(连 ssh 用户名一起)。★纯静态,能进 CI。★
# ★已应用的迁移不许改★(2026-08-16 开 prod 当天加):ADR-0001 失效,回到「只增不改」。
#   改老迁移的报应是**延迟且致命**的 —— prod pod 起不来,而且是在部署那一刻才炸。
#   ★纯静态、不连任何库(所以也永远碰不到 prod 数据),能进 CI。★
gate "已应用的迁移不许改"         bash scripts/migration-frozen-check.sh
gate "内网地址不入库"             bash scripts/no-internal-addr.sh
# ★取值只走 effective_*★(2026-08-16 超管后台):三项治理配置改成超管可配之后,
#   任何一处仍读旧常量都会造成「超管改了、页面显示新值、行为还是旧的」——
#   ★这类错不报错★,只能靠一道会红的规则拦。★纯静态,能进 CI。★
gate "取值只走 effective_*"       bash scripts/no-bypass-effective.sh
gate "版本号两处一致"             bash scripts/version-sync-check.sh
gate "前端 tsc"                  bash -c 'cd web && pnpm typecheck'
gate "前端 test"                 bash -c 'cd web && pnpm test'

# ══ ★这三道是纯离线的,2026-09-04 从 non-CI 块里搬出来★ ══
#   搬迁前它们和「要活 dev 库」的那几道混在同一个 `if` 里,于是 **CI 里一次都没跑过**。
#   而它们其实一样都不依赖活环境:`authz-coverage` 是纯 grep;`schema-coverage` 只跑
#   `cargo run --bin openapi-dump`;`api-check` 也只要那个离线 dump —— 它唯一缺的是
#   runner 上没装 oasdiff,平台 2026-09-04 装好了(v1.29.1,群 msg 461)。
#   ★最刺眼的是「写接口都判权」★:漏判权是本仓最严重的一类缺陷(A1 就是),
#   我在它的注释里写着「在此之前没有任何东西守着它」—— 加了闸,却把它加在了
#   合并门禁**够不着**的地方,于是「新加一个 POST 忘了 require_*」在 CI 里照样全绿。
#   ★一道只在作者本机跑的闸,守的是作者的自觉,不是这个仓库。★
gate "写接口都判权" bash scripts/authz-coverage.sh
gate "接口面 api-check" bash scripts/api-check.sh check
# 字段级 schema 的欠账只许变少 —— 见脚本头注:做很久的活的共同死法是「做了一半就停在那」。
gate "schema 覆盖率(只减不增)" bash scripts/schema-coverage.sh

if [ "$CI_ONLY" != "--ci" ]; then
  # ══ ★这三道 2026-08-17 起不再直连库,走平台的 db/sql 接口★(scripts/dbq.py 头注写了来龙去脉)══
  #   起因:iah101 加入集群成为节点后,直连 PG 被 `data-tier-isolation` 这条 NetworkPolicy 挡掉。
  #   ★我的第一反应是去请平台改那条 NP,而 liaoruili 问了一句「你需要实现什么功能」★ ——
  #   一查:没有任何**产品功能**需要直连,只有这三道开发期门禁需要;
  #   而平台早有 `POST /api/subsystems/{slug}/db/sql`(dev-only),`sql-prepare-check.py`
  #   本来就默认走它。⇒ 那个请求是多余的,已在群里撤回。
  #   ★教训:遇到「连不上」先问「我到底需不需要这条路」,别直接跳到「怎么把这条路修通」。★
  #
  #   ⚠ 所以这里**不再用 `CONGROVE_DEV_DSN` 当开关** —— 用它当开关的话,
  #     一个没配 DSN 的环境(比如 CI)会把这三道显示成「未跑」,而它们其实跑得了。
  #     令牌从 `IAH_TOKEN` 或 `~/.config/iah/congrove-token` 取,取不到各脚本自己 exit 2(= 红,不是绿)。
  #   ⚠ prod 那半仍要 DSN(db/sql 对 prod 是 403),而 liaoruili 定了不给 —— 那一格照旧「未核」。
  gate "SQL 对真库 PREPARE" python3 scripts/sql-prepare-check.py
  gate "schema 对拍"        bash scripts/schema-check.sh check
  # ★迁移校验和★(2026-08-15 事故当晚补的):前十六道全在问「代码自己对不对」,
  #   ★没有一道在问「代码和**运行环境的状态**还对得上吗」★ —— 改了 0001_init.sql
  #   却没清库,一路全绿到 pod CrashLoop。这一道把 sqlx 启动时那个比对提前到本地。
  gate "迁移校验和(dev/prod)"      bash scripts/migration-checksum-check.sh
  # ★每个写接口都要判权★(2026-08-23 全量审计的产物):漏判权是本仓最严重的一类缺陷
  #   (A1 就是),而在此之前**没有任何东西守着它** —— 新加一个 POST 忘了 require_*,门禁照样全绿。
  # ★响应体形状★(2026-08-14 新增):补的是 api-check 看不见的那一半 ——
  #   生成的契约里响应只写 `{"description":"成功"}`、没有 schema,于是把响应体
  #   从 `[...]` 改成 `{total, items}`(2026-08-13,货真价实的破坏性变更)时,
  #   ★八道门禁一道都没红★。这一道直接对着**真实响应**比形状,那次改动实测会被它抓住。
  #   ⚠ 它要跑 golden.mjs 打真实请求,比别的闸慢(约 40s),且同样进不了 CI。
  if [ -n "${IAH_E2E_KEY:-}" ]; then
    gate "响应体形状对拍" bash scripts/shape-check.sh check
  else
    RESULTS+=("  ? 未跑:响应体形状对拍（缺 IAH_E2E_KEY）"); SKIPPED=1
  fi
fi

printf '\n══ 门禁汇总 ══\n'
printf '%s\n' "${RESULTS[@]}"
# ★「有闸没跑」不能报成「全部通过」★(2026-08-16):本仓栽过五次「工具没跑 → 输出为空 → 报绿」,
#   而我刚给 exit 3 加完「? 未跑」这一档,汇总行**还是照旧打「全部通过」** —— 等于把刚做的区分又抹掉了。
#   三种收尾各说各话:全绿 / 全绿但有格子没守 / 有红。
if [ $FAILED -ne 0 ]; then echo "★有门禁未通过 —— 不要提交★"
elif [ $SKIPPED -ne 0 ]; then echo "★没有红,但上面带「?」的格子**没跑**(不等于通过)—— 提交前想清楚那几格谁来守★"
else echo "★全部通过★"; fi
# ★在 CI 里,「?」也是红★(2026-09-04)。本地允许「?」是因为有些闸确实只能在配了 prod DSN
#   的环境跑,人看见问号自己会掂量;而 CI 是**合并门禁**,没有人在看 —— `exit $FAILED`
#   会把「oasdiff 没装成 → 量不到 → ?」原样报成绿,那正是本仓栽过五次的「没跑报成通过」。
#   ⚠ 前提是 `--ci` 挑出来的这一组**每一道都能在 runner 上真跑起来**:是的,它们全是
#     静态扫描 / cargo / pnpm,没有一道要库、要凭据、要内网 CA。所以这里出现问号
#     只有一种解释:runner 环境坏了或缺工具 —— 那本来就该拦下合并。
if [ "$CI_ONLY" = "--ci" ] && [ $SKIPPED -ne 0 ]; then
  echo "★CI 里不接受「未跑」—— runner 上这几道本该都能跑,出问号即环境有问题★"; exit 1
fi
exit $FAILED
