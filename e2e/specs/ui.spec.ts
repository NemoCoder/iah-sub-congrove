// 界面测试(真浏览器) —— ★API 测试抓不到的那一类 bug 在这里抓★。
//
// 起因很具体:2026-08-07 用户在真实界面上点开「发起活动」,发现**记录员下拉框「暂无数据」**,
// 而记录员是必填 —— 等于根本建不了活动。而后端 `/api/users` 完全正常:
// 它是「输入即搜」的接口,不带 `q` 就返回空数组,是**前端把它当成「拉全部候选」用错了**。
// ★这种「接口没错、用法错了」的 bug,API 层测试一条都抓不到。★
//
// 前置(比 API 测试多一条):浏览器要信任内网 CA。
// ⚠ `NODE_EXTRA_CA_CERTS` **只对 Node 侧生效,浏览器是独立进程不读它**。
// 正确做法是把 CA 装进 Chromium 用的 NSS 库(一次性,见 ../README.md):
//     certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n IAH-Internal-CA -i <ca.crt>
// ★别用 ignoreHTTPSErrors 图省事★——那会把「证书真的错了」和「证书是内网 CA 签的」一起吞掉。
import { expect, request as pwRequest, test } from '@playwright/test'
import { 会议 } from './_presets'
import { 每条都留图 } from './_shot'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

test.describe('发起活动表单', () => {
  test('★记录员候选里必须有我自己★,且默认就填好', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /发起活动/ }).click()

    // ★定位靠表单字段 id,断言靠可见文本 —— 都不碰组件内部类名★。
    // 2026-08-07 教训:第一版写的是 `.ant-select-selection-item`,那是 **AntD 5** 的类名,
    // 而本项目用 AntD 6(实际是 `.ant-select-content`)。结果测试红了,
    // 但**产品完全正常** —— 差点被自己的测试误导去改没坏的代码。
    // 组件库的内部类名是实现细节,升个大版本就变;id 和用户看得见的文本才是契约。
    const item = page.locator('.ant-form-item').filter({ has: page.locator('#recorder') })

    // 记录员默认填当前用户 —— 「记录员也可以是发起人本身」是最常见的情形(用户 2026-08-07 指出)
    await expect(item, '记录员没有默认值,每次都要手动选一次').toContainText('e2e')

    // 展开下拉:★不输入任何关键词也要有候选★(这就是那个 bug:原来是「暂无数据」)
    await item.click()
    const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option')
    await expect(options.first(), '下拉框「暂无数据」= 必填项选不了 = 建不了活动').toBeVisible()
    await expect(options.filter({ hasText: 'e2e' }).first()).toBeVisible()
  })

  test('关联项目只列出我有编辑权的', async ({ page, request }) => {
    // ★先给自己造一个项目★:这条用例原来依赖「库里恰好有我能编辑的项目」——
    // teardown 改彻底(2026-08-13,按 owner 分别扫)之后 e2e 名下被清空，它当场变红。
    // ★红的不是产品，是用例借了别人留下的数据★，与那三条配额用例同一族。
    expect((await request.post('/api/projects',
      { data: { name: `E2E-下拉候选-${Date.now()}` } })).status()).toBe(200)
    await page.goto('/')
    await page.getByRole('button', { name: /发起活动/ }).click()
    // ⚠★别用 hasText 定位表单项★(2026-08-08 踩的):M0-4 给「活动类型」加了能力位徽章,
    //   徽章文字是「须关联项目 / 可不关联项目」—— 也含「关联项目」,于是这个定位器
    //   同时命中两栏、strict mode 直接报错。按 **label 精确匹配**才稳。
    await page.locator('.ant-form-item')
      .filter({ has: page.getByText('关联项目', { exact: true }) })
      .locator('.ant-select').click()
    // 至少要有候选 —— 一个都没有的话,这个必填项同样会把人卡死
    await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option').first()).toBeVisible()
  })
})

