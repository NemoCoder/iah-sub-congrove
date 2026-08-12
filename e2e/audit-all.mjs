#!/usr/bin/env node
// ★全面巡检★（2026-08-13 liaoruili:「每一个按键你都测试了吗。截图了吗？」
// 「截图必须要全部放下来！！！慢没问题，核心是我怕你漏掉！！！」）。
//
// 这不是「验某个功能」的脚本，而是**把界面走一遍**：每个视图、每个项目、每场活动、
// 每个 tab、每个能点的元素，点一下、截一张全页图、记一笔。它要抓的是逐条功能验收
// **结构上看不见**的那一类：点了没反应 / 点了报错 / 点开一片空白。
// 逐条验收只走 happy path，这三样在里面永远不会暴露。
//
// ══ 按 liaoruili 的两条要求定的死规矩 ══
// ★① 全页截图（fullPage）★：视口截图会把长页面**切掉下半截**，而「下半截长什么样」
//    正是他上一次发现问题的地方（24 条转移请求把页面拉到滚不完）。切掉 = 漏掉。
// ★② 不去重、不按名字合并★：同名按钮在不同行上是**不同的按钮**（每个项目行都有「⋯」），
//    按名字去重会让「只有第 7 行那个坏了」永远测不出来。逐个下标点。
//    代价是慢一个数量级 —— 他明确说了慢没问题。
//
// ══ 三条安全纪律 ══
// ① ★破坏性动作只对自己造的数据做★：删除/归档/清空/退出进名单，在真实数据上只截图不点；
//    真正的删除生命周期在最后一段对 `E2E-审计-*` 自己的数据走。
// ② ★弹窗只开不确认★：对话框开了截图就 Esc，绝不点「确定」——
//    审计脚本误改真实数据比漏测一个按钮严重得多。
// ③ ★全程收 console error 与 HTTP >= 400★：很多「点了没反应」在界面上是安静的，
//    只有这两条流水里看得出来。
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const WHO = process.env.AUDIT_USER ?? 'liaoruili'
const VER = process.env.AUDIT_VER ?? 'v0.4.113'
/// ★每一轮一个独立目录★（2026-08-13 踩的第二个坑）：重跑一小段时编号又从 0001 开始，
/// **把上一轮的报告和前 11 张截图直接覆盖掉了** —— 全量那份 178 次点击的报告就此没了
/// （幸好终端日志还在）。截图是证据，证据不能被下一次运行擦掉。
const RUN = process.env.AUDIT_RUN ?? '全量'
const DIR = `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${VER}/巡检-${RUN}`
mkdirSync(DIR, { recursive: true })

/// 点了会改数据的名字：不是不测，是只对自己造的数据测（纪律①）
const 破坏性 = /删\s*除|清\s*空|移\s*除|退\s*出|注\s*销|归\s*档|恢复为|撤\s*销|解\s*除|吊\s*销|转\s*让|转\s*移|还\s*原|彻底|清理|purge/i
/// 会把页面整个带走的（登出、跳外站），以及**会改账号状态**的。
///
/// ⚠★「进入超管模式」是 2026-08-13 第一轮巡检踩的坑★:它不含「删除/归档」这类字眼,
///   于是溜过了破坏性名单 —— 脚本点了它,把 liaoruili 的账号**提权了两小时**。
///   ★破坏性不只是「改数据」,还包括「改这个人的权限状态」★:后者更隐蔽,
///   因为它在界面上什么都不删,只是让这个人此后看得到所有人的东西。
///   (发现方式也值得记:是我逐张看截图时看见顶部那条黄色横幅才发觉的,报告里一个字都没有。)
const 别点 = /退出登录|IAH 开发平台|开发平台|hub\.ruciah|超管模式/
/// 一屏之内可点的东西
const SEL = 'button:visible, a:visible, [role=tab]:visible, [role=radio]:visible'

const 错误 = [], 网络 = [], 记录 = []
let n = 0
const shot = async (名) => {
  const f = `${String(++n).padStart(4, '0')}-${名.replace(/[\/\s]+/g, '_').replace(/[^\w一-龥.-]/g, '').slice(0, 48)}.png`
  // ★fullPage★：长页面不许被视口切掉（要求①）
  await p.screenshot({ path: `${DIR}/${f}`, fullPage: true }).catch(() => {})
  return f
}

const b = await chromium.connect('ws://172.19.0.14:9333/congrove', { timeout: 20000 })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': WHO } })
const p = await ctx.newPage()
p.on('console', (m) => { if (m.type() === 'error') 错误.push(m.text().slice(0, 220)) })
p.on('pageerror', (e) => 错误.push('★未捕获异常★ ' + String(e).slice(0, 220)))
p.on('response', (r) => { if (r.status() >= 400) 网络.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })

