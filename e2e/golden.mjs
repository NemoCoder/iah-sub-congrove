// ★改名前后的机械对照★（2026-08-08，为 v0.5 M0 重构做的安全网）。
//
// 起因：四路同行评审量出来——现有 E2E 只覆盖 84 个接口里的 28 个，
// 而 M0 是一次 800+ 处的机械改名。**改错的测试会掩盖真实回归**：
// 改名后某条断言红了，你分不清是产品坏了还是测试改错了。
//
// 这个脚本的用法是**跑两遍**：
//   1. 改名前（v0.4.x）：`node golden.mjs > golden-before.json`
//   2. 改名后（v0.5 M0）：`node golden.mjs > golden-after.json`
//   3. `diff golden-before.json golden-after.json`
//      → ★只允许出现 key 名的变化（meeting_id → activity_id 这类），值不许变★
//      → 出现任何值的变化，都要在 PR 描述里逐条解释为什么它不是回归
//
// ★为什么不直接存响应体★：里面全是自增 id、时间戳、随机项目名，两次跑必然不同，
// diff 会淹在噪音里。所以存的是**规范化后的形状**：
//   · 数字 id → "<id>"，时间戳 → "<ts>"，本次造的随机名 → "<gen>"
//   · 数组只留第一个元素的形状（长度单独记）
// 这样剩下的就只有「接口返回了哪些字段、什么类型、什么固定值」——
// 那正是「行为不变」这四个字要守的东西。
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
/// ★按**模式**而不是按「本轮这个串」规范化★（2026-08-08 修）：
/// 原来 `GEN` 只装本次的 tag，于是第二遍跑的时候，
/// 列表里**上一遍**留下的项目名原样进了指纹 —— 两遍自比就 diff 不干净，
/// 而这份指纹的全部用处就是拿来做 diff。凡是 `E2E-G<13位时间戳>` 一律当生成物。
const GEN = /E2E-G\d{13}/g

/// 规范化：把「每次跑都会变的东西」抹平，留下形状。
function norm(v, depth = 0) {
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) {
    // ★数组只留第一个元素的形状 + 长度★：元素个数受造数据顺序影响，形状才是契约
    return v.length === 0 ? [] : [norm(v[0], depth + 1), `<len:${v.length > 0 ? 'n' : 0}>`]
  }
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k], depth + 1)
    return out
  }
  if (typeof v === 'number') return Number.isInteger(v) && v > 1000 ? '<id>' : `<num:${typeof v}>`
  if (typeof v === 'boolean') return v            // ★布尔值保留★：它常常就是那条被改坏的开关
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return '<ts>'
    if (GEN.test(v)) { GEN.lastIndex = 0; return '<gen>' }   // ⚠ /g 正则有 lastIndex 状态，用完必须归零
    if (/^[0-9a-f]{32}$/.test(v)) return '<token>'
    return v                                       // ★普通字符串保留★：枚举值、错误文案都在这
  }
  return String(v)
}

const shots = {}
/// ★端点不存在时必须炸,不能悄悄记一条指纹★（2026-08-08 加）。
/// 起因：这个脚本第一版把访客面写成 `/api/s/{token}`、把「我的分享」写成 `/api/shares`，
/// 两个路径都不存在 —— 而 congrove 的 SPA 兜底路由会**回 200 + index.html**。
/// 于是指纹里稳稳当当记着 `{status:200, body:"<!doctype html>..."}`，
/// 改名前后**一模一样**，diff 干干净净 —— ★而它其实什么都没测★。
/// 所以这里认死一条：**响应体是 HTML = 这个端点根本不存在**，直接让脚本非零退出。
const BAD = []
async function shot(name, path, init) {
  try {
    const r = await R.fetch(BASE + path, init)
    const t = await r.text()
    if (/^\s*<!doctype html/i.test(t)) { BAD.push(`${name}  ${path}  ← 回的是 SPA 兜底页,此端点不存在`); return }
    let body
    try { body = JSON.parse(t) } catch { body = t.slice(0, 120) }
    shots[name] = { status: r.status(), body: norm(body) }
  } catch (e) {
    shots[name] = { error: String(e).split('\n')[0].slice(0, 120) }
  }
}
const post = (p, data) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, data })
const put = (p, data) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, data })