test.describe('日程页', () => {
  test('日历不做成可滚动的:折叠时 8–24 点、展开后 0–24 点', async ({ page }) => {
    await page.goto('/')
    // ⚠★这条用例过期过一次★(2026-08-12 全量跑 E2E 时红的):
    //   它原来死判 720px(24 小时 × 30),而 2026-08-09 liaoruili 要的
    //   「凌晨 0–8 默认折叠」上线之后,默认高度就是 **480**(16 小时 × 30)。
    //   ★用例比它要守的那个功能还老 —— 于是它天天报红,而产品完全正常。★
    //   这种红比没有用例更糟:所有人都会学会忽略它。
    //   现在两态都判,并且**判的是「不滚动」这条真正的约束**,不是某个写死的像素值。
    const col = page.locator('div[style*="repeating-linear-gradient"]').first()
    await expect(col).toBeVisible()
    const 折叠高 = await col.evaluate((e) => (e as HTMLElement).offsetHeight)
    expect(折叠高, '折叠态应当是 8–24 点(16 小时 × 30px)').toBe(480)

    // 展开凌晨那一段 → 变成整 24 小时
    // ★点折叠条本身,别去点「展开 ▾」那三个字★:页面上带「展开」字样的元素有两个,
    //   `.last()` 挑中的是另一个,于是这一步**看起来点了、其实什么也没发生**,
    //   失败信息却是「高度还是 480」—— 又一次「前置动作静默没做成,伪装成后面那条断言的失败」。
    //   折叠条是唯一带「凌晨」的元素(实测 count=1),点它 480 → 720。
    const 折叠条 = page.getByText(/凌晨/).first()
    if (await 折叠条.count()) {
      await 折叠条.click()
      await expect
        .poll(async () => col.evaluate((e) => (e as HTMLElement).offsetHeight), { timeout: 4000 })
        .toBe(720)
    }
  })

  // ⚠★这条用例一直是**空的**★（2026-08-13 逐张看截图时顺手量 DOM 才发现）。两处同时失效:
  //   ① 选择器 `div[title]` 过滤 `style.position==='absolute' && e.title` —— AntD 6 的 Tooltip
  //      不再把文字写进 DOM 的 `title` 属性，事件块本身也没有 title，★实测匹配 0 个★;
  //   ② 就算选对了，它也只在**库里恰好存在重叠活动**时才有断言 ——
  //      teardown 把测试数据清干净之后，日历上一场重叠都没有，`narrow` 为空、
  //      for 循环一次都不进、`expect` 一次都不执行，★于是它每轮都绿，而它什么都没验★。
  //   这正是本仓库反复记的那条:**空断言比不测更坏** —— 不测起码不会给人「这块有人守着」的错觉。
  //   修法两条一起:自己造两场**必然重叠**的活动，再按真实 DOM(绝对定位的块)量。
  test('★重叠的活动必须都看得见★', async ({ page, request }) => {
    // 自己造数据:同一时段两场，必然重叠 —— 不靠库里恰好有什么
    // ★必须排在白天★:凌晨 0–8 点默认是**折叠**的,排在那一段的会一个块都不渲染 ——
    //   我第一版写 `now + 3h`，凌晨一点多跑就落进折叠区，于是「造了两场却量到 0 个块」。
    //   (是上面那句护栏把它抓出来的 —— 没有护栏的话它会安静地退回「空跑也绿」。)
    const t0 = new Date(); t0.setHours(14, 0, 0, 0)
    if (t0.getTime() < Date.now()) t0.setDate(t0.getDate() + 1)   // 今天 14 点过了就排明天
    const t1 = new Date(t0.getTime() + 3600_000)
    const pr = await request.post('/api/projects', { data: { name: `E2E-重叠-${Date.now()}` } })
    expect(pr.status(), '建项目失败,后面的断言就没有意义了').toBe(200)
    const pid = (await pr.json()).id as number
    for (const i of [1, 2]) {
      const r = await request.post('/api/activities', {
        data: { type_id: 会议, title: `E2E-重叠-${i}-${Date.now()}`, recorder: 'e2e',
                starts_at: t0.toISOString(), ends_at: t1.toISOString(), project_ids: [pid] },
      })
      expect(r.status(), await r.text()).toBe(200)
    }

    await page.goto('/')
    await page.waitForTimeout(1500)
    // ★按真实 DOM 取★:绝对定位 + 有 top/height 的那些 div 才是事件块
    // ⚠★光判「绝对定位」不够★:AntD 的 Tooltip 内部也是一堆绝对定位的 div(箭头、气泡壳),
    //   它们的 width 是空串、left 是 `0px` —— 于是全落进下面的 `narrow`,
    //   ★7 个 tooltip 碎片挤在同一个 left 上，把这条用例判成红的（我第一版修就是这么误报的）★。
    //   事件块的特征是**两个值都用百分比**(left:0%/50%…、width:100%/50%…),按这个筛。
    //
    // ★★判据换成「屏幕上有没有真的压在一起」★★（2026-08-13 全量跑出 1 条 flaky 才发现）:
    //   我上一版按 `top + width` 分组、比 `left` 是否互不相同 —— ★这个键漏了「哪一列」★。
    //   `left`/`width` 是**各自那一天那一列内部**的百分比:周二 14:00 与周四 14:00 的两个块,
    //   top 一样、width 一样、left 都是 `0%` → 被判成「叠在一起」,而它们在屏幕上离着几百像素。
    //   ★所以它红不红取决于那几天恰好有没有会 —— 这就是那条 flaky 的成因。★
    //   ⚠ flaky 不是「基本能过」,是**判据本身写错了**,只是错得不总是暴露;重试变绿最容易让人放过它。
    //   现在直接量 `boundingBox()` 判**矩形相交**:这才是「都看得见」的字面意思,
    //   也天然不关心那些百分比是相对谁算的。
    // ⚠★一次 `$$eval` 在页内算完,别逐个元素来回问浏览器★:
    //   我第一版对**每个 div** 各发一次 evaluate + boundingBox —— 页面上上千个 div,
    //   几百次往返直接把用例拖到 30 秒超时。★那次超时是我的实现慢,不是产品慢★,
    //   而报错只说「Test timeout」,看起来像页面卡死。
    const boxes = await page.$$eval('div', (els) => els
      .filter((e) => {
        const st = (e as HTMLElement).style
        return st.position === 'absolute' && !!st.top && !!st.height
            && st.left.endsWith('%') && st.width.endsWith('%')
      })
      .map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
      .filter((r) => r.width > 0 && r.height > 0))
    // ★先证明这条用例**有东西可验**★:刚造了两场重叠的,分栏之后必然出现「比满宽窄」的块。
    // 没有这一句,选择器再坏一次它就又安静地退回「空跑也绿」。
    const 满宽 = Math.max(...boxes.map((b) => b.width), 0)
    expect(boxes.filter((b) => b.width < 满宽 * 0.95).length,
      '★刚造了两场重叠的活动,却一个并排块都没有 = 要么没渲染,要么选择器又失效了★').toBeGreaterThan(0)
    // ★判据是「有没有块被**完全盖住**」,不是「有没有相交一个像素」★
    //   （2026-08-13 第四次修这条用例才想明白）:
    //   布局是 `left: col*100/n%` + `width: 100/n%` —— **精确等分,同一簇内不可能重叠**。
    //   而实测确实抓到过两个块竖直方向压 1.4px,来源是另一条**刻意的**设计决定:
    //   ★「极短的会也要有可点中的高度」(最小高度 30px)★ —— 它把一个短块撑过自己的结束时间,
    //   蹭进下一簇 1 个多像素。
    //   ⚠ 那时我的断言写的是「任何两块都不许相交」,于是**我的判据和一条刻意的设计打架** ——
    //     用例红了,而产品完全正确。★判据比产品严,和判据比产品松,都是判据错。★
    //   这条用例的名字说的是「都看得见」,它真正要守的是 v0.4.2 那个 bug
    //   (三个以上重叠时后来者被全宽覆盖 = 整块消失)。所以判「完全包含」:
    //   一个块被另一个块完全罩住 → 它在界面上就是不存在。蹭掉一两像素不影响「看得见」。
    const 完全盖住 = (大: typeof boxes[0], 小: typeof boxes[0]) =>
      大.x <= 小.x + 0.5 && 大.y <= 小.y + 0.5
      && 大.x + 大.width >= 小.x + 小.width - 0.5
      && 大.y + 大.height >= 小.y + 小.height - 0.5
    for (let m = 0; m < boxes.length; m++) {
      for (let n = 0; n < boxes.length; n++) {
        if (m === n) continue
        expect(完全盖住(boxes[m], boxes[n]),
          `★有块被完全盖住 = 那场活动在界面上消失了:${JSON.stringify(boxes[n])} 被 ${JSON.stringify(boxes[m])} 罩住★`)
          .toBe(false)
      }
    }
  })
})

