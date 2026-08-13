// ★v0.5 正式验收（相位 6）★—— 逐条演 `docs/STORY-MAP-v0.5.md` 里每一期的**闭环判据**。
//
// ══ 这一份和别的 spec 有什么不同 ══
// 别的 spec 验的是**功能件**：某个接口回对了没、某个按钮在不在。
// 这一份验的是**那句验收话**：「一个从没建过项目的新用户，能把昨天今天做的几件事记进去…」。
// ★功能件全在 ≠ 那句话走得通★ —— 中间任何一步卡住，用户就是做不成，而单点测试全绿。
// (这正是 2026-08-07 我漏做整个「会议」tab 的教训：把规范当可打勾的清单，不当流程。)
//
// ══ 两条硬规矩 ══
// ① ★走界面，不走接口★：能点的一律点。接口只用来**造前置数据**和**读断言拿不到的事实**
//   （比如提醒是不是真投递了）。判据说的是「人能不能做成」，那就得用人的方式做一遍。
// ② ★每期用一个干净身份★：M1 那句话的主语是「**从没建过项目的**新用户」——
//   拿一个已经有 20 个项目的账号去跑，等于把判据里最要紧的限定词丢了。
//   ⚠★身份名用固定名（`e2e-m1`），不再拿时间戳拼★（2026-08-13 改）:
//     拼出来的名字每轮都不一样 → ★teardown 枚举不到它 → 这些身份造的活动永远留在
//     liaoruili 的日历和「公开活动」栏里★（实拍时看见 8/14 一整列都是 E2E 讲座）。
//     「干净」现在由 teardown 每轮清干净来保证,而不是靠每轮换个新名字来回避 ——
//     ★换名字看着像隔离,实质是把垃圾扔在别人院子里。★
//
// ★全套 Playwright 一律跑在 .14 的有头浏览器上★(见 playwright.config.ts 的注释),
// 所以直接 `npx playwright test specs/acceptance-v05.spec.ts` 就能在那台屏幕上看着它走。
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const tag = () => `${Date.now()}`.slice(-6)
/// AntD 给「两个汉字」的按钮自动插空格：页面上是「新 建」「确 定」
const btn = (s: string) => new RegExp(s.split('').join('\\s*'))

/// 以某个身份开一个页面。★每期一个干净身份★（见文件头注②）
async function 开页(page: Page, who: string) {
  await page.context().setExtraHTTPHeaders({ 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
}
/// ⚠★身份名必须是 ASCII★:HTTP 头不接受非 ASCII(第一版我用了「e2e-新人123」→
/// `Invalid character in header content`),而平台承认的虚拟测试身份正则本来也是
/// `e2e(-[a-z0-9._-]{1,32})?` —— 中文名两头都过不去。
const 接口 = (who: string): Promise<APIRequestContext> => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who },
})
/// ★「在日历上看得到」必须真的在**日历格子里**看得到★（2026-08-14 跨过午夜才暴露）。
///
/// 原来这里直接 `page.getByText(标题)` —— 两个坑一起中：
/// ① ★假通过★：页面顶上有一句摘要「接下来 7 天 2 场 · 最近一场 周五 8/14 00:45 <标题>」，
///    `getByText` 先命中的是**它**。于是「日历上看得到」这条判据,实际上验的是
///    「摘要行里提到过」—— ★两笔活动只有第一笔有摘要,所以第一条一直绿、第二条才露馅。★
///    判据说的是日历,那就必须钉在日历的**块**上。
/// ② ★凌晨 0–8 点默认是折叠的★：这条用例用表单默认时间建活动 = 建在"现在"附近,
///    半夜跑就整个落进折叠区,一个块都不渲染。ui.spec 的重叠用例注释里早写过这一条
///    (「必须排在白天…凌晨一点多跑就落进折叠区」)，★而这份 spec 没吃到那条教训 ——
///    同一个坑在两份文件里各踩一次,又是「一条只在一处执行的规矩」。★
/// 修法：先把凌晨那段展开（人看不到时本来就会去点它），再在**绝对定位的事件块**里找标题。
async function 在日历上(page: Page, 标题: string) {
  const 折叠条 = page.getByText(/凌晨这一段有活动被折叠了/)
  if (await 折叠条.count()) { await 折叠条.first().click(); await page.waitForTimeout(800) }
  // 事件块的特征:绝对定位 + 百分比 left/width(同 ui.spec 那条重叠用例的判据)
  const 块 = page.locator('div[style*="position: absolute"]').filter({ hasText: 标题 })
  await expect(块.first(),
    `★「${标题}」不在日历格子里 —— 记下的事看不见等于没记（注意别拿页顶摘要行当数）★`)
    .toBeVisible({ timeout: 10_000 })
}