// ── 造一组固定形状的数据 ──
const pid = (await (await R.post(`${BASE}/api/projects`, { data: { name: `${tag}-项目`, visibility: 'public' } })).json()).id
const now = Date.now()
const mid = (await (await R.post(`${BASE}/api/meetings`, { data: {
  title: `${tag}-会议`, recorder: 'e2e', project_ids: [pid],
  starts_at: new Date(now + 3600e3).toISOString(), ends_at: new Date(now + 7200e3).toISOString(),
  agenda: '议题一\n议题二', location: '明德 1016', online_url: 'https://meeting.example/x',
} })).json()).id
const up = await R.post(`${BASE}/api/projects/${pid}/upload?meeting_id=${mid}`, {
  multipart: { file: { name: 'g.txt', mimeType: 'text/plain', buffer: Buffer.from(`${tag}-body`) } },
})
const iid = up.ok() ? (await up.json()).id : null
const share = iid ? await (await R.post(`${BASE}/api/items/${iid}/shares`, { data: {} })).json() : {}

// ── 打一遍只读接口（★这些的形状就是「行为」★）──
const from = new Date(now - 86400e3).toISOString(), to = new Date(now + 30 * 86400e3).toISOString()
await shot('me', '/api/me')
await shot('projects', '/api/projects')
await shot('project.detail', `/api/projects/${pid}`)
await shot('project.members', `/api/projects/${pid}/members`)
await shot('project.stats', `/api/projects/${pid}/stats?range=quarter`)
await shot('project.items', `/api/projects/${pid}/items`)
await shot('meetings.list', `/api/meetings?from=${from}&to=${to}`)
await shot('meeting.detail', `/api/meetings/${mid}`)
await shot('meeting.items', `/api/meetings/${mid}/items`)
await shot('meeting.minutes', `/api/meetings/${mid}/minutes`)
await shot('meeting.messages', `/api/meetings/${mid}/messages`)
await shot('meeting.linkhist', `/api/meetings/${mid}/link-history`)
await shot('meetings.public', '/api/meetings/public')
await shot('freebusy', `/api/freebusy?users=e2e&from=${from}&to=${to}`)
await shot('me.stats', '/api/me/stats?range=quarter')
await shot('me.unread', '/api/me/unread')
await shot('me.transfers', '/api/me/transfers')
await shot('shares.mine', '/api/shares/mine')
if (iid) await shot('item.detail', `/api/items/${iid}`)
if (iid) await shot('item.versions', `/api/items/${iid}/versions`)
// ★访客面挂在 `/pub` 不在 `/api`★（`mod.rs` 里那个不挂 require_auth 的 nest）
if (share.token) await shot('share.visitor', `/pub/share/${share.token}`)
await shot('apis', '/api/_dev/apis')

// ── 打几条「该被拒」的（★错误码与文案也是契约★）──
await shot('deny.meeting.past', '/api/meetings', post('', {
  title: `${tag}-过去`, recorder: 'e2e', project_ids: [pid],
  starts_at: new Date(now - 86400e3).toISOString(), ends_at: new Date(now - 82800e3).toISOString(),
}))
await shot('deny.meeting.noproject', '/api/meetings', post('', {
  title: `${tag}-无项目`, recorder: 'e2e', project_ids: [],
  starts_at: new Date(now + 3600e3).toISOString(), ends_at: new Date(now + 7200e3).toISOString(),
}))
await shot('deny.stats.range', '/api/me/stats?range=drop')
await shot('deny.item.404', '/api/items/99999999')

// ★自己清自己★：这个脚本**不走 Playwright**，所以 `teardown.ts` 的全局清理轮不到它。
// 2026-08-08 之前每跑一遍就在 dev 留一个项目。删项目会级联带走它下面的会议与材料。
await R.delete(`${BASE}/api/projects/${pid}`).catch(() => {})
await b.close()
if (BAD.length) {
  console.error('★指纹作废★ —— 下列端点回的是 SPA 兜底页(路径写错了,不是真接口):\n  ' + BAD.join('\n  '))
  process.exit(1)
}
console.log(JSON.stringify(shots, null, 2))
