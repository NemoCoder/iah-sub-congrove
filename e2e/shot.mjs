// 一次性截图脚本:清理旧测试数据 → 造演示数据 → 截各页面。
// 产物落 unit_tests/congrove/screenshots/(临时产物区)。
//
// ★NODE_EXTRA_CA_CERTS 只对 Node 侧生效,浏览器是独立进程不读它★——
// 内网自签 CA 要么装进系统信任库(要 root),要么在这里显式放行。截图是一次性用途,
// 且证书本身已用 curl --cacert 验过,取后者。⚠ 真做 UI 断言测试时别照抄这一行。
import { chromium } from '@playwright/test'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const OUT = '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots'
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(1) }

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY },
  viewport: { width: 1500, height: 1050 },
  ignoreHTTPSErrors: true,
  locale: 'zh-CN',
})
const call = async (path, init) => {
  const r = await ctx.request.fetch(BASE + path, init)
  const t = await r.text()
  try { return JSON.parse(t) } catch { return t }
}

// ── 先清场:把历次 E2E/演示造的会议取消掉,否则日历被垃圾数据淹没 ──
// (dev 库数据本来就随意,但截图要能看清布局)
const wide = { from: new Date(Date.now() - 30 * 864e5).toISOString(), to: new Date(Date.now() + 30 * 864e5).toISOString() }
const old = await call(`/api/meetings?from=${wide.from}&to=${wide.to}`)
let n = 0
for (const m of Array.isArray(old) ? old : []) {
  // ★清理规则要跟着 spec 里的标题走★:meetings.spec.ts 里那条测「忙闲不泄露标题」的用例
  // 造的会议叫「这个标题不该出现在忙闲里」,第一版漏了它,凌晨那格堆了五个。
  if (/^(E2E 会议|演示·|每周组会|组会|健身|读书会|模型评审|数据对齐|数据治理周会|这个标题不该出现在忙闲里)/.test(m.title)) {
    await call(`/api/meetings/${m.id}`, { method: 'DELETE' }); n++
  }
}
// 项目同样要清:每跑一次截图就多两个,不清照样会淹没列表
const ps = await call('/api/projects')
let np = 0
for (const p of Array.isArray(ps) ? ps : []) {
  if (/^(E2E-|演示·|课题组·计量经济 |私下组队 )/.test(p.name)) { await call(`/api/projects/${p.id}`, { method: 'DELETE' }); np++ }
}
console.log(`清掉 ${n} 场旧会议、${np} 个旧项目`)

// ── 造一批看得出布局的演示数据 ──
const stamp = Date.now()
const pub = (await call('/api/projects', { method: 'POST', data: { name: `演示·课题组计量经济 ${stamp % 10000}`, visibility: 'public' } })).id
const priv = (await call('/api/projects', { method: 'POST', data: { name: `演示·私下组队 ${stamp % 10000}`, visibility: 'private' } })).id

const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - weekStart.getDay())
const at = (d, h, min = 0, durH = 1) => {
  const s = new Date(weekStart); s.setDate(s.getDate() + d); s.setHours(h, min, 0, 0)
  const e = new Date(s); e.setMinutes(e.getMinutes() + durH * 60)
  return { starts_at: s.toISOString(), ends_at: e.toISOString() }
}
const mk = (title, pid, when, agenda) => call('/api/meetings', {
  method: 'POST',
  data: { title, recorder: 'e2e', project_ids: [pid], agenda: agenda ?? '1. 上周进展\n2. 本周计划\n3. 需要拉通的事项', ...when },
})
const 组会 = (await mk('每周组会', pub, at(3, 10, 0, 1.5),
  '1. 上周进展汇报（每人 5 分钟）\n2. 论文投稿进度与审稿意见回复\n3. 下阶段数据采集安排\n4. 自由讨论')).id
await mk('模型评审', pub, at(3, 10, 30, 1))        // 与组会重叠 → 并排
await mk('数据对齐', pub, at(3, 11, 0, 1))          // 三个重叠 → 三列
await mk('数据治理周会', pub, at(5, 15, 0, 1))
await mk('读书会', priv, at(1, 19, 0, 2))           // 私密 → 紫色虚框
await mk('健身', priv, at(4, 7, 0, 1))
console.log('演示数据就绪')

const page = await ctx.newPage()
const shot = async (name) => {
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  console.log('✓', name)
}

await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await shot('01-日程页')

// 会议详情:★用待办/日历都可能被遮挡,直接点标题精确匹配的那个,force 绕过遮挡判定★
await page.locator('div[title^="每周组会"]').first().click({ force: true })
await shot('02-会议详情')

// 纪要页
const minutesBtn = page.getByRole('button', { name: '会议纪要' })
if (await minutesBtn.count()) { await minutesBtn.click(); await shot('03-会议纪要') }

// 发起会议
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /发起会议/ }).click()
await shot('04-发起会议')

await browser.close()
