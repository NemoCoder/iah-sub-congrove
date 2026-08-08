// ★改名前后的机械对照★（2026-08-08，为 v0.5 M0 重构做的安全网）。
//
// 用法是**跑两遍 + 一次脚本对照**：
//   1. 改名前（v0.4.x）：`node golden.mjs > golden/before.json`
//   2. 改名后（v0.5 M0）：`node golden.mjs > golden/after.json`
//   3. `node golden-diff.mjs golden/before.json golden/after.json`
//      —— ★不是人眼 diff★：它按 RENAMES 表归一化改名，再拿 EXPECTED_CHANGES
//      白名单核销**事先声明**的行为变更，剩下任何差异都让它非零退出。
//
// ══════ ★这个脚本第一版是负价值的，下面这段是它的验尸报告★ ══════
//
// 四路同行评审实测：第一版的 fixture 是「项目 public + 活动 private」，
// 于是基线里 `activities.list[0].is_private = false`。而 M0 要把 is_private 换定义
// （从「所有关联项目都不 public」改成「活动自己的 visibility != 'public'」）：
//   · 实现**对**了 → 该值变 true → 指纹**红**，还要写解释；
//   · 实现**反**了（写成 `== 'public'`）→ 仍是 false → 指纹**干干净净**。
// ★实现对了会红、实现错了是绿的★ —— 这不叫覆盖不足，叫方向相反。
//
// 根因有三个，这一版逐个修：
//   ① fixture 是「全阳性单例」：每个布尔只取到一个值、每个数组只有一个元素、
//      只有一种活动、一个身份 → 任何「判反」都不可能显形；
//   ② `norm` 抹得太狠：所有数值一律记成 `<num:number>`、数组只留第 0 个元素、
//      长度只区分空/非空 → 配额算错、列表多返回少返回、排序坏掉，一概看不见；
//   ③ 残缺指纹会被静静打印出来：`shot()` 把异常吞成 `{error}`，
//      `iid` 取不到时三个快照直接消失，混在改名 churn 里根本看不出来。
import { chromium } from '@playwright/test'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(1) }

const b = await chromium.launch()
const ctx = await b.newContext({ extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY } })
const R = ctx.request

/// ★前缀必须是 `E2E-`★：`teardown.ts` 按 `^(E2E-|演示·)` 扫着清测试数据。
/// 2026-08-08 我第一版起了 `G<ts>-项目` 这个自造前缀，teardown 认不出来 →
/// 每跑一遍就在 dev 里留一个永不回收的项目。★别另立命名约定，用已有的那一个★。
const tag = `E2E-G${Date.now()}`
/// ★按**模式**而不是按「本轮这个串」规范化★：原来 `GEN` 只装本次的 tag，
/// 于是第二遍跑的时候，列表里**上一遍**留下的项目名原样进了指纹 ——
/// 两遍自比就 diff 不干净，而这份指纹的全部用处就是拿来做 diff。
const GEN = /E2E-G\d{13}/

// ══════════════ 规范化：★白名单抹平，不是全抹平★ ══════════════
//
// 只抹「每次跑必然不同」的四样：**主键 id / 时间戳 / 令牌 / 本轮生成的名字**。
// ★其余一律保留原值★ —— 尤其是数值：`used_bytes` / `size` / `quota_bytes` /
// `participant_count` / `hours` 全都是「行为」的一部分，抹掉它们
// 等于宣布「配额算错了不算回归」。
//
// id 按**键名**判（`id` 或 `*_id`），不按大小判。第一版用 `>1000` 当 id，
// 于是 `quota_bytes = 10737418240` 被当成 id 抹掉了 —— 而配额恰恰是「钱」路径。
const isIdKey = (k) => k === 'id' || /_id$/.test(k ?? '')

function norm(v, key) {
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) {
    // ★记真实长度 + **全部元素形状的并集**★（第一版只留 v[0]，长度还塌成 'n'/0）。
    // 并集去重后排序 —— 元素顺序不该影响指纹，但「有几种形状」必须影响。
    const shapes = [...new Set(v.map((x) => JSON.stringify(norm(x, key))))].sort()
    return { '<len>': v.length, '<of>': shapes.map((s) => JSON.parse(s)) }
  }
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k], k)
    return out
  }
  if (typeof v === 'number') return isIdKey(key) ? '<id>' : v      // ★数值保留原值★
  if (typeof v === 'boolean') return v                             // 布尔常常就是被改坏的那个开关
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return '<ts>'
    if (GEN.test(v)) return '<gen>'
    if (/^[0-9a-f]{32}$/.test(v)) return '<token>'
    return v                                                       // 枚举值、错误文案都是契约
  }
  return String(v)
}

