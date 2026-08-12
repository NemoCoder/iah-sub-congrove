#!/usr/bin/env node
// ★时区的实地验收★ —— 对着 docs/TECH-DESIGN-M3-timezone.md §5 的用例 10–13。
// （1–9 是纯函数单测，已在 web/src/tz.test.ts；14 要真发一封提醒，单独跑。）
//
// 纪律同 verify-remind.mjs：数据经 Playwright 从真实界面建，SQL 只读。
// 跑在 .14 的有头浏览器上；连不上直接退出，不静默回退 headless。
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY, DSN = process.env.CONGROVE_DEV_DSN
if (!KEY || !DSN) { console.error('缺 IAH_E2E_KEY 或 CONGROVE_DEV_DSN'); process.exit(2) }
const q = (s) => execFileSync('psql', [DSN, '-tA', '-c', s], { encoding: 'utf8' }).trim()
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗ ★失败★'} ${n}${d ? '   — ' + d : ''}`); ok ? pass++ : fail++ }

// ★验线上时跑 .14 的有头浏览器（liaoruili 要看得见），连不上就硬失败不静默回退★。
// ⚠ 唯一的例外：BASE 指向 localhost 时用本机 headless —— 这不是图省事，是**结构性**的：
//   .14 是另一台机器，它够不着我这台的 localhost:5181。
//   改前端时先对着本地 vite 验一轮，再部署到 dev 上用 .14 复验，两步都不省。
const 本地 = /localhost|127\.0\.0\.1/.test(BASE)
const b = 本地
  ? await chromium.launch({ headless: true })
  : await chromium.connect(process.env.PW_WS ?? 'ws://172.19.0.14:9333/congrove', { timeout: 15000 })
      .catch((e) => { console.error('✗ 连不上 .14 有头浏览器:', e.message.split('\n')[0].slice(0, 70)); process.exit(2) })
if (本地) console.log('（BASE 是本地，用本机 headless —— .14 够不着 localhost）')
const ctx = await b.newContext({ viewport: { width: 1520, height: 1000 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': 'liaoruili' } })
const p = await ctx.newPage()
const 项 = (l) => p.locator('.ant-form-item').filter({ has: p.locator('.ant-form-item-label label', { hasText: new RegExp('^' + l) }) }).first()
const 设时区 = async (名) => {
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500)
  await p.locator('.ant-avatar').first().click(); await p.waitForTimeout(700)
  await p.locator('.ant-dropdown-menu-item', { hasText: /^个人面板$/ }).first().click(); await p.waitForTimeout(2200)
  const sel = p.locator('.ant-select').first()
  if (名 === null) { await sel.hover(); await p.waitForTimeout(300)
    const c = p.locator('.ant-select-clear').first(); if (await c.count()) await c.click({ force: true }) }
  else { await sel.click(); await p.waitForTimeout(600)
    await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 名 }).first().click() }
  await p.waitForTimeout(2000)
}
/// 建一场**跨日**的活动（用例 13 的关键：它在不同时区里落在不同的日期）
const 建跨日 = async (title, tz) => {
  const d = new Date(Date.now() + 3 * 864e5)
  const 日 = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500)
  await p.getByRole('button', { name: /发起活动/ }).first().click(); await p.waitForTimeout(2000)
  await p.locator('#title').fill(title)
  const ins = 项('时间').locator('.ant-picker-input input')
  for (const i of [0, 1]) { await ins.nth(i).click(); await p.waitForTimeout(300); await ins.nth(i).fill(日); await p.waitForTimeout(400); await p.keyboard.press('Enter'); await p.waitForTimeout(500) }
  const 挑 = async (n, hm) => { await 项('时间').locator('.ant-select').nth(n).click(); await p.waitForTimeout(500)
    await p.keyboard.type(hm); await p.waitForTimeout(800)
    await p.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click(); await p.waitForTimeout(400) }
  // ⚠★挑时刻要同时满足两条★(前两版各栽一次):
  //   ① 方向别反 —— 要让**西边**时区落在**前一天**,活动得排在东边的**上午**。
  //      北京 23:00 = 纽约同日 11:00,★还是同一天,测不出跨日★。
  //   ② 别落进凌晨折叠带(0–8) —— 北京 01:00 虽然跨日,但默认折叠、根本不在 DOM 里,
  //      而「找不到」和「摆错列」在断言里长得一模一样。
  //   北京 09:00 = 纽约前一日 21:00:既跨日,又在网格上看得见。
  await 挑(0, '09:00'); await 挑(1, '10:00')
  const t = 项('时区').locator('.ant-select').first()
  await t.click(); await p.waitForTimeout(500); await p.keyboard.type(tz); await p.waitForTimeout(700)
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click(); await p.waitForTimeout(400)
  await 项('关联项目').locator('.ant-select').first().click(); await p.waitForTimeout(700)
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click()
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  await p.getByRole('button', { name: '创建活动' }).click(); await p.waitForTimeout(3000)
  return Number(q(`SELECT id FROM activities WHERE title='${title}' LIMIT 1`))
}
/// 这条活动在周视图里落在哪一列（返回列头文字）
const 落在哪列 = async (title) => {
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000)
  // ⚠★凌晨 0–8 默认折叠★:这条活动排在北京 01:00,不展开就根本不在 DOM 里,
  //   而「找不到」和「摆错列」在断言里长得一样 —— ★必须先确认展开成功★。
  const 展 = p.locator('span,a').filter({ hasText: /展开/ }).last()
  if (await 展.count()) { await 展.click({ force: true }); await p.waitForTimeout(1200) }
  return p.evaluate((t) => {
    // ⚠★要取**最内层**那个块★:第一版用 `children.length <= 3` 找,结果匹配到了
    //   包着整个网格的容器 —— 它的中心恒在周三/周四那一带,于是**任何**活动都被判成同一列。
    //   ★那种错给出的是一组看起来可信的错数据★(北京视角也报「周四 13」,而活动明明在 15 号)。
    const all = [...document.querySelectorAll('*')].filter((x) => (x.innerText || '').includes(t))
    const blk = all.filter((x) => ![...x.children].some((c) => (c.innerText || '').includes(t))).pop()
    if (!blk) return '(没找到这条活动)'
    const x = blk.getBoundingClientRect().left + blk.getBoundingClientRect().width / 2
    const heads = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^周[日一二三四五六]\s*\d+/.test((e.innerText || '').trim()))
    let best = null, dist = 1e9
    for (const h of heads) { const r = h.getBoundingClientRect(); const d = Math.abs(r.left + r.width / 2 - x); if (d < dist) { dist = d; best = h.innerText.trim() } }
    return best ?? '(对不上列头)'
  }, title)
}

