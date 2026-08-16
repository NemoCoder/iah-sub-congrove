// ★项目页「发起活动」★（2026-08-16 liaoruili:「点进具体的项目,增加发起活动的功能,
// 自动关联该项目」）—— 入口在项目标题栏,表单里「关联项目」预填当前项目。
//
// ══ 这份 spec 存在的理由:一个**只有眼睛看得见**的 bug ══
// v0.7.1 上线后第一次在真浏览器里看截图,「关联项目」那个 chip 上画的是★「1 ×」★——
// 项目 id 的裸数字,不是项目名。★页面照常渲染、控制台没有一条错、接口全 200★:
// 提交上去的 project_ids 完全正确,只是**人看到的是个数字**。
//
// 根因不在我们的代码,在 AntD Select 的一个隐含前提(详见 `web/src/activity-new.tsx` 里
// 那段注释):已选项被 filter 从 options 里摘掉之后,它的中文名靠 rc-select 的 label 缓存;
// 而★那个缓存只在「人点选」时被填★ —— onChange 直接带着被点那个 option 的 label。
// 用 `form.setFieldValue` 程序化赋值走的不是这条路,缓存里永远没有这一条,
// 于是它把裸 value 画了出来。修法是 `labelInValue`(让 label 跟着值走)。
//
// ⇒ ★这类 bug,单元测试一条都抓不到★:我们自己的逻辑全对,错的是与组件的交互;
//   给「预填算出了正确的 id」写个断言,修不修都会绿 —— 那是一句空断言。
//   能挡住它的只有「打开浏览器,看那个 chip 上写的是什么」。
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const 我 = 'e2e-projnew'

function 截图目录(子: string): string {
  const src = readFileSync(new URL('../../web/src/version.ts', import.meta.url), 'utf8')
  const v = /VERSION\s*=\s*'([^']+)'/.exec(src)?.[1] ?? 'unknown'
  const d = `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${v}/${子}`
  mkdirSync(d, { recursive: true })
  return d
}

const 接口 = (who: string): Promise<APIRequestContext> => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who },
})

async function 开页(page: Page, who: string) {
  await page.context().setExtraHTTPHeaders({
    'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who,
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
}

/// 进「项目」tab 并选中某个项目
async function 进项目(page: Page, 项目名: string) {
  await page.locator('.ant-segmented-item', { hasText: '项目' }).click()
  await page.waitForTimeout(1500)
  await page.locator(`text=${项目名}`).first().click()
  await page.waitForTimeout(1500)
}

test.describe('项目页「发起活动」', () => {

  test('★预填的关联项目显示的是项目名,不是裸 id★', async ({ page }) => {
    test.setTimeout(180_000)
    const t = `${Date.now()}`.slice(-6)
    const 项目名 = `E2E-发起活动-${t}`
    const api = await 接口(我)
    try {
      const r = await api.post('/api/projects', { data: { name: 项目名 } })
      expect(r.status(), await r.text()).toBe(200)

      await 开页(page, 我)
      await 进项目(page, 项目名)

      // ── 入口在标题栏 ──
      const 按钮 = page.getByRole('button', { name: /发起活动/ })
      await expect(按钮.first(), '★项目标题栏上应该有「+ 发起活动」★').toBeVisible()
      await 按钮.first().click()
      await page.waitForTimeout(2500)
      await page.screenshot({ path: `${截图目录('项目页发起活动')}/01-预填.png`, fullPage: true }).catch(() => {})

      // ── ★核心断言★:chip 上写的是项目名 ──
      const chip = page.locator('.ant-form-item:has-text("关联项目") .ant-select-selection-item')
      await expect(chip.first(), '关联项目应当已经预填').toBeVisible()
      const 文字 = (await chip.first().innerText()).trim()
      expect(文字, `★chip 上写着「${文字}」—— 预填必须显示项目名★`).toContain(项目名)
      // 冗余但值得:把「裸数字」这个具体的坏形态单独钉死,将来读失败信息的人一眼知道发生了什么
      expect(/^\d+$/.test(文字), `★chip 退化成了裸 id「${文字}」—— labelInValue 被去掉了?★`).toBe(false)

      // ── 取消要原路退回项目页(不是把人扔在活动列表) ──
      // ⚠★选择器必须容忍中间那个空格★:AntD 在两个汉字之间插空格,按钮实际是「取 消」。
      //   2026-08-16 我用 /^取消$/ 写过一版 —— ★点击根本没发生,而断言把它报成了「落错了 tab」★。
      await page.getByRole('button', { name: /取\s*消/ }).first().click()
      await page.waitForTimeout(1800)
      await expect(page.locator('.ant-segmented-item-selected').first(),
        '★取消之后应当回到「项目」,不是留在活动列表★').toContainText('项目')
      await expect(page.locator(`text=${项目名}`).first(), '而且仍选中原来那个项目').toBeVisible()
    } finally { await api.dispose() }
  })

  test('★已归档项目上不给这个按钮★（反向对照）', async ({ page }) => {
    test.setTimeout(180_000)
    const t = `${Date.now()}`.slice(-6)
    const 项目名 = `E2E-归档-${t}`
    const api = await 接口(我)
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: 项目名 } })).json()).id as number

      // ★先验正向:归档之前,同一个项目、同一个人,按钮是在的★
      // 没有这一步,下面那条「归档后没有按钮」在**按钮从来就没出现过**时也会绿 ——
      // 那样它验的是「我的选择器写错了」,不是「归档挡住了它」。
      await 开页(page, 我)
      await 进项目(page, 项目名)
      await expect(page.getByRole('button', { name: /发起活动/ }).first(),
        '★正向对照:没归档时按钮必须在★').toBeVisible()

      const a = await api.post(`/api/projects/${pid}/archive`, { data: { archived: true } })
      expect(a.ok(), `归档失败:${await a.text()}`).toBeTruthy()

      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2200)
      await page.locator('.ant-segmented-item', { hasText: '项目' }).click()
      await page.waitForTimeout(1200)
      await page.locator('.ant-segmented-item', { hasText: '已归档' }).click()
      await page.waitForTimeout(1200)
      await page.locator(`text=${项目名}`).first().click()
      await page.waitForTimeout(1800)
      await page.screenshot({ path: `${截图目录('项目页发起活动')}/02-已归档.png`, fullPage: true }).catch(() => {})
      await expect(page.getByRole('button', { name: /发起活动/ }),
        '★归档 = 只读,归档弹窗自己写着「不能再上传或建活动」★').toHaveCount(0)
    } finally { await api.dispose() }
  })
})