// ★取消了的活动:只说一句「活动已取消」,不再摊开细节★
// （2026-08-13 liaoruili：「如果已经取消，具体信息就别显示了，直接做个取消页面，就像 404 页面那样」
//   「这些啰嗦的解释不要了，直接活动已取消即可」；并专门纠正过★用词是「活动」不是「会议」★）。
//
// ⚠ 之前是照常渲染整页、只在顶上挂一条带长解释的 Alert —— 议程、地点、链接、名单、讨论区
//   全都还摆着，而它们此刻**一条都不该再被行动**。
//   ★一屏可操作的东西配一句「已取消」，读起来像「还能去」。★
test.describe('取消了的活动', () => {
  test('★只显示「活动已取消」,细节一概不摊开★', async ({ page, request }) => {
    const t = Date.now()
    const pid = (await (await request.post('/api/projects', { data: { name: `E2E-取消页-${t}` } })).json()).id
    const 明天 = new Date(); 明天.setDate(明天.getDate() + 1); 明天.setHours(10, 0, 0, 0)
    const r = await request.post('/api/activities', {
      data: { type_id: 会议, title: `E2E-取消页-活动-${t}`, recorder: 'e2e', project_ids: [pid],
              starts_at: 明天.toISOString(), ends_at: new Date(明天.getTime() + 3600e3).toISOString(),
              agenda: 'E2E议程不该出现', location: 'E2E地点不该出现',
              online_url: 'https://meeting.tencent.com/e2e-不该出现' },
    })
    expect(r.status(), await r.text()).toBe(200)
    const mid = (await r.json()).id as number
    expect((await request.delete(`/api/activities/${mid}`)).status(), '取消(DELETE=置 canceled,不是真删)').toBe(200)

    await page.goto(`/?activity=${mid}`)
    await page.waitForTimeout(2500)
    const 屏 = (await page.locator('body').textContent()) ?? ''
    expect(屏, '★要有「活动已取消」这句话★').toContain('活动已取消')
    // ★细节一条都不许露★ —— 这几条是「还能去」的信号，取消之后一个都不该在
    for (const 不该有 of ['E2E议程不该出现', 'E2E地点不该出现', 'meeting.tencent.com/e2e-不该出现']) {
      expect(屏, `★取消页不该摊开细节,却看到了：${不该有}★`).not.toContain(不该有)
    }
    // ★也不该再有那段长解释★（他明确说「啰嗦的解释不要了」）
    expect(屏, '★长解释已经去掉了,别又加回来★').not.toContain('删掉之后没人说得清')
    // ★用词是「活动」不是「会议」★：M0 起「会议」只是众多类型之一
    expect(屏, '★别写成「会议已取消」—— 会议只是活动类型之一★').not.toContain('会议已取消')
  })
})

