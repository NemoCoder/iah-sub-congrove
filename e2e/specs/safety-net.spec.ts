// ★M0 重构的安全网★（2026-08-08 补，只加测试、不碰产品代码）。
//
// 起因：v0.5 的四路同行评审量出来一个数字——现有 50 条 E2E 只覆盖 84 个接口里的 **28 个（33%）**，
// 而**完全没有覆盖**的恰恰是 M0 要动的那几块：
//
//   · 内容 items（17 个接口）—— `items.activity_id → activity_id` 的改名点
//   · 直传 media（5 个）—— 配额预检就在这里
//   · 公开分享（8 个）—— `share.rs` 里 JOIN activities 取活动级 no_share
//   · 超管（4 个）—— 配额接口要被整个替换
//
// ★「行为不变」这个门禁承担不起它现在被赋予的分量★：配额是「钱」、禁下载禁分享是「权」，
// 两者在改名后一旦坏掉，没有任何一条现有测试会红。
//
// ⚠ 这一组**刻意不测 UI**，只打接口：它要在改名前后各跑一遍做对照，
// 而 UI 在 M1 本来就要变，掺进来会让对照失去意义。
import { expect, test, type APIRequestContext } from '@playwright/test'
import { 会议 } from './_presets'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1e4)}`

async function newProject(req: APIRequestContext, name: string, extra: Record<string, unknown> = {}) {
  const r = await req.post('/api/projects', { data: { name, visibility: 'public', ...extra } })
  expect(r.status(), await r.text()).toBe(200)
  return (await r.json()).id as number
}

/// 传一个小文件。★用 multipart★——这条路径（`POST /api/projects/{id}/upload`）是
/// 流式 multipart，与预签名直传是两条不同的路，改名时两条都要验。
async function upload(req: APIRequestContext, pid: number, name: string, body: string, qs = '') {
  const r = await req.post(`/api/projects/${pid}/upload${qs}`, {
    multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(body) } },
  })
  return r
}

/// 项目的已用字节。★只有列表接口回 used_bytes,详情接口不回★——
/// 2026-08-08 我第一版把它写成读 `GET /api/projects/{id}`,拿到的永远是 undefined,
/// 于是「用量要涨」这条断言恒假。**端点名不能凭记忆写**,这一条是它的实证。
async function usedBytes(req: APIRequestContext, pid: number) {
  const list = (await (await req.get('/api/projects')).json()) as { id: number; used_bytes: number }[]
  const row = list.find((x) => x.id === pid)
  expect(row, `项目 ${pid} 不在列表里`).toBeTruthy()
  return row!.used_bytes
}

async function newActivity(req: APIRequestContext, pid: number, extra: Record<string, unknown> = {}) {
  const now = Date.now()
  const r = await req.post('/api/activities', {
    data: {
      type_id: 会议,
      title: `E2E-网-活动-${tag()}`, recorder: 'e2e', project_ids: [pid],
      starts_at: new Date(now + 3600_000).toISOString(),
      ends_at: new Date(now + 7200_000).toISOString(),
      ...extra,
    },
  })
  expect(r.status(), await r.text()).toBe(200)
  return (await r.json()).id as number
}

// ════════ ① 内容：上传 → 下载 → 秒传 → 软删 → 还原 → purge ════════

test.describe('安全网·内容', () => {
  test('★上传后能下载,内容逐字节相同★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-内容-${tag()}`)
    const body = `hello-${tag()}`
    const r = await upload(request, pid, 'a.txt', body)
    expect(r.status(), await r.text()).toBe(200)
    const iid = (await r.json()).id as number

    const dl = await request.get(`/api/items/${iid}/download`)
    expect(dl.status()).toBe(200)
    // ★验内容不只验状态码★：改名改坏 s3_key 的取法时，接口照样 200 但取回的是别的东西
    expect(await dl.text()).toBe(body)
  })

  test('同内容再传一次走秒传,两份都下得到', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-秒传-${tag()}`)
    const body = `dup-${tag()}`
    const a = (await (await upload(request, pid, 'a.txt', body)).json()).id as number
    const b = (await (await upload(request, pid, 'b.txt', body)).json()).id as number
    expect(a).not.toBe(b)
    // 内容寻址：两行指向同一个 blob。★删一个不能影响另一个★——这正是 2026-08-08 修的那个 bug 的核心
    expect(await (await request.get(`/api/items/${a}/download`)).text()).toBe(body)
    expect(await (await request.get(`/api/items/${b}/download`)).text()).toBe(body)
  })

  test('★软删进回收站、还原回来、内容还在★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-回收站-${tag()}`)
    const body = `trash-${tag()}`
    const iid = (await (await upload(request, pid, 'a.txt', body)).json()).id as number

    expect((await request.delete(`/api/items/${iid}`)).status()).toBe(200)
    // 删进回收站之后直链也不该下得到（v0.3.55 一次补了 11 处的那条纪律）
    expect((await request.get(`/api/items/${iid}/download`)).status()).toBe(404)

    expect((await request.post(`/api/items/${iid}/undelete`)).status()).toBe(200)
    expect(await (await request.get(`/api/items/${iid}/download`)).text()).toBe(body)
  })

  test('★删掉一个项目,不影响另一个项目里同内容的文件★', async ({ request }) => {
    // 这条钉的是 2026-08-08 修的缺陷：内容寻址之后 blob 全库共享，
    // 直接 storage.delete 会把别人的文件打空（items 行还在、点开是空的）
    const body = `shared-${tag()}`
    const pa = await newProject(request, `E2E-网-共享A-${tag()}`)
    const pb = await newProject(request, `E2E-网-共享B-${tag()}`)
    const ia = (await (await upload(request, pa, 'a.txt', body)).json()).id as number
    const ib = (await (await upload(request, pb, 'b.txt', body)).json()).id as number

    expect((await request.delete(`/api/projects/${pa}`)).status()).toBe(200)
    const still = await request.get(`/api/items/${ib}/download`)
    expect(still.status(), '★B 项目那份必须还在★').toBe(200)
    expect(await still.text()).toBe(body)
    void ia
  })
})

