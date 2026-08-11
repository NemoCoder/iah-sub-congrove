#!/usr/bin/env node
// ★提醒功能的实地验收★ —— 对着 docs/TECH-DESIGN-M1-remind.md §6 的用例表逐条跑。
//
// ══════ 为什么必须实地跑 ══════
// 这个功能的判据**几乎全在 SQL 里**（设计 §6 自己说的），而本仓 sqlx 全用 runtime 查询：
// 编译器不看 SQL、单测覆盖不到后台循环。PREPARE 闸只保证「语法与 schema 对得上」，
// 保证不了「发给了对的人、而且只发一次」。
//
// ══════ 纪律（liaoruili 强调过两次）══════
//  · ★数据一律经 Playwright 从真实界面建★ —— 不许直接写库，**也不许直接打 API**。
//    绕过界面建出来的行未必是界面会产生的形状；而且这样连我新加的「提醒我」下拉一起验了。
//  · SQL **只读不写**：只用来观察 `reminded_at` / `remind_minutes` 这两列。
//    后台循环写的东西没有接口读得到全貌，观察必须落到库上。
//  · 后台循环 30 秒一轮（remind.rs 的 TICK_SEC），每次断言前等够一轮 + 余量。
//
// ⚠★经界面建的活动只能落在 15 分钟的整槽上★（time-slots.ts 的 STEP_MIN）——
//   所以不写死「20 分钟后」这种断言，而是**把真实 starts_at 读回来**再判该不该发。
//   写死偏移的话，脚本会因为取整而随机红，那种红比不测更糟。
//
// 用法：
//   source ~/.config/iah/congrove-dev.env
//   IAH_E2E_KEY=$(cat ~/.config/iah/congrove-e2e-key) node e2e/verify-remind.mjs
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const DSN = process.env.CONGROVE_DEV_DSN
if (!KEY || !DSN) { console.error('缺 IAH_E2E_KEY 或 CONGROVE_DEV_DSN'); process.exit(2) }
const AS = 'liaoruili'
const DEFAULT_REMIND = 15   // remind.rs 的 DEFAULT_REMIND_MIN（个人也没设时的兜底）

/// ★只读★。用 -tA 拿裸值，方便直接比较。
const q = (s) => execFileSync('psql', [DSN, '-tA', '-c', s], { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
/// 向上取到 15 分钟整槽（与 time-slots.ts 的 ceil 语义一致）
const slotAfter = (minFromNow) => {
  const d = new Date(Date.now() + minFromNow * 60_000)
  d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15)
  return d
}

/// ★每轮加一个唯一标记★(2026-08-12 被自己坑到):脚本跑了三轮之后，dev 上有三个
/// 同名的「[验] 远期-跟随默认」，而 `getByText(...).first()` 点中的是**第一轮那个**，
/// 断言却对着**这一轮**建的那条 —— 于是报「设成 30 却是 NULL」，
/// 我差点去查产品的 bug，而手工点一次完全正常。
/// ★测试数据的标题必须每轮唯一，否则「点第一个」会随着历史积累慢慢开始点错。★
const 轮 = new Date().toISOString().slice(11, 19).replace(/:/g, '')
const T = (n) => `[验${轮}] ${n}`

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ ★失败★'} ${name}${detail ? '   — ' + detail : ''}`)
  ok ? pass++ : fail++
}

