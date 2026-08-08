// ★多身份 E2E★（2026-08-08）——平台的 `X-IAH-E2E-User` 让「跨用户的权限判定」终于能验收了。
//
// ══════ 为什么这个文件在今天才出现 ══════
//
// 在此之前所有 spec 都只有 `e2e` 一个身份，于是**一切「别人能不能看到我的东西」**
// 结构上无法验收。我在技术设计里把它写成了「平台的阻塞依赖 O3」，还实测过
// 「带 `X-Forwarded-Preferred-Username: alice` 拿到的仍是 e2e」当作证据。
//
// ★那个实测是对的，结论是错的★：被剥掉的是**伪造的网关头**（平台的 strip-identity 在正常干活），
// 而平台**早就提供了另一个头** `X-IAH-E2E-User` 专门干这件事 —— 我用错了名字，
// 然后把「我试的那个不行」写成了「这件事做不了」。
// **「我试过一种办法没成」不等于「没有办法」。**
//
// 头的语义（已逐条实测）：
//   带 key + `X-IAH-E2E-User: alice`      → 身份 alice
//   带 key + `X-IAH-E2E-User: liaoruili`  → 身份 liaoruili，**且 is_super=true**
//   只带 key                               → 身份 e2e（默认，向后兼容）
//   伪造 X-Forwarded-Preferred-Username    → 仍是 e2e（网关剥掉）
//   用户名非法（空格/非 ASCII/CRLF）        → 400（防头注入）
import { expect, request as pwRequest, test, type APIRequestContext } from '@playwright/test'
import { 会议 } from './_presets'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