// ══════════════ 采样 ══════════════
const shots = {}
const BAD = []
/// ★端点不存在 / 请求出错时必须炸，不能悄悄记一条指纹★。
/// 起因：第一版把访客面写成 `/api/s/{token}`、「我的分享」写成 `/api/shares`，
/// 两个路径都不存在 —— 而 SPA 兜底路由会**回 200 + index.html**，
/// 于是指纹里稳稳记着 `{status:200, body:"<!doctype html>…"}`，改名前后一模一样。
/// ★它什么都没测，却长得像测过了。★
async function shot(name, path, init) {
  try {
    const r = await R.fetch(BASE + path, init)
    const t = await r.text()
    if (/^\s*<!doctype html/i.test(t)) { BAD.push(`${name}  ${path}  ← 回的是 SPA 兜底页，此端点不存在`); return }
    let body
    try { body = JSON.parse(t) } catch { body = t.slice(0, 120) }
    shots[name] = { status: r.status(), body: norm(body) }
  } catch (e) {
    BAD.push(`${name}  ${path}  ← 请求异常：${String(e).split('\n')[0].slice(0, 90)}`)
  }
}
const post = (data) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, data })

/// 造数据时任何一步失败都**立刻停**：半截 fixture 产出的是残缺指纹，
/// 而残缺指纹混在几百行改名 churn 里看不出来，比没有指纹更糟。
function must(v, what) {
  if (v === null || v === undefined) { console.error(`★fixture 造不出来：${what}★`); process.exit(1) }
  return v
}
const j = async (p) => { const r = await p; return r.ok() ? r.json() : null }

// ══════════════ fixture：★每个判据都要有正反两个方向★ ══════════════
const now = Date.now()
const iso = (ms) => new Date(now + ms).toISOString()

// 两个项目，可见性相反。★同一个 owner★ —— 这样「配额按 owner 汇总」才测得出来
// （只有一个项目时，按项目算和按 owner 算得数相同，改错了也看不见）。
const pubPid = must((await j(R.post(`${BASE}/api/projects`, { data: { name: `${tag}-项目公开`, visibility: 'public' } })))?.id, '公开项目')
const prvPid = must((await j(R.post(`${BASE}/api/projects`, { data: { name: `${tag}-项目私密`, visibility: 'private' } })))?.id, '私密项目')

const mk = async (title, projectIds, extra) => must((await j(R.post(`${BASE}/api/activities`, {
  data: {
    // ★预置「会议」类型★（id 见 specs/_presets.ts 的说明：部署纪律保证它恒为 1）
    type_id: 1,
    title: `${tag}-${title}`, recorder: 'e2e', project_ids: projectIds,
    starts_at: iso(3600e3), ends_at: iso(7200e3),
    agenda: '议题一\n议题二', location: '明德 1016', online_url: 'https://activity.example/x',
    ...extra,
  },
})))?.id, `活动 ${title}`)

// ══ ★is_private 的四个组合，一个都不能少★ ══
//
// M0 要把 is_private 换定义：旧 = 「所有关联项目都不 public」，新(J4) = 「活动自己 visibility != public」。
// 最危险的错法是**判反**（写成 `== 'public'`）—— 而 v0.3.55 的教训是它**不报错**，
// 只是让私密的活动在日历上显示成公开色。
//
// ⚠ 2026-08-08 实测教训：我原本只造了前两个组合，并以为「正反都有就能抓住判反」。
//   ★错了，而且是拿脚本实测证伪的★ —— 前两个组合恰好是
//   「旧定义」与「判反的新定义」**结果重合**的那两个：
//
//   | 活动 visibility | 关联项目 | 旧定义 | 新定义(对) | 新定义(判反) |
//   |---|---|---|---|---|
//   | private | public  | false | **true**  | false ← 与旧值相同，diff 里根本不出现 |
//   | public  | private | true  | **false** | true  ← 同上 |
//   | private | private | true  | true      | **false** ← ★只有这两个组合能抓住判反★ |
//   | public  | public  | false | false     | **true**  ← ★同上★ |
//
//   所以四个都要造：前两个证明「换定义这件事确实发生了」（会进白名单，带 from/to 写死），
//   后两个在实现正确时**不产生任何 diff**、在判反时产生**没人声明的 diff** → 门禁红。
const midA = await mk('活动A私密', [pubPid], { visibility: 'private' })   // 旧 false → 新 true
const midB = await mk('活动B公开', [prvPid], { visibility: 'public' })    // 旧 true  → 新 false
const midD = await mk('活动D双私', [prvPid], { visibility: 'private' })   // 旧 true  = 新 true（判反→false）
const midE = await mk('活动E双公', [pubPid], { visibility: 'public' })    // 旧 false = 新 false（判反→true）
const midC = await mk('活动C取消', [pubPid], {})
await R.delete(`${BASE}/api/activities/${midC}`)          // DELETE = 取消（不是删除），status → canceled

