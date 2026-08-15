// ★M0 的门禁：把「指纹对照」变成 exit code★（2026-08-08）
//
// 用法：
//   node golden-diff.mjs golden/before.json golden/after.json            # 检查
//   node golden-diff.mjs golden/before.json golden/after.json --freeze   # 把当前差异冻成预期
// exit 0 = 只有事先声明过的变化；exit 1 = 出现了没人声明的差异。
//
// ══════ 为什么需要这个脚本（前一版的门禁是**可证伪**的）══════
//
// 技术设计 v2 把 M0 的唯一门禁写成「指纹 diff **只有 key 名变化**」。
// 拿真实基线一对就破了：里面存着
//   deny.meeting.past.body.error = "会议开始时间不能早于现在"
//   projects[].quota_bytes       = 10737418240
// 而设计自己要求**删掉**那条校验、**删掉**那一列。
// ★判据在第一个 PR 落地那一刻就为假★，于是实际执行必然退化成
// 「人对着 200 行块移动的 diff 说服自己」—— 而那正是 golden 本来要防的事。
//
// ══════ ★2026-08-08 第二次改造：白名单从「人写的清单」换成「程序生成的 diff」★ ══════
//
// 上一版把预期变更写成 `EXPECTED_CHANGES` —— 11 条手写条目，每条带 path / why /
// 可选的 from-to。它能用，但有一个结构性缺陷：
// **它是「人写的声明」，评审得核对「声明」和「代码」是否一致**，而声明会随代码前进自动过期。
// ★这正是相位 4 反复送审八轮的根因（平台已把这条写进 DEV-PROCESS.md）。★
//
// 现在改成：**预期差异本身就是一个 checked-in 的文本文件 `golden/expected.diff`**，
// 由 `--freeze` 生成，评审直接读差异。它不可能和现实不符 —— 不符就是红。
//
// ★顺带修好了一个上一版明确记着「结构上守不住」的洞★（原注释说别再试第三次）：
//   `is_private` 换定义时，判反产生的值与正确实现**数值一模一样**，只是落在不同的行上，
//   写 from/to 也核销得掉，因为白名单条目是**按路径模式**匹配的（`*` 通配下标）。
//   而 expected.diff 把 **路径 + 旧值 + 新值** 逐行钉死、且要求**逐字节相等**：
//   判反会让这些行落到不同路径上 → 文本对不上 → 红。
//   （具名断言 `safety-net.spec.ts` 的四组合仍然保留 —— 两道各守各的，不互相替代。）
import fs from 'node:fs'
import path from 'node:path'

// ── ① 机械改名：归一化后不算差异 ──────────────────────────────
// 顺序有意义：长的先替，否则 `meeting_id` 会被 `meeting` 的规则先啃掉。
//
// ⚠ 为什么改名仍然要归一化、而不是让它们原样进 expected.diff：
//   M0 的改名会产生**几百行**差异，全塞进 expected.diff 就没人读得动了，
//   而「读得动」正是这个文件存在的理由。改名有 `scripts/no-meeting.sh` 单独守。
const RENAMES = [
  ['meeting_id', 'activity_id'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_projects', 'activity_projects'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meetings', 'activities'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting', 'activity'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
]
const rename = (s) => RENAMES.reduce((acc, [a, b]) => acc.split(a).join(b), s)

// ── ② 逐路径比 ─────────────────────────────────────────────
const args = process.argv.slice(2)
const freeze = args.includes('--freeze')
const [beforeFile, afterFile] = args.filter((a) => !a.startsWith('--'))
if (!beforeFile || !afterFile) {
  console.error('用法: node golden-diff.mjs <before.json> <after.json> [--freeze]'); process.exit(2)
}
const EXP = path.join(path.dirname(beforeFile), 'expected.diff')
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'))
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'))

/// 把嵌套对象摊平成 `a.b.c = 值` 的清单，便于逐路径比对。
function flat(v, prefix, out) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v)) flat(v[k], prefix ? `${prefix}.${k}` : k, out)
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => flat(x, `${prefix}.${i}`, out))
  } else {
    out[prefix] = v
  }
  return out
}
// ★两侧都过一遍改名★，不是只归一化 before。
// 改名规则对**已经改过名**的一侧是空操作（`activity_id` 里不含 `meeting_id`），所以幂等；
// 而只归一化一侧的话，拿两份**同为改名前**的文件自比会报出一堆假差异
// —— 2026-08-08 第一版就是这么写的，自检时当场露馅。
// ★一个用来判定回归的脚本，必须先能通过「同一份输入比自己」这道最基本的自检。★
const A = flat(JSON.parse(rename(JSON.stringify(before))), '', {})
const B = flat(JSON.parse(rename(JSON.stringify(after))), '', {})

const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()
const changes = []
for (const k of keys) {
  const a = JSON.stringify(A[k]), b = JSON.stringify(B[k])
  if (a !== b) changes.push(`${k}: ${a} → ${b}`)
}
const actual = changes.join('\n')

// ── ③ 与事先冻结的预期比 ────────────────────────────────────
if (freeze) {
  fs.writeFileSync(EXP, actual ? actual + '\n' : '')
  console.log(`★已冻结 ${changes.length} 处预期变更 → ${EXP}★`)
  console.log('→ ★提交前逐行读一遍★：每一行都该是你**打算**造成的变化。')
  console.log('  这个文件就是评审要看的东西 —— 它是程序生成的，不会和现实脱节。')
  process.exit(0)
}
const expected = fs.existsSync(EXP) ? fs.readFileSync(EXP, 'utf8').trimEnd() : null

if (!actual) {
  // ★「你什么都没做」不能是全绿★：老的 schema-diff.mjs 就栽在这一格（评审实测能骗过它）。
  if (expected) {
    console.error(`★两份指纹**毫无差异**，但 ${EXP} 声明了 ${expected.split('\n').length} 处预期变更 —— 门禁不通过★`)
    console.error('→ 要么改动还没部署上去，要么 after.json 是拿旧代码采的，要么 expected.diff 是陈的。')
    process.exit(1)
  }
  console.log('★两份指纹一致 —— 门禁通过★'); process.exit(0)
}
if (expected === null) {
  console.error(`★出现 ${changes.length} 处变更，但没有 ${EXP} —— 门禁不通过★`)
  console.error('→ 逐行读一遍下面的差异，确认每一条都是**有意为之**，再用 --freeze 冻结：\n')
  console.error(actual)
  process.exit(1)
}
if (actual === expected) {
  console.log(`★${changes.length} 处变更全部与 ${EXP} 逐字节相符 —— 门禁通过★`)
  process.exit(0)
}
// 对不上：把「预期」与「实际」之间的差异打出来（这是**差异的差异**，读的时候留神）
const exp = new Set(expected.split('\n')), act = new Set(changes)
console.error('★实际差异与事先声明的预期对不上 —— 门禁不通过★\n')
const gone = [...exp].filter((l) => !act.has(l)), came = [...act].filter((l) => !exp.has(l))
if (gone.length) { console.error(`声明了却没发生（${gone.length} 条）—— 这条改动是不是漏做了？`); for (const l of gone) console.error('  - ' + l) }
if (came.length) { console.error(`\n没声明却发生了（${came.length} 条）—— 真实回归，或者你忘了重新 --freeze：`); for (const l of came) console.error('  + ' + l) }
process.exit(1)
