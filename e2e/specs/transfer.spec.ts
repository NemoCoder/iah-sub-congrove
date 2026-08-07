// 转移主持人「需对方接受」（v0.4.27，PRD ⑨.5，设计见 docs/TECH-DESIGN-M1-owner-transfer.md）。
//
// ★这一组存在的理由★：这是全系统唯一一处「一个动作要跨两个人才算完成」的流程，
// 中间状态（发起了但没接受）是真正危险的那一格 —— 早一步生效，项目在空档期无主；
// 晚一步生效，交接不算数。中间态没人测，就没人知道它对不对。
//
// ⚠ **单身份的天花板**：E2E 通道现在只有 `e2e` 一个身份（平台注入），
// 所以「对方点接受」这一步在这里**打不出来** —— 我不能同时是发起人和被转让人。
// 能打的是：发起后 owner 不变、pending 出现在详情里、重复发起被拒、撤回、以及各种拒绝路径。
// ★接受路径的覆盖缺口是已知的，不是忘了★：等平台的 X-IAH-E2E-User 多身份头（群里已提），
// 到了就补 `accept` 那条。在那之前它只有 api_cases 的契约描述兜着。
import { expect, test, type APIRequestContext } from '@playwright/test'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

async function newProject(req: APIRequestContext, name: string) {
  const r = await req.post('/api/projects', { data: { name, visibility: 'public' } })
  expect(r.status(), `建项目失败: ${await r.text()}`).toBe(200)
  return (await r.json()).id as number
}

/// 造一个「我是主持人 + 有另一个成员」的项目。
/// 拉的人用固定用户名 `liaoruili`：平台 users/exists 校验真实存在的用户才让加（不能编一个）。
const PEER = process.env.E2E_PEER ?? 'liaoruili'

async function projectWithPeer(req: APIRequestContext, tag: string) {
  const pid = await newProject(req, `E2E-转移-${tag}-${Date.now()}`)
  const r = await req.put(`/api/projects/${pid}/members`, { data: { usernames: [PEER], role: 'editor' } })
  expect(r.status(), `拉人失败: ${await r.text()}`).toBe(200)
  return pid
}

async function ownerOf(req: APIRequestContext, pid: number) {
  const r = await req.get(`/api/projects/${pid}/members`)
  return (await r.json()).owner as string
}

test.describe('转移主持人:发起 ≠ 生效', () => {
  test('★发起后 owner 先不变,pending 出现在详情里★', async ({ request }) => {
    const pid = await projectWithPeer(request, 'T1')
    const before = await ownerOf(request, pid)

    const r = await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })
    expect(r.status(), await r.text()).toBe(200)
    expect((await r.json()).transfer_id).toBeTruthy()

    // ★T1 的全部意义就在这一行★：发起即卸任会让项目在「对方还没点」的整段时间里
    // 没人能加人、没人能改设置，而对方可能永远不点。
    expect(await ownerOf(request, pid)).toBe(before)

    const d = await (await request.get(`/api/projects/${pid}`)).json()
    expect(d.pending_transfer, '详情里要能看到这条待答复的转移').toBeTruthy()
    expect(d.pending_transfer.to).toBe(PEER)
  })

  test('同一项目第二条 pending 被拒(库里唯一索引)', async ({ request }) => {
    const pid = await projectWithPeer(request, 'T2')
    expect((await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })).status()).toBe(200)
    // 并发两条会造成「两个人都以为自己接手了」，而 owner 只有一个
    const second = await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })
    expect(second.status()).toBe(400)
    expect(await second.text()).toContain('已有一条')
  })

  test('撤回后详情里的 pending 消失,可以重新发起', async ({ request }) => {
    const pid = await projectWithPeer(request, 'T3')
    await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })

    const del = await request.delete(`/api/projects/${pid}/transfer`)
    expect(del.status(), await del.text()).toBe(200)
    const d = await (await request.get(`/api/projects/${pid}`)).json()
    expect(d.pending_transfer, '撤回后不该还挂着').toBeNull()

    // 撤回不是「用掉了唯一的一次机会」——手滑转错人之后要能改转给对的人
    expect((await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })).status()).toBe(200)
  })

  test('没有待撤回的转移时 DELETE 返回 400', async ({ request }) => {
    const pid = await projectWithPeer(request, 'T4')
    expect((await request.delete(`/api/projects/${pid}/transfer`)).status()).toBe(400)
  })
})

test.describe('转移主持人:拒绝路径', () => {
  test('不能转给非成员', async ({ request }) => {
    const pid = await newProject(request, `E2E-转移-非成员-${Date.now()}`)
    // ★他接受的瞬间会成为一个自己都进不去的项目的主持人★(T3)
    const r = await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })
    expect(r.status()).toBe(400)
    expect(await r.text()).toContain('成员')
  })

  test('不能转给自己', async ({ request }) => {
    const pid = await projectWithPeer(request, 'self')
    const r = await request.post(`/api/projects/${pid}/transfer`, { data: { to: 'e2e' } })
    expect(r.status()).toBe(400)
  })

  test('★归档项目不能发起转移★', async ({ request }) => {
    const pid = await projectWithPeer(request, 'arch')
    expect((await request.post(`/api/projects/${pid}/archive`, { data: { archived: true } })).status()).toBe(200)
    // 归档 = 只读存档(D17)
    const r = await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })
    expect(r.status()).toBe(400)
    expect(await r.text()).toContain('归档')
  })

  test('没有待答复的转移时 respond 返回 400', async ({ request }) => {
    const pid = await projectWithPeer(request, 'noresp')
    const r = await request.post(`/api/projects/${pid}/transfer/respond`, { data: { accept: true } })
    expect(r.status()).toBe(400)
  })

  test('★不是被转让人不能替他答复★', async ({ request }) => {
    const pid = await projectWithPeer(request, 'notme')
    await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })
    // 我是发起人，不是被转让人 —— 接受主持人是本人才能做的决定，否则「需对方接受」形同虚设
    const r = await request.post(`/api/projects/${pid}/transfer/respond`, { data: { accept: true } })
    expect(r.status()).toBe(403)
    expect(await ownerOf(request, pid)).toBe('e2e')
  })
})

test.describe('待我处理:等我答复的转移', () => {
  test('/api/me/transfers 只列等我答复的', async ({ request }) => {
    const pid = await projectWithPeer(request, 'mine')
    await request.post(`/api/projects/${pid}/transfer`, { data: { to: PEER } })

    const list = await (await request.get('/api/me/transfers')).json()
    expect(Array.isArray(list)).toBe(true)
    // 这条是转给 PEER 的，不是转给我的 —— 不该出现在**我的**待办里
    expect(list.some((t: { project_id: number }) => t.project_id === pid)).toBe(false)
  })
})