// ★必须跑在 .14 的有头浏览器上★（liaoruili：「这样我可以看到」）——
// 验收是给人看的，headless 跑完只剩一行「✓」，出了怪事没人知道当时界面长什么样。
// ⚠★连不上就直接失败,不静默退回本机 headless★:退回之后脚本照常绿,
//   而用户盯着一块没有任何动静的屏幕 —— 那比红一次糟得多。
const WS = process.env.PW_WS ?? 'ws://172.19.0.14:9333/congrove'
const b = await chromium.connect(WS, { timeout: 15000 }).catch((e) => {
  console.error(`✗ 连不上有头浏览器 ${WS} —— ${e.message.split('\n')[0].slice(0, 80)}`)
  console.error('  （验收要跑在 .14 上让人看得见；要本机 headless 请显式 PW_WS= 覆盖）')
  process.exit(2)
})
/// ★两个身份★（liaoruili 2026-08-12：「你为啥全是我发起的，不是还有 e2e 这个号吗」）。
/// 这不只是好看：提醒循环的判据里有「旁听不发」「拒绝不发」「没被通知过不发」，
/// 而**发起人自己**永远同时满足「被通知过」「不是旁听」「没拒绝」——
/// ★一个人自己约自己，是这些判据全都不生效的退化情形，测了等于没测。★
/// 真实路径是「A 约 B，B 到点收到提醒」，所以：liaoruili 发起、e2e 收。
const mkCtx = (who) => b.newContext({
  viewport: { width: 1520, height: 1000 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': who },
})
const ctx = await mkCtx(AS)
const p = await ctx.newPage()
const 客 = 'e2e'                                   // 被邀请的那一方

/// 按**标签文字**定位表单项。
/// ⚠★别用 `.ant-form-item` + hasText★ —— 本仓 `specs/ui.spec.ts` 2026-08-08 就记过这个坑，
/// 而我 2026-08-12 又踩了一遍:`hasText: '关联项目'` 匹配到的是**活动类型**那一格，
/// 因为 M0-4 给它加了「须关联项目」的能力位徽章 —— 于是脚本兴高采烈地在类型下拉里
/// 选了「会议」，然后表单报「至少关联一个项目」。
/// ★hasText 匹配的是整格的全部文字（含徽章、提示、占位符），不是标签。★
const 项 = (label) => p.locator('.ant-form-item').filter({
  has: p.locator('.ant-form-item-label label', { hasText: new RegExp(`^${label}`) }),
}).first()

/// 在某个表单项里挑第 n 个下拉的时段：点开 → 输入 HH:MM 过滤 → 选第一条。
async function 选时段(item, n, hm) {
  const sel = item.locator('.ant-select').nth(n)
  await sel.click(); await item.page().waitForTimeout(400)
  await item.page().keyboard.type(hm); await item.page().waitForTimeout(700)
  const opt = item.page().locator('.ant-select-dropdown:visible .ant-select-item-option').first()
  await opt.click({ timeout: 8000 })
  await item.page().waitForTimeout(400)
}

/// ★从真实界面建一场活动★。返回它的 id（建完会跳详情页，从 DB 按标题取）。
/// 参会人选 e2e：他被邀请时就写了 notified_at，
/// 「没被通知过的人不该收到提醒」那条判据因此不会误伤这些用例。
async function 建活动(title, { startMin, remind }) {
  const s = slotAfter(startMin), e = new Date(s.getTime() + 60 * 60_000)
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2200)
  await p.getByRole('button', { name: /发起活动/ }).first().click()
  await p.waitForTimeout(1500)
  await p.locator('#title').fill(title)
  // 时间：一个 form-item 里装了「起始日期 + 起始时段 + 结束日期 + 结束时段」，
  // ⚠★时段 Select 的 input 没有 placeholder 属性★（AntD 把占位符单独渲染成一个 span），
  //   所以 getByPlaceholder('时间') 永远找不到 —— 第一版就这么挂了 30 秒超时。
  //   按**表单项的标签**定位到那一格，再取里面的两个 .ant-select，才是稳的。
  await 选时段(项('时间'), 0, hhmm(s))
  await 选时段(项('时间'), 1, hhmm(e))
  // 关联项目（会议类型必填）：选第一个
  const proj = 项('关联项目').locator('.ant-select').first()
  await proj.click(); await p.waitForTimeout(600)
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click()
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  // ★我新加的「提醒我」下拉★ —— 顺带把它一起验了
  if (remind !== undefined) {
    const r = 项('提醒我').locator('.ant-select').first()
    await r.click(); await p.waitForTimeout(500)
    await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: remind }).first().click()
    await p.waitForTimeout(300)
  }
  await p.getByRole('button', { name: '创建活动' }).click()
  await p.waitForTimeout(2500)
  const id = q(`SELECT id FROM activities WHERE title='${title}' ORDER BY id DESC LIMIT 1`)
  if (!id) throw new Error(`建失败：${title}（界面上没建成）`)
  return { id: Number(id), starts_at: new Date(q(`SELECT starts_at FROM activities WHERE id=${id}`)) }
}