/// ★第二个**真实**用户名★（`IAH_E2E_PEER`）——扮演任何人靠 header 就够了，
/// 但**拉人 / 授权**要过 `ensure_platform_user`：它以 **Keycloak 为真相源**
/// （`projects.rs::ensure_platform_user`，registry 可达时不降级），编出来的名字一律 400。
/// 所以「加入即可见 / 离开即失去」「正式参会人 vs 旁听者」这两组需要一个**平台上真实存在**的账号。
/// ★没配就跳过，而不是拿 liaoruili 去跑★——那会给真人反复发站内信。
/// 已向平台申请两个专用 E2E 账号；到位后配上这个变量，下面两组自动生效。
const PEER = process.env.IAH_E2E_PEER

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1e4)}`

/// 以某个人的身份拿一个请求上下文。★用户不必真的登录过★——
/// 平台在校验 key 之后注入身份，congrove 的 auth 会 upsert 一行 app_user。
async function asUser(username: string): Promise<APIRequestContext> {
  return await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: {
      'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!,
      'X-IAH-E2E-User': username,
    },
  })
}

test.describe('多身份通道自身', () => {
  test('三种身份各自拿到对的人,伪造的网关头拿不到', async () => {
    const a = await asUser('e2e-alice')
    expect((await (await a.get('/api/me')).json()).username).toBe('e2e-alice')

    // ★超管身份也能拿到★ —— 这让超管路径（配额、审计、_dev 面）第一次可测
    const boss = await asUser('liaoruili')
    const me = await (await boss.get('/api/me')).json()
    expect(me.username).toBe('liaoruili')
    expect(me.is_super, 'liaoruili 在 CONGROVE_SUPER_USERS 里').toBe(true)

    // ★伪造网关头必须无效★：这条是平台 strip-identity 的回归测试，顺手在这里钉住
    const forged = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: {
        'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!,
        'X-Forwarded-Preferred-Username': 'liaoruili',
      },
    })
    expect((await (await forged.get('/api/me')).json()).username, '伪造的身份头必须被剥').toBe('e2e')
    await Promise.all([a.dispose(), boss.dispose(), forged.dispose()])
  })
})

// ════════ ★v0.4.39 修的旁听者提权 —— 终于能端到端验了★ ════════
//
// 缺陷：`observe`（自助旁听）往 activity_participants 插一行 `kind='observer'`，
// 而 `perm.rs::activity_view` 与 `activities.rs::respond` 两处判定都不看 `kind`
// → 点一下「旁听」就从 Observer 提权成 Inside，拿到参会人名单与讨论区（D9 明写都不给），
//   还能提交 `counter`（建议改期）—— 而 counter 是**唯一会给发起人发站内信**的分支。
//
// 修复之前只有 6 条纯函数单测守着（`decide_view`）。★单测守的是判定，这里守的是整条路★。
test.describe('权限·旁听者不得提权', () => {
  const T = tag()
  let organizer: APIRequestContext, outsider: APIRequestContext
  let mid = 0

  test.beforeAll(async () => {
    organizer = await asUser('e2e-host')
    outsider = await asUser('e2e-passerby')
    // 发起人建一个**公开**活动（公开才可能被路人旁听）
    const pid = (await (await organizer.post('/api/projects', {
      data: { name: `E2E-旁听-项目-${T}`, visibility: 'public' },
    })).json()).id
    const now = Date.now()
    const r = await organizer.post('/api/activities', {
      data: {
        type_id: 会议,
        title: `E2E-旁听-公开会-${T}`, recorder: 'e2e-host', project_ids: [pid], visibility: 'public',
        starts_at: new Date(now + 3600e3).toISOString(), ends_at: new Date(now + 7200e3).toISOString(),
        agenda: '这段议程旁听者看得到', location: '明德 1016',
      },
    })
    expect(r.status(), await r.text()).toBe(200)
    mid = (await r.json()).id
  })
  test.afterAll(async () => { await Promise.all([organizer.dispose(), outsider.dispose()]) })

  test('旁听前:路人只看得到元信息,看不到名单与讨论区', async () => {
    const d = await outsider.get(`/api/activities/${mid}`)
    expect(d.status(), '公开活动路人看得见').toBe(200)
    const body = await d.json()
    expect(body.title).toContain('E2E-旁听-公开会')
    expect(body.agenda, 'D9:议程给').toBeTruthy()
    expect(body.participants ?? null, '★名单不给★').toBeNull()
  })

  test('★点了旁听之后**仍然**看不到名单与讨论区★（这就是被修掉的提权）', async () => {
    const o = await outsider.post(`/api/activities/${mid}/observe`, { data: {} })
    expect(o.status(), await o.text()).toBe(200)

    // ★缺陷版在这里会返回完整名单★：observe 插的 kind='observer' 行让他被判成 Inside
    const body = await (await outsider.get(`/api/activities/${mid}`)).json()
    expect(body.participants ?? null, '★旁听之后名单仍然不给★').toBeNull()

    // 讨论区同理（Inside 才给）
    const msgs = await outsider.get(`/api/activities/${mid}/messages`)
    expect([403, 404], '★讨论区不给旁听者★').toContain(msgs.status())
  })

  test('★旁听者不能给自己投一票,更不能借 counter 给发起人发站内信★', async () => {
    const before = (await (await organizer.get('/api/me/unread')).json()) as unknown[]
    const r = await outsider.post(`/api/activities/${mid}/respond`, {
      data: {
        status: 'counter',
        counter_starts_at: new Date(Date.now() + 9 * 3600e3).toISOString(),
        counter_ends_at: new Date(Date.now() + 10 * 3600e3).toISOString(),
        counter_reason: '路人也想改期',
      },
    })
    // 缺陷版:200，且发起人收到一条站内信
    expect(r.status(), '★旁听者不在正式名单里,答复必须被拒★').toBe(403)
    const after = (await (await organizer.get('/api/me/unread')).json()) as unknown[]
    expect(after.length, '★发起人不该因为路人的动作收到站内信★').toBe(before.length)
  })

  test('正式参会人照常能看名单、能答复（★证明上面拦的是旁听者,不是把所有人都拦了★）', async () => {
    test.skip(!PEER, '需要 IAH_E2E_PEER(平台上真实存在的第二个账号) —— 拉人要过 Keycloak 校验')
    const inv = await organizer.put(`/api/activities/${mid}/participants`, {
      data: { usernames: [PEER], kind: 'attendee' },
    })
    expect(inv.status(), await inv.text()).toBe(200)

    const body = await (await outsider.get(`/api/activities/${mid}`)).json()
    expect(body.participants, '★被正式邀请后名单就给了★').toBeTruthy()
    expect((await outsider.post(`/api/activities/${mid}/respond`, { data: { status: 'accepted' } })).status()).toBe(200)
  })
})

// ════════ 项目权限：加入即可见 / 离开即失去（D3 / R1）════════
//
// 这一组同样是「只有一个身份」时结构上做不了的：它的全部内容就是「**别人**看不看得到」。
test.describe('权限·加入即可见,离开即失去（D3/R1）', () => {
  test('非成员 404 → 拉进来立刻可见（含加入之前的历史）→ 移出立刻失去', async () => {
    test.skip(!PEER, '需要 IAH_E2E_PEER(平台上真实存在的第二个账号) —— 授权要过 Keycloak 校验')
    const T = tag()
    const owner = await asUser('e2e-owner')
    const guest = await asUser(PEER!)
    try {
      const pid = (await (await owner.post('/api/projects', {
        data: { name: `E2E-D3-项目-${T}`, visibility: 'private' },
      })).json()).id
      // ★先传一份材料,再拉人★ —— R1 要的是「加入即可见**全部历史**」
      const up = await owner.post(`/api/projects/${pid}/upload`, {
        multipart: { file: { name: 'old.txt', mimeType: 'text/plain', buffer: Buffer.from('加入之前就存在的内容') } },
      })
      expect(up.status(), await up.text()).toBe(200)
      const iid = (await up.json()).id

      // ★非成员一律 404 不是 403★（perm.rs 的口径:不泄露存在性）
      expect((await guest.get(`/api/projects/${pid}/items`)).status(), '非成员看不见').toBe(404)
      expect((await guest.get(`/api/items/${iid}`)).status(), '非成员看不见具体条目').toBe(404)

      expect((await owner.put(`/api/projects/${pid}/members`, {
        // ★`MemberIn` 是 `usernames: Vec<String>` 复数数组★（我第一版写成单数 `username` → 422）
        data: { usernames: [PEER], role: 'viewer' },
      })).status()).toBe(200)
      expect((await guest.get(`/api/items/${iid}`)).status(), '★加入即可见,含加入之前的历史★').toBe(200)

      expect((await owner.delete(`/api/projects/${pid}/members?username=${PEER}`)).status()).toBe(200)
      expect((await guest.get(`/api/items/${iid}`)).status(), '★移出即失去全部★').toBe(404)
    } finally {
      await Promise.all([owner.dispose(), guest.dispose()])
    }
  })
})
