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

/// ★造一段**这一轮独有**、长度精确为 n 的内容★（2026-08-12）。
///
/// ⚠ 配额那几条用例原来用的是固定内容（`'a'.repeat(3000)`），而它们断言的是**增量**
/// （「传 3000 字节，用量涨 3000」）。一旦库里躺着一份**内容相同**的旧文件，
/// 新上传就走内容寻址秒传 → 用量一个字节都不涨 → 用例红。
/// ★而那时产品是**对的**：它正确地去重了；错的是用例假设了一个干净的库。★
/// 这一晚就是这么被打穿的：反复跑 E2E 攒下 180 多个残留项目，
/// 里面全是 `'a'.repeat(3000)`。
///
/// 把 tag 拌进内容里，novelty 就由用例自己保证，不再依赖「库是干净的」这个前提。
const 独有内容 = (n: number, seed = tag()) => (seed + 'x'.repeat(n)).slice(0, n)


async function newProject(req: APIRequestContext, name: string, extra: Record<string, unknown> = {}) {
  const r = await req.post('/api/projects', { data: { name, visibility: 'public', ...extra } })
  expect(r.status(), await r.text()).toBe(200)
  return (await r.json()).id as number
}

/// 传一个小文件。★用 multipart★——这条路径（`POST /api/projects/{id}/upload`）是
/// 流式 multipart，与预签名直传是两条不同的路，改名时两条都要验。
async function upload(req: APIRequestContext, pid: number, name: string, body: string, qs = '', mime = 'text/plain') {
  const r = await req.post(`/api/projects/${pid}/upload${qs}`, {
    multipart: { file: { name, mimeType: mime, buffer: Buffer.from(body) } },
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
    await upload(request, a, 'a.txt', 独有内容(3000))
    await upload(request, b, 'b.txt', 独有内容(4000))
    // ★两个项目的占用要加在同一个人头上★ —— 不是各算各的
    expect((await myQuota(request)).used_bytes, '两个项目的用量没汇总到 owner 头上').toBe(before + 7000)
  })

  test('★同一 owner 内按 blob 去重,只算一份★', async ({ request }) => {
    const a = await newProject(request, `E2E-网-去重A-${tag()}`)
    const b = await newProject(request, `E2E-网-去重B-${tag()}`)
    // ★同一份内容、但这一轮独有★：要测的是「同内容只算一份」，
    //   所以两次上传必须**彼此相同**，同时**与库里已有的都不同**。
    const same = 独有内容(5000)
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
    const 一稿 = 独有内容(1000)
    await request.put(`/api/items/${iid}/content`, { data: { text: 一稿 } })
    const one = (await myQuota(request)).used_bytes
    expect(one, '文档存完要占用量').toBeGreaterThan(0)
    // 改一次内容 → 旧版进 item_versions，两份都占盘，都该算
    await request.put(`/api/items/${iid}/content`, { data: { text: 独有内容(1800) } })
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

    // ⚠★响应体是 {total, items} 不是数组★(v0.4.136 加分页时改的):原来后端写死 `LIMIT 500`
    //   不给总数,第 501 条起在「我的分享」里看不见也**撤不掉** —— 而分享是全系统唯一
    //   绕过项目授权的出口,撤不掉的分享是安全问题。
    const list = (await (await request.get('/api/shares/mine')).json()) as { total: number; items: { token: string }[] }
    expect(list.items.find((x) => x.token === token), '「我的分享」里应当列得出来').toBeTruthy()
    expect(list.total, '★分页必须带 total★:没有它,界面就不知道自己看到的是不是全部').toBeGreaterThan(0)
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
    const mine = (await (await request.get('/api/shares/mine')).json()) as { items: { token: string; item_deleted?: boolean }[] }
    expect(mine.items.find((x) => x.token === token)?.item_deleted, '「我的分享」要标出内容已删').toBe(true)
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

// ════════ ⑤ 出口闸：内容离开受限范围的四条路（2026-08-15 对抗检查）════════
//
// 这一组的四条用例对应同一类缺陷：★「禁止下载」这个开关有四个侧门★，
// 每一个都不报错、不留痕，界面上照样写着「禁止下载」。
// ⚠ 共同的判据：**闸要判服务端算出来的事实，不能判调用方自己报的意图**。

/// 建一条分享链接并**解锁**,返回访客面要用的 (token, 票)。
///
/// ⚠★访客面每个接口的 `k`(解锁票)是**必填**★ —— 少了它拿到的是
///   `400 Failed to deserialize query string: missing field \`k\``,
///   **和「这条闸拒绝了你」长得一模一样**(都是 400)。
///   2026-08-15 我写下面那条 zip 用例时就漏了 `k`:于是它在**没修产品代码的线上**照样绿,
///   ★它绿的原因是参数没填对,跟被测的那道闸一点关系都没有★。
///   暴露它的是紧随其后那条「txt 仍然看得到」——同一条路、同样没填 `k`,却断言 200,当场红。
///   ⇒ ★一组只会「拒绝」的用例证明不了闸在工作:必须配一条「正常情况要成功」的对照★,
///     否则「整条路根本没打通」与「闸判对了」在断言层面无法区分。
/// ⚠ 票在 `open` 的响应里叫 `ticket`,在查询串里叫 `k`,两个名字不一样。
async function 分享并解锁(req: APIRequestContext, iid: number, allow_download: boolean) {
  const s = await req.post(`/api/items/${iid}/shares`, { data: { allow_download } })
  expect(s.status(), await s.text()).toBe(200)
  const token = (await s.json()).token as string
  const o = await req.post(`/pub/share/${token}/open`, { data: {} })
  expect(o.status(), await o.text()).toBe(200)
  const k = (await o.json()).ticket as string
  expect(k, '拿不到解锁票的话,下面测的就不是那道闸了').toBeTruthy()
  return { token, k }
}

test.describe('安全网·出口闸', () => {
  test('★禁下载的分享:`?inline=1` 不能把非预览类型偷下来★', async ({ request }) => {
    const pid = await newProject(request, `E2E-闸-分享inline-${tag()}`)
    // ★类型要选**不可 inline 预览**的★:zip / octet-stream。text/plain 在白名单里,
    //   拿它测这条会绿得毫无意义(它本来就该 inline 放行)。
    const body = `zip-${tag()}`
    const iid = (await (await upload(request, pid, 'a.zip', body, '', 'application/zip')).json()).id as number
    // ★先证明前提成立★:整条用例立在「这份内容的 mime 不在 inline 白名单里」之上。
    //   服务端若没采信我声明的 mime(比如按扩展名另判),下面那条断言就成了空话。
    expect((await (await request.get(`/api/items/${iid}`)).json()).mime,
      '前提:mime 必须真的是 application/zip').toBe('application/zip')
    const { token, k } = await 分享并解锁(request, iid, false)

    const r = await request.get(`/pub/share/${token}/file/${iid}?k=${k}&inline=1`)
    expect(r.status(), '★带 inline=1 也必须拒★——闸判的是服务端算出的 disposition').toBe(400)
    // 验它不是「拒了但把内容一起发了」:响应体里不能出现原文
    expect(await r.text()).not.toContain(body)
    // 反向:不带 inline 本来就该拒(防止上面那条因为别的原因红而看不出来)
    expect((await request.get(`/pub/share/${token}/file/${iid}?k=${k}`)).status()).toBe(400)
  })

  test('禁下载的分享:白名单类型仍然看得见(★这条是上一条的对照组★)', async ({ request }) => {
    const pid = await newProject(request, `E2E-闸-分享可读-${tag()}`)
    const body = `txt-${tag()}`
    const iid = (await (await upload(request, pid, 'a.txt', body)).json()).id as number
    const { token, k } = await 分享并解锁(request, iid, false)
    const r = await request.get(`/pub/share/${token}/file/${iid}?k=${k}&inline=1`)
    // ★这条一红,上一条的绿就作废★:说明整条访客路没打通,而不是闸判对了。
    expect(r.status(), 'text/plain 在 inline 白名单里,禁下载也该看得到').toBe(200)
    expect(r.headers()['content-disposition'] ?? '', 'disposition 必须是 inline').toContain('inline')
    expect(await r.text(), '看得到 = 内容真的发出来了').toContain(body)
  })

  test('★禁下载的材料:不能靠「复制到别的项目」洗掉限制★', async ({ request }) => {
    const 源 = await newProject(request, `E2E-闸-复制源-${tag()}`)
    const 目标 = await newProject(request, `E2E-闸-复制靶-${tag()}`)
    const mid = await newActivity(request, 源)
    const iid = (await (await upload(request, 源, 'm.txt', `c-${tag()}`, `?activity_id=${mid}`)).json()).id as number
    // 设限之前复制得动 —— 证明这条用例测的是「限制生效」,不是「复制这个功能本来就不通」
    const 先 = await request.post(`/api/items/${iid}/copy`, { data: { project_id: 目标 } })
    expect(先.status(), await 先.text()).toBe(200)

    expect((await request.put(`/api/activities/${mid}`, { data: { no_download: true } })).status()).toBe(200)
    const r = await request.post(`/api/items/${iid}/copy`, { data: { project_id: 目标 } })
    expect(r.status(), '★设限之后必须拒★:副本落在别人自己的项目里,他在那儿是 admin,限制就没了').toBe(400)
  })

  test('★禁**分享**的材料,同样不能靠复制洗掉★', async ({ request }) => {
    // no_download 与 no_share 是两个开关,闸是一句 `OR` —— 只测其中一个,
    // 另一个漏掉时不会有任何用例红(2026-08-15 第一版就只测了 no_download)。
    const 源 = await newProject(request, `E2E-闸-复制禁分享源-${tag()}`)
    const 目标 = await newProject(request, `E2E-闸-复制禁分享靶-${tag()}`)
    const mid = await newActivity(request, 源)
    const iid = (await (await upload(request, 源, 'm.txt', `c-${tag()}`, `?activity_id=${mid}`)).json()).id as number
    expect((await request.put(`/api/activities/${mid}`, { data: { no_share: true } })).status()).toBe(200)
    const r = await request.post(`/api/items/${iid}/copy`, { data: { project_id: 目标 } })
    expect(r.status(), '复制到自己的项目再发公开链接,是绕过 no_share 的第二条路').toBe(400)
  })

  test('★禁下载的活动:/play 不能发不记名的预签名直链★', async ({ request }) => {
    const pid = await newProject(request, `E2E-闸-play-${tag()}`)
    const mid = await newActivity(request, pid)
    // kind=video 由 mime 判定;/play 只对 video 放行
    const iid = (await (await upload(request, pid, 'v.mp4', `mp4-${tag()}`, `?activity_id=${mid}`, 'video/mp4')).json()).id as number
    const 前 = await request.get(`/api/items/${iid}/play`, { maxRedirects: 0 })
    expect(前.status(), '设之前是 302 到预签名直链').toBe(302)

    expect((await request.put(`/api/activities/${mid}`, { data: { no_download: true } })).status()).toBe(200)
    const r = await request.get(`/api/items/${iid}/play`, { maxRedirects: 0 })
    // ★不是「不许播」而是「不许发直链」★:开关的原话是「能看但不能下」
    expect([200, 206], `★设之后不能再 302★(拿到的是 ${r.status()})`).toContain(r.status())
    expect(r.headers()['location'], '★一条 location 都不能有★——直链一旦发出去就不记名了').toBeUndefined()
    expect(r.headers()['accept-ranges'], '同源代理必须支持 Range,否则进度条拖不动').toBe('bytes')
  })

  test('★纪要定稿后,改一个字段不能把它打回草稿★', async ({ request }) => {
    const pid = await newProject(request, `E2E-闸-纪要-${tag()}`)
    const mid = await newActivity(request, pid)
    expect((await request.put(`/api/activities/${mid}/minutes`, { data: { status: 'done', content_md: '甲' } })).status()).toBe(200)

    // 前端是**逐字段保存**的:改一下参会人就 PUT 一次,身上不带 status
    const r = await request.put(`/api/activities/${mid}/minutes`, { data: { attendees: '张三' } })
    expect(r.status(), await r.text()).toBe(200)
    expect((await r.json()).status, '★不传 status = 保持原样★').toBe('done')

    const m = await (await request.get(`/api/activities/${mid}/minutes`)).json()
    expect(m.minutes.status, '库里也得还是 done').toBe('done')
    expect(m.minutes.completed_at, '★定稿时间不能被清掉★').toBeTruthy()
    expect(m.minutes.content_md, '没传的字段照旧保留').toBe('甲')

    // 反向:显式传 draft 才撤稿(否则上面那条可能只是「status 根本改不动」)
    const back = await request.put(`/api/activities/${mid}/minutes`, { data: { status: 'draft' } })
    expect((await back.json()).status).toBe('draft')
  })
})