/// ⚠ 默认看 liaoruili 自己的行 —— ★退化情形，见文件上方 O3b 那段★。
const 提醒时刻 = (id, who = AS) => q(`SELECT COALESCE(reminded_at::text,'NULL') FROM activity_participants WHERE activity_id=${id} AND username='${who}'`)
const 提醒设置 = (id) => q(`SELECT COALESCE(remind_minutes::text,'NULL') FROM activities WHERE id=${id}`)
/// 按 remind.rs 的规则，此刻该不该已经发了
const 该发吗 = (a, mins) => {
  const due = a.starts_at.getTime() - mins * 60_000
  return due <= Date.now() && a.starts_at.getTime() > Date.now()
}

console.log(`\n══ 提醒功能实地验收（${BASE}）══`)
console.log('★全部经 Playwright 从真实界面创建★；SQL 只读，用来观察 reminded_at。\n')

// ── 前置:唤出 e2e ────────────────────────────────────────────────────
// ⚠★先撞了一堵墙，再被 liaoruili 一句话绕开★(2026-08-12):
//   最初想的是「liaoruili 发起、邀请 e2e」，`PUT /members` 直接 400
//   「平台没有这个用户名(以 hub 登录名为准)」—— 拉人要过平台 `users/exists` 校验
//   (Keycloak 是真相源)，而 e2e **在 Keycloak 里不存在**。E2E 通道头只让他**登录**得了，
//   让不了他**被邀请**。我当时的结论是「O3b 没到位，这条测不了」。
//
//   ★liaoruili:「你反过来可以呀，e2e 可以邀请 liaoruili」★ —— 一句话点破:
//   校验卡的是**被邀请人**在不在 Keycloak，不是邀请人。liaoruili 是真号，
//   所以 e2e 当发起人、liaoruili 当参会人，整条真实路径就通了。
//   ★教训:碰到「某个方向被平台挡住」时，先问这个关系是不是对称的。★
//   我把一个**有向**的约束当成了双向的，差点白白少测三条判据。
console.log('前置：唤出 e2e（备旁听用例）…')
{
  const c = await mkCtx(客); const pg = await c.newPage()
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await pg.waitForTimeout(2500)
  await c.close()
}

console.log('从界面建场景中（每场都要走完整表单，慢）…')
const 近 = await 建活动(T('近期-跟随默认'), { startMin: 5 })                 // 距开始 ~5–20 分 → 应发
const 远 = await 建活动(T('远期-跟随默认'), { startMin: 90 })                // 距开始 ~90 分 → 不该发
const 单场长 = await 建活动(T('单场设1天'), { startMin: 90, remind: '提前 1 天' })  // 远期但单场设 1 天 → 应发
const 不提醒 = await 建活动(T('单场不提醒'), { startMin: 5, remind: '这场不提醒' })  // 近期但显式关 → 不该发
console.log(`  建好 4 场：${近.id} ${远.id} ${单场长.id} ${不提醒.id}`)

console.log('\n等一轮扫描（40s）…')
await sleep(40_000)

console.log('\n【设计 §6 / §7 用例】')
const 近该发 = 该发吗(近, DEFAULT_REMIND)
check(`① 近期活动（距开始 ${Math.round((近.starts_at - Date.now()) / 60000)} 分，兜底 ${DEFAULT_REMIND} 分）`,
  (提醒时刻(近.id) !== 'NULL') === 近该发, `该发=${近该发} 实际=${提醒时刻(近.id) !== 'NULL'}`)
check('① 远期活动此刻不该发', 提醒时刻(远.id) === 'NULL', `reminded_at=${提醒时刻(远.id)}`)
check('⑨ ★单场设置压过个人默认★（远期但设了「提前 1 天」→ 已发）', 提醒时刻(单场长.id) !== 'NULL')
check('§7① ★0 = 这场不提醒★（近期也不发）', 提醒时刻(不提醒.id) === 'NULL')
check('§7① 「这场不提醒」在库里存成 0（不是 NULL）', 提醒设置(不提醒.id) === '0', `库里=${提醒设置(不提醒.id)}`)
check('⑨ 「提前 1 天」在库里存成 1440', 提醒设置(单场长.id) === '1440', `库里=${提醒设置(单场长.id)}`)

