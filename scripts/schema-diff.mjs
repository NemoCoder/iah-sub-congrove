// ★M0-1 的真门禁：老迁移建出来的 schema vs 新 0001 建出来的 schema★（2026-08-08）
//
// 用法：
//   IAH_TOKEN=<个人令牌> NODE_EXTRA_CA_CERTS=~/.config/iah/IAH-Internal-CA-new.crt \
//     node scripts/schema-diff.mjs
//
// ══════ 为什么需要它 ══════
//
// M0-1 是整个 M0 里**最危险**的一个 PR —— 它把 0001~0007 压成一份重写的建表脚本。
// 而它的门禁**实质是空的**：它不动任何 `.rs`，全树又有 0 处 `sqlx::query!` 编译期校验宏
// （SQL 全是运行期字符串），所以 `cargo test` 的输出与基线**逐字节相同**，
// 对一份整体重写的 schema 是**零判定力**。
//
// 而这正是已经出过事的地方：技术设计 v3 的重写清单围绕「改名」组织，
// ★漏掉了「0002~0007 往老表上加的东西」这一整类★ —— 照它写，
// `projects.archived_at` / `archived_by` / `idx_projects_active` 会消失，
// **归档功能（刚上线的 D17）连同权限层的归档只读闸一起没了**，而所有门禁都是绿的。
//
// 人肉逐行打勾挡不住这个：那张清单本身就是人写的，写清单的人漏了什么，打勾的人也会漏。
// ★所以要让机器去比。★
//
// ══════ 怎么比 ══════
//
// 在 dev 库里建两个临时 schema：`zz_old` 跑 0001~0007，`zz_new` 跑新的 0001。
// 然后从 information_schema / pg_indexes / pg_constraint 把两边的**结构**抠出来，
// 按 RENAMES 归一化改名，再逐项比对，报三类：
//
//   ① ★只在老库有★ —— **这一类默认就是 bug**：你把一样东西弄丢了。
//                      确实要删的（如 projects.quota_bytes）写进 EXPECTED_DROPS。
//   ② 只在新库有   —— 新增的，写进 EXPECTED_ADDS（每条带 PRD 条款号）。
//   ③ 两边都有但定义不同 —— 类型/默认值/可空性变了，写进 EXPECTED_CHANGES。
//
// 非白名单的差异 → exit 1。
//
// ★自检：今天（M0-1 之前）跑它，`0001_init.sql` 还是老的那份，
//   所以它应当**恰好**报出 0002~0007 的全部产物为「只在老库有」。
//   报不出来 = 这个脚本本身没用。★
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = process.env.IAH_TOKEN
if (!TOKEN) { console.error('缺 IAH_TOKEN（门户「日志」页生成的个人令牌）'); process.exit(2) }
const API = 'https://registry.ruciah.com/api/subsystems/congrove/db/sql'
const ROOT = path.resolve(import.meta.dirname, '..')

async function sql(text) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'dev', sql: text }),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(`SQL 失败：${j.error}\n--- 语句 ---\n${text.slice(0, 300)}`)
  return j
}

// ── 改名映射：长的先替，否则 `meeting_id` 会被 `meeting` 的规则先啃掉 ──
const RENAMES = [
  ['meeting_id', 'activity_id'],
  ['meeting_projects', 'activity_projects'],
  ['meeting_participants', 'activity_participants'],
  ['meeting_messages', 'activity_messages'],
  ['meeting_minutes', 'activity_minutes'],
  ['meeting_reads', 'activity_reads'],
  ['meeting_link_history', 'activity_link_history'],
  ['meetings', 'activities'],
  // 索引/约束名里的缩写
  ['idx_mpj_', 'idx_apj_'], ['idx_mp_', 'idx_ap_'], ['idx_mm_', 'idx_am_'],
  ['idx_mlh_', 'idx_alh_'], ['idx_mr_', 'idx_ar_'],
  ['meeting', 'activity'],
]
const rn = (s) => RENAMES.reduce((a, [x, y]) => a.split(x).join(y), s)

// ── 白名单：每条**必须**带依据（PRD 条款号或技术设计小节号）──
// ★「只在老库有」这一类要格外吝啬★：它默认就是「你弄丢了东西」。
const EXPECTED_DROPS = [
  { m: /^projects\.quota_bytes$/, why: 'PRD L3：配额挪到 user_quota' },
  { m: /^projects\.visibility$/, why: '技术设计 §3.2：退出忙闲判定后这一列没有任何语义' },
]
const EXPECTED_ADDS = [
  { m: /^activity_types\b/, why: 'PRD A1：新表' },
  { m: /^user_prefs\b/, why: 'PRD E0/F3：新表' },
  { m: /^user_quota\b/, why: 'PRD L3：新表' },
  { m: /^projects\.kind$/, why: 'PRD J1：区分 materials 区' },
  { m: /^activities\.(type_id|busy|remind_minutes|remind_done_at|deleted_at|deleted_by)$/, why: '技术设计 §2.4' },
  { m: /^activity_participants\.notified_at$/, why: 'PRD L0b（O5 拍板）' },
  { m: /^idx_(atype_|proj_materials|act_|items_project)/, why: '技术设计 §2.3/§2.4/§2.9/§3.3' },
]
const EXPECTED_CHANGES = [
  { m: /^activities\.recorder\b/, why: '技术设计 §2.4：改为仅 has_minutes 必填 → 加 DEFAULT ""' },
  { m: /^activities\.actual_minutes\b/, why: '技术设计 §2.4：上界 1440 → 43200（★30 倍放宽，已披露★）' },
  { m: /^activities\.remind_done_at\b/, why: '技术设计 §2.4：reminded_at 改名 + 改语义' },
]
const hit = (list, key) => list.find((e) => e.m.test(key))