// ════════ ② 配额（「钱」路径，改名后要整体换算法）════════

// ★M0-6 换算法（ADR-0004）★：额度从「每项目」挪到「每人」，用量算**项目 owner** 名下
// 所有项目之和，同一 owner 内按 blob 去重。PRD 要验 6 条语义，此前只有 1 条 ——
// 下面 5 条是 M0-6 开工前补的（M0-PLAN 写死：★先补测试再改实现★，
// 否则这个 PR 的门禁判定不了它声称判定的东西）。
async function myQuota(req: APIRequestContext) {
  return (await (await req.get('/api/me/quota')).json()) as { quota_bytes: number; used_bytes: number }
}

test.describe('安全网·配额', () => {
  test('用量随上传增长,且回收站里的仍然计入', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-配额-${tag()}`)
    const before = await usedBytes(request, pid)
    const body = 'x'.repeat(5000)
    const iid = (await (await upload(request, pid, 'q.txt', body)).json()).id as number
    const after = await usedBytes(request, pid)
    expect(after, '传完用量要涨').toBe(before + body.length)

    await request.delete(`/api/items/${iid}`)
    // ★回收站仍然计入★：占着盘就该算（v0.4 明确定过，M0 的配额改造最容易在这里改错）
    expect(await usedBytes(request, pid), '删进回收站后用量不该掉').toBe(after)
  })

  test('★按 owner 汇总他名下所有项目★', async ({ request }) => {
    const a = await newProject(request, `E2E-网-额度A-${tag()}`)
    const b = await newProject(request, `E2E-网-额度B-${tag()}`)
    const before = (await myQuota(request)).used_bytes
    await upload(request, a, 'a.txt', 'a'.repeat(3000))
    await upload(request, b, 'b.txt', 'b'.repeat(4000))
    // ★两个项目的占用要加在同一个人头上★ —— 不是各算各的
    expect((await myQuota(request)).used_bytes, '两个项目的用量没汇总到 owner 头上').toBe(before + 7000)
  })

  test('★同一 owner 内按 blob 去重,只算一份★', async ({ request }) => {
    const a = await newProject(request, `E2E-网-去重A-${tag()}`)
    const b = await newProject(request, `E2E-网-去重B-${tag()}`)
    const same = 'dedup'.repeat(1000)   // 5000 字节，同一份内容
    const before = (await myQuota(request)).used_bytes
    await upload(request, a, 'same.txt', same)
    const mid = (await myQuota(request)).used_bytes
    await upload(request, b, 'same.txt', same)
    // 内容寻址让同内容全库只存一份；同一个人放进两个项目还算两遍 = 收他没花的钱
    expect(mid, '第一次传要涨').toBe(before + same.length)
    expect((await myQuota(request)).used_bytes, '★同一个人的同一份内容算了两遍★').toBe(mid)
  })

  test('★版本历史计入★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-版本-${tag()}`)
    // ⚠★建**文档**而不是传文件★：版本历史(item_versions)是文档保存时产生的。
    // ⚠★入参是 `text` 不是 `content`★ —— 第一版我按直觉写了 `content`，
    //   于是 PUT 静默什么都没改、用量不涨，测试红了却指向「算法漏了版本历史」。
    //   ★`docs/openapi.json` 里写着 `text, label`，我手边就有却没查。★
    //   (和 2026-08-08「安全网端点全是编的」是同一类错:凭直觉写接口形状。)
    const doc = await request.post(`/api/projects/${pid}/items`, { data: { name: 'v.md', kind: 'doc' } })
    const iid = (await doc.json()).id as number
    await request.put(`/api/items/${iid}/content`, { data: { text: 'v1'.repeat(500) } })
    const one = (await myQuota(request)).used_bytes
    expect(one, '文档存完要占用量').toBeGreaterThan(0)
    // 改一次内容 → 旧版进 item_versions，两份都占盘，都该算
    await request.put(`/api/items/${iid}/content`, { data: { text: 'v2'.repeat(900) } })
    expect((await myQuota(request)).used_bytes, '历史版本没被计入 = 用户能靠反复改版白嫖').toBeGreaterThan(one)
  })

  test('★半截直传不计★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-半截-${tag()}`)
    const before = (await myQuota(request)).used_bytes
    // begin 只建占位行（s3_key 为空），没 complete 就不该占额度
    const r = await request.post(`/api/projects/${pid}/media/begin`, {
      data: { name: 'big.bin', size: 12345, mime: 'application/octet-stream', parts: 1 },
    })
    expect([200, 501]).toContain(r.status())   // 501 = 平台没开直传，跳过判定
    if (r.status() === 200) {
      expect((await myQuota(request)).used_bytes, '半截直传就开始占额度 = 取消一次就白扣').toBe(before)
    }
  })

  test('★新用户没有 user_quota 行时走系统默认,不是 0★', async ({ request }) => {
    // e2e 这个账号从没被超管调过额度 → user_quota 里没有它的行
    const q = await myQuota(request)
    expect(q.quota_bytes, '没有 quota 行时额度算成了 0 = 新用户一上来就超额').toBeGreaterThan(0)
    expect(q.quota_bytes, '默认额度应当是 10GiB').toBe(10737418240)
  })
})

