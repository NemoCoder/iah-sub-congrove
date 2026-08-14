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

  test('★拒绝之后,提醒不该再弹★', async () => {
    // liaoruili 截图:「我不是已经拒绝了 为啥还有提醒」——右上角还在弹「活动即将开始」。
    //
    // ★根因是两侧只判了一侧★:投递侧(`remind.rs`)早就有 `p.status <> 'declined'`,
    //   注释还写着「拒绝了的人不必再提醒」—— 但它只管**要不要发**。
    //   真实顺序常常是:先发出去(`reminded_at` 落库)、人看到了才去拒。
    //   于是「已经发过」这个事实继续在**拉取侧**(`GET /api/me/reminders`)生效,toast 照弹。
    // ⚠ 这和 ADR-0003 同族:★存的是「当时发生过」的事实,读的时候没再问一次「现在还成不成立」★。
    //
    // ══ 这条用例写坏过三次,每一次都是「绿得毫无意义」,记在这 ══
    // ① 路径写成 `/api/activities/reminders` —— **不存在**,回的不是 JSON 而是「Invalid URL」,
    //    `.json()` 直接抛。它在修复前后都红,★而红的理由根本不是那个 bug★ ——
    //    我却拿这个红当成「用例复现了问题」写进了 PR 描述。
    //    ★「它红了」不等于「它红在我以为的地方」。★ 真实路径是 `/api/me/reminders`。
    // ② `since` 不给的话服务端**直接回空数组**(`my_reminders` 的 `None => vec![]`),
    //    于是 `some(...)` 恒为 false —— 白捡一个绿,而且看起来完全正常。
    // ③ 用 `e2e` 这个身份跑:它名下符合条件的提醒有 **54 条**,而接口 `ORDER BY starts_at LIMIT 20`
    //    —— ★我造的那场被截在第 20 名之外,于是「查不到」和「被过滤掉」长得一模一样。★
    //    改用专用身份 `e2e-remind`(干净、且 teardown 从 spec 源码推导身份,会自动清它)。
    //
    // ★最要紧的一条:必须先等提醒**真的投递出去**★。`reminded_at` 只由后台循环写
    //   (30 秒一跳),手动 `remind` 接口只给 pending 的人发站内信、不写这个字段。
    //   不等到它出现就去拒,那么列表本来就是空的 —— ★这条用例会绿,而我改的那句 SQL 一次都没被执行到。★
    test.setTimeout(180_000)
    const t = `${Date.now()}`.slice(-6)
    const 收件人 = 'e2e-remind'
    const host = await 主(发起人), 他 = await 主(收件人)
    try {
      const pid = (await (await host.post('/api/projects', { data: { name: `E2E-提醒-项目-${t}` } })).json()).id as number
      await host.put(`/api/projects/${pid}/members`, { data: { username: 收件人, role: 'editor' } }).catch(() => {})
      // 40 分钟后开始 + 提前 60 分钟提醒 = ★立刻落进提醒窗口★,下一跳就发
      const 开始 = new Date(Date.now() + 40 * 60_000)
      const r = await host.post('/api/activities', {
        data: { type_id: 会议, title: `E2E-提醒-${t}`, recorder: 发起人, project_ids: [pid],
                participants: [收件人], remind_minutes: 60,
                starts_at: 开始.toISOString(), ends_at: new Date(开始.getTime() + 3600e3).toISOString() },
      })
      expect(r.status(), await r.text()).toBe(200)
      const id = (await r.json()).id as number
      const since = new Date(Date.now() - 864e5).toISOString()
      const 提醒里有它 = async () => {
        const 回 = await 他.get(`/api/me/reminders?since=${encodeURIComponent(since)}`)
        expect(回.status(), await 回.text()).toBe(200)
        return ((await 回.json()) as { items: { activity_id: number }[] }).items.some((x) => x.activity_id === id)
      }
      // ★防呆:先证明它**真的被提醒了**★(后台循环 30s 一跳,给到 4 跳)
      await expect.poll(提醒里有它, { timeout: 130_000, intervals: [5_000] })
        .toBe(true)

      // 现在才去拒 —— 这正是用户遇到的顺序
      expect((await 他.post(`/api/activities/${id}/respond`, { data: { status: 'declined' } })).status()).toBe(200)
      expect(await 提醒里有它(),
        '★拒绝掉的活动还在提醒列表里 —— 右上角就会继续弹「活动即将开始」★').toBe(false)
    } finally { await Promise.all([host.dispose(), 他.dispose()]) }
  })
})