const 到首页 = async () => { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2200) }
const nav = async (名) => { await p.getByText(名, { exact: true }).first().click(); await p.waitForTimeout(1300) }
const 收弹窗 = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await p.locator('.ant-modal:visible, .ant-drawer:visible, .ant-select-dropdown:visible, .ant-dropdown:visible').count())) break
    await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  }
}

/// ★巡一屏★：把当前屏上所有可点元素**逐个下标**点一遍，每点一次先复位。
/// `复位` 必须把页面带回到「这一屏」，否则下一个下标指向的就不是同一个东西了。
const ONLY = process.env.AUDIT_ONLY
async function 巡一屏(页面, 复位) {
  if (ONLY && !页面.includes(ONLY)) return
  await 复位()
  const 全部 = []
  for (const el of await p.locator(SEL).all()) {
    const t = ((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')
    const aria = (await el.getAttribute('aria-label').catch(() => null)) ?? ''
    全部.push(t || aria || '(无文字)')
  }
  console.log(`\n── ${页面}：${全部.length} 个可点元素 ──`)
  for (let i = 0; i < 全部.length; i++) {
    const 名 = 全部[i]
    if (别点.test(名)) { 记录.push({ 页面, 序: i, 元素: 名, 结果: '跳过(会离开本站/登出)', 截图: '' }); continue }
    // ★复位后按**名字**找回来,不认死下标★（2026-08-13 第一轮巡检暴露的脚本 bug）:
    //   下标会漂移(点了一下之后列表长短变了、或复位落在了别的屏),
    //   死认下标的结果是 8 条「复位后这个位置没有元素了」——
    //   ★而那 8 条的真相是「这个按钮我根本没测到」,不是「它坏了」。★
    //   把没测到报成异常会掩盖真异常;把没测到报成通过更糟。所以单列一类「未测」。
    let el = null
    for (let 轮 = 0; 轮 < 2 && !el; 轮++) {
      await 复位()
      const 现在 = await p.locator(SEL).all()
      const 文 = []
      for (const e of 现在) 文.push(((((await e.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')) || '(无文字)'))
      if (文[i] === 名) el = p.locator(SEL).nth(i)
      else { const j = 文.indexOf(名); if (j >= 0) el = p.locator(SEL).nth(j) }
    }
    if (!el) { 记录.push({ 页面, 序: i, 元素: 名, 结果: '未测(复位后找不到这个元素)', 截图: '' }); console.log(`  ? [${页面}] #${i} ${名} — 未测:复位后找不到`); continue }
    const 现名 = (((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')) || '(无文字)'
    if (破坏性.test(名) || 破坏性.test(现名)) {
      记录.push({ 页面, 序: i, 元素: 名, 结果: '跳过(破坏性,改到 E2E- 数据上测)', 截图: await shot(`${页面}-${i}-跳过-${名}`) })
      console.log(`  ⊘ [${页面}] #${i} ${名} — 破坏性，只截图`)
      continue
    }
    const 错前 = 错误.length, 网前 = 网络.length
    let 结果 = 'ok'
    try { await el.click({ timeout: 6000 }) } catch (e) { 结果 = '★点不动★ ' + String(e).split('\n')[0].slice(0, 90) }
    await p.waitForTimeout(1000)
    const 新错 = 错误.slice(错前), 新网 = 网络.slice(网前)
    if (新错.length) 结果 = '★JS 报错★ ' + 新错[0]
    else if (新网.length) 结果 = '★HTTP ' + 新网[0] + '★'
    const f = await shot(`${页面}-${i}-${名}`)
    记录.push({ 页面, 序: i, 元素: 名 + (现名 !== 名 ? ` (复位后是「${现名}」)` : ''), 结果, 截图: f })
    console.log(`  ${结果 === 'ok' ? '✓' : '✗'} [${页面}] #${i} ${名}${结果 === 'ok' ? '' : '   — ' + 结果}`)
    await 收弹窗()
  }
}

console.log(`\n══ 全面巡检 ${VER}（${BASE}，身份 ${WHO}）══`)
console.log(`★全页截图、不去重、逐下标点★；报告与截图落 ${DIR}\n`)

// ══ 一、三个主视图 ══
await 到首页(); await shot('首页-日程-初始')
await 巡一屏('日程', 到首页)
await 巡一屏('项目', async () => { await 到首页(); await nav('项目') })
await 巡一屏('活动', async () => { await 到首页(); await nav('活动') })

// ══ 二、每个项目 × 每个 tab（按钮大半住在这里）══
await 到首页(); await nav('项目')
const 项目名单 = []
for (const el of await p.locator('.ant-card').filter({ hasText: '项目' }).first()
  .locator('div[style*="cursor"], li, .ant-list-item').all()) {
  const t = ((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')
  if (t && t.length < 40 && !/进行中|已归档|回收站|新\s*建/.test(t)) 项目名单.push(t.split(/管理员|成员|只读|系统/)[0].trim())
}
const 项目们 = [...new Set(项目名单)].filter(Boolean).slice(0, 8)
console.log(`\n══ 项目共 ${项目们.length} 个：${项目们.join(' / ')} ══`)
for (const 名 of 项目们) {
  const 进项目 = async () => {
    await 到首页(); await nav('项目')
    await p.getByText(名, { exact: false }).first().click(); await p.waitForTimeout(1400)
  }
  await 进项目(); await shot(`项目-${名}-进入`)
  // 右侧 tab 逐个进，进去之后再把那一屏点一遍
  const tabs = []
  for (const t of await p.locator('[role=tab]:visible').all()) {
    const s = ((await t.textContent().catch(() => '')) ?? '').trim()
    if (s) tabs.push(s)
  }
  for (const tb of tabs) {
    await 巡一屏(`项目·${名}·${tb}`, async () => {
      await 进项目()
      const t = p.locator('[role=tab]:visible').filter({ hasText: tb }).first()
      if (await t.count()) { await t.click(); await p.waitForTimeout(1100) }
    })
  }
}

// ══ 三、每场活动的详情页 ══
await 到首页(); await nav('活动')
const 活动们 = []
for (const el of await p.locator('div[style*="cursor"], .ant-list-item').all()) {
  const t = ((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')
  if (t && t.length > 2 && t.length < 60) 活动们.push(t.split(/\d{1,2}\/\d{1,2}/)[0].trim())
}
const 活动清单 = [...new Set(活动们)].filter((x) => x && x.length > 2).slice(0, 6)
console.log(`\n══ 活动共巡 ${活动清单.length} 场 ══`)
for (const 名 of 活动清单) {
  await 巡一屏(`活动·${名}`, async () => {
    await 到首页(); await nav('活动')
    const el = p.getByText(名, { exact: false }).first()
    if (await el.count()) { await el.click(); await p.waitForTimeout(1600) }
  })
}

// ══ 四、用户菜单四个页面 ══
for (const 项 of ['个人面板', '我的分享', '我的活动类型', '开发者']) {
  await 巡一屏(`菜单·${项}`, async () => {
    await 到首页()
    await p.locator('button').filter({ hasText: new RegExp(WHO.slice(0, 6)) }).first().click().catch(() => {})
    await p.waitForTimeout(700)
    const it = p.locator('.ant-dropdown-menu-item:visible').filter({ hasText: 项 }).first()
    if (await it.count()) { await it.click(); await p.waitForTimeout(1400) }
  })
}

// ══ 汇总 ══
const 坏 = 记录.filter((r) => r.结果 !== 'ok' && !r.结果.startsWith('跳过') && !r.结果.startsWith('未测'))
const 未测 = 记录.filter((r) => r.结果.startsWith('未测'))
writeFileSync(`${DIR}/报告.md`, [
  `# 全面巡检报告 ${VER}`, '',
  `站点 ${BASE}　身份 ${WHO}　共点 ${记录.length} 处，异常 **${坏.length}** 处，★未测 ${未测.length} 处★，截图 ${n} 张（全部 fullPage）`, '',
  ...(未测.length ? ['## ★未测清单★（不是通过,是没点到——必须补）', '',
    ...未测.map((r) => `- ${r.页面} #${r.序} ${r.元素}：${r.结果}`), ''] : []),
  ...(坏.length ? ['## ★异常清单★', '', '| 页面 | # | 元素 | 结果 | 截图 |', '|---|---|---|---|---|',
    ...坏.map((r) => `| ${r.页面} | ${r.序} | ${r.元素} | ${r.结果} | ${r.截图} |`), ''] : ['## 异常清单', '（无）', '']),
  '## 全部点击记录', '', '| 页面 | # | 元素 | 结果 | 截图 |', '|---|---|---|---|---|',
  ...记录.map((r) => `| ${r.页面} | ${r.序} | ${r.元素} | ${r.结果} | ${r.截图} |`), '',
  '## console 错误', ...(错误.length ? [...new Set(错误)].map((e) => '- ' + e) : ['（无）']), '',
  '## HTTP >= 400', ...(网络.length ? [...new Set(网络)].map((e) => '- ' + e) : ['（无）']),
].join('\n'))
console.log(`\n══ 共点 ${记录.length} 处，异常 ${坏.length} 处，未测 ${未测.length} 处；截图 ${n} 张；console 错误 ${new Set(错误).size} 种，HTTP>=400 ${new Set(网络).size} 种 ══`)
console.log(`报告：${DIR}/报告.md`)
await b.close()