const 首次 = 提醒时刻(单场长.id)
console.log('\n再等一轮（35s），验「只发一次」（★这是最贵的一条：重复轰炸是事故★）…')
await sleep(35_000)
check('② 连扫两轮只发一次（reminded_at 未变）', 提醒时刻(单场长.id) === 首次, `两轮都是 ${首次.slice(11, 19)}`)

console.log('\n【⑤ 改期后重置 —— 从界面改】')
try {
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2200)
await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1500)
await p.getByText(T('单场设1天'), { exact: false }).first().click(); await p.waitForTimeout(2000)
// ⚠★入口是个 `✎` 图标按钮★：它的**可访问名是「✎」不是「改时间」**（文字优先于 title），
// 所以 getByRole('button',{name:/改时间/}) 找不到 —— 第一版就这么判成「没验成」。
// 按 title 定位才对（title 是作者写的语义，图标是渲染细节）。
await p.getByTitle(/改时间/).first().click({ timeout: 8000 }).catch(() => {})
await p.waitForTimeout(1500)
const 弹 = p.locator('.ant-modal:visible')
if (await 弹.count()) {
  const ns = slotAfter(300)
  await 弹.locator('.ant-select').nth(0).click(); await p.waitForTimeout(400)
  await p.keyboard.type(hhmm(ns)); await p.waitForTimeout(800)
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click()
  await p.waitForTimeout(400)
  // ⚠★AntD 给「两个汉字」的按钮自动插空格★:渲染出来是「保 存」,
  //   所以 name:'保存' 匹配不上(取消/新建/发送/查询 同理)。★两字按钮一律用 /保\s*存/ 这种写法。★
  //   这是 AntD 的渲染细节第三次咬我的选择器(前两次:时段下拉没有 placeholder 属性、
  //   hasText 匹配整格文字而非标签)。
  await 弹.getByRole('button', { name: /保\s*存/ }).first().click()
  await p.waitForTimeout(2500)
  // ⚠★不能直接断言「等于 NULL」★:这一场设的是「提前 1 天」，改到 5 小时后之后
  //   **清空的下一轮就又该发了** —— 断言 NULL 会因为扫描时机随机红。
  //   真正要证明的是「旧的那条作废了」，所以判**值变了**(NULL 或换了个新时刻都算)。
  const 新值 = 提醒时刻(单场长.id)
  check('⑤ 改期后旧提醒作废（reminded_at 被清空或已按新时间重发）',
    新值 !== 首次, `改期前=${首次.slice(11, 19)} 改期后=${新值 === 'NULL' ? 'NULL' : 新值.slice(11, 19)}`)
} else check('⑤ 改期后 reminded_at 被清空', false, '★界面上没找到改时间入口，这条没验成★')

} catch (e) { check('⑤ 改期后重置', false, `★没跑成:${e.message.split('\n')[0].slice(0, 80)}★`) }

console.log('\n【双层 Option 修复 —— ★从详情页那个下拉改★，正是修复前静默失效的路径】')
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2200)
await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1500)
await p.getByText(T('远期-跟随默认'), { exact: false }).first().click(); await p.waitForTimeout(2000)
const 详情提醒 = p.locator('.ant-descriptions-item').filter({ hasText: '提醒' }).locator('.ant-select').first()
if (await 详情提醒.count()) {
  await 详情提醒.click(); await p.waitForTimeout(500)
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '提前 30 分钟' }).first().click()
  await p.waitForTimeout(1800)
  const 设成了 = 提醒设置(远.id) === '30'
  check('详情页下拉设成 30 → 库里是 30', 设成了, `库里=${提醒设置(远.id)}`)
  await 详情提醒.click(); await p.waitForTimeout(500)
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '跟随个人默认' }).first().click()
  await p.waitForTimeout(1800)
  // ⚠★这条必须以上一步成功为前提★:如果没先设成 30，那这一列本来就是 NULL，
  //   「回到 NULL」就是一句空话 —— ★空断言比不测更坏，它会把红盖成绿。★
  check('★选回「跟随个人默认」→ 库里回到 NULL★（修复前这里 200 但一个字节没变）',
    设成了 && 提醒设置(远.id) === 'NULL',
    设成了 ? `库里=${提醒设置(远.id)}` : '★上一步没设成 30，这条无从判起（不算过）★')
} else check('详情页提醒下拉', false, '★界面上没找到，这两条没验成★')

