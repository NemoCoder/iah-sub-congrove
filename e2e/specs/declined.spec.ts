// ★拒绝掉的活动去哪了★（2026-08-14 liaoruili:「我拒绝的会议为啥出现在日程中？
// 建议把我拒绝的单独放到 活动tab下面的已拒绝 与我参与的 并列（现在我拒绝的与我接受的放到一起了）」）。
//
// ══ 这条判据为什么值得单独写一份 ══
// 它是**一件事的两半**,而两半住在不同的视图里:
//   · 日程(日历)里**不该有**它 —— 日程回答「我接下来要去哪」,而我已经说了不去;
//   · 活动页里**该有**它,但要单独一格 —— 拒了不等于没发生过,回看时还要找得到。
// ★只验一半就会把另一半改坏而没人知道★:把 declined 从接口层滤掉,日历干净了,
//   「已拒绝」那一格会永远是空的 —— 而它看起来完全正常(「我没拒过谁」)。
//   所以这份 spec 两半一起钉。
//
// ⚠ 后端 `/api/activities` **必须继续返回 declined**:过滤是两个视图各自的事。
//   这条也顺带钉住了 —— 见「接口仍然返回」那一段。
import { expect, request as pwRequest, test, type Page } from '@playwright/test'
import { 会议 } from './_presets'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
/// 发起人用另一个身份:自己发起的活动**不能**自己拒(respond 对发起人回 400,见 activities.spec)。
const 发起人 = 'e2e-host'
const 我 = 'e2e'
const 主 = (who: string) => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who },
})

/// 造一场「别人约我、我拒掉」的活动,排在**明天白天**(避开凌晨 0–8 默认折叠那一段)。
async function 造一场被我拒掉的活动(t: string) {
  const host = await 主(发起人), mine = await 主(我)
  const pid = (await (await host.post('/api/projects', { data: { name: `E2E-拒绝-项目-${t}` } })).json()).id as number
  // 拉我进项目,否则我看不见这场活动(D3:非成员一律 404)
  await host.put(`/api/projects/${pid}/members`, { data: { username: 我, role: 'editor' } }).catch(() => {})
  const 明天 = new Date(); 明天.setDate(明天.getDate() + 1); 明天.setHours(14, 0, 0, 0)
  const 标题 = `E2E-被我拒掉的会-${t}`
  const r = await host.post('/api/activities', {
    data: { type_id: 会议, title: 标题, recorder: 发起人, project_ids: [pid],
            participants: [我],
            starts_at: 明天.toISOString(), ends_at: new Date(明天.getTime() + 3600e3).toISOString() },
  })
  expect(r.status(), await r.text()).toBe(200)
  const id = (await r.json()).id as number
  const rp = await mine.post(`/api/activities/${id}/respond`, { data: { status: 'declined' } })
  expect(rp.status(), `★拒绝这一步就没成功,后面全是空跑: ${await rp.text()}★`).toBe(200)
  return { id, 标题, host, mine }
}

const 开页 = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
}

test.describe('拒绝掉的活动', () => {

  test('★日程里不再出现,活动页「已拒绝」里找得到★', async ({ page }) => {
    test.slow()
    const t = `${Date.now()}`.slice(-6)
    const { 标题, host, mine } = await 造一场被我拒掉的活动(t)
    try {
      // ── ① 接口仍然返回它 ──────────────────────────────────────────
      // ★这一句是防「一刀切在后端」★:那样日历确实干净了,但「已拒绝」那一格
      //   会永远是空的,而它看起来完全正常。过滤是**视图**的事。
      const from = new Date(Date.now() - 864e5).toISOString()
      const to = new Date(Date.now() + 7 * 864e5).toISOString()
      const 全部 = await (await mine.get(`/api/activities?from=${from}&to=${to}`)).json() as
        { title: string; my_status: string | null }[]
      const 它 = 全部.find((m) => m.title === 标题)
      expect(它, '★接口不该把 declined 藏起来 —— 「已拒绝」那一格就是靠它★').toBeTruthy()
      expect(它!.my_status, '状态应当是 declined').toBe('declined')

      // ── ② 日程(日历)里没有它 ─────────────────────────────────────
      await 开页(page)
      // 凌晨那段默认折叠,先展开,免得「看不见」是因为它被折起来了而不是被滤掉了
      const 折叠条 = page.getByText(/凌晨这一段有活动被折叠了/)
      if (await 折叠条.count()) { await 折叠条.first().click(); await page.waitForTimeout(700) }
      // ★下周也要看一眼★:活动排在明天,若正好跨周,本周视图里本来就没有它 ——
      //   那样这条断言会**因为错误的理由**通过。先确认本周确实覆盖到明天。
      await expect(page.getByText(标题), '★拒掉的活动不该还躺在日程上★').toHaveCount(0)

      // ── ③ 活动页:「我参与的」里没有,「已拒绝」里有 ────────────────
      await page.getByText('活动', { exact: true }).first().click(); await page.waitForTimeout(1800)
      await expect(page.getByText('我参与的').first()).toBeVisible()
      await expect(page.getByText(标题),
        '★拒掉的还混在「我参与的」里 —— 这正是要分开的那件事★').toHaveCount(0)

      await page.getByText('已拒绝', { exact: true }).first().click(); await page.waitForTimeout(1500)
      await expect(page.getByText(标题).first(),
        '★「已拒绝」这一格里必须找得到 —— 拒了不等于没发生过★').toBeVisible({ timeout: 10_000 })

      // ── ④ 「已结束」里也不该有 ───────────────────────────────────
      // ⚠ 这一条是**时间过去之后**才会暴露的那个洞:只把 declined 从「我参与的」摘掉,
      //   等它结束了又会从「已结束」冒出来 —— ★人会以为「我不是拒了吗,怎么还记在我账上」★。
      //   这里的活动排在明天、还没结束,所以这条验的是「已结束」那一格的**筛选式子**本身。
      await page.getByText('已结束', { exact: true }).first().click(); await page.waitForTimeout(1500)
      await expect(page.getByText(标题), '★「已结束」不该收拒掉的活动★').toHaveCount(0)
    } finally { await Promise.all([host.dispose(), mine.dispose()]) }
  })
})
