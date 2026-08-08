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
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

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
  ['meeting_id', 'activity_id'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_projects', 'activity_projects'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_participants', 'activity_participants'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_messages', 'activity_messages'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_minutes', 'activity_minutes'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_reads', 'activity_reads'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meeting_link_history', 'activity_link_history'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  ['meetings', 'activities'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
  // 索引/约束名里的缩写
  ['idx_mpj_', 'idx_apj_'], ['idx_mp_', 'idx_ap_'], ['idx_mm_', 'idx_am_'],
  ['idx_mlh_', 'idx_alh_'], ['idx_mr_', 'idx_ar_'],
  ['meeting', 'activity'],   // no-meeting:allow —— ★改名映射表本身，改了映射就没了★
]
const rn = (s) => RENAMES.reduce((a, [x, y]) => a.split(x).join(y), s)

// ── 白名单：每条**必须**带依据（PRD 条款号或技术设计小节号）──
// ★「只在老库有」这一类要格外吝啬★：它默认就是「你弄丢了东西」。
const EXPECTED_DROPS = [
  { m: /^projects\.quota_bytes$/, why: 'PRD L3：配额挪到 user_quota' },
  { m: /^projects\.visibility$/, why: '技术设计 §3.2：退出忙闲判定后这一列没有任何语义' },
]
const EXPECTED_ADDS = [
  // ⚠ ★别用 `\b`：下划线是词字符★，`/^activity_types\b/` **匹配不上** `activity_types_pkey`
  //   （实测 `/^activity_types\b/.test('activity_types_pkey')` = false）。
  //   于是三张新表的主键/非空/CHECK 约束会全部落成「未声明的新增」——
  //   说明这份白名单从没对着 M0-1 的**目标状态**跑过。用 `(\.|_|$)` 显式收边。
  { m: /^activity_types(\.|_|$)/, why: 'PRD A1：新表' },
  { m: /^user_prefs(\.|_|$)/, why: 'PRD E0/F3：新表' },
  { m: /^user_quota(\.|_|$)/, why: 'PRD L3：新表' },
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

// ══════ 老侧：★从**钉死的 sha** 取迁移，绝不读工作树★ ══════
//
// ⚠⚠ ★这是第一版最致命的错，而且我的「自检」当时证明不了它★：
//    第一版两侧都 `readdirSync(migrations/)` —— 老侧取全部、新侧取 `0001*`。
//    今天跑它，工作树里有 7 个文件，于是老侧 7 个、新侧 1 个，报出 41 项差异，看起来很对。
//    ★但 M0-1 那个 PR 的第一件事就是**删掉 0002~0007**★（§4.2 明写，否则 `sqlx::migrate!`
//    会去 ALTER 已改名的表）。到那时工作树里只剩一个文件 → 老侧 = 新侧 = 同一份新 0001
//    → 脚本自信地打印「门禁通过」，而它比的是新 0001 和它自己。
//    ★在唯一要守的那个 PR 上，它必定空绿。★（实测 exit=0）
//
//    根因是我把「实测要验到能推翻自己那一步」这条规矩用在了 schema 上、**没用在脚本自己身上**：
//    我在「今天的状态」下自检，而不是在「M0-1 的状态」下自检。
//
// → 老侧改成 `git show <sha>:migrations/...`。这也让它和文档表头「现状钉一个 sha」同源。
const BASE_SHA = process.env.SCHEMA_BASE_SHA ?? '8f82cf1'   // 改名前的基准（= 文档表头那个）
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })

const OLD = git('ls-tree', '--name-only', BASE_SHA, 'migrations/')
  .split('\n').filter((f) => f.endsWith('.sql')).sort()
const readOld = (f) => git('show', `${BASE_SHA}:${f}`)

const migDir = path.join(ROOT, 'migrations')
const NEW = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => path.join('migrations', f))
const readNew = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