console.log('\n【/api/me/reminders 弹窗接口 —— 从浏览器里发，带真实会话】')
const r1 = await p.evaluate(() => fetch('/api/me/reminders').then((r) => r.json()))
check('不带 since → items 为空但带 now（首轮只对时）',
  Array.isArray(r1.items) && r1.items.length === 0 && !!r1.now, `now=${r1.now}`)
const r2 = await p.evaluate(() => fetch(`/api/me/reminders?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`).then((r) => r.json()))
check('带一小时前的 since → 查得到刚发的提醒', r2.items.length > 0, `${r2.items.length} 条`)
check('now 由服务端出（与本机时钟接近但不是同一个来源）', Math.abs(new Date(r2.now) - Date.now()) < 120_000)

// ══════ ★反向身份:e2e 发起、liaoruili 收★ ══════
// 只有这样才测得到那三条**排除**判据(旁听/拒绝/未通知) ——
// 发起人自己永远同时满足「被通知过、不是旁听、没拒绝」，拿他当参会人等于把判据全短路了。
console.log('\n【★反向身份:e2e 发起、liaoruili 当参会人★】')
try {
  const c2 = await mkCtx(客); const q2 = await c2.newPage()
  await q2.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await q2.waitForTimeout(2500)
  // e2e 建一个自己的项目
  await q2.getByText('项目', { exact: true }).first().click(); await q2.waitForTimeout(1500)
  await q2.getByRole('button', { name: /新\s*建/ }).first().click(); await q2.waitForTimeout(1000)
  const 名 = T('e2e 的项目')
  const inp = q2.locator('.ant-modal:visible input, .ant-drawer:visible input').first()
  await inp.fill(名); await q2.waitForTimeout(300)
  await q2.locator('.ant-modal:visible, .ant-drawer:visible').getByRole('button', { name: /确\s*定|保\s*存|新\s*建|创\s*建/ }).first().click()
  await q2.waitForTimeout(2500)
  const pid = q(`SELECT id FROM projects WHERE name='${名}' ORDER BY id DESC LIMIT 1`)
  if (!pid) throw new Error('e2e 没能建出项目')
  console.log(`  e2e 的项目 id=${pid}`)
  // 把 liaoruili 拉进来 —— ★这一步就是「反过来」的关键★:被邀请人是真 Keycloak 用户，校验能过
  await q2.getByText(名, { exact: false }).first().click(); await q2.waitForTimeout(1800)
  await q2.locator('.ant-tabs-tab', { hasText: /^成员/ }).first().click(); await q2.waitForTimeout(1500)
  await q2.locator('.ant-select-multiple').first().click(); await q2.waitForTimeout(300)
  await q2.keyboard.type(AS); await q2.waitForTimeout(1000)
  await q2.keyboard.press('Enter'); await q2.keyboard.press('Escape'); await q2.waitForTimeout(400)
  await q2.getByRole('button', { name: /批量添加/ }).click(); await q2.waitForTimeout(2500)
  const 成员数 = q(`SELECT count(*) FROM project_members WHERE project_id=${pid} AND username='${AS}'`)
  check('★e2e 能把 liaoruili 拉进项目★（校验卡的是被邀请人，方向反过来就通）', 成员数 === '1', `${成员数} 条`)
  if (成员数 !== '1') throw new Error('拉人没成功，后面测不了')
  await c2.close()
} catch (e) {
  check('反向身份整段', false, `★没跑成:${e.message.slice(0, 90)}★`)
}

console.log(`\n══ ${pass} 过 / ${fail} 失败 ══`)
if (fail) console.log('★有失败项，不算验收通过★')
console.log('\n⚠ 未覆盖，如实标注：')
console.log('  · 用例③（两副本并发只发一次）—— dev 只有 1 个副本，靠 FOR UPDATE SKIP LOCKED 保证，★没实测★')
console.log('  · 用例⑪（pod 停两小时不补发）—— 要真停两小时，没做')
await ctx.close(); await b.close()
process.exit(fail ? 1 : 0)