// ★公开活动广场 · 可旁听★（2026-08-13 liaoruili 指出「你没有测试公开活动」——他说得对，
// 87 条里一条都没覆盖到这块）。这一组走完整闭环：
//   别人发的公开会出现在我的广场 → 我点旁听 → 它进我的日历 → 它从广场消失。
//
// ⚠★必须由**别人**发起★：广场按设计滤掉「我已经与之有关」的会（我发起/我参与/我已旁听），
//   用自己的身份造等于白造 —— 它永远不会出现在自己的广场里。
test.describe('公开活动广场(可旁听)', () => {
  test('★别人的公开会列得出 → 旁听 → 进我日历 → 从广场消失★', async ({ page, request }) => {
    test.slow()
    const t = Date.now()
    const 他 = await pwRequest.newContext({
      baseURL: process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com',
      extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 'e2e-lecturer' },
    })
    try {
      const pid = (await (await 他.post('/api/projects', { data: { name: `E2E-广场-项目-${t}` } })).json()).id
      // ★这场必须落在「日程页默认显示的那一周」里★(2026-08-15 实测踩到)。
      //   周视图是**周日→周六**,于是「明天 15:00」在**周六那天**会掉进下一周 ——
      //   接口有它(第 ④ 步前半句照样绿)、页面也没坏,只是那一周不显示它,
      //   于是最后一句断言红,报错写着「element(s) not found」,★看着像旁听功能坏了★。
      //   这条用例因此**只在周六红**:上一轮跑在周五就是绿的,今天周六才炸出来。
      // ⚠★不能靠「先点『›』翻到下一周再断言」绕过★:翻周会重新取一次数,
      //   而这条断言要抓的恰恰是「旁听后日历不自动刷新」(2026-08-12 liaoruili 撞过的那个 bug)——
      //   翻一次周就把它盖住了,用例还会一直绿。所以只能让活动**排进当前这一周**。
      // ⚠★还有第三个条件,我第一版漏了并且因此又红了一次★:日程页默认把**凌晨 0–8 点**折叠起来
      //   (「这段有 N 项 展开▾」)。我第一版写的是「周六就排到 15 分钟后」——而那次跑在
      //   **01:23**,于是活动排到 01:38,正落在折叠带里:页面上有它、但看不见,报错一模一样
      //   还是「element(s) not found」。★所以时间要同时满足三条:在未来、在本周、且钟点 ≥ 8。★
      const 目标 = new Date(); 目标.setHours(15, 0, 0, 0)          // 先试「今天 15:00」——三条都满足
      if (目标.getTime() < Date.now() + 30 * 60e3) {               // 今天 15:00 已过(或近到来不及)
        if (目标.getDay() === 6) 目标.setHours(Math.min(22, new Date().getHours() + 1), 0, 0, 0)
        else 目标.setDate(目标.getDate() + 1)                      // 非周六:明天 15:00 仍在本周内
      }
      // ⚠ 残留的死角:**周六 22:00 之后**这一小段,本周再也排不出「未来 + 钟点≥8」的位置。
      //   不为它加特例 —— 加了就是把判据改成「反正能过」,那比这条用例偶尔红更坏。
      const 明天 = 目标
      const 标题 = `E2E-公开讲座-${t}`
      const r = await 他.post('/api/activities', {
        data: { type_id: 会议, title: 标题, recorder: 'e2e-lecturer', project_ids: [pid], visibility: 'public',
                starts_at: 明天.toISOString(), ends_at: new Date(明天.getTime() + 2 * 3600e3).toISOString(),
                agenda: '一、引言', location: '明德 1016' },
      })
      expect(r.status(), await r.text()).toBe(200)
      const mid = (await r.json()).id as number

      // ① 它出现在**我**的广场里（我与它毫无关系）
      const 广场 = async () => (await (await request.get('/api/activities/public')).json()) as { id: number }[]
      expect((await 广场()).some((x) => x.id === mid), '★别人发的公开会要出现在我的广场里★').toBe(true)

      // ② 界面上点「旁听」——★走按钮，不打接口★：这条用例要验的正是那张卡能不能用
      await page.goto('/')
      await page.waitForTimeout(2500)
      const 卡 = page.locator('.ant-card').filter({ hasText: '公开活动' }).first()
      await expect(卡, '★日程页右栏得有「公开活动」这张卡★').toBeVisible({ timeout: 10_000 })
      // ★广场从「折叠展开」换成了真分页(v0.4.133),这里要跟着换成翻页去找★（2026-08-14 才红）。
      //   原来这段是「if 看见『还有 N 场公开活动』就点展开」—— 那个元素早就不存在了,
      //   `if` 直接跳过、整段变成**空操作**,而用例照旧绿。
      //   ★它绿只是因为广场上的场次一直不够翻页(每页 5 场)★:今天多灌了几场公开活动,
      //   刚发的那场落到第 2 页,它当场就红了。
      //   ⚠★一个「找不到就跳过」的前置动作,在它要守的东西消失之后,不会报错,只会安静地失效。★
      //     这和「凌晨折叠」「摘要行假通过」是同一族:用例还在,判据已经空了。
      //   现在按**人的走法**:一页页翻过去找,翻到头还没有才算真没有。
      const 行定位 = () => 卡.locator('div[style*="border-bottom"]').filter({ hasText: 标题 }).first()
      for (let i = 0; i < 10 && !(await 行定位().count()); i++) {
        const 下一页 = 卡.locator('.ant-pagination-next:not(.ant-pagination-disabled)')
        if (!(await 下一页.count())) break     // 翻到最后一页了
        await 下一页.first().click(); await page.waitForTimeout(700)
      }
      // ⚠★别用 `.filter({hasText}).last()` 够那一行★:`.last()` 拿到的是最里层、只装着标题的
      //   那个 div —— 里面根本没有按钮,于是点击等 90 秒超时,而报错只说「click 超时」,
      //   ★看起来像按钮坏了/页面卡死,其实是我指错了元素★(今天第三次栽在 `.last()` 上)。
      //   广场的每一行是带下边框的容器(PublicBoard 里 `borderBottom` 那个 div),按它定位。
      const 行 = 卡.locator('div[style*="border-bottom"]').filter({ hasText: 标题 }).first()
      await expect(行, '★刚发的那场要在卡里看得到★').toBeVisible({ timeout: 10_000 })
      await 行.getByRole('button', { name: /旁\s*听/ }).first().click()
      // ★等一个**确定的信号**,别靠 sleep 猜★（2026-08-13 这条 flaky 的成因）:
      //   原来是 `waitForTimeout(2000)` 然后轮询 8 秒 —— 慢一点就红、重试又绿。
      //   ⚠★flaky 的修法不是把睡眠加长★:那只是把「多久算够」这个猜测往后挪一点,
      //     下次机器忙一点照旧红。等界面自己说「已加入我的日程」,才是**事件驱动**。
      await expect(page.getByText('已加入我的日程').first(),
        '★点了旁听要有反馈 —— 没有反馈的按钮，人不知道到底成没成★').toBeVisible({ timeout: 10_000 })

      // ③ 它从广场消失（我已经与它有关了）
      await expect.poll(async () => (await 广场()).some((x) => x.id === mid), { timeout: 15_000 })
        .toBe(false)

      // ④ ★它进了我的日历★ —— 「已加入我的日程」不能只是一句提示
      //   (2026-08-12 liaoruili 撞过：加入旁听后日历没自动刷新)
      const from = new Date(Date.now() - 864e5).toISOString()
      const to = new Date(Date.now() + 3 * 864e5).toISOString()
      const 我的 = (await (await request.get(`/api/activities?from=${from}&to=${to}`)).json()) as { id: number }[]
      expect(我的.some((x) => x.id === mid), '★点了旁听就得进我的日历,否则那句提示是空话★').toBe(true)
      await expect(page.getByText(标题).first(), '★页面上也要看得见(不刷新等于没生效)★')
        .toBeVisible({ timeout: 10_000 })
    } finally { await 他.dispose() }
  })
})

