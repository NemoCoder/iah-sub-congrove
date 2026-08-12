// 活动模块的核心流程 —— 从 `iah_sub/congrove/tests/api_cases.rs` 的用例表翻过来。
//
// ★挑的是那些标了 ★ 的规则★:它们要么是需求文档里被反复推翻后定下的(D1/D2/D3/D8/D9),
// 要么是「写错了也不会报错、只会静静地泄露或误判」的那种 —— 单元测试覆不到,只能端到端打。
//
// 前置:E2E key(第一层)+ congrove v0.3.60 起的第二层(信任平台注入的身份头)。
// 身份固定是 `e2e` 这个用户,由平台网关注入;它在 congrove 里是普通用户(除非进了超管白名单)。
import { expect, test, type APIRequestContext } from '@playwright/test'
import { 会议 } from './_presets'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

/// 每个 case 自己造数据、用完就走。★不共享夹具★:共享会让失败互相污染,
/// 而 dev 库是随便造的,多几条垃圾数据比调试串扰便宜得多。
async function newProject(req: APIRequestContext, name: string, visibility: 'public' | 'private' = 'public') {
  const r = await req.post('/api/projects', { data: { name, visibility } })
  expect(r.status(), `建项目失败: ${await r.text()}`).toBe(200)
  return (await r.json()).id as number
}

async function newActivity(req: APIRequestContext, projectIds: number[], extra: Record<string, unknown> = {}) {
  const now = Date.now()
  const r = await req.post('/api/activities', {
    data: {
      type_id: 会议,
      title: `E2E 活动 ${now}`,
      recorder: 'e2e',
      starts_at: new Date(now + 3600_000).toISOString(),
      ends_at: new Date(now + 7200_000).toISOString(),
      project_ids: projectIds,
      ...extra,
    },
  })
  return r
}

test.describe('活动:建与关联项目', () => {
  test('建活动必须关联至少一个项目', async ({ request }) => {
    const r = await newActivity(request, [])
    // ★材料权限来自项目成员身份,没有项目就没人管得了它的材料★(D3)
    expect(r.status()).toBe(400)
    expect(await r.text()).toContain('至少一个项目')
  })

  test('不填记录员不让建', async ({ request }) => {
    const pid = await newProject(request, `E2E-记录员-${Date.now()}`)
    const r = await newActivity(request, [pid], { recorder: '' })
    // ★纪要由记录员按模板整理,AI 转写只是原材料★(D14)
    expect(r.status()).toBe(400)
  })

  test('建活动后发起人自动 accepted、记录员自动进名单', async ({ request }) => {
    const pid = await newProject(request, `E2E-名单-${Date.now()}`)
    const r = await newActivity(request, [pid])
    expect(r.status()).toBe(200)
    const { id } = await r.json()
    const d = await (await request.get(`/api/activities/${id}`)).json()
    const me = d.participants.find((p: { username: string }) => p.username === 'e2e')
    // 他自己定的时间,不该再要求他答复一次
    expect(me?.status).toBe('accepted')
  })

  test('★多项目关联要逐个验权★:有一个没权限就整体拒绝', async ({ request }) => {
    const mine = await newProject(request, `E2E-多项目-${Date.now()}`)
    // 借一个不存在的项目 id 冒充「我没权限的项目」——效果等价(require_role 对无授权回 404)
    const r = await newActivity(request, [mine, 999_999_999])
    // ★只验第一个的话,漏验的那个就是越权入口★(D4)
    expect([400, 403, 404]).toContain(r.status())
  })
})

