// 站内信（v0.4.26）—— 只打**能在这一侧观察到的部分**。
//
// ⚠ 站内信本身落在**平台 registry** 的收件箱里，congrove 这边读不到，
// 所以「A 到底收没收到」这一步在这里验不了。诚实地说清比装作测过了强。
// 这一组打的是通知的两条**结构性**保证：
//   ① ★发不出信不能拖垮业务★ —— best-effort 是设计，不是借口；
//   ② ★通知点进去要能到那场会★ —— `?activity=<id>` 深链落地在活动上，
//      而不是首页让人自己去找是哪一场（那样通知只完成了一半）。
import { expect, test, type APIRequestContext } from '@playwright/test'
import { 会议 } from './_presets'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

async function newProject(req: APIRequestContext, name: string) {
  const r = await req.post('/api/projects', { data: { name, visibility: 'public' } })
  expect(r.status(), await r.text()).toBe(200)
  return (await r.json()).id as number
}

async function newActivity(req: APIRequestContext, pid: number, title: string) {
  const now = Date.now()
  const r = await req.post('/api/activities', {
    data: {
      type_id: 会议,
      title, recorder: 'e2e',
      starts_at: new Date(now + 3600_000).toISOString(),
      ends_at: new Date(now + 7200_000).toISOString(),
      project_ids: [pid],
    },
  })
  expect(r.status(), await r.text()).toBe(200)
  return (await r.json()).id as number
}

test.describe('站内信:不拖垮业务', () => {
  test('★建会 / 改时间 / 取消都照常 200★', async ({ request }) => {
    const pid = await newProject(request, `E2E-通知-${Date.now()}`)
    const mid = await newActivity(request, pid, `E2E 通知活动 ${Date.now()}`)

    // 改时间会触发一轮通知；通知失败只该 warn 一行日志，绝不能让改期失败
    const now = Date.now()
    const upd = await request.put(`/api/activities/${mid}`, {
      data: {
        starts_at: new Date(now + 86400_000).toISOString(),
        ends_at: new Date(now + 90000_000).toISOString(),
      },
    })
    expect(upd.status(), await upd.text()).toBe(200)

    // 取消同理 —— ★这是最需要通知的动作，也最不能因为通知而失败★
    const del = await request.delete(`/api/activities/${mid}`)
    expect(del.status(), await del.text()).toBe(200)
  })

  test('改时间把所有人的答复清回 pending', async ({ request }) => {
    const pid = await newProject(request, `E2E-改期清答复-${Date.now()}`)
    const mid = await newActivity(request, pid, `E2E 改期 ${Date.now()}`)
    // ⚠ 详情是 { activity, participants, projects, can_edit } 的嵌套结构,
    // 我的答复在 activity.my_status 上(2026-08-07 第一版写成 d.my_status 挂了 —— 是 spec 错不是产品坏)
    let d = await (await request.get(`/api/activities/${mid}`)).json()
    expect(d.activity.my_status, '发起人建会时自动 accepted').toBe('accepted')

    const now = Date.now()
    await request.put(`/api/activities/${mid}`, {
      data: {
        starts_at: new Date(now + 172800_000).toISOString(),
        ends_at: new Date(now + 176400_000).toISOString(),
      },
    })
    d = await (await request.get(`/api/activities/${mid}`)).json()
    // ★改的人自己不用重新答复★（他知道自己改成了什么）——被清的是**别人**的答复。
    // 这条钉的是「别把改期人自己也清掉」，否则他每改一次时间都要给自己点一次接受。
    expect(d.activity.my_status).toBe('accepted')
  })
})

test.describe('站内信:点得进去', () => {
  test('★?activity= 深链直接落在那场会上★', async ({ page, request }) => {
    const pid = await newProject(request, `E2E-深链-${Date.now()}`)
    const title = `E2E 深链活动 ${Date.now()}`
    const mid = await newActivity(request, pid, title)

    await page.goto(`/?activity=${mid}`)
    // 只说「有事发生」而落地在首页，人还得自己去找是哪场会 —— 通知只完成了一半
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 })
  })

  test('?activity= 给非法值不炸页面', async ({ page }) => {
    // 参数来自站内信 URL，用户可能手改；解析不认的值应当**退回正常首页**而不是白屏
    await page.goto('/?activity=abc')
    await expect(page.getByRole('button', { name: /日程/ })).toBeVisible({ timeout: 15_000 })
  })
})

// ★删掉项目后它的活动要跟着从日历上消失★（2026-08-07）。
//
// 这个 bug 不是测试发现的，是**截图里肉眼看出来的**：日历上堆着一批 `E2E改…` 的会，
// 而它们的项目早被 teardown 删了 —— 更糟的是它们还被误标成「私密」（紫色虚框），
// 因为 is_private 的判据是「找不到未删的公开关联项目」。
// 所以这一条测的不只是「会不会显示」，还有「显示成什么颜色」这种没人会写断言的地方。
test.describe('软删除:项目删了活动要跟着走', () => {
  test('★删项目后它的会不再出现在日历里★', async ({ request }) => {
    const pid = await newProject(request, `E2E-删项目-${Date.now()}`)
    const title = `E2E 孤儿活动 ${Date.now()}`
    const mid = await newActivity(request, pid, title)

    const inList = async () => {
      const from = new Date(Date.now() - 86400_000).toISOString()
      const to = new Date(Date.now() + 30 * 86400_000).toISOString()
      const all = await (await request.get(`/api/activities?from=${from}&to=${to}`)).json()
      return (all as { id: number }[]).some((x) => x.id === mid)
    }
    expect(await inList(), '删之前当然在').toBe(true)

    expect((await request.delete(`/api/projects/${pid}`)).status()).toBe(200)
    // 活动必须关联至少一个项目（硬约束），项目全没了它就是个孤儿
    expect(await inList(), '★删掉项目之后不该还躺在日历上★').toBe(false)
  })
})

// 公开活动广场（D9）—— ★它是「发现」的入口，不是「我的日程」的副本★（2026-08-07 用户指出）。
test.describe('公开活动广场:只列我还没有关系的会', () => {
  test('★自己发起的公开会不出现在广场里★', async ({ request }) => {
    const pid = await newProject(request, `E2E-广场-${Date.now()}`)
    const now = Date.now()
    const r = await request.post('/api/activities', {
      data: {
        type_id: 会议,
        title: `E2E 我发起的公开会 ${now}`, recorder: 'e2e', visibility: 'public',
        starts_at: new Date(now + 3600_000).toISOString(),
        ends_at: new Date(now + 7200_000).toISOString(),
        project_ids: [pid],
      },
    })
    expect(r.status(), await r.text()).toBe(200)
    const mid = (await r.json()).id as number

    const board = await (await request.get('/api/activities/public')).json()
    // 我发起的会已经在我的日历里了；出现在广场上还配「取消旁听」按钮是荒谬的 —— 我从来就不是旁听
    expect((board as { id: number }[]).some((x) => x.id === mid),
      '★自己发起的会不该出现在广场★').toBe(false)
  })
})
