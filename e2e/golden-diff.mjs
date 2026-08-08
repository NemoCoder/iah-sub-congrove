// ★M0 的门禁：把「指纹对照」变成 exit code★（2026-08-08）
//
// 用法：`node golden-diff.mjs golden/before.json golden/after.json`
//        exit 0 = 只有事先声明过的变化；exit 1 = 出现了没人声明的差异。
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
// 所以这里把它拆成两件事：
//   ① RENAMES —— 机械改名，归一化掉，**不算差异**；
//   ② EXPECTED_CHANGES —— 行为变更，★必须事先逐条声明、带 PRD 条款号★，核销掉；
//   ③ 剩下的任何差异 → 非零退出。
//
// ★事先声明的白名单，和事后为 diff 找理由，是两件完全不同的事。★
// 前者逼你在动手之前想清楚「这次要改的行为到底有哪些」；
// 后者只会让每一条意外差异都找到一个听起来合理的解释。
import fs from 'node:fs'

// ── ① 机械改名：归一化后不算差异 ──────────────────────────────
// 顺序有意义：长的先替，否则 `meeting_id` 会被 `meeting` 的规则先啃掉。
const RENAMES = [
  ['meeting_id', 'activity_id'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_projects', 'activity_projects'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meetings', 'activities'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting', 'activity'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
]
const rename = (s) => RENAMES.reduce((acc, [a, b]) => acc.split(a).join(b), s)

// ── ② 事先声明的行为变更 ────────────────────────────────────
// 路径写法：`<快照名>` 或 `<快照名>.<json 路径>`；`*` 匹配任意一段。
// 每条**必须**写 why（PRD/技术设计的条款号）—— 没有依据的变更不叫「预期」。
//
// ★可选的 `to`（以及 `from`）：写了就必须**精确对上**才算核销★。
//   为什么需要它（2026-08-08 自查时发现的洞）：只写 path 的条目等于说
//   「这个字段允许变」，而**没说变成什么**。对 `is_private` 这种布尔来说，
//   fixture 里正反两条的值一旦**对调**（正是「判反」的表现），
//   两条都落在同一个 path 上、都被核销 —— 刚补上的负样本当场作废。
//   所以凡是「值有确定期望」的变更，一律写死 to。
//   ⚠ 对不上时它**不会**被核销 → 报成未声明差异 → 门禁红。这是 fail-closed，是想要的：
//   宁可让人看一眼，也不要让一个判反的布尔从白名单底下溜过去。
const EXPECTED_CHANGES = [
  { path: 'deny.activity.past',        why: 'PRD F0：去掉「不能排过去时间」的校验，该请求由 400 变 200' },
  { path: 'deny.activity.noproject',   why: 'PRD A1：project_ids 仅 needs_project 的类型必填' },
  { path: 'projects.body.<of>.*.quota_bytes', to: undefined, why: 'PRD L3：配额挪到 user_quota，projects 这一列删除' },
  // ⚠ ★这一条**故意**只声明「它会变」，不声明「变成什么」—— 因为白名单在结构上守不住它★
  //   （2026-08-08 两轮实测得出的结论，别再试第三次）：
  //   指纹摊平成 `…<of>.<下标>.is_private` 之后，`visibility` 与 `is_private`
  //   **在同一行里的关联就丢了**，而「判反」恰恰只体现在这个关联上 ——
  //   判反产生的变化 `false→true` / `true→false` 与正确实现产生的**数值一模一样**，
  //   只是落在不同的行上，写 from/to 也核销得掉。
  //   ★所以这条语义由具名断言守：`safety-net.spec.ts` 的「安全网·is_private 语义」四组合。★
  //   分工：golden 抓**意料之外**的变化；**已知**的语义变更由具名测试守。
  { path: 'activities.list.body.<of>.*.is_private',
    why: 'PRD J4 换定义。★新值由 safety-net.spec.ts「安全网·is_private 语义」四组合断言守，不由本白名单守★' },
  { path: 'freebusy',                  why: 'PRD A4：判据改成 activities.busy，不再要求关联公开项目' },
  // ⚠ ★整块前缀豁免 = me/stats 的所有改动都没有机械守卫★（评审 P2-2）。
  //   其中包括 PRD L0b 残留边界②那条**安全性收紧**（口径只认 accepted）——
  //   把整块放过，等于那条收紧改没改、改反没改，golden 都不吭声。
  //   → 收窄成逐字段，并给「只认 accepted」在 safety-net 里配一条具名断言（§5.2b）。
  { path: 'me.stats.body.by_type',     why: 'PRD K：新增按类型分组' },
  { path: 'me.stats.body.by_project',  why: 'PRD B3：归档项目计入，带 archived 标记' },
  { path: '*.body.<of>.*.type_id',     why: 'PRD A1：活动新增 type_id（NOT NULL）' },
  { path: '*.body.<of>.*.busy',        why: 'PRD A1：活动新增 busy' },
  { path: '*.body.type_id',            why: 'PRD A1（详情形态）' },
  { path: '*.body.busy',               why: 'PRD A1（详情形态）' },
]
const pathMatches = (pat, path) => {
  const p = pat.split('.'), q = path.split('.')
  if (p.length > q.length) return false
  // 前缀匹配：声明 `me.stats` 就核销它底下的一切（整块语义都变了，逐字段列没意义）
  return p.every((seg, i) => seg === '*' || seg === q[i])
}
/// 一条变更能不能被这个白名单条目核销：路径要匹配；
/// 若条目写了 from / to，值也必须**精确**对上（见 EXPECTED_CHANGES 头注）。
const explains = (e, path, a, b) => {
  if (!pathMatches(e.path, path)) return false
  if ('from' in e && JSON.stringify(e.from) !== JSON.stringify(a)) return false
  if ('to' in e && JSON.stringify(e.to) !== JSON.stringify(b)) return false
  return true
}

// ── ③ 逐路径比 ─────────────────────────────────────────────
const [beforeFile, afterFile] = process.argv.slice(2)
if (!beforeFile || !afterFile) { console.error('用法: node golden-diff.mjs <before.json> <after.json>'); process.exit(2) }
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'))
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'))

/// 把嵌套对象摊平成 `a.b.c = 值` 的清单，便于逐路径比对与白名单匹配。
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
const unexplained = [], explained = []
for (const k of keys) {
  const a = A[k], b = B[k]
  if (JSON.stringify(a) === JSON.stringify(b)) continue
  const hit = EXPECTED_CHANGES.find((e) => explains(e, k, a, b))
  const line = `${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`
  if (hit) explained.push(`${line}    [${hit.why}]`)
  else unexplained.push(line)
}

console.log(`已声明的变更 ${explained.length} 条：`)
for (const l of explained) console.log('  ✓ ' + l)
if (!unexplained.length) {
  console.log('\n★没有未声明的差异 —— 门禁通过★')
  process.exit(0)
}
console.error(`\n★${unexplained.length} 条**没人声明**的差异 —— 门禁不通过★`)
console.error('每一条要么是真实回归，要么是你忘了把它写进 EXPECTED_CHANGES（写的时候必须带条款号）：')
for (const l of unexplained) console.error('  ✗ ' + l)
process.exit(1)