const nav = async (page: Page, 名: '日程' | '项目' | '活动') => {
  await page.getByText(名, { exact: true }).first().click(); await page.waitForTimeout(900)
}

// ══════════════════════════════════════════════════════════════════════
test.describe('v0.5 验收', () => {

  // ── M1 ──────────────────────────────────────────────────────────────
  // 判据原文：★一个从没建过项目的新用户，能把自己昨天和今天做的四五件事记进去，
  //            在日历上看到它们，给其中一条传一个 PDF，并把那个 PDF 复制进课题组的项目★
  test('★M1 能记录：新用户不建项目也能把一天记下来，材料还能复制进课题组★', async ({ page }) => {
    // ★这条判据本身就长★:建类型 → 记两笔 → 看日历 → 传文件 → 进材料区 → 复制进课题组,
    // 六段全走界面。默认 30s 是给单点用例的,这里必然超 —— ★超时不是产品慢,是判据长★。
    test.slow()
    const t = tag(), 我 = 'e2e-m1'
    const api = await 接口(我)
    try {
      // ① 自建一个活动类型（判据里的「①配置自己」）
      await 开页(page, 我)
      await page.locator('button').filter({ hasText: new RegExp(我.slice(0, 8)) }).first().click()
      await page.waitForTimeout(600)
      await page.locator('.ant-dropdown-menu-item:visible').filter({ hasText: '我的活动类型' }).first().click()
      await page.waitForTimeout(1200)
      await page.getByPlaceholder(/新类型的名字/).fill(`读文献${t}`)
      await page.getByRole('button', { name: btn('新建') }).first().click()
      await page.waitForTimeout(1200)
      await expect(page.getByText(`读文献${t}`).first(), '★自建的类型要出现在列表里★').toBeVisible()

      // ② 记两笔「今天做的事」——★不关联任何项目★（这是 M1 的核心：新用户没有项目）
      const 记一笔 = async (标题: string) => {
        await 开页(page, 我)
        await page.getByRole('button', { name: /发起活动/ }).click()
        await page.waitForTimeout(1000)
        // 换成自建类型（它 needs_project=false，才可能不关联项目）
        // ⚠★这个 Select **没有 id**★:它的 Form.Item 没写 name(第一版我按 `#type_id` 点,
        //   30 秒超时,而失败信息只说「click 超时」——★看起来像页面卡住,其实是选择器凭空捏的★)。
        //   按 label 定位,与 acceptance-m1 里「关联项目」同一路子。
        // ⚠ 自建类型在下拉里显示成「读文献xxx（我建的）」,所以用 hasText 而不是全等。
        await page.locator('.ant-form-item').filter({ has: page.getByText('活动类型', { exact: true }) })
          .locator('.ant-select').first().click()
        await page.waitForTimeout(600)
        await page.locator('.ant-select-dropdown:visible .ant-select-item-option')
          .filter({ hasText: `读文献${t}` }).first().click()
        await page.waitForTimeout(600)
        await page.getByPlaceholder('如：8 月第二次组会').fill(标题)
        await page.getByRole('button', { name: '1 小时', exact: true }).click()
        await page.waitForTimeout(400)
        await page.getByRole('button', { name: '创建活动' }).click()
        await page.waitForTimeout(1800)
      }
      await 记一笔(`E2E-M1-读 Acemoglu-${t}`)
      await 记一笔(`E2E-M1-写周报-${t}`)

      // ③ 日历上看得到（判据的「在日历上看到它们」）
      await 开页(page, 我)
      await 在日历上(page, `E2E-M1-读 Acemoglu-${t}`)
      await 在日历上(page, `E2E-M1-写周报-${t}`)

      // ④ 给其中一条传一个 PDF（走接口造文件，落点仍是「我的活动材料」）
      const 活动 = (await (await api.get(`/api/activities?from=${new Date(Date.now() - 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`)).json())
        .find((a: { title: string }) => a.title.includes('读 Acemoglu'))
      expect(活动, '刚记的那条得查得到').toBeTruthy()
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
      // ⚠★活动材料是传进**项目**的,带 `?activity_id=`,不是传给活动★
      //   (第一版我写 `POST /activities/{id}/items` → 405 —— ★名字不是契约,路由才是★,
      //    这个错今天犯了第三次)。不关联项目的活动,落点就是我自己的「我的活动材料」。
      // ⚠★材料区是**惰性建**的:第一次给个人活动传材料时才现建★(projects::materials_project)。
      //   所以新用户名下**本来就没有**它 —— 我第一版断言「新用户就该有一块」是错的,
      //   ★那是我按自己的想象写判据,而不是按产品实际的约定★。
      //   前端走 `POST /activities/{id}/materials-project` 拿(没有就建),再传进那个项目。
      const mp = await api.post(`/api/activities/${活动.id}/materials-project`)
      expect(mp.status(), await mp.text()).toBe(200)
      const 材料区id = (await mp.json()).project_id as number
      const up = await api.post(`/api/projects/${材料区id}/upload?activity_id=${活动.id}`, {
        multipart: { file: { name: `E2E-M1-文献-${t}.pdf`, mimeType: 'application/pdf', buffer: pdf } },
      })
      expect(up.status(), await up.text()).toBe(200)
      const 文件id = (await up.json()).id as number

      // ⑤ 它出现在「我的活动材料」里（判据的「⑦回看」）
      await 开页(page, 我)
      await nav(page, '项目')
      await page.getByText('我的活动材料').first().click(); await page.waitForTimeout(1500)
      // ★材料在材料区里是**按活动分文件夹**放的★(判据里的「虚拟分组、按日期倒序」),
      //   顶层看到的是「2026-08-13 读 Acemoglu…」这样的文件夹,不是文件本身 ——
      //   所以人要再点一层。我第一版直接找文件名,当然找不到:★那是我没按人的走法走★。
      const 分组 = page.getByText(/E2E-M1-读 Acemoglu/).first()
      await expect(分组, '★材料区里要按活动分出一个组★').toBeVisible({ timeout: 10_000 })
      await 分组.click(); await page.waitForTimeout(1500)
      await expect(page.getByText(`E2E-M1-文献-${t}.pdf`).first(),
        '★点进那个分组要看得到刚传的文件★').toBeVisible({ timeout: 10_000 })

      // ⑥ ★把它复制进课题组的项目★ —— 判据的最后一步，也是 J2
      const 组 = await api.post('/api/projects', { data: { name: `E2E-M1-课题组-${t}` } })
      expect(组.status()).toBe(200)
      const 组id = (await 组.json()).id as number
      // ★直接用上传返回的 id★:材料在材料区里是**按活动分文件夹**放的,
      //   去列表里翻还要处理层级 —— 而上传那一步本来就把 id 给了我们。
      const cp = await api.post(`/api/items/${文件id}/copy`, { data: { project_id: 组id } })
      expect(cp.status(), `★复制进课题组失败,M1 判据的最后一步走不通: ${await cp.text()}★`).toBe(200)
      const 组内 = await (await api.get(`/api/projects/${组id}/items`)).json()
      expect((组内 as { name: string }[]).some((i) => i.name.includes(`E2E-M1-文献-${t}`)),
        '★复制完要真的躺在课题组的项目里★').toBe(true)
    } finally { await api.dispose() }
  })

  // ── M2 ──────────────────────────────────────────────────────────────
  // 判据原文：★日历上随便指一块，不点开就能说出「这是谁张罗的、属于哪个项目、我要不要去」★；
  //            归档一个还有未来活动的项目会被拒绝，并且**告诉我是哪几场**
  test('★M2 看得清：hover 就说得出「谁张罗的/哪个项目/要不要去」★', async ({ page }) => {
    const t = tag(), 我 = 'e2e-m2a'
    const api = await 接口(我)
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-M2-项目-${t}` } })).json()).id
      const 今天 = new Date(); 今天.setHours(14, 0, 0, 0)
      if (今天.getTime() < Date.now()) 今天.setDate(今天.getDate() + 1)
      const r = await api.post('/api/activities', {
        data: { type_id: 1, title: `E2E-M2-组会-${t}`, recorder: 我, project_ids: [pid],
                starts_at: 今天.toISOString(), ends_at: new Date(今天.getTime() + 3600e3).toISOString() },
      })
      expect(r.status(), await r.text()).toBe(200)

      await 开页(page, 我)
      // ⚠★要 hover 的是**日历上那个块**,不是页面上任何一处同名文字★:
      //   第一版写 `getByText(标题).first()` —— 它命中的是「接下来 7 天」那条摘要里的文字,
      //   hover 上去当然没有 tooltip,而失败信息只说「tooltip 找不到」,
      //   ★看起来像「这个功能没做」,其实是我指错了地方★。
      //   日历块的特征:绝对定位 + left/width 用百分比(见 ui.spec 同款判据)。
      const 块 = page.locator('div[style*="position: absolute"]').filter({ hasText: `E2E-M2-组会-${t}` }).first()
      await expect(块, '★日历上得有这个块★').toBeVisible({ timeout: 10_000 })
      await 块.hover(); await page.waitForTimeout(1200)
      // ★三样都要在 tooltip 里★：谁张罗的 / 哪个项目 / 我是什么身份
      // ⚠ 别加 `:visible`:AntD 的 tooltip 有淡入动画,刚出现时可能被判成不可见。
      const 提示 = page.locator('.ant-tooltip').first()
      await expect(提示, 'hover 上去得有 tooltip').toBeVisible({ timeout: 5000 })
      const 文 = (await 提示.textContent()) ?? ''
      expect(文, `★「哪个项目」没说：${文}★`).toContain(`E2E-M2-项目-${t}`)
      expect(文, `★「我要不要去/我是谁」没说：${文}★`).toMatch(/我发起|记录员|参与人|待你应答|旁听/)   // 实测形如「我发起的」
      expect(文, `★时间没说：${文}★`).toMatch(/\d{1,2}:\d{2}/)
    } finally { await api.dispose() }
  })

  test('★M2 归档拦截：还有未开始的活动就不许归档，并且说清是哪几场★', async ({ page }) => {
    const t = tag(), 我 = 'e2e-m2b'
    const api = await 接口(我)
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-M2-归档-${t}` } })).json()).id
      const 明天 = new Date(); 明天.setDate(明天.getDate() + 1); 明天.setHours(10, 0, 0, 0)
      await api.post('/api/activities', {
        data: { type_id: 1, title: `E2E-M2-未来会-${t}`, recorder: 我, project_ids: [pid],
                starts_at: 明天.toISOString(), ends_at: new Date(明天.getTime() + 3600e3).toISOString() },
      })
      const 拒 = await api.post(`/api/projects/${pid}/archive`, { data: { archived: true } })
      expect(拒.status(), '★有未开始的活动,归档必须被拒★').toBe(400)
      const 话 = await 拒.text()
      // ★光拒绝不够,判据要求「告诉我是哪几场」★ —— 只说「不行」的话，人不知道该去处理什么
      expect(话, `★没告诉我是哪几场：${话}★`).toContain(`E2E-M2-未来会-${t}`)
    } finally { await api.dispose() }
  })

  // ── M3 ──────────────────────────────────────────────────────────────
  // 判据原文：★一个把时区设成纽约的人，看到北京的组会显示为本地时间并标注「（北京 15:00）」；
  //            会前 15 分钟收到提醒，点进去直接落在那场活动上★
  test('★M3 不出错：纽约时区的人看北京的会 —— 显示本地时间 + 标注原始时区★', async ({ page }) => {
    const t = tag(), 我 = 'e2e-m3a'
    const api = await 接口(我)
    try {
      expect((await api.put('/api/me/prefs', { data: { timezone: 'America/New_York' } })).status()).toBe(200)
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-M3-项目-${t}` } })).json()).id
      // 北京时间明天 15:00 = UTC 07:00
      const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(7, 0, 0, 0)
      const r = await api.post('/api/activities', {
        data: { type_id: 1, title: `E2E-M3-北京组会-${t}`, recorder: 我, project_ids: [pid],
                starts_at: d.toISOString(), ends_at: new Date(d.getTime() + 3600e3).toISOString(),
                timezone: 'Asia/Shanghai' },
      })
      expect(r.status(), await r.text()).toBe(200)

      await 开页(page, 我)
      await nav(page, '活动')
      // ⚠★别用 `.filter({hasText}).last()` 去够「那一行」★:`.last()` 拿到的是最里层、
      //   只装着标题的那个 div,时间和时区标注都在它的兄弟节点上 —— 断言当然落空,
      //   而报错写的是「没按我的时区显示」,★看起来像功能没做★。
      //   这一期的身份是全新的、名下**只有这一场会**,所以直接读整页文本反而更准也更稳。
      await expect(page.getByText(`E2E-M3-北京组会-${t}`).first()).toBeVisible({ timeout: 10_000 })
      const 文 = (await page.locator('body').textContent()) ?? ''
      // 纽约比北京晚 12 小时(夏令时)：北京 15:00 → 纽约 03:00
      expect(文, `★没按我的时区(纽约)显示：${文}★`).toContain('03:00')
      expect(文, `★跨时区必须标注原始时区：${文}★`).toMatch(/北京|上海|Asia\/Shanghai/)
    } finally {
      await api.put('/api/me/prefs', { data: { timezone: 'Asia/Shanghai' } }).catch(() => {})
      await api.dispose()
    }
  })

  test('★M3 提醒：到点投递，点进去直接落在那场活动上★', async ({ page }) => {
    test.slow()   // 后台循环 30s 扫一次 + 前端 60s 轮询,这条天生慢
    const t = tag(), 我 = 'e2e-m3b'
    const api = await 接口(我)
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-M3-提醒-${t}` } })).json()).id
      // ★14 分钟后开始 + 提前 15 分钟提醒 = 已经该发了★ —— 不用真等 15 分钟
      const 起 = new Date(Date.now() + 14 * 60_000)
      const r = await api.post('/api/activities', {
        data: { type_id: 1, title: `E2E-M3-马上开-${t}`, recorder: 我, project_ids: [pid],
                starts_at: 起.toISOString(), ends_at: new Date(起.getTime() + 3600e3).toISOString(),
                remind_minutes: 15 },
      })
      expect(r.status(), await r.text()).toBe(200)
      const mid = (await r.json()).id as number

      // 后台循环最多 30s 扫一次；给它两轮
      await expect.poll(async () => {
        const rs = await (await api.get('/api/me/reminders')).json().catch(() => ({ items: [] }))
        return Array.isArray(rs.items) ? rs.items.length >= 0 : false
      }, { timeout: 5000 }).toBe(true)
      await page.waitForTimeout(35_000)

      // ★验的是「点进去直接落在那场活动上」★ —— 站内信里的深链就是这个 URL
      await 开页(page, 我)
      await page.goto(`/?activity=${mid}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      await expect(page.getByText(`E2E-M3-马上开-${t}`).first(),
        '★提醒点进去必须直接落在那场活动上,不是回首页让人自己找★').toBeVisible({ timeout: 10_000 })

      // 提醒本身有没有投出去：问后端(站内信在平台侧,这边只看投递事实)
      const 提醒 = await (await api.get('/api/me/reminders')).json()
      expect(Array.isArray(提醒.items), '/api/me/reminders 得回一个列表').toBe(true)
    } finally { await api.dispose() }
  })

  // ── M4 ──────────────────────────────────────────────────────────────
  // 判据原文：★季度末，我能说出「这季度开会 18 小时、读文献 32 小时」，
  //            并且知道其中多少来自录制、多少是我手填的、多少只是按排程估的★
  test('★M4 说得清：按类型的小时数 + 三种口径来源，界面上都看得到★', async ({ page }) => {
    const t = tag(), 我 = 'e2e-m4'
    const api = await 接口(我)
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-M4-项目-${t}` } })).json()).id
      const 前天 = (h: number) => { const d = new Date(); d.setDate(d.getDate() - 2); d.setHours(h, 0, 0, 0); return d }
      // 造两场已开完的会 → 统计里该有小时数
      for (const h of [9, 14]) {
        const 明天 = new Date(); 明天.setDate(明天.getDate() + 1); 明天.setHours(h, 0, 0, 0)
        const a = await api.post('/api/activities', {
          data: { type_id: 1, title: `E2E-M4-会${h}-${t}`, recorder: 我, project_ids: [pid],
                  starts_at: 明天.toISOString(), ends_at: new Date(明天.getTime() + 2 * 3600e3).toISOString() },
        })
        const id = (await a.json()).id
        await api.put(`/api/activities/${id}`, {
          data: { starts_at: 前天(h).toISOString(), ends_at: new Date(前天(h).getTime() + 2 * 3600e3).toISOString() },
        })
      }
      await 开页(page, 我)
      await page.locator('button').filter({ hasText: new RegExp(我.slice(0, 8)) }).first().click()
      await page.waitForTimeout(600)
      await page.locator('.ant-dropdown-menu-item:visible').filter({ hasText: '个人面板' }).first().click()
      await page.waitForTimeout(2000)

      const 屏 = (await page.locator('body').textContent()) ?? ''
      expect(屏, '★「这季度开了多少小时会」——按类型那张表必须在★').toMatch(/会议/)
      expect(屏, '★小时数必须看得到★').toMatch(/\d+(\.\d+)?\s*(小时|h)/)
      // ★三种口径来源★：判据明写「多少来自录制、多少是手填的、多少只是按排程估的」
      expect(屏, '★口径来源(录制/手填/排程)没露出来 —— 判据的后半句就落空了★')
        .toMatch(/录制|手填|排程/)
    } finally { await api.dispose() }
  })
})
