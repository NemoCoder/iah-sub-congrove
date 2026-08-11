// 屏幕关掉之后,有头浏览器还渲染吗? —— 判据不是「连得上」,而是**截图里真的有像素内容**。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const OUT = '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/screen-off'
mkdirSync(OUT, { recursive: true })
const b = await chromium.connect(process.env.PW_WS ?? 'ws://172.19.0.14:9333/congrove', { timeout: 15000 })
console.log('✓ 连上浏览器服务, version =', b.version())
const ctx = await b.newContext({ viewport: { width: 1520, height: 950 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY, 'X-IAH-E2E-User': 'liaoruili' } })
const p = await ctx.newPage()
const t0 = Date.now()
await p.goto('https://congrove-dev.sub.ruciah.com/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(3000)
console.log(`✓ 页面加载完 (${Date.now() - t0}ms)`)
const txt = (await p.locator('body').innerText()).replace(/\n+/g, ' | ')
console.log('✓ 读到文字:', txt.slice(0, 120))
// ★真正的判据★:合成器在关屏时可能停止绘制,那样截图会是纯色/全黑。数一下颜色分布。
const buf = await p.screenshot({ path: `${OUT}/probe.png` })
console.log('✓ 截图', buf.length, '字节')
// 交互也验一下:点一个 tab,看内容真的变了
await p.getByText('活动', { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(1500)
const t2 = (await p.locator('body').innerText()).replace(/\n+/g, ' | ')
console.log('✓ 点击后内容变了吗:', t2.slice(0, 100) !== txt.slice(0, 100) ? '★变了,交互正常★' : '没变')
await p.screenshot({ path: `${OUT}/after-click.png` })
await ctx.close(); await b.close()
