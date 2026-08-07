// 截图脚本:清理旧测试数据 → 造演示数据 → 截各页面。
//
// ★产物按版本号分目录★(2026-08-07 用户要求):
//     unit_tests/congrove/screenshots/<线上版本>/xxx.png
// 版本号**从线上页面实际抓**,不是读本地 version.ts —— 截的是线上,
// 本地领先几个版本是常态,用本地号会把图归错档(而归错档的图比没有更糟)。
//
// ★NODE_EXTRA_CA_CERTS 只对 Node 侧生效,浏览器是独立进程不读它★。
// 浏览器信任内网 CA 走 NSS 库(见 README);这里不用 ignoreHTTPSErrors。
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const ROOT = '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots'
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(1) }

const browser = await chromium.launch()
const ctx = await browser.newContext({
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY },
  // ★别用 fullPage★:整页常超 2000px,读图工具会拒。要看下半屏就滚动后再截一张。
  viewport: { width: 1400, height: 950 },
  locale: 'zh-CN',
})
const safe = (e) => String(e).split('\n')[0].slice(0, 110)
async function call(path, init) {
  try {
    const r = await ctx.request.fetch(BASE + path, init)
    const t = await r.text()
    try { return JSON.parse(t) } catch { return null }
  } catch (e) { console.log('call 失败', path, safe(e)); return null }
}

const page = await ctx.newPage()
await page.goto(BASE + '/')
await page.waitForTimeout(800)
// 页眉上的版本号就是这批图的归档目录
const ver = (await page.locator('header, body').first().innerText())
  .match(/v\d+\.\d+\.\d+/)?.[0] ?? 'unknown'
const OUT = `${ROOT}/${ver}`
mkdirSync(OUT, { recursive: true })
console.log('线上版本:', ver, '→', OUT)

// ── 清场 + 造演示数据 ──
const ps = await call('/api/projects')
if (Array.isArray(ps)) for (const x of ps) if (/^(E2E-|演示)/.test(x.name)) await call('/api/projects/' + x.id, { method: 'DELETE' })
const pid = (await call('/api/projects', { method: 'POST', data: { name: '演示·课题组 计量经济学', visibility: 'public' } }))?.id
await call('/api/projects', { method: 'POST', data: { name: '演示·私下组队', visibility: 'private' } })
const now = Date.now()
const mk = (title, hOffset, durH, extra = {}) => call('/api/meetings', { method: 'POST', data: {
  title, recorder: 'e2e', project_ids: [pid],
  starts_at: new Date(now + hOffset * 3600e3).toISOString(),
  ends_at: new Date(now + (hOffset + durH) * 3600e3).toISOString(),
  agenda: '1. 上周进展汇报（每人 5 分钟）\n2. 论文投稿进度与审稿意见回复\n3. 下阶段数据采集安排',
  ...extra } })
const m = await mk('模型评审会', 2, 1.5, { online_url: 'https://meeting.tencent.com/xxx', location: '3 号楼 401' })
await mk('数据治理周会', 26, 1)
await mk('组会', 3, 1)          // 与模型评审会重叠 → 看并排布局
if (m?.id) await call('/api/meetings/' + m.id, { method: 'PUT', data: { online_url: 'https://meeting.tencent.com/new-link' } })

const shot = async (name) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('✓', name) }
const nav = async (t) => { await page.getByText(t, { exact: true }).first().click(); await page.waitForTimeout(1000) }

await page.goto(BASE + '/'); await shot('01-日程')
await nav('会议'); await shot('02-会议列表')
await page.getByText('模型评审会').first().click(); await shot('03-会议详情-上')
await page.mouse.wheel(0, 700); await shot('04-会议详情-下')
await page.goto(BASE + '/'); await nav('会议')
await page.getByRole('button', { name: /发起会议/ }).click(); await shot('05-发起会议')
await page.goto(BASE + '/'); await nav('项目'); await shot('06-项目')

await browser.close()