const T = `[时区验收] 上午跨日 ${new Date().toISOString().slice(11, 19)}`
console.log(`\n══ 时区实地验收（${BASE}）══\n`)

console.log('① 先把时区清空（跟随浏览器=北京），建一场「北京 09:00–10:00」的活动…')
await 设时区(null)
const id = await 建跨日(T, '北京')
if (!id) { console.error('✗ 没建成，后面测不了'); await ctx.close(); await b.close(); process.exit(1) }
const utc = q(`SELECT starts_at::text FROM activities WHERE id=${id}`)
console.log(`   建好 id=${id}  starts_at=${utc}`)
check('⑫ 在「北京」排 09:00 → 库里是同日 01:00Z', utc.includes('01:00:00'), utc)

const 列北京 = await 落在哪列(T)
console.log(`   北京视角落在: ${列北京}`)

console.log('\n② 把设置时区改成纽约（同一条活动，视角变了）…')
await 设时区('America/New_York')
const 列纽约 = await 落在哪列(T)
console.log(`   纽约视角落在: ${列纽约}`)
// 北京 09:00 = 纽约**前一日** 21:00 → ★在纽约应当落在前一天那一列★
const 号 = (s) => Number((s.match(/(\d+)\s*$/) || [])[1] || 0)
check('⑬ ★跨日活动在两种时区下落在正确的日期列★', 号(列纽约) === 号(列北京) - 1 || (号(列北京) === 1 && 号(列纽约) > 20),
  `北京=${列北京} / 纽约=${列纽约}（纽约应当早一天）`)

await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000)
const body = await p.locator('body').innerText()
check('⑪ E0 提示条出现（设备北京 / 设置纽约）', body.includes('你的设备时区'), (body.match(/你的设备时区[^\n]*/) || [''])[0].slice(0, 60))
// ⚠★标注不在日历色块上,在**列表模式**和 tooltip 里★(格子太小塞不下)——
//   所以要切到列表再看。第一版在日历首页扫 innerText,当然扫不到,
//   ★而那种「没找到」看起来和「功能没做」一模一样。★
await p.locator('.ant-segmented-item', { hasText: /^列表$/ }).first().click(); await p.waitForTimeout(1800)
const 列表 = await p.locator('body').innerText()
check('⑩ 跨时区标注出现（列表模式）', /（北京 \d{2}:\d{2}）/.test(列表),
  (列表.match(/（北京 \d{2}:\d{2}）/) || ['(没有)'])[0])

console.log('\n③ 收尾：时区改回「跟随浏览器」…')
await 设时区(null)
console.log(`\n══ ${pass} 过 / ${fail} 失败 ══`)
if (fail) console.log('★有失败项，不算验收通过★')
console.log('\n⚠ 用例 14（纽约用户收到的提醒站内信按谁的时区）要真发一封，单独跑。')
await ctx.close(); await b.close()
process.exit(fail ? 1 : 0)
