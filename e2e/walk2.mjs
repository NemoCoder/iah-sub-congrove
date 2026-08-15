#!/usr/bin/env node
// 深一层的巡查:点进项目 / 点进活动详情 / 打开发起表单,盯用户报过的那几类缺陷。
// 判据尽量是**可判定的事实**(数字、几行、有没有这个元素),而不是「看起来怎样」。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { pwWs } from './pw-endpoint.mjs'

const WS = pwWs()
const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(2) }

/// ★截图一律落 `unit_tests/congrove/screenshots/<版本>/`★(liaoruili 定,别再写 /tmp)——
/// 那里按版本分目录存着历次巡查的图,能**跨版本对照**;丢进 /tmp 的一重启就没了,
/// 也就没法回答「这个毛病是这版才有的还是一直如此」。
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
const shot = (n) => p.screenshot({ path: `${SHOT_DIR}/w2-${n}.png` })
const say = (...a) => console.log(...a)

/// 「抖动」的可判定判据:动作前后**页面总高**或**是否出现纵向滚动条**发生变化。
/// 用户报了七八次「页面抖动」,肉眼描述不了,但这两个量能钉死它。
const metrics = () => p.evaluate(() => ({
  h: document.documentElement.scrollHeight,
  hasV: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  y: window.scrollY,
}))
const jitter = async (label, act) => {
  const a = await metrics(); await act(); await p.waitForTimeout(1200); const c = await metrics()
  const moved = a.h !== c.h || a.hasV !== c.hasV
  say(`  ${moved ? '⚠抖动' : '✓平稳'} ${label}: 高 ${a.h}→${c.h} 纵向滚动 ${a.hasV}→${c.hasV}`)
  return moved
}

await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2500)

// ══════ 一、项目页:只读材料区 + 活动文件夹能不能直达活动 ══════
say('\n════ 项目 ════')
await p.getByText('项目', { exact: true }).first().click(); await p.waitForTimeout(1500)
await p.getByText('我的活动材料', { exact: true }).first().click(); await p.waitForTimeout(1800)
let t = await p.locator('body').innerText()
say('【我的活动材料】', t.slice(t.indexOf('我的活动材料')).replace(/\n+/g, ' | ').slice(0, 380))
// 只读的判据:★不该出现「上传 / 新建文件夹 / 删除」这类写入入口★
const writeBtns = await p.evaluate(() => [...document.querySelectorAll('button')]
  .map((x) => x.innerText.trim()).filter((s) => /上传|新建|删除|移动|重命名/.test(s)))
say('  写入类按钮:', writeBtns.length ? '⚠ ' + JSON.stringify(writeBtns) : '✓ 无（只读）')
// 活动文件夹「操作」栏应当能点回活动详情
const rowLinks = await p.evaluate(() => [...document.querySelectorAll('tbody tr')].slice(0, 4).map((tr) => ({
  第一格: tr.cells?.[0]?.innerText.trim().slice(0, 30),
  操作: [...tr.querySelectorAll('a,button')].map((x) => x.innerText.trim()).filter(Boolean).join('/'),
})))
say('  文件夹行:', JSON.stringify(rowLinks))
await shot('01-materials')

// 切到普通项目,验「切 tab 之后不串台」(用户报过:在别的 tab 切到我的活动材料就乱)
const proj = p.getByText('课题组·计量经济学', { exact: true }).first()
if (await proj.count()) {
  await jitter('切到「课题组·计量经济学」', async () => { await proj.click() })
  t = await p.locator('body').innerText()
  say('  项目内容:', t.slice(t.indexOf('课题组')).replace(/\n+/g, ' | ').slice(0, 300))
  await shot('02-project')
}

// ══════ 二、活动详情:tab 切换抖不抖 / 参会率 / 纪要入口 ══════
say('\n════ 活动详情 ════')
await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1500)
await p.getByText('八月第二次组会').first().click(); await p.waitForTimeout(2200)
t = await p.locator('body').innerText()
say('【详情】', t.replace(/\n+/g, ' | ').slice(0, 500))
// 参会率:曾经算出过 333%
const pct = [...t.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => +m[1])
say('  页面上的百分比:', pct.length ? pct : '（无）', pct.some((x) => x > 100) ? '★★超过 100%★★' : '✓')
await shot('03-detail')

for (const tab of ['材料', '录制', '纪要', '参会人']) {
  const el = p.getByRole('tab', { name: tab }).or(p.getByText(tab, { exact: true })).first()
  if (await el.count()) await jitter(`切到「${tab}」tab`, async () => { await el.click({ timeout: 4000 }).catch(() => {}) })
  await shot('tab-' + tab)
}

// ══════ 三、发起活动:开始/结束时间的分钟粒度(用户要 00/15/30/45) ══════
say('\n════ 发起活动 ════')
await p.getByText('+ 发起活动').or(p.getByRole('button', { name: /发起活动/ })).first()
  .click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(1800)
t = await p.locator('body').innerText()
say('【表单】', t.replace(/\n+/g, ' | ').slice(0, 420))
await shot('04-create')
// 打开时间下拉,看给的分钟选项
const timeBox = p.locator('input[placeholder*="时间"],input[placeholder*="开始"]').first()
if (await timeBox.count()) {
  await timeBox.click({ timeout: 4000 }).catch(() => {})
  await p.waitForTimeout(1200)
  const opts = await p.evaluate(() => [...document.querySelectorAll('.ant-select-item,.ant-picker-time-panel-cell,[role=option]')]
    .map((x) => x.innerText.trim()).filter(Boolean).slice(0, 40))
  say('  时间下拉选项:', JSON.stringify(opts))
  await shot('05-timepicker')
}

say('\n控制台报错:', errs.length ? errs.slice(0, 6) : '无 ✓')
await p.waitForTimeout(3000)
await ctx.close(); await b.close()