// ════════ ③ 材料策略：禁下载 / 禁分享（「权」路径）════════

test.describe('安全网·材料策略', () => {
  test('★活动设了禁下载,材料就下不了(在线预览不拦)★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-禁下载-${tag()}`)
    const mid = await newActivity(request, pid)
    const iid = (await (await upload(request, pid, 'm.txt', 'secret', `?activity_id=${mid}`)).json()).id as number
    expect((await request.get(`/api/items/${iid}/download`)).status(), '设之前下得到').toBe(200)

    expect((await request.put(`/api/activities/${mid}`, { data: { no_download: true } })).status()).toBe(200)
    expect((await request.get(`/api/items/${iid}/download`)).status(), '★设之后下不了★').toBe(400)
    // 判据是 items JOIN activities —— 改名时这条 JOIN 一旦写错，闸就静默失效
    expect((await request.get(`/api/items/${iid}`)).status(), '详情仍可看').toBe(200)
  })

  test('★活动设了禁分享,建不了公开链接★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-禁分享-${tag()}`)
    const mid = await newActivity(request, pid)
    const iid = (await (await upload(request, pid, 'm.txt', 'secret', `?activity_id=${mid}`)).json()).id as number
    expect((await request.post(`/api/items/${iid}/shares`, { data: {} })).status(), '设之前建得了').toBe(200)

    expect((await request.put(`/api/activities/${mid}`, { data: { no_share: true } })).status()).toBe(200)
    const r = await request.post(`/api/items/${iid}/shares`, { data: {} })
    expect(r.status(), '★设之后后端必须拒★——前端隐藏不是安全边界').toBe(400)
  })

  test('★项目设了禁分享,也建不了(2026-08-08 修的缺陷)★', async ({ request }) => {
    const name = `E2E-网-项目禁分享-${tag()}`
    const pid = await newProject(request, name)
    const iid = (await (await upload(request, pid, 'p.txt', 'x')).json()).id as number
    expect((await request.post(`/api/items/${iid}/shares`, { data: {} })).status()).toBe(200)

    // ★`ProjectIn.name` 没有 `#[serde(default)]` = 必填★:只发 `{no_share:true}` 会反序列化失败,
    // 拿到的是 422 而不是 200。2026-08-08 我第一版就漏了 name,这条断言当场红。
    const pu = await request.put(`/api/projects/${pid}`, { data: { name, no_share: true } })
    expect(pu.status(), await pu.text()).toBe(200)
    // 此前这道闸只在「打开开关那一刻」撤销存量链接，之后照样能建新的
    const r = await request.post(`/api/items/${iid}/shares`, { data: {} })
    expect(r.status(), '★开着的开关必须真的挡住新链接★').toBe(400)
  })
})

