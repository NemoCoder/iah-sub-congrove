#!/usr/bin/env bash
# 字段级 schema 的覆盖率闸 —— ★只减不增★。
#
# ══ 为什么需要它 ══
# 「给 109 个接口补 request/response schema」是个做很久的活,而做很久的活有一个
# 共同的死法:★做了一半,新接口又不带 schema 加进来,净欠账原地踏步★ ——
# 而没有任何东西会指出这件事(契约照样生成、门禁照样绿)。
#
# 这道闸把「还欠多少」变成一个**会红的数字**:欠账只许变少。
# 新加接口不带 schema → 数字变大 → 红。补完一批 → 数字变小 → 提示你更新基线。
#
# ⚠★基线是「还欠多少」,不是「已完成多少」★:前者归零就是做完了,
#   而后者要跟着接口总数一起变,新增接口时会自己往上飘,盯不住任何东西。
# ⚠★bash 里的变量名一律 ASCII★ —— 本仓库栽到第六次了(2026-08-22 又一次):
#   `总数=$(...)` 不是赋值,bash 把它当**命令名**执行 → `总数=109: command not found`,
#   而 `$?` 只反映最后一条命令,★门禁照样 exit 0★。
#   「赋值静默失败 + 门禁照报绿」是这个坑最坏的形状:它不吭声。
#   (中文**注释**和**输出文案**没问题,只有标识符不行。)
set -uo pipefail
cd "$(dirname "$0")/.."
BASE=docs/schema-coverage-baseline.txt
[ -f "$BASE" ] || { echo "★找不到 $BASE —— 不能当成通过★"; exit 2; }
want=$(grep -oE '^[0-9]+' "$BASE") || { echo "★基线文件里读不到数字★"; exit 2; }
[ -n "$want" ] || { echo "★基线文件里读不到数字★"; exit 2; }

got=$(cargo run -q --bin openapi-dump 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['info']['x-iah-schema-coverage']['响应体未接'])") \
  || { echo "★生成不了契约,量不到覆盖率 —— 不能当成通过★"; exit 2; }
[ -n "$got" ] || { echo "★量不到覆盖率 —— 不能当成通过★"; exit 2; }

TOTAL=$(cargo run -q --bin openapi-dump 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['info']['x-iah-schema-coverage']['总数'])")
[ -n "$TOTAL" ] || { echo "★量不到接口总数 —— 不能当成通过★"; exit 2; }
echo "响应体未接 schema:$got / $TOTAL 条(基线 $want)"
if [ "$got" -gt "$want" ]; then
  cat <<TIP
★欠账变多了 —— 门禁不通过★
  基线 $want → 现在 $got。多半是**新加的接口没带 schema**。
  写法(src/http/apidoc.rs 的 api! 宏):
      api!("GET", "/api/x", "组", "登录", "说明", "", res: crate::http::x::XOut)
  响应类型要 #[derive(serde::Serialize, schemars::JsonSchema)];
  ★doc 注释会自动变成契约里的 description,所以注释照常写就行。★
TIP
  exit 1
fi
if [ "$got" -lt "$want" ]; then
  echo "★欠账变少了($want → $got)—— 把基线改小,把这份进展固定下来★:"
  echo "  echo $got > $BASE   # 并在提交信息里说明这批接了哪些"
  exit 1
fi
echo "★与基线持平 —— 通过★"