// ★「建议改期」里的时间控件真的能选★（2026-08-13 liaoruili：「建议改期的日期时间无法选择，
// 这个点击 playwright 做了吗！！」——★没做★，而且这个「没做」很具体：
// 巡检确实点了「建议改期」并报 ✓，但那个 ✓ 只证明**弹窗打开了**；
// 纪律②是「弹窗只开不确认」，于是弹窗**里面**的控件一次都没被碰过。
// ★「点开了」和「里面能用」是两件事，而报告只报得出前一件。★)
//
// 真凶：`TimeRangePicker` 是**受控**组件（显示完全由 `value` 决定），
// 而这一处只传了 `onChange`、没回传 `value` —— 选了日期，控件照旧显示空的，且不报任何错。
test.describe('建议改期', () => {
  test('★选了时间就要显示出来,并且提交按钮要活过来★', async ({ page, request }) => {
    test.slow()
    const t = Date.now()
    const 他 = await pwRequest.newContext({
      baseURL: process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com',
      extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 'e2e-organizer' },
    })
    try {
      // 别人约我 → 我这边才会出现「建议改期」
      const pid = (await (await 他.post('/api/projects', { data: { name: `E2E-改期-${t}` } })).json()).id
      await 他.put(`/api/projects/${pid}/members`, { data: { usernames: ['e2e'], role: 'editor' } })
      const 后天 = new Date(); 后天.setDate(后天.getDate() + 2); 后天.setHours(10, 0, 0, 0)
      const r = await 他.post('/api/activities', {
        data: { type_id: 会议, title: `E2E-改期-活动-${t}`, recorder: 'e2e-organizer', project_ids: [pid],
                starts_at: 后天.toISOString(), ends_at: new Date(后天.getTime() + 3600e3).toISOString() },
      })
      expect(r.status(), await r.text()).toBe(200)
      const mid = (await r.json()).id as number
      expect((await 他.put(`/api/activities/${mid}/participants`,
        { data: { usernames: ['e2e'], kind: 'attendee' } })).status()).toBe(200)

      await page.goto(`/?activity=${mid}`)
      await page.waitForTimeout(2500)
      await page.getByRole('button', { name: /建议改期/ }).first().click()
      await page.waitForTimeout(800)

      // ★提交按钮此刻必须是灰的★（还没选时间）—— 先钉住这一头，
      //   否则后面「它活过来了」就证明不了是**选时间**让它活的。
      const 提交 = page.getByRole('button', { name: /提交改期建议/ })
      await expect(提交, '★还没选时间,提交按钮就该是灰的★').toBeDisabled()

      // 选一个时长 —— 这是 time-range 里最短的一条路径（一次点击定起止）
      await page.getByRole('button', { name: '1 小时', exact: true }).first().click()
      await page.waitForTimeout(600)

      // ★控件上要**看得见**选中的时间★ —— 这正是那个 bug：选了却不显示
      const 日期框 = page.locator('input[placeholder="请选择日期"], .ant-picker-input input').first()
      await expect.poll(async () => (await 日期框.inputValue().catch(() => '')) || '', { timeout: 5000 })
        .toMatch(/\d{4}-\d{2}-\d{2}/)
      // ★而且提交按钮要活过来★ —— 「显示了」和「表单认了」是两件事，两条都要钉
      await expect(提交, '★选了时间,提交按钮就该能点 —— 不然这条路根本走不通★').toBeEnabled()
    } finally { await 他.dispose() }
  })
})

// ⚠★分享链接的界面闭环在 `share-ui.spec.ts`,别再往这里加一份★(2026-08-13)。
// 写它的过程中留下一条值得记的事实:★`browser.newContext()` **会继承** config 里的
// `use.extraHTTPHeaders`★(探针实测:那样建出来的上下文 GET /api/me 回 200 且带身份)。
// 我一度按「新建上下文 = 干净访客」写过一版,注释信誓旦旦,而它测的根本不是匿名访问 ——
// ★注释里的断言也是断言,它同样会撒谎,并且没有任何门禁去核它。★


// ★每条界面用例都留一张全页图★(见 _shot.ts:他要能逐张看)
每条都留图('界面')