// ════════ ④ 公开分享的访客面（唯一绕过项目授权的出口）════════
//
// ⚠ ★2026-08-08 的教训:这一组第一版全部打错了端点★。我凭记忆写了 `/api/s/{token}`
//   与 `/api/shares`,而真实路由是 `/pub/share/{token}`(访客面,`mod.rs` 里 **不挂 require_auth**
//   的那个 nest)与 `/api/shares/mine`。打错的后果不只是红——
//   ★`GET /api/s/xxx` 会被前端 SPA 的兜底路由接走、回 200 + index.html★,
//   于是「访客拿得到内容」那条**绿了,而且绿得毫无意义**。
//   ★假绿比红危险得多★:红会被人看见,假绿会一直冒充覆盖率。
//   所以这一组的每条断言都不只看状态码,还看**响应体里的业务字段**——HTML 兜底页不可能有它们。
const PUB = (token: string) => `/pub/share/${token}`

test.describe('安全网·公开分享', () => {
  test('无提取码的链接:访客拿得到内容', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-分享-${tag()}`)
    const body = `pub-${tag()}`
    const iid = (await (await upload(request, pid, 's.txt', body)).json()).id as number
    const s = await request.post(`/api/items/${iid}/shares`, { data: {} })
    expect(s.status(), await s.text()).toBe(200)
    const token = (await s.json()).token as string

    const meta = await request.get(PUB(token))
    expect(meta.status(), '★访客面不需要登录也不需要项目成员身份★').toBe(200)
    // ★验业务字段★:只看 200 的话,SPA 兜底页也是 200
    expect((await meta.json()).needs_code, '访客面应当回 JSON 元信息').toBe(false)
  })

  test('★撤销之后一律 404,不区分「不存在」与「已撤销」★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-撤销-${tag()}`)
    const iid = (await (await upload(request, pid, 's.txt', 'x')).json()).id as number
    const token = (await (await request.post(`/api/items/${iid}/shares`, { data: {} })).json()).token as string
    expect((await request.get(PUB(token))).status()).toBe(200)

    const list = (await (await request.get('/api/shares/mine')).json()) as { token: string }[]
    expect(list.find((x) => x.token === token), '「我的分享」里应当列得出来').toBeTruthy()
    // ★撤销按 token 不按行 id★(`DELETE /api/shares/{token}`)
    expect((await request.delete(`/api/shares/${token}`)).status()).toBe(200)

    // 区分「不存在」和「已撤销」就等于给了一个探测工具（share.rs 头注的 fail-closed）
    expect((await request.get(PUB(token))).status()).toBe(404)
    expect((await request.get(PUB('deadbeef00000000deadbeef00000000'))).status(), '不存在的也是 404,两者不可区分').toBe(404)
  })

  test('★删进回收站的材料,墙外的链接也取不到★', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-分享软删-${tag()}`)
    const iid = (await (await upload(request, pid, 's.txt', 'x')).json()).id as number
    const token = (await (await request.post(`/api/items/${iid}/shares`, { data: {} })).json()).token as string
    expect((await request.get(PUB(token))).status()).toBe(200)

    await request.delete(`/api/items/${iid}`)
    // v0.3.55 一次补了 11 处的那条纪律，整个公开分享面当时全漏了
    expect((await request.get(PUB(token))).status(), '★删了就不该再取得到★').toBe(404)
    // 链接本身没被撤销,只是内容没了 —— 「我的分享」里应当标出来(item_deleted),否则用户不知道链接为什么废了
    const mine = (await (await request.get('/api/shares/mine')).json()) as { token: string; item_deleted?: boolean }[]
    expect(mine.find((x) => x.token === token)?.item_deleted, '「我的分享」要标出内容已删').toBe(true)
  })
})

// ════════ ⑤ 活动材料区与纪要（items.activity_id 的改名点）════════

test.describe('安全网·活动材料与纪要', () => {
  test('带 activity_id 传的材料出现在活动材料区,录制单列', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-活动材料-${tag()}`)
    const mid = await newActivity(request, pid)
    await upload(request, pid, 'doc.txt', 'a', `?activity_id=${mid}`)
    await upload(request, pid, 'rec.txt', 'b', `?activity_id=${mid}&is_recording=true`)

    const items = await (await request.get(`/api/activities/${mid}/items`)).json() as { is_recording: boolean }[]
    expect(items.length).toBe(2)
    // ★录制 ≠ 材料★（D5）：只有录制会被转写、并作为活动时长依据
    expect(items.filter((i) => i.is_recording).length).toBe(1)
  })

  test('纪要:没写时回空而不是 404,写了能读回来', async ({ request }) => {
    const pid = await newProject(request, `E2E-网-纪要-${tag()}`)
    const mid = await newActivity(request, pid)
    const empty = await request.get(`/api/activities/${mid}/minutes`)
    expect(empty.status(), '★前端不该为「还没写」判 404★').toBe(200)

    const text = `决议-${tag()}`
    expect((await request.put(`/api/activities/${mid}/minutes`, {
      data: { content_md: text, status: 'draft' },
    })).status()).toBe(200)
    const got = await (await request.get(`/api/activities/${mid}/minutes`)).json()
    expect(got.minutes?.content_md).toBe(text)
  })
})

