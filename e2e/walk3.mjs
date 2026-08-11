#!/usr/bin/env node
// 第三轮:发起活动表单(★时间粒度 00/15/30/45★)+ 月视图(今天高亮 / 左右翻页布局)。
// 前端**没上路由库**(app.tsx 只在 /viewer /s 两条上读 pathname),所以只能一路点进去。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const WS = process.env.PW_WS ?? 'ws://172.20.0.14:9333/congrove'
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

// ★定位「开始」那一行的时间下拉★ ——
// ⚠ 上一版用 `input[readonly]` 撞到了**活动类型**那个 select(它也是 readonly),
//   于是打出「1 / 2 / 会议 / 个人日程」当成时间候选。★选择器撞错元素不会报错,
//   只会给你一组看似合理的错数据★ —— 所以判据要落在「它旁边写着什么」上。
const startRow = p.locator('.ant-select').filter({ has: p.locator('input') })
const n = await startRow.count()
console.log(`  表单里有 ${n} 个 select`)
let found = false
for (let i = 0; i < n && !found; i++) {
  await startRow.nth(i).click({ timeout: 3000 }).catch(() => {})
  await p.waitForTimeout(900)
  const opts = await p.evaluate(() => [...document.querySelectorAll(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')]
    .map((x) => x.innerText.trim()).filter(Boolean))
  const times = opts.filter((s) => /^\d{1,2}:\d{2}/.test(s))
  if (times.length >= 4) {
    found = true
    console.log(`  ★第 ${i} 个是时间下拉★,共 ${opts.length} 项,前 12 个:`, JSON.stringify(times.slice(0, 12)))
    // 判据:分钟只该是 00/15/30/45(用户原话「后面只有 00 15 30 45 这几个分钟」)
    const mins = [...new Set(times.map((s) => s.match(/:(\d{2})/)?.[1]).filter(Boolean))].sort()
    console.log('  出现过的分钟:', mins,
      mins.every((m) => ['00', '15', '30', '45'].includes(m)) ? '✓ 只有一刻钟四格' : '★不止 00/15/30/45★')
    await shot('02-timeopts')
  }
  await p.keyboard.press('Escape').catch(() => {})
}
if (!found) console.log('  ★没找到时间下拉 —— 先怀疑选择器,再怀疑产品★')
// ★关掉表单再走★ —— 上一版按 Escape 就往下读,而弹窗其实没关,
// 于是「月视图」那一段读到的还是发起表单,却报出了一组像模像样的数字。
// ★脚本必须先证明自己真的走到了那一页,再开始读★:读错页面比读不到更坏 ——
// 后者会报错,前者会给你一个**看起来可信的错误结论**。
await p.getByRole('button', { name: /取\s*消/ }).first().click({ timeout: 4000 }).catch(() => {})
await p.keyboard.press('Escape').catch(() => {})
await p.waitForTimeout(1200)

// ══════ 二、月视图 ══════
console.log('\n════ 月视图 ════')
await p.getByText('日程', { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(1500)
// ⚠★别用 getByText('月')★:它会匹配到标题里的「2026 年 8 **月** 9 – 15 日」,
//   于是点了个不是按钮的东西、页面纹丝不动,而脚本继续往下读周视图当月视图。
//   周/月/列表 是个 ant-segmented,按它的 item 精确取。
await p.locator('.ant-segmented-item', { hasText: /^月$/ }).first().click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(2200)
t = await p.locator('body').innerText()
// ★导航判据要能证伪★:周视图有整点行(8:00 / 9:00),月视图没有。
// 只判「有没有『月』字」是判不出来的 —— 两个视图都有。
const onMonth = !t.includes('活动标题') && !/\b9:00\b/.test(t)
console.log(onMonth ? '  ✓ 确实切到月视图' : '  ★还停在周视图,下面的读数作废★')
console.log('【月视图】', t.replace(/\n+/g, ' | ').slice(0, 400))
if (!onMonth) { console.log('\n(跳过月视图判定)'); await ctx.close(); await b.close(); process.exit(1) }
// 今天高亮:找出所有日期格,看哪个的背景/字重与众不同
// ⚠★别按 `td,[class*=cell],[class*=day]` 找★:这套月历是 div 拼的、类名对不上,
//   上一版因此返回「总格数 0」——**看起来像「今天没高亮」,其实是没找到任何格子**。
//   ★脚本必须把「我没找到」和「它不存在」分开报★,否则我的 bug 会被当成产品的 bug。
//   判据换成「找到只写着一个日期数字的最小元素」,不依赖类名。
const today = await p.evaluate(() => {
  const dd = String(new Date().getDate())
  const leaf = [...document.querySelectorAll('div,span,td')]
    .filter((x) => /^\d{1,2}$/.test((x.innerText || '').trim()) && x.children.length === 0)
  const pick = (d) => {
    const el = leaf.find((x) => x.innerText.trim() === d)
    if (!el) return null
    const cs = getComputedStyle(el)
    // 底色可能挂在包着数字的那层(圆圈)上,往上找两层
    let bg = cs.backgroundColor
    for (let x = el; x && bg.includes('rgba(0, 0, 0, 0)'); x = x.parentElement) bg = getComputedStyle(x).backgroundColor
    return { 数字: d, 底色: bg, 字重: cs.fontWeight, 字色: cs.color }
  }
  return { 找到几个日期格: leaf.length, 今天: pick(dd), 对照日: pick(dd === '1' ? '2' : '1') }
})
console.log('【今天高亮】', JSON.stringify(today))
if (today.今天 && today.对照日) {
  const diff = today.今天.底色 !== today.对照日.底色 || today.今天.字重 !== today.对照日.字重
  console.log(diff ? '  ✓ 今天与普通日在视觉上确实不同' : '  ★今天和普通日一模一样 —— 没高亮★')
}
await shot('03-month')

console.log('\n控制台报错:', errs.length ? errs.slice(0, 6) : '无 ✓')
await p.waitForTimeout(2500)
await ctx.close(); await b.close()
