#!/usr/bin/env bash
# ★第十八道:三项治理配置只许走 effective_*,不许直接读常量 / state.config★(2026-08-16)
#
# ══ 它拦的是哪一类错 ══
# 三项配置(谁能建项目 / 全站默认配额 / 全站默认提醒提前量)2026-08-16 起可以由超管
# 在后台改。取值的唯一推导在 `src/settings.rs`:库 > env > 编译期默认。
#
# 而绕过它的后果是★安静的★:某处仍读旧常量 → 超管在界面上改了、页面也显示新值,
# **行为却还是旧的**。没有报错、没有日志、没有失败的请求 —— 只有「我明明改了啊」。
#
# `effective_llm_model` 的头注 2026-08-16 就写下过这句警告。但那是一句注释,
# ★注释拦不住下一个人★ —— 下一个人多半根本不会读到它(他只是在别处 grep 了个常量名)。
# 这道闸把那句注释变成一条会红的规则,和「旧命名」那道同一形状。
#
# ⚠ 这道闸只看文本,所以它也会拦住「合法地提到这些名字」——
#   允许出现的地方逐个白名单在下面,加白名单时**必须想清楚为什么那里读裸值是对的**。
#
# ⚠★整行是注释的跳过★(2026-08-16 写完第一版当场撞上):
#   第一版把「// 别读 state.config.project_creators」这类**解释为什么不能读**的注释
#   全判成了违规 —— 而那正是这道闸想保住的知识。
#   ★这和我之前踩的 ddl-check 是同一个形状:一道把规则照字面编码的门禁,
#     拦的不再是错误,而是正确的做法。★ 判据是**取值路径**,不是「提到这个名字」。
#   ⚠ 只跳过**整行注释**:`let x = DEFAULT_QUOTA_BYTES;  // 说明` 这种照样要红 ——
#     行尾挂个注释就能豁免的话,这道闸一天就废了。
# ⚠★变量名一律 ASCII★:bash 不接受中文标识符(`SYMS=(` → “not a valid identifier”)。
#   我在这个仓库里已经栽过四次,每次的表现都一样 —— ★门禁因为一个假原因变红★,
#   而假红比不红更浪费时间:它会让人去查一个根本不存在的规则违反。注释照旧写中文。
set -uo pipefail
cd "$(dirname "$0")/.."

# 被守的三个符号。★key 的字面量不在此列★:那是数据不是取值路径。
SYMS=(
  "DEFAULT_QUOTA_BYTES"
  "DEFAULT_REMIND_MIN"
  "config.project_creators"
)

# 允许出现的位置(逐条给理由):
#   · src/settings.rs      —— 唯一推导自己,它当然要读兜底值
#   · src/config.rs        —— 常量的定义处
#   · scripts/             —— 本脚本
ALLOW='^(src/settings\.rs|src/config\.rs|scripts/)'

HITS=0
for sym in "${SYMS[@]}"; do
  # -F 固定字符串:`config.project_creators` 里的点不该当通配符
  while IFS= read -r line; do
    f=${line%%:*}
    [[ "$f" =~ $ALLOW ]] && continue
    # 去掉「路径:行号:」前缀,只看代码本身;整行注释(// /// //! * #)跳过
    code=${line#*:}; code=${code#*:}
    case "$(printf '%s' "$code" | sed 's/^[[:space:]]*//')" in
      //*|/\**|\**|\#*) continue ;;
    esac
    echo "  ✗ $line"
    HITS=$((HITS + 1))
  done < <(grep -rnF "$sym" src/ scripts/ 2>/dev/null || true)
done

if [ "$HITS" -gt 0 ]; then
  cat <<'TXT'

★门禁不通过★:上面这些地方绕过了 settings.rs 的唯一推导。
改法:
  · 配额     → crate::settings::effective_default_quota(pool).await.0
  · 提醒     → crate::settings::effective_default_remind(pool).await.0
  · 建项目名单 → crate::settings::effective_project_creators(pool, &state.config).await.0
⚠ 别用 `#[allow]` 式的绕法或加白名单图省事 —— 这类错**不报错**,
  它的全部代价都落在「超管改了不生效,而且没人知道」上。
TXT
  exit 1
fi
echo "★取值路径门禁通过★:三项治理配置只从 settings.rs 的 effective_* 取"