// 材料策略布尔的两个方向：A 禁下载、B 禁分享
await R.put(`${BASE}/api/activities/${midA}`, post({ no_download: true }))
await R.put(`${BASE}/api/activities/${midB}`, post({ no_share: true }))

/// 固定字节数 → `size` / `used_bytes` 变成可比的常量（配套 norm 保留数值）
const upload = async (pid, name, bytes, qs = '') => await j(R.post(`${BASE}/api/projects/${pid}/upload${qs}`, {
  multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.alloc(bytes, 'x') } },
}))

// 三个文件，各钉一条判据：
const withAct = must((await upload(pubPid, 'a.txt', 5000, `?activity_id=${midA}`))?.id, '带活动的材料')
// ★不带 activity_id 的文件★：抓「活动材料区/材料区的过滤失效」——
//   过滤写漏时它会混进活动材料列表，而第一版的 fixture 里根本没有这种行，测不出来。
const noAct = must((await upload(pubPid, 'b.txt', 3000))?.id, '不带活动的材料')
// ★已软删的文件★：抓 `deleted_at IS NULL` 漏过滤（v0.3.55 补过 11 处、v0.4.28 补过 5 处，M0 是第三轮）
const delItem = must((await upload(pubPid, 'c.txt', 1000))?.id, '待软删的材料')
await R.delete(`${BASE}/api/items/${delItem}`)
// 第二个项目里也放一个 → 配额按 owner 汇总时这份必须被算进去
must((await upload(prvPid, 'd.txt', 7000))?.id, '私密项目里的材料')

const share = must(await j(R.post(`${BASE}/api/items/${withAct}/shares`, { data: {} })), '公开分享链接')

// ══════════════ 快照 ══════════════
const from = iso(-86400e3), to = iso(30 * 86400e3)
await shot('me', '/api/me')
await shot('projects', '/api/projects')
await shot('project.detail', `/api/projects/${pubPid}`)
await shot('project.members', `/api/projects/${pubPid}/members`)
await shot('project.stats', `/api/projects/${pubPid}/stats?range=quarter`)
await shot('project.items', `/api/projects/${pubPid}/items`)
await shot('project.trash', `/api/projects/${pubPid}/trash`)          // 软删的那份应当在这里
await shot('activities.list', `/api/activities?from=${from}&to=${to}`)     // ★A/B 两条方向相反的 is_private★
await shot('activity.detail', `/api/activities/${midA}`)
await shot('activity.detail.b', `/api/activities/${midB}`)
// ★取消态★：`activities.list` 的长度（2 而不是 3）已经钉住「取消的不进日历」，
//   这一条钉的是另一半 ——「取消 ≠ 删除，它照样读得到」。M0 给活动新加了软删除，
//   两个状态正交，最容易被合并成一个，所以两边都要有快照。
await shot('activity.detail.c', `/api/activities/${midC}`)
await shot('activity.items', `/api/activities/${midA}/items`)             // ★不该含 noAct 那份★
await shot('activity.minutes', `/api/activities/${midA}/minutes`)
await shot('activity.messages', `/api/activities/${midA}/messages`)
await shot('activity.linkhist', `/api/activities/${midA}/link-history`)
await shot('activities.public', '/api/activities/public')
// ★忙闲要在**没人用的远期窗口**里采★（2026-08-09 踩的）：
// 原来用的是 `from=-1天 to=+30天`，那会把**别的 spec 造的活动**全网罗进来 ——
// 忙块条数于是随「这一轮跑了多少测试」变化，golden 每次都红，而且红在一个
// **不是回归**的地方。`<len>` 这类计数只有在窗口里只有自己的东西时才有意义。
const fbA = await mk('忙闲取样', [pubPid], { starts_at: iso(20 * 86400e3), ends_at: iso(20 * 86400e3 + 3600e3) })
const fbFrom = iso(20 * 86400e3 - 3600e3), fbTo = iso(20 * 86400e3 + 7200e3)
await shot('freebusy', `/api/freebusy?users=e2e&from=${fbFrom}&to=${fbTo}`)
await shot('me.stats', '/api/me/stats?range=quarter')
await shot('me.unread', '/api/me/unread')
await shot('me.transfers', '/api/me/transfers')
await shot('shares.mine', '/api/shares/mine')
await shot('item.detail', `/api/items/${withAct}`)
await shot('item.versions', `/api/items/${withAct}/versions`)
await shot('item.deleted', `/api/items/${delItem}`)                    // 软删后的详情：钉住它回什么
await shot('share.visitor', `/pub/share/${share.token}`)               // ★访客面在 /pub 不在 /api★
await shot('apis', '/api/_dev/apis')                                  // e2e 非超管 → 403，钉住这个事实

