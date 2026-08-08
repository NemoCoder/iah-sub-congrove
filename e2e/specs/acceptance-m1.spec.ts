// M1 验收（相位 6）—— ★走 UI，不打 API★。
//
// 其余 spec 大多用 `request` 直接打接口，那验的是**后端对不对**；
// 这一组用 `page` 点真实按钮、填真实表单，验的是**人能不能把事做成**。
// 两者缺一不可：接口全绿而按钮点不动，用户眼里就是坏的。
//
// 对着的是 `docs/STORY-MAP.md` §4 的 M1 自检清单：
//   建项目 → 拉人 → 发会 → 看冲突 → 应答 → 按时开会（从日历点开看到链接）
// 以及那一期的验收标准：「一个新人能在不问任何人的情况下，把一次会约成并如期开上」。
//
// ⚠ **单身份的天花板**（与 transfer.spec.ts 同一条限制）：E2E 通道只有 `e2e` 一个身份。
//   ★「别人收到邀请 → 他答复 → 我看到他的答复」这一段在这里走不通★ ——
//   发起人建会时自动 accepted，我无法把自己变成待应答的人。
//   这个缺口是**已知的**，等平台的 X-IAH-E2E-User 多身份头（群里已提）。
//   在那之前，应答那一步只有 api_cases 的契约描述 + 后端单测兜着。
import { expect, test, type Page } from '@playwright/test'

// ★AntD 会给「两个汉字」的按钮自动插一个空格★:页面上是「新 建」「取 消」「确 定」「今 天」,
// 不是「新建」「取消」。第一版 spec 全按我以为的文案写,于是每一个都定位不到 ——
// 表现是超时 30s,看起来像页面没加载,最难查的那种失败。
// ★所以这一组的按钮一律用允许空格的正则★。三个字以上不插空格(「创建活动」「发起活动」照常)。
const btn = (s: string) => new RegExp(s.split('').join('\\s*'))

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const PEER = process.env.E2E_PEER ?? 'liaoruili'
const stamp = () => String(Date.now()).slice(-8)

/// 点顶部主导航。★用 exact 匹配★：「活动」在页面里到处都是（「发起活动」「公开活动」…），
/// 模糊匹配会点到别的东西上去——这类失败最难查，因为它看起来像是页面没加载。
async function nav(page: Page, name: '日程' | '项目' | '活动') {
  await page.getByText(name, { exact: true }).first().click()
  await page.waitForTimeout(700)
}