test.describe('活动:答复与建议改期', () => {
  // ⚠★这条原来叫「接受邀请」,拿**发起人自己**去 accept 并断言 200★——
  //   而 2026-08-09 liaoruili 定了「发起人不答复自己发起的活动」(「发起人怎么还能拒绝呢？」),
  //   respond 从此对发起人回 400。用例没跟上,于是它红着,红的理由是产品**按决定改对了**。
  //   ★这类用例最危险的地方在于它读起来完全正当★:「接受邀请回 200」谁看都像该过的,
  //   于是修的人很容易顺手把闸拆掉,把已经拍板的决定悄悄推翻回去。
  //   现在把它翻成正面断言那条决定。
  test('★发起人不答复自己发起的活动★:自己 accept 要被拒', async ({ request }) => {
    const pid = await newProject(request, `E2E-答复-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    const r = await request.post(`/api/activities/${id}/respond`, { data: { status: 'accepted' } })
    expect(r.status(), '发起人自己答复应当 400').toBe(400)
  })

  // 真正的「**被邀请的人**接受邀请」还没有用例:它要第二个**平台上真实存在**的账号
  // (拉人要过 ensure_platform_user,以 Keycloak 为真相源,编的名字一律 400),
  // 和 multi-identity.spec.ts 里跳过的那两组同一个前提 —— 待平台 O3b(见 CLAUDE.md)。
  // ★这里不放 `test.skip(!PEER, …)` 占位★:裸写在 describe 体里的 test.skip(条件)
  // 跳的是**整个 describe**,会把上面这一组答复用例一起静默跳掉 —— 那比没有用例更坏。

  test('★建议改期必须带具体的替代时间★', async ({ request }) => {
    const pid = await newProject(request, `E2E-改期-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    const r = await request.post(`/api/activities/${id}/respond`, { data: { status: 'counter' } })
    // ★只说「我不行」等于把问题丢回给发起人★——私密项目的日程对发起人完全隐形,
    // 他根本不知道我忙,counter 是这个冲突唯一的结构化出口(D2)
    expect(r.status()).toBe(400)
  })

  test('乱填答复状态要被拒', async ({ request }) => {
    const pid = await newProject(request, `E2E-乱答-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    const r = await request.post(`/api/activities/${id}/respond`, { data: { status: 'whatever' } })
    expect(r.status()).toBe(400)
  })

  test('改了活动时间,已有答复清回 pending', async ({ request }) => {
    const pid = await newProject(request, `E2E-改期清答-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    // 先接受
    await request.post(`/api/activities/${id}/respond`, { data: { status: 'accepted' } })
    // 发起人改时间
    const t = Date.now() + 86400_000
    const u = await request.put(`/api/activities/${id}`, {
      data: { starts_at: new Date(t).toISOString(), ends_at: new Date(t + 3600_000).toISOString() },
    })
    expect(u.status()).toBe(200)
    // ⚠ 改时间的人是发起人自己,按实现他**不被**清回 pending(他知道自己改了什么)。
    //   这条用例验的是接口不报错 + 时间确实改了;「别人被清回 pending」要两个身份才测得了,
    //   ★E2E 通道只有 e2e 一个身份,测不了多人场景★——记在这里,别以为漏了。
    const d = await (await request.get(`/api/activities/${id}`)).json()
    expect(new Date(d.activity.starts_at).getTime()).toBe(t)
  })
})

test.describe('活动:取消与留档', () => {
  test('★取消不是删除★', async ({ request }) => {
    const pid = await newProject(request, `E2E-取消-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    expect((await request.delete(`/api/activities/${id}`)).status()).toBe(200)
    // 谁邀了谁、谁拒了是协作事实,真删掉之后没人说得清当时发生过什么
    const d = await request.get(`/api/activities/${id}`)
    expect(d.status()).toBe(200)
    expect((await d.json()).activity.status).toBe('canceled')
  })

  test('取消后不再产生忙闲', async ({ request }) => {
    const pid = await newProject(request, `E2E-取消忙闲-${Date.now()}`, 'public')
    const { id } = await (await newActivity(request, [pid])).json()
    const from = new Date(Date.now() - 3600_000).toISOString()
    const to = new Date(Date.now() + 86400_000).toISOString()
    const before = await (await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)).json()
    expect(before.busy.e2e.length).toBeGreaterThan(0)
    await request.delete(`/api/activities/${id}`)
    const after = await (await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)).json()
    expect(after.busy.e2e.length).toBeLessThan(before.busy.e2e.length)
  })
})

test.describe('忙闲:按项目可见性分流(D1)', () => {
  const window_ = () => ({
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date(Date.now() + 86400_000).toISOString(),
  })

  test('公开项目的会产生忙闲,且★只有时间没有内容★', async ({ request }) => {
    const pid = await newProject(request, `E2E-公开忙闲-${Date.now()}`, 'public')
    await newActivity(request, [pid], { title: '这个标题不该出现在忙闲里' })
    const { from, to } = window_()
    const r = await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)
    expect(r.status()).toBe(200)
    const body = await r.text()
    expect(JSON.parse(body).busy.e2e.length).toBeGreaterThan(0)
    // ★忙闲泄露标题 = 隐私模型破了★:别人只该看到「忙」,不该知道在忙什么
    expect(body).not.toContain('这个标题不该出现在忙闲里')
  })

  // ★2026-08-08 M0-1 换判据（PRD A4）★：忙闲不再看「项目公不公开」，看**活动自己的 `busy`**。
  //
  // 旧行为是「私密项目的会完全隐形」。它把两件**正交**的事绑成了一件 ——
  // 「内容给谁看」与「我这个时段有没有空」。后者本来就不泄露任何内容，
  // 而绑在一起的后果是：私密项目的会不占忙闲成了默认，别人永远约得到你、你却真在开会。
  // 新模型：占不占由用户**逐条**控制（类型给初值），想隐身就把 `busy` 关掉。
  test('★忙闲由活动自己的 busy 决定，与项目可见性无关★', async ({ request }) => {
    const { from, to } = window_()
    const before = await (await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)).json()
    // 「私密」项目（该列已删，传了也是空操作）里的会，照样产生忙块 —— 因为 busy 默认 true
    const pid = await newProject(request, `E2E-私密忙闲-${Date.now()}`, 'private')
    const m = await newActivity(request, [pid])
    expect(m.status()).toBe(200)
    const after = await (await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)).json()
    expect(
      after.busy.e2e.length,
      '★项目「私密」不该再让活动隐身★（A4：忙闲归活动自己的 busy）',
    ).toBeGreaterThan(before.busy.e2e.length)
  })

  test('★列表要正确标出私密/公开★(is_private 必须由 SQL 算出来)', async ({ request }) => {
    // ★判据换成活动自己的 visibility★（M0-1，PRD J4）：项目那一列已删，
    // 所以这里改成造**两个可见性不同的活动**，而不是两个可见性不同的项目。
    const pid = await newProject(request, `E2E-标色-${Date.now()}`)
    const { id: mPriv } = await (await newActivity(request, [pid], { visibility: 'private' })).json()
    const { id: mPub } = await (await newActivity(request, [pid], { visibility: 'public' })).json()
    const from = new Date(Date.now() - 3600_000).toISOString()
    const to = new Date(Date.now() + 86400_000).toISOString()
    const list = await (await request.get(`/api/activities?from=${from}&to=${to}`)).json()
    const f = (id: number) => list.find((m: { id: number }) => m.id === id)
    // ★这条防的是一个静默 bug★:字段在结构体里声明了、SQL 却没算,
    // #[sqlx(default)] 会安静地给 false —— 于是私密项目的会在日历上显示成公开色,
    // D1 的隐私提示当场失效,而且没有任何报错。2026-08-07 我就这么写错过一次。
    expect(f(mPriv)?.is_private, '私密活动没被标成私密').toBe(true)
    expect(f(mPub)?.is_private, '公开活动被误标成私密').toBe(false)
  })

  test('忙闲查询要挡住离谱参数', async ({ request }) => {
    const now = new Date().toISOString()
    // to 早于 from
    expect((await request.get(`/api/freebusy?users=e2e&from=${now}&to=${now}`)).status()).toBe(400)
    // users 空
    expect((await request.get(`/api/freebusy?users=&from=${now}&to=${now}`)).status()).toBe(400)
  })
})

test.describe('活动讨论区(D13)', () => {
  test('公开发言与读取', async ({ request }) => {
    const pid = await newProject(request, `E2E-讨论-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    const s = await request.post(`/api/activities/${id}/messages`, { data: { body: '我可能晚十分钟' } })
    expect(s.status()).toBe(200)
    const list = await (await request.get(`/api/activities/${id}/messages`)).json()
    expect(list.some((m: { body: string }) => m.body === '我可能晚十分钟')).toBe(true)
  })

  test('空内容不让发', async ({ request }) => {
    const pid = await newProject(request, `E2E-空发言-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    expect((await request.post(`/api/activities/${id}/messages`, { data: { body: '   ' } })).status()).toBe(400)
  })

  test('★私聊只能发给发起人或记录员★', async ({ request }) => {
    const pid = await newProject(request, `E2E-私聊-${Date.now()}`)
    const { id } = await (await newActivity(request, [pid])).json()
    const r = await request.post(`/api/activities/${id}/messages`, {
      data: { channel: 'private', peer: 'somebody-else', body: '私聊' },
    })
    // ★不做任意点对点,否则这里会长成一个 IM★(D13)
    expect(r.status()).toBe(400)
  })
})

test.describe('活动可见性(D9)', () => {
  test('看不见的活动回 404 而不是 403', async ({ request }) => {
    // 用一个几乎不可能存在的 id:未授权与不存在必须**同一种回应**,
    // 否则按 id 爬一遍就成了存在性预言机。
    const r = await request.get('/api/activities/999999999')
    expect(r.status()).toBe(404)
  })
})

test.describe('项目归档(D17)', () => {
  /// 归档一个项目并返回它的 id
  const archive = async (req: APIRequestContext, pid: number, on = true) =>
    req.post(`/api/projects/${pid}/archive`, { data: { archived: on } })

  test('★归档后写操作 409、读操作仍 200★', async ({ request }) => {
    const pid = await newProject(request, `E2E-归档-${Date.now()}`)
    // 归档前:能写
    expect((await request.post(`/api/projects/${pid}/items`,
      { data: { name: '归档前建的', kind: 'folder' } })).status()).toBe(200)

    expect((await archive(request, pid)).status()).toBe(200)

    // ★写:409 而不是 403★ —— 语义是「项目结束了」不是「你没权限」
    const w = await request.post(`/api/projects/${pid}/items`, { data: { name: '归档后', kind: 'folder' } })
    expect(w.status(), '归档后还能往里写 = 只读没生效').toBe(409)
    // 建活动同样被挡(它也走 require_role(Editor))
    const m = await newActivity(request, [pid])
    expect(m.status(), '归档项目还能建活动').toBe(409)

    // ★读:仍然 200★ —— 归档就是为了以后还能查,查不到就等于删了
    expect((await request.get(`/api/projects/${pid}/items`)).status(), '归档后读不到了 = 存档失去意义').toBe(200)
    expect((await request.get(`/api/projects/${pid}`)).status()).toBe(200)
  })

  test('恢复为进行中之后,同一个写请求由 409 变 200', async ({ request }) => {
    const pid = await newProject(request, `E2E-归档恢复-${Date.now()}`)
    await archive(request, pid)
    expect((await request.post(`/api/projects/${pid}/items`, { data: { name: 'x', kind: 'folder' } })).status()).toBe(409)
    // ★恢复走 require_owner 不走 require_role★:后者对归档项目拒绝一切写操作,
    // 那样归档之后就再也解不开了(自锁)。这条用例就是守这个。
    expect((await archive(request, pid, false)).status(), '★解不开了 = 自锁★').toBe(200)
    expect((await request.post(`/api/projects/${pid}/items`, { data: { name: 'y', kind: 'folder' } })).status()).toBe(200)
  })

  test('★归档项目的会留在日历上但标出来、不再产生忙闲★', async ({ request }) => {
    const pid = await newProject(request, `E2E-归档日历-${Date.now()}`, 'public')
    const { id: mid } = await (await newActivity(request, [pid])).json()
    // ★把会挪到过去,否则**根本归档不了**★:项目归档有一道真闸——「还有没开始的活动,
    //   先处理掉再归档」(2026-08-12 查出)。这条用例原来直接 `await archive(...)`
    //   **不看返回码**,于是归档被 400 拒掉、测试却继续往下断言 ——
    //   ★一个没检查返回码的前置步骤,失败时不会报「前置没做成」,而是伪装成后面那条断言的失败★,
    //   查的人于是去查日历 SQL,而真凶在三行之前。所有前置动作都要 expect 状态码。
    //   改时间没有「不能选过去」这条限制(那也用来补录,见 time-range.tsx 的头注)。
    const past = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    expect((await request.put(`/api/activities/${mid}`,
      { data: { starts_at: past(3), ends_at: past(2) } })).status(), '补录到过去应当允许').toBe(200)
    const from = past(4)
    const to = new Date(Date.now() + 86400_000).toISOString()

    // 归档前:会在日历里,也产生忙闲
    const before = await (await request.get(`/api/activities?from=${from}&to=${to}`)).json()
    expect(before.some((x: { id: number }) => x.id === mid)).toBe(true)
    const fbBefore = await (await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)).json()
    expect(fbBefore.busy.e2e.length).toBeGreaterThan(0)

    expect((await archive(request, pid)).status(), '归档没成功,后面的断言都是空的').toBe(200)

    // 归档后:★活动**照常留在日历上**,但带着 `archived` 标记★(PRD B0,2026-08-07 liaoruili
    // 推翻了 D17 的这一半:「日程也是我做过什么的记录,归档不该让过去消失」)。
    //
    // ⚠★这条用例此前断言的是相反的事(`toBe(false)`),执行的是一条已被明令推翻的决定★——
    //   代码 2026-08-09 就按 B0 改了(activities.rs 那段注释写得很清楚),用例没跟上,
    //   于是它每轮都红,而红的理由是「产品按产品负责人的决定改了」。
    //   ★一条断言旧契约的用例不是「暂时失效」,它是在往反方向拽★:
    //   谁要是照它去「修」,就等于把 liaoruili 的决定又推翻一次。
    const after = await (await request.get(`/api/activities?from=${from}&to=${to}`)).json()
    const row = after.find((x: { id: number }) => x.id === mid)
    expect(row, '归档项目的会不该从日历上消失(PRD B0)').toBeTruthy()
    // ★必须**标出来**★:归档项目只读(D17 的这一半仍然成立),不标的话人会点进去想传材料才发现动不了。
    expect(row.archived, '归档项目的会要带 archived 标记,否则前端淡化不了').toBe(true)
    // 忙闲也没有了 —— 否则历史活动会让人永远约不到你
    const fbAfter = await (await request.get(`/api/freebusy?users=e2e&from=${from}&to=${to}`)).json()
    expect(fbAfter.busy.e2e.length, '归档项目仍在产生忙闲').toBeLessThan(fbBefore.busy.e2e.length)

    // ★但活动本身还查得到★:历史归历史,进项目页/直接开 id 都能看
    expect((await request.get(`/api/activities/${mid}`)).status(), '归档后历史活动查不到了').toBe(200)
  })

  test('项目列表带出归档状态,且归档的排在后面', async ({ request }) => {
    const act = await newProject(request, `E2E-归档排序A-${Date.now()}`)
    const arc = await newProject(request, `E2E-归档排序B-${Date.now()}`)
    await archive(request, arc)
    const ps = await (await request.get('/api/projects')).json()
    const iAct = ps.findIndex((p: { id: number }) => p.id === act)
    const iArc = ps.findIndex((p: { id: number }) => p.id === arc)
    expect(ps[iArc].archived_at, '列表没带出 archived_at,前端无从区分').toBeTruthy()
    expect(ps[iAct].archived_at).toBeFalsy()
    expect(iArc, '归档项目没有沉到后面').toBeGreaterThan(iAct)
  })
})
