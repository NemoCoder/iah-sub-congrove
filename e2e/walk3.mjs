#!/usr/bin/env node
// 第三轮:发起活动表单(★时间粒度 00/15/30/45★)+ 月视图(今天高亮 / 左右翻页布局)。
// 前端**没上路由库**(app.tsx 只在 /viewer /s 两条上读 pathname),所以只能一路点进去。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const WS = process.env.PW_WS ?? 'ws://172.20.0.14:9333/acf3729be085cb1c063b8a33b2a87794'
const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(2) }
const SHOT_DIR = process.env.SHOT_DIR ?? `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${process.env.SHOT_VER ?? 'latest'}`
mkdirSync(SHOT_DIR, { recursive: true })

const b = await chromium.connect(WS, { timeout: 15000 })
const ctx = await b.newContext({
  viewport: { width: 1520, height: 950 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': 'liaoruili' },
})
const p = await ctx.newPage()
const errs = []
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)) })
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 140)))
const shot = (n) => p.screenshot({ path: `${SHOT_DIR}/w3-${n}.png` })

await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2500)

// ══════ 一、发起活动表单 ══════
console.log('════ 发起活动 ════')
await p.getByRole('button', { name: /发起活动/ }).first().click({ timeout: 6000 }).catch(async () => {
  await p.getByText('发起活动').first().click({ timeout: 6000 }).catch(() => {})
})
await p.waitForTimeout(2000)
let t = await p.locator('body').innerText()
console.log('【表单】', t.replace(/\n+/g, ' | ').slice(0, 460))
await shot('01-create-form')

// 表单上的输入控件清单 —— 看看时间到底是什么控件(用户明确不要「时分秒」滚轮)
const fields = await p.evaluate(() => [...document.querySelectorAll('input,select,textarea')].map((x) => ({
  ph: x.placeholder || '', v: (x.value || '').slice(0, 24), type: x.type || x.tagName,
  cls: (x.className || '').toString().slice(0, 48),
})).slice(0, 20))
console.log('【控件】', JSON.stringify(fields, null, 0))

// 逐个点开可能的时间输入,记录它给出的候选
for (const sel of ['input[placeholder*="开始"]', 'input[placeholder*="时间"]', '.ant-picker input', 'input[readonly]']) {
  const el = p.locator(sel).first()
  if (!(await el.count())) continue
  await el.click({ timeout: 4000 }).catch(() => {})
  await p.waitForTimeout(1200)
  const opts = await p.evaluate(() => [...document.querySelectorAll(
    '.ant-select-item-option-content,.ant-picker-time-panel-cell-inner,[role=option]')]
    .map((x) => x.innerText.trim()).filter(Boolean))
  if (opts.length) {
    console.log(`【${sel} 的候选】共 ${opts.length} 个:`, JSON.stringify(opts.slice(0, 30)))
    // ★判据★:分钟只该出现 00/15/30/45(用户原话「后面只有 00 15 45 60 这几个分钟」)
    const mins = [...new Set(opts.map((s) => s.match(/:(\d{2})/)?.[1]).filter(Boolean))]
    if (mins.length) console.log('   出现过的分钟:', mins.sort(), mins.every((m) => ['00', '15', '30', '45'].includes(m)) ? '✓' : '★不止 00/15/30/45★')
    await shot('02-timeopts')
    break
  }
}
await p.keyboard.press('Escape').catch(() => {})

// ══════ 二、月视图 ══════
console.log('\n════ 月视图 ════')
await p.getByText('日程', { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(1200)
await p.getByText('月', { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(2000)
t = await p.locator('body').innerText()
console.log('【月视图】', t.replace(/\n+/g, ' | ').slice(0, 400))
// 今天高亮:找出所有日期格,看哪个的背景/字重与众不同
const today = await p.evaluate(() => {
  const dd = String(new Date().getDate())
  const cells = [...document.querySelectorAll('td,[class*=cell],[class*=day]')]
    .filter((c) => /^\s*\d{1,2}\s*$/.test((c.innerText || '').split('\n')[0]))
  const info = cells.map((c) => {
    const cs = getComputedStyle(c)
    return { d: c.innerText.split('\n')[0].trim(), bg: cs.backgroundColor, w: cs.fontWeight, c: cs.color }
  })
  const mine = info.filter((x) => x.d === dd)
  const others = info.filter((x) => x.d !== dd).slice(0, 3)
  return { 今天: mine, 其他日: others, 总格数: info.length }
})
console.log('【今天高亮】', JSON.stringify(today))
await shot('03-month')

console.log('\n控制台报错:', errs.length ? errs.slice(0, 6) : '无 ✓')
await p.waitForTimeout(2500)
await ctx.close(); await b.close()