async function build(schema, list, read) {
  await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  for (const f of list) {
    // ★每条请求都自带 search_path★：这个端点每次可能是新连接，SET 不会跨请求保留
    await sql(`SET search_path TO ${schema}; ${read(f)}`)
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

console.error(`老 schema（★取自 ${BASE_SHA}★）：${OLD.length} 个迁移`)
console.error(`新 schema（工作树）：${NEW.length} 个迁移`)
// ★同源守卫比**内容**，不比参数长什么样★：原来写的是 `BASE_SHA === 'HEAD'`，
//   于是 `SCHEMA_BASE_SHA=$(git rev-parse HEAD)` 就绕过去了、空绿。
{
  const h = (x) => crypto.createHash('sha256').update(x).digest('hex')
  const oldH = h(OLD.map(readOld).join('\0')), newH = h(NEW.map(readNew).join('\0'))
  if (oldH === newH) { console.error('⚠ 两侧内容完全相同，这次比对没有意义'); process.exit(2) }
}
let A0, B0
try {
  await build('zz_old', OLD, readOld)
  await build('zz_new', NEW, readNew)
  A0 = await snapshot('zz_old'); B0 = await snapshot('zz_new')
} finally {
  // ★异常时也要清★：第一版把 DROP 放在最后，脚本一抛异常就把 zz_old/zz_new 留在真库里
  await sql('DROP SCHEMA IF EXISTS zz_old CASCADE; DROP SCHEMA IF EXISTS zz_new CASCADE').catch(() => {})
}
// ★**两侧都**过一遍改名★（不是只归一化老侧）：改名规则对已改名的一侧是空操作
// （`activities` 里不含 `meetings`），所以幂等；而只归一化一侧的话，
// **自检时**（两边都是改名前的 0001）老侧变成 activities、新侧还是 meetings → 全不匹配。
// ⚠ 这跟 `e2e/golden-diff.mjs` 第一版栽的是**同一个坑**，同一个修法 ——
//    「归一化必须对称」这条，两个脚本各踩一次，记在这里免得第三次。
const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [rn(k), rn(v)]))
const A = norm(A0), B = norm(B0)

// ══════ ★「你什么都没做」也必须红★（2026-08-08 评审抓出来的，这是本脚本最大的盲区）══════
//
// 这个脚本的比对是**改名归一化之后**做的（`rn()` 两侧都过），所以
// ★「你根本没改名」在归一化之后完全不可见★ —— 把 0001~0007 原样 cat 成一个 0001、
// 一处不改名、一张新表不建，它照样打印「门禁通过」。实测确认过。
//
// 根因是它的判定形状：**只能证明「你没弄丢东西」，永远证明不了「你做了你说要做的事」。**
// 所以要另外加两条正向断言：
//   ① 新侧必须**真的**出现每一条 EXPECTED_ADDS（三张新表、新列、新索引一个都不能少）；
//   ② 新侧必须**不再**出现改名前的表名（`meetings`/`meeting_*`）。
function positiveChecks(B) {
  const miss = []
  for (const e of EXPECTED_ADDS) {
    if (!Object.keys(B).some((k) => e.m.test(bare(k)))) miss.push(`${e.m}  —— ${e.why}`)
  }
  // 新侧还留着旧表名 = 根本没改名
  const stale = Object.keys(B).filter((k) => /(^|[^a-z])meetings?([^a-z]|$)/i.test(bare(k)))
  return { miss, stale }
}

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

// ★正向断言：光「没丢东西」不算过★
const { miss, stale } = positiveChecks(B0)   // ★用**未归一化**的新侧★，否则旧表名会被 rn() 抹掉
if (miss.length) {
  console.error(`\n★${miss.length} 条 EXPECTED_ADDS **在新 schema 里根本不存在**★（= 你没建它们）：`)
  for (const m of miss) console.error('  ✗ ' + m)
}
if (stale.length) {
  console.error(`\n★新 schema 里还留着 ${stale.length} 处改名前的表名★（= 你没改名）：`)
  for (const k of stale.slice(0, 10)) console.error('  ✗ ' + k)
}

const bad = dropped.length + added.length + changed.length + miss.length + stale.length
if (bad) {
  console.error(`\n★${bad} 项未声明的差异 —— 门禁不通过★`)
  console.error('「只在老库有」优先看：它默认就是「重写建表脚本时弄丢了东西」，')
  console.error('而这正是 v3 漏掉整个归档功能的那一类。确实要删的写进 EXPECTED_DROPS 并注明依据。')
  process.exit(1)
}
console.log('\n★没有未声明的差异 —— 门禁通过★')
