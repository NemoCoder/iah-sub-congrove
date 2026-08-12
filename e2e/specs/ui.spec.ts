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
import { expect, test } from '@playwright/test'
import { 会议 } from './_presets'

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
    const boxes = await page.$$eval('div', (els) =>
      els.filter((e) => {
        const st = (e as HTMLElement).style
        return st.position === 'absolute' && !!st.top && !!st.height
            && st.left.endsWith('%') && st.width.endsWith('%')
      }).map((e) => ({ top: (e as HTMLElement).style.top, left: (e as HTMLElement).style.left, w: (e as HTMLElement).style.width })))
    // ★先证明这条用例**有东西可验**★:上面刚造了两场重叠的,分栏之后必然出现非满宽的块。
    // 没有这一句的话,选择器再坏一次,它又会安静地退回「空跑也绿」。
    const narrow = boxes.filter((b) => b.w !== '100%')
    expect(narrow.length, '★刚造了两场重叠的活动,却一个并排块都没有 = 要么没渲染,要么选择器又失效了★')
      .toBeGreaterThan(0)
    for (const b of narrow) {
      const sameSpot = narrow.filter((x) => x.top === b.top && x.w === b.w)
      const lefts = new Set(sameSpot.map((x) => x.left))
      // ★同一位置同宽度的多个盒子,left 必须互不相同★——相同就是叠在一起,等于有活动看不见。
      // 这是 v0.4.2 修的那个 bug(三个以上重叠时后来者全宽覆盖)。
      expect(lefts.size, '有事件盒子叠在同一位置 = 活动在界面上消失了').toBe(sameSpot.length)
    }
  })
})