// ── 跑迁移 ──
const migDir = path.join(ROOT, 'migrations')
const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
const OLD = files                       // 0001~0007，历史真相
const NEW = files.filter((f) => f.startsWith('0001'))   // 重写后应当只剩这一个

async function build(schema, list) {
  await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  for (const f of list) {
    const body = fs.readFileSync(path.join(migDir, f), 'utf8')
    // ★每条请求都自带 search_path★：这个端点每次可能是新连接，SET 不会跨请求保留
    await sql(`SET search_path TO ${schema}; ${body}`)
  }
}

/// 把一个 schema 的结构抠成 `key -> 定义` 的扁平表
async function snapshot(schema) {
  const out = {}
  // ★把临时 schema 名抹掉★：外键/索引定义里带着 zz_old./zz_new. 前缀，
  //   不抹的话**每一条**都会被算成「定义变了」——第一次跑就是这样，313 项里绝大多数是这种噪音。
  const unq = (v) => String(v).split(`${schema}.`).join('')
  const cols = await sql(`SET search_path TO ${schema};
    SELECT table_name||'.'||column_name,
           data_type||' null='||is_nullable||' def='||coalesce(column_default,'-')
      FROM information_schema.columns WHERE table_schema='${schema}' ORDER BY 1`)
  for (const [k, v] of cols.rows) out[`列 ${k}`] = unq(v)
  const idx = await sql(`SELECT indexname, regexp_replace(indexdef,'^.*USING','USING')
      FROM pg_indexes WHERE schemaname='${schema}' ORDER BY 1`)
  for (const [k, v] of idx.rows) out[`索引 ${k}`] = unq(v)
  const con = await sql(`SELECT c.conname, pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
     WHERE n.nspname='${schema}' ORDER BY 1`)
  for (const [k, v] of con.rows) out[`约束 ${k}`] = unq(v)
  return out
}

console.error(`老 schema：跑 ${OLD.length} 个迁移 ${OLD.join(', ')}`)
await build('zz_old', OLD)
console.error(`新 schema：跑 ${NEW.length} 个迁移 ${NEW.join(', ')}`)
await build('zz_new', NEW)

const A0 = await snapshot('zz_old'), B0 = await snapshot('zz_new')
// ★**两侧都**过一遍改名★（不是只归一化老侧）：改名规则对已改名的一侧是空操作
// （`activities` 里不含 `meetings`），所以幂等；而只归一化一侧的话，
// **自检时**（两边都是改名前的 0001）老侧变成 activities、新侧还是 meetings → 全不匹配。
// ⚠ 这跟 `e2e/golden-diff.mjs` 第一版栽的是**同一个坑**，同一个修法 ——
//    「归一化必须对称」这条，两个脚本各踩一次，记在这里免得第三次。
const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [rn(k), rn(v)]))
const A = norm(A0), B = norm(B0)

await sql('DROP SCHEMA IF EXISTS zz_old CASCADE; DROP SCHEMA IF EXISTS zz_new CASCADE')

const bare = (k) => k.replace(/^(列|索引|约束) /, '')
const dropped = [], added = [], changed = [], ok = []
for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
  if (!(k in B)) { (hit(EXPECTED_DROPS, bare(k)) ? ok : dropped).push([k, A[k]]) }
  else if (!(k in A)) { (hit(EXPECTED_ADDS, bare(k)) ? ok : added).push([k, B[k]]) }
  else if (A[k] !== B[k]) { (hit(EXPECTED_CHANGES, bare(k)) ? ok : changed).push([k, A[k], B[k]]) }
}

const show = (title, rows, fmt) => {
  if (!rows.length) return
  console.log(`\n★${title}（${rows.length}）★`)
  for (const r of rows.sort()) console.log('  ' + fmt(r))
}
console.log(`已按白名单核销 ${ok.length} 项`)
show('只在老库有 —— 你把它弄丢了', dropped, ([k, a]) => `${k}\n      老: ${a}`)
show('只在新库有 —— 没写进 EXPECTED_ADDS', added, ([k, b]) => `${k}\n      新: ${b}`)
show('定义变了 —— 没写进 EXPECTED_CHANGES', changed, ([k, a, b]) => `${k}\n      老: ${a}\n      新: ${b}`)

const bad = dropped.length + added.length + changed.length
if (bad) {
  console.error(`\n★${bad} 项未声明的差异 —— 门禁不通过★`)
  console.error('「只在老库有」优先看：它默认就是「重写建表脚本时弄丢了东西」，')
  console.error('而这正是 v3 漏掉整个归档功能的那一类。确实要删的写进 EXPECTED_DROPS 并注明依据。')
  process.exit(1)
}
console.log('\n★没有未声明的差异 —— 门禁通过★')