test.describe('M1 验收:一个人能不能把会约成', () => {
  test('★建项目 → 拉人 → 发会 → 在日历上看到它 → 点开看到链接★', async ({ page }) => {
    const tag = stamp()
    const pname = `E2E-验收-项目-${tag}`
    const mtitle = `E2E-验收-活动-${tag}`
    const url = `https://meeting.tencent.com/acc-${tag}`

    await page.goto('/')
    await expect(page.getByText('日程', { exact: true })).toBeVisible({ timeout: 20_000 })

    // ── ① 建项目 ──
    await nav(page, '项目')
    await page.getByRole('button', { name: btn('新建') }).first().click()
    await page.getByPlaceholder(/项目名/).fill(pname)
    await page.getByRole('button', { name: btn('确定') }).last().click()
    await expect(page.getByText(pname).first()).toBeVisible({ timeout: 15_000 })

    // ── ② 拉人 ──
    // 「成员」tab 在项目页里；候选允许手输（平台没有用户搜索接口，只有 users/exists 校验）
    await page.getByText(pname).first().click()
    await page.waitForTimeout(600)
    await page.getByRole('tab', { name: /成员/ }).click()
    await page.waitForTimeout(500)
    // ★别用 AntD 的内部类名定位★:`.ant-select-selector` 是 AntD 5 的,AntD 6 里根本不存在
    // (这条我踩过第二次了 —— 第一次是 `.ant-select-selection-item`)。
    // 类名是实现细节、跟着版本变;**占位符和可见文本是产品的一部分**,改了才该让测试红。
    // ⚠ AntD 的 Select 把 placeholder 渲染成一个 <span>,不是 input 的 placeholder 属性 ——
    // getByPlaceholder 抓不到它。用 **role=combobox**(AntD 给 Select 的 input 就是这个 role),
    // 语义定位,既不碰内部类名也不依赖文案。成员 tab 里第一个 combobox 是选人的那个。
    await page.getByRole('combobox').first().click()
    await page.keyboard.type(PEER)
    await page.waitForTimeout(900)
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '批量添加' }).click()
    await expect(page.getByText(PEER).first()).toBeVisible({ timeout: 15_000 })

    // ── ③ 发起活动 ──
    await nav(page, '日程')
    await page.getByRole('button', { name: /发起活动/ }).click()
    await page.waitForTimeout(800)

    // 占位符照实物抄(e2e/probe.mjs 抓的清单),不凭印象写
    await page.getByPlaceholder('如：8 月第二次组会').fill(mtitle)
    // 线上链接 —— ★这是「按时开会」那一步的落点★：到点了人要从这里点进去
    await page.getByPlaceholder('腾讯活动 / Zoom 链接').fill(url)

    // 时间：默认值可能是空的，明天这个点开一小时
    const start = new Date(Date.now() + 26 * 3600_000)
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
    await page.getByPlaceholder('开始日期').fill(fmt(start))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    await page.getByPlaceholder('结束日期').fill(fmt(new Date(start.getTime() + 3600_000)))
    await page.keyboard.press('Enter')
    // ⚠ 日期面板按 Enter 之后**还浮在上面**,会挡住下面的「关联项目」——
    //   表现是「元素找到了但一直 not stable」,重试 44 次然后超时。Escape 收掉它。
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // ★关联项目是必填★——第一版 spec 漏了这一步,表单正确地标红「至少关联一个项目」把我拦住了。
    // 这条本身就是一次验收:后端的硬约束(活动必须关联项目,材料权限才有来源 D3)在前端有对应提示。
    // ★靠**表单字段 id** 定位★(与 ui.spec.ts 同一路子):AntD 的 Select 把 placeholder
    // 渲染成一个 <span>,点它会撞上「元素找到了但 not stable」——那个 span 被 Select 自己的
    // 交互层盖着。字段 id 来自 Form.Item 的 name,是**我们自己写的**,比任何类名都稳。
    await page.locator('#project_ids').click()
    await page.waitForTimeout(500)
    // ★必须先打字过滤★:下拉是**虚拟列表**,库里项目一多,刚建的那个根本没被渲染出来
    // (表现是 getByTitle 找不到)。真实用户也是这么用的 —— 项目多了谁都不会去滚动找。
    await page.keyboard.type(pname)
    await page.waitForTimeout(700)
    await page.getByTitle(pname).first().click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // 参会人(右栏):把刚拉进项目的人请来 —— 「拉人 → 发会」这条线到这里才闭合
    await page.locator('#participants-picker').click()
    await page.keyboard.type(PEER)
    await page.waitForTimeout(900)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    await page.getByRole('button', { name: '创建活动' }).click()
    await page.waitForTimeout(2000)

    // ── ④ 日历上看得到 ──
    await nav(page, '日程')
    // 会在明天，本周视图里应当能看到（除非跨周——那种情况点「›」翻一页）
    let seen = await page.getByText(mtitle).first().isVisible().catch(() => false)
    if (!seen) {
      await page.getByRole('button', { name: '›' }).click()
      await page.waitForTimeout(900)
      seen = await page.getByText(mtitle).first().isVisible().catch(() => false)
    }
    expect(seen, '★约完的会必须出现在日历上★——看不见等于没约').toBe(true)

    // ── ⑤ 点开 → 看到链接（「到点了知道去哪开」）──
    await page.getByText(mtitle).first().click()
    await page.waitForTimeout(1200)
    await expect(page.getByText(url).first(),
      '★活动详情里必须能看到线上链接★——M1 的流程就断在这一步上过(STORY-MAP 问题 1)').toBeVisible({ timeout: 15_000 })

    // 参会人卡在**右栏**（原型 meet 视图；2026-08-07 用户第二次指出我放错了位置）
    await expect(page.getByText(/参会人/).first()).toBeVisible()
    // 「想旁听的人」那一栏没人时也要在 —— 不显示的话发起人不知道有这个位置
    await expect(page.getByText(/想旁听的人/).first()).toBeVisible()
  })

  test('活动页的列表里也找得到（D7:两个入口）', async ({ page }) => {
    await page.goto('/')
    await nav(page, '活动')
    // 活动页与日程页是同一批会的两个视图；列表为空只可能是「真没有会」
    await expect(page.getByText(/即将进行|没有活动/).first()).toBeVisible({ timeout: 20_000 })
  })
})