// ════════ ⑥ `is_private` 的四个组合（★M0 要换定义，这是那条语义的守卫★）════════
//
// ⚠ ★为什么这条必须是**直接断言**，而不是靠 golden 的 diff 白名单★（2026-08-08 实测教训）：
//
// M0 要把 is_private 从「所有关联项目都不 public」换成「活动自己 visibility != public」（PRD J4）。
// 我一开始想靠 golden 指纹的 diff 白名单守它，做了两轮都失败：
//   · 第一轮：fixture 只有一种组合 → 判反时**根本不产生 diff**（旧值与判反值恰好相同）；
//   · 第二轮：补齐四个组合，白名单写 `{from:false,to:true}` / `{from:true,to:false}`
//     —— 判反产生的两条变化**数值一模一样**，只是落在不同的行上，照样被白名单核销。
// 根因是结构性的：指纹摊平成 `…<of>.<下标>.is_private` 之后，
// ★`visibility` 与 `is_private` 在同一行里的关联就丢了★，而「判反」恰恰只体现在这个关联上。
//
// 所以分工是：**golden 抓意料之外的变化；已知的语义变更由这里的具名断言守。**
// 下面这条现在断言的是**旧定义**（它现在必须是绿的）。M0-3 换定义时，
// 实现者必须**有意识地**把期望值改成新定义 —— 那一刻判反就会当场变红。
test.describe('安全网·is_private 语义', () => {
  // ★2026-08-08 M0-1 换定义（PRD J4）★：从「所有关联项目都不 public」
  // 改成「**活动自己的** visibility 不是 public」。四个组合的期望值因此变成：
  //   项目 public + 活动 private → 旧 false / ★新 true★
  //   项目 private + 活动 public → 旧 true  / ★新 false★
  // 另两个组合新旧同值 —— ★所以只造那两个是抓不住「判反」的，四个都要留★
  //（这一课是 2026-08-08 实测得出的：前两个组合恰好是「旧定义」与「判反的新定义」
  //  结果重合的组合。）
  //
  // ⚠ 项目那一列**保留但已无语义**：`projects.visibility` M0-1 已删，
  //   `newProject` 传它等于空操作。留着是为了证明★项目可见性不再影响 is_private★ ——
  //   同一个活动可见性下，两种项目必须给出同一个值。
  const COMBOS = [
    { proj: 'public' as const, act: 'private' as const, want: true },
    { proj: 'private' as const, act: 'public' as const, want: false },
    { proj: 'private' as const, act: 'private' as const, want: true },
    { proj: 'public' as const, act: 'public' as const, want: false },
  ]

  test('★四个组合逐个对★（新定义 = 活动自己的 visibility）', async ({ request }) => {
    const from = new Date(Date.now() - 864e5).toISOString()
    const to = new Date(Date.now() + 30 * 864e5).toISOString()
    for (const c of COMBOS) {
      const pid = await newProject(request, `E2E-网-isp-${c.proj}-${tag()}`, { visibility: c.proj })
      const mid = await newActivity(request, pid, { visibility: c.act })
      const list = (await (await request.get(`/api/activities?from=${from}&to=${to}`)).json()) as
        { id: number; is_private: boolean }[]
      const row = list.find((m) => m.id === mid)
      expect(row, `活动 ${mid} 应当在日历里`).toBeTruthy()
      expect(
        row!.is_private,
        `项目=${c.proj} 活动=${c.act} 时 is_private 应当是 ${c.want}`,
      ).toBe(c.want)
    }
  })
})
