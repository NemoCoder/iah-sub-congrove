// ★右上角那个「活动即将开始」★——界面闭环（2026-08-14 liaoruili 截图:「我不是已经拒绝了
// 为啥还有提醒」；随后他要求「全部都要走一遍」有头浏览器）。
//
// ══ 为什么单开一份、而且必须用浏览器 ══
// `declined.spec.ts` 里那条验的是 `GET /api/me/reminders` 还返不返回它 —— 那是 toast 的
// **数据源**。「源里没有 → 界面就不会弹」这个推理成立,★但它是推理,不是看见★。
// 前端 `remind-poll.tsx` 自己还有三层判据,那一层此前没人守:
//   ① 60 秒一轮;② ★第一轮只用来对时,直接 return★;③ `mins <= 0` 的不弹、`shown` 去重。
//
// ══ ★否定那一半写不好必然是空的★(这份 spec 最要紧的一段) ══
// 后端判据是 `p.reminded_at > since`,而 `since` 是**上一轮返回的服务端时间**。
// 于是「先拒、再打开页面」这种直觉写法是**假的**:
//   打开页面 → 第一轮 since=null(后端回空)并把 since 钉到「现在」→ 第二轮 since 已经晚于
//   reminded_at → ★那条提醒本来就不会返回,和拒不拒绝毫无关系★。用例会绿,而它什么都没验。
// 真正能验到我那句 `AND p.status <> 'declined'` 的顺序只有一个:
//   ① 建活动(落进提醒窗口,但还没投递)
//   ② ★先打开页面★ —— 把 since 钉在**投递之前**
//   ③ 等后端真的投递(reminded_at 落库,30s 一跳)
//   ④ ★立刻拒★(赶在前端下一轮 60s 轮询之前)
//   ⑤ 等那一轮轮询:since 早于 reminded_at,★不修的话它一定会被返回、一定会弹★
// 顺序错一步,这条用例就退化成一句废话。
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import { 会议 } from './_presets'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const 发起人 = 'e2e-host'
const 主 = (who: string) => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who },
})

/// 建一场「40 分钟后开始、提前 60 分钟提醒」的活动 —— ★立刻落进提醒窗口★,后端下一跳就投。
async function 排一场马上要提醒的活动(host: APIRequestContext, 收件人: string, t: string) {
  const pid = (await (await host.post('/api/projects', { data: { name: `E2E-弹窗-项目-${t}` } })).json()).id as number
  await host.put(`/api/projects/${pid}/members`, { data: { username: 收件人, role: 'editor' } }).catch(() => {})
  const 开始 = new Date(Date.now() + 40 * 60_000)
  const 标题 = `E2E-弹窗-${t}`
  const r = await host.post('/api/activities', {
    data: { type_id: 会议, title: 标题, recorder: 发起人, project_ids: [pid], participants: [收件人],
            remind_minutes: 60, starts_at: 开始.toISOString(),
            ends_at: new Date(开始.getTime() + 3600e3).toISOString() },
  })
  expect(r.status(), await r.text()).toBe(200)
  return { id: (await r.json()).id as number, 标题 }
}

/// 以某个身份开页面(config 只注入 key,默认身份是 `e2e`,这里要显式指定人)
async function 开页(page: Page, who: string) {
  await page.context().setExtraHTTPHeaders({
    'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who,
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
}

test.describe('提醒弹窗(有头浏览器)', () => {

  test('★到点了,右上角真的弹出「活动即将开始」★', async ({ page }) => {
    // 前端 60s 一轮、且首轮只对时 → 最坏要等到第二轮才弹,给到 3 轮。
    test.setTimeout(300_000)
    const t = `${Date.now()}`.slice(-6), 我 = 'e2e-toast'
    const host = await 主(发起人)
    try {
      await 开页(page, 我)                                   // 先开页面:首轮对时
      const { 标题 } = await 排一场马上要提醒的活动(host, 我, t)
      // ★等它真的弹★ —— 这条断言就是「人看得见」的字面意思
      await expect(page.getByText('活动即将开始').first(),
        '★到点了却没弹 —— 提醒对用户就是不存在★').toBeVisible({ timeout: 200_000 })
      await expect(page.getByText(标题).first(), '弹的得是这一场').toBeVisible()
      // 「还有 N 分钟开始」里的数字是这条通知唯一要人立刻读到的东西
      await expect(page.getByText(/还有/).first()).toBeVisible()
      await page.screenshot({
        path: '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/v0.4.145/提醒弹窗/01-弹出来了.png',
        fullPage: true }).catch(() => {})
    } finally { await host.dispose() }
  })

  test('★投递之后再拒绝,那一轮轮询就不该再弹★', async ({ page }) => {
    // ⚠ 顺序见文件头注:错一步这条用例就变成废话。
    test.setTimeout(300_000)
    const t = `${Date.now()}`.slice(-6), 我 = 'e2e-toast2'
    const host = await 主(发起人), 他 = await 主(我)
    try {
      // ② 先开页面 —— ★把 since 钉在投递之前★(这一步的位置就是整条用例的判据所在)
      await 开页(page, 我)
      // ① 再建活动
      const { id, 标题 } = await 排一场马上要提醒的活动(host, 我, t)

      // ③ 等后端**真的投递**(reminded_at 落库);不等到它,后面拒不拒都一样 —— 空跑
      const since = new Date(Date.now() - 864e5).toISOString()
      await expect.poll(async () => {
        const r = await 他.get(`/api/me/reminders?since=${encodeURIComponent(since)}`)
        if (r.status() !== 200) return false
        return ((await r.json()) as { items: { activity_id: number }[] }).items.some((x) => x.activity_id === id)
      }, { timeout: 130_000, intervals: [5_000] }).toBe(true)

      // ④ 立刻拒(赶在前端下一轮 60s 轮询之前)
      expect((await 他.post(`/api/activities/${id}/respond`, { data: { status: 'declined' } })).status()).toBe(200)

      // ⑤ 等两轮轮询过去。★不修的话它一定会弹★:页面的 since 早于 reminded_at。
      await page.waitForTimeout(140_000)
      await expect(page.getByText(标题),
        '★已经拒绝了,右上角还在弹「活动即将开始」★').toHaveCount(0)
      // 顺带确认页面确实活着、轮询在跑(不然「没弹」可能只是因为页面挂了)
      await expect(page.getByText('日程').first(), '★页面本身得是活的,否则「没弹」证明不了什么★')
        .toBeVisible()
    } finally { await Promise.all([host.dispose(), 他.dispose()]) }
  })
})
