#!/usr/bin/env node
// ★走一遍 UI★ —— 用 **DOM 断言**而不是截图。
//
// 为什么不靠截图:①Claude 一段会话的图片是有上限的(600 张 / 32MB,而且整段会话
// 每轮都重发一次,所以是**累计**的);②更要紧的是**断言比肉眼准** ——
// 「跨天块把网格撑高了」这种事,`scrollHeight - clientHeight` 会告诉你差了多少像素,
// 而看图只能说「感觉有点高」。视觉审美留给人(浏览器就开在 liaoruili 旁边那台机器上)。
//
// 用法:IAH_E2E_KEY=$(cat ~/.config/iah/congrove-e2e-key) node e2e/walk.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { pwWs } from './pw-endpoint.mjs'

const WS = pwWs()
const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(2) }

const pass = [], fail = []
const ok = (name, cond, detail = '') => (cond ? pass : fail).push(`${name}${detail ? ' —— ' + detail : ''}`)

/// ★截图一律落 `unit_tests/congrove/screenshots/<版本>/`★(liaoruili 定,别再写 /tmp)——
/// 那里按版本分目录存着历次巡查的图,能**跨版本对照**;丢进 /tmp 的一重启就没了,
/// 也就没法回答「这个毛病是这版才有的还是一直如此」。
const SHOT_DIR = process.env.SHOT_DIR ?? `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${process.env.SHOT_VER ?? 'latest'}`
mkdirSync(SHOT_DIR, { recursive: true })

const b = await chromium.connect(WS, { timeout: 15000 })
const ctx = await b.newContext({
  viewport: { width: 1520, height: 950 },
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': 'liaoruili' },
})
const p = await ctx.newPage()
/// 控制台报错是**免费的信号**:它抓得到「渲染出来了但底下在报错」这类肉眼看不见的问题。
const errs = []
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)) })
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)))

const shot = (n) => p.screenshot({ path: `${SHOT_DIR}/walk-${n}.png` })
const text = async (sel) => (await p.locator(sel).first().innerText().catch(() => '')).trim()

await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(3000)

// ══ 0. 落地:版本、身份 ══
const body = await p.locator('body').innerText()
const ver = body.match(/v\d+\.\d+\.\d+/)?.[0] ?? '?'
console.log(`\n【线上】${ver}  身份=${body.includes('liaoruili') ? 'liaoruili ✓' : '★不是 liaoruili★'}`)
console.log('顶部:', body.slice(0, 160).replace(/\n+/g, ' | '))

// ══ 1. 全局:页面不该横向滚动(用户报过「我的内容没超出屏幕，为啥右边有个滚动条」)══
const scroll = await p.evaluate(() => ({
  docW: document.documentElement.scrollWidth, cliW: document.documentElement.clientWidth,
  docH: document.documentElement.scrollHeight, cliH: document.documentElement.clientHeight,
  bodyOverflowX: getComputedStyle(document.body).overflowX,
}))
ok('全局无横向滚动', scroll.docW <= scroll.cliW + 1, `scrollWidth=${scroll.docW} clientWidth=${scroll.cliW}`)

// ══ 2. 日程周视图 ══
// 2a. 折叠条:上面写的数字必须等于折叠区里真实的活动数(★本轮改的就是这个★)
const foldBar = body.match(/凌晨[^\n]*/)?.[0] ?? ''
console.log('\n【日程】折叠条:', foldBar || '(没有折叠条)')
const foldNum = foldBar.match(/这段有\s*(\d+)\s*项/)?.[1]

// 2b. 网格高度:跨天的活动块不该把网格撑出纵向滚动
const grid = await p.evaluate(() => {
  // 找到最深的、同时含有「时刻列」的滚动容器
  const cands = [...document.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 2)
  return cands.slice(0, 6).map((d) => ({
    cls: (d.className || '').toString().slice(0, 60),
    over: d.scrollHeight - d.clientHeight, h: d.clientHeight,
  }))
})
console.log('【日程】纵向溢出的容器:', grid.length ? JSON.stringify(grid) : '无 ✓')

// 2c. 今天高亮
// ⚠★这里原来一直返回 null,而界面上其实是有高亮的★(2026-08-10):
// 选择器按 `th,[class*=head],[class*=col]` 找,可这套日历是 div 拼的、类名对不上 ——
// 于是脚本报「没找到」,我差点把它当成「没高亮」写进结论。
// ★「选择器没匹配上」和「这个东西不存在」是两回事,脚本必须把两者分开报★:
// 前者是我的 bug,后者才是产品的 bug。判据换成「按可见文字定位」——
// 它是用户真正看到的东西,不依赖 DOM 结构怎么搭。
const todayHl = await p.evaluate(() => {
  const el = [...document.querySelectorAll('div,th,td,span')]
    .filter((x) => (x.innerText || '').includes('今天') && x.children.length <= 3)
    .sort((a, b) => a.innerText.length - b.innerText.length)[0]
  if (!el) return { 找到: false, 说明: '★没找到写着「今天」的元素——先怀疑选择器,再怀疑产品★' }
  const bg = (n) => { // 背景可能挂在祖先上,往上找到第一个非透明的
    for (let x = n; x && x !== document.body; x = x.parentElement) {
      const c = getComputedStyle(x).backgroundColor
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c
    }
    return '(全透明)'
  }
  const cs = getComputedStyle(el)
  return { 找到: true, 文字: el.innerText.replace(/\n/g, ' ').slice(0, 20), 底色: bg(el), 字重: cs.fontWeight }
})
console.log('【日程】今天那一列:', JSON.stringify(todayHl, null, 0))

await shot('01-schedule')

// ══ 3. 逐个 tab 走一遍,记录切换时的**布局抖动** ══
// 用户反复报「页面抖动」:判据是切换后 body 的 scrollHeight 突变 / 出现纵向滚动条。
const tabs = ['日程', '项目', '活动']
for (const t of tabs) {
  const link = p.getByRole('link', { name: t }).or(p.getByText(t, { exact: true })).first()
  if (!(await link.count())) { console.log(`\n【${t}】找不到入口`); continue }
  const before = await p.evaluate(() => document.documentElement.scrollHeight)
  await link.click({ timeout: 5000 }).catch(() => {})
  await p.waitForTimeout(1800)
  const after = await p.evaluate(() => document.documentElement.scrollHeight)
  const t2 = (await p.locator('body').innerText()).replace(/\n+/g, ' | ')
  console.log(`\n【${t}】高度 ${before}→${after}  内容: ${t2.slice(0, 260)}`)
  await shot('tab-' + t)
}

console.log('\n══ 断言 ══')
pass.forEach((s) => console.log('  ✓', s))
fail.forEach((s) => console.log('  ✗', s))
console.log('\n控制台报错:', errs.length ? errs.slice(0, 8) : '无 ✓')
console.log('折叠条声称:', foldNum ?? '(无)')

await p.waitForTimeout(4000)
await ctx.close(); await b.close()
