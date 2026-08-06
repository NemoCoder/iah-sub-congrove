// 一次性截图脚本:造点数据 → 截各页面。★产物落 unit_tests/congrove/screenshots/★(临时产物区)。
// 跑法:cd e2e && NODE_EXTRA_CA_CERTS=... IAH_E2E_KEY=... node shot.mjs
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const OUT = '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots'
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(1) }

// ★NODE_EXTRA_CA_CERTS 只对 Node 侧(APIRequestContext)生效,浏览器是独立进程、不读它★
// —— 所以 request 能通而 page.goto 直接失败。内网自签 CA 要么装进系统信任库(要 root),
// 要么在这里显式放行。截图是一次性用途,且证书本身已用 curl --cacert 验过,取后者。
// ⚠ 真做 UI 断言测试时别照抄这一行:那时应当把 CA 装进容器/系统,否则会把
// 「证书真的错了」一起吞掉(e2e/README.md 里那条纪律)。
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext({
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY },
  viewport: { width: 1440, height: 1000 },
  ignoreHTTPSErrors: true,
})
const api = async (path, init) => {
  const r = await ctx.request.fetch(BASE + path, init)
  const t = await r.text()
  try { return { status: r.status(), body: JSON.parse(t) } } catch { return { status: r.status(), body: t } }
}

// ── 造数据:一个公开项目 + 一个私密项目,各排几场会,含一场待我应答的 ──
const stamp = Date.now()
const pub = (await api('/api/projects', { method: 'POST', data: { name: `演示·课题组 ${stamp}`, visibility: 'public' } })).body.id
const priv = (await api('/api/projects', { method: 'POST', data: { name: `演示·私下组队 ${stamp}`, visibility: 'private' } })).body.id
console.log('projects', pub, priv)

// 本周内几个时间点(周日为一周第一天,与前端一致)
const now = new Date()
const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - weekStart.getDay())
const at = (dayOffset, hour, durH = 1) => {
  const s = new Date(weekStart); s.setDate(s.getDate() + dayOffset); s.setHours(hour, 0, 0, 0)
  const e = new Date(s); e.setHours(e.getHours() + durH)
  return { starts_at: s.toISOString(), ends_at: e.toISOString() }
}
const mk = (title, pid, when, extra = {}) => api('/api/meetings', {
  method: 'POST',
  data: { title, recorder: 'e2e', project_ids: [pid], agenda: '1. 上周进展\n2. 本周计划\n3. 需要拉通的事项', ...when, ...extra },
})
const m1 = (await mk('组会', pub, at(3, 10))).body.id
await mk('数据治理周会', pub, at(5, 15))
await mk('读书会', priv, at(1, 11))          // 私密 → 紫色虚框
await mk('健身', priv, at(3, 10, 1))          // 与组会重叠 → 两列并排
const m5 = (await mk('模型评审会', pub, at(4, 10, 2))).body.id
// 造一场「待我应答」的:把自己的答复改回 pending 做不到(接口不允许),
// 改用另一场会 + 改时间触发清回 pending —— 但改时间的人是自己不会被清。
// 所以直接看常规态即可,红色那类在真实多人场景才出现。
console.log('meetings', m1, m5)

const page = await ctx.newPage()
const shot = async (name, path, wait = 1200) => {
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(wait)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  console.log('✓', name)
}

await shot('01-日程页', '/')
// 会议详情:点日历里的「组会」
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
await page.getByTitle(/组会/).first().click()
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/02-会议详情.png`, fullPage: true })
console.log('✓ 02-会议详情')
// 发起会议
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await page.getByRole('button', { name: /发起会议/ }).click()
await page.waitForTimeout(1000)
await page.screenshot({ path: `${OUT}/03-发起会议.png`, fullPage: true })
console.log('✓ 03-发起会议')
// 项目页(对照:重构后的样子)
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.getByRole('radio', { name: '项目' }).click().catch(() => page.getByText('项目', { exact: true }).first().click())
await page.waitForTimeout(1000)
await page.screenshot({ path: `${OUT}/04-项目页.png`, fullPage: true })
console.log('✓ 04-项目页')

await browser.close()