// ── 「该被拒」的（★错误码与文案也是契约★，而且它们是 M0 明确要改的，见 golden-diff 的白名单）──
await shot('deny.activity.past', '/api/activities', post({ type_id: 1,
  title: `${tag}-过去`, recorder: 'e2e', project_ids: [pubPid],
  starts_at: iso(-86400e3), ends_at: iso(-82800e3),
}))
await shot('deny.activity.noproject', '/api/activities', post({ type_id: 1,
  title: `${tag}-无项目`, recorder: 'e2e', project_ids: [],
  starts_at: iso(3600e3), ends_at: iso(7200e3),
}))
await shot('deny.stats.range', '/api/me/stats?range=drop')
await shot('deny.item.404', '/api/items/99999999')
await shot('deny.download.nodownload', `/api/items/${withAct}/download`)   // A 设了禁下载 → 400
await shot('deny.trashed.download', `/api/items/${delItem}/download`)      // 软删的 → 404

// ══════════════ 自检：★残缺指纹不许被打印出来★ ══════════════
//
// 快照名 manifest。少一个（造数据半路失败）或多一个（有人加了快照没改这里）
// 都非零退出 —— 否则「少了三个快照」这种事会混在几百行改名 churn 里，没人看得出来。
const EXPECT = [
  'me', 'projects', 'project.detail', 'project.members', 'project.stats', 'project.items', 'project.trash',
  'activities.list', 'activity.detail', 'activity.detail.b', 'activity.detail.c', 'activity.items', 'activity.minutes',
  'activity.messages', 'activity.linkhist', 'activities.public', 'freebusy',
  'me.stats', 'me.unread', 'me.transfers', 'shares.mine',
  'item.detail', 'item.versions', 'item.deleted', 'share.visitor', 'apis',
  'deny.activity.past', 'deny.activity.noproject', 'deny.stats.range', 'deny.item.404',
  'deny.download.nodownload', 'deny.trashed.download',
]

// ★自己清自己★：这个脚本**不走 Playwright**，`teardown.ts` 的全局清理轮不到它。
// ⚠★活动也要清★（2026-08-09 踩的）：原来只删项目，而活动**不随项目级联删** ——
//   于是每跑一次 golden 就在库里多留几场，下一次采 `freebusy` 的 `<len>` 就多一个。
//   症状是 golden 门禁红在一个**不是回归**的地方，且每跑一次红得不一样。
for (const m of [midA, midB, midD, midE, fbA]) await R.delete(`${BASE}/api/activities/${m}`).catch(() => {})
for (const p of [pubPid, prvPid]) await R.delete(`${BASE}/api/projects/${p}`).catch(() => {})
await b.close()

const got = Object.keys(shots).sort(), want = [...EXPECT].sort()
const missing = want.filter((k) => !got.includes(k))
const extra = got.filter((k) => !want.includes(k))
if (BAD.length || missing.length || extra.length) {
  console.error('★指纹作废，不予输出★')
  if (BAD.length) console.error('  采样失败：\n    ' + BAD.join('\n    '))
  if (missing.length) console.error('  缺快照：' + missing.join(', '))
  if (extra.length) console.error('  多快照（加了没写进 EXPECT）：' + extra.join(', '))
  process.exit(1)
}
console.log(JSON.stringify(shots, null, 2))
