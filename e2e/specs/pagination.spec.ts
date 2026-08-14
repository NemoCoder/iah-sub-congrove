// ★五处分页的回归用例★（2026-08-14 liaoruili 定「这个优先」）。
//
// ══ 为什么非要有这一份 ══
// 分页是 v0.4.133~137 分三轮做的,做完只有**实拍截图**守着 —— 而截图不会在 CI 里红。
// 谁把某个 `pagination` 改回 `false`、或者把 `total` 接错,不会有任何人知道。
//
// ══ 判据必须钉在「不吞数据」上,不是「翻页器在不在」★ ══
// 「页面上有个翻页器」是**弱判据**:第 2 页原样显示第 1 页的内容,它照样绿
//   （offset 没接上就是这个症状,而且是分页最常见的写错方式）。
// 所以每条用例都走同一套三段判据:
//   ① ★总数对★ —— total 必须等于真实条数(写死 LIMIT 那个病就是「总数根本没说」);
//   ② ★不重复★ —— 第 2 页不能出现第 1 页的行(offset 真的生效了);
//   ③ ★不丢★  —— 逐页收集起来的**并集 = 全部**(这才是「分页没吞掉东西」的字面意思)。
// ★三段里只有 ③ 真正守住了用户会痛的那件事★:回收站里明明有 600 条,界面只认 500 条,
//   人以为清干净了 —— 那次事故就是 ①③ 同时缺位。
//
// ══ 两类分页,判法一样但入口不同 ══
//   · 后端分页(回收站 / 我的分享):数据会真丢,所以直接打接口验 —— ★接口层能把
//     「第 2 页 = 第 1 页」这种错钉死,而且不必造满一屏 UI 才看得出来★(用 size=2 就够)。
//   · 前端分页(项目文件列表 / 访客分享页 / 项目回收站):后端本来就一条不丢,
//     错只可能错在界面 —— 那就必须**在界面上**数行,造够跨页的数据。
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
/// ★用 teardown 扫得到的身份★(`e2e-owner`),否则这些数据永远留在 dev 上
/// —— 那正是 2026-08-13 修过的那个漂移。
const 我 = 'e2e-owner'
const 接口 = (): Promise<APIRequestContext> => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 我 },
})
const tag = () => `${Date.now()}`.slice(-6)

/// ★页面上的身份必须和造数据的身份是同一个人★（2026-08-14 两条红的共同根因）。
/// config 里只注入了 `X-IAH-E2E-Key`,网关据此给出**默认身份 `e2e`**;而这份 spec 用
/// `e2e-owner` 造数据 —— 于是:
///   · 项目回收站按人分 → 浏览器看的是**另一个人的**回收站,我造的 12 条一条都读不到,
///     判据报「分页把数据吞了」,★而真相是「我在看别人的柜子」★;
///   · 项目列表更直接 → `e2e` 非成员看不见那个项目(D3 一律 404),点不到、90 秒超时,
///     报错只说「Test timeout」,★看起来像页面卡死★。
/// ⚠ 这两条一个报「吞数据」一个报「超时」,症状差得很远,根因是同一句话没写。
async function 开页(page: Page) {
  await page.context().setExtraHTTPHeaders({
    'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 我,
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
}

/// 三段判据里的 ②③:把逐页取到的东西合起来核对。
/// `取一页(n)` 返回那一页的**标识串**(名字/token 都行,只要唯一)。
async function 逐页核对(opts: {
  页数: number, 取一页: (页: number) => Promise<string[]>, 期望: Set<string>, 名: string,
}) {
  const { 页数, 取一页, 期望, 名 } = opts
  expect(页数, `★${名}:造的数据没跨页,这条用例等于没验★`).toBeGreaterThan(1)
  const 见过 = new Set<string>()
  for (let p = 1; p <= 页数; p++) {
    const 本页 = await 取一页(p)
    for (const x of 本页) {
      // ② 不重复 —— 第 2 页原样显示第 1 页 = offset 没接上,这是分页最常见的写错方式
      expect(见过.has(x), `★${名}:第 ${p} 页又出现了前面见过的「${x}」—— offset 没生效★`).toBe(false)
      见过.add(x)
    }
  }
  // ③ 不丢 —— 并集必须盖住我造的全部
  const 漏 = [...期望].filter((x) => !见过.has(x))
  expect(漏, `★${名}:翻遍所有页也没见到 ${漏.length} 条 —— 分页把数据吞了★`).toEqual([])
}

test.describe('分页不吞数据', () => {

  // ── 后端分页 ①:回收站 ──────────────────────────────────────────────
  test('★回收站:total 对、翻页不重不漏★', async () => {
    const t = tag(), api = await 接口()
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-分页-回收站-${t}` } })).json()).id as number
      const 名字 = Array.from({ length: 5 }, (_, i) => `E2E-回-${String(i + 1).padStart(2, '0')}-${t}.txt`)
      for (const n of 名字) {
        const r = await api.post(`/api/projects/${pid}/upload`,
          { multipart: { file: { name: n, mimeType: 'text/plain', buffer: Buffer.from('x') } } })
        expect(r.status(), await r.text()).toBe(200)
        await api.delete(`/api/items/${(await r.json()).id}`)
      }
      // ★用 size=2 逼出多页★:不必造满一屏,判据照样成立 —— 而且页数越多越容易暴露 offset 的错
      const 首 = await (await api.get(`/api/projects/${pid}/trash?page=1&size=2`)).json()
      // ① 总数对。★这一句就是写死 LIMIT 500 那个病的解药★:当年根本没有 total,
      //    于是「看到的就是全部」这个错觉无从证伪。
      expect(首.total, '★回收站的 total 和实际条数对不上★').toBe(5)
      expect(首.items.length, '第一页应当按 size 给 2 条').toBe(2)
      await 逐页核对({
        页数: Math.ceil(5 / 2), 名: '回收站', 期望: new Set(名字),
        取一页: async (p) => ((await (await api.get(`/api/projects/${pid}/trash?page=${p}&size=2`)).json())
          .items as { name: string }[]).map((x) => x.name),
      })
    } finally { await api.dispose() }
  })

  // ── 后端分页 ②:我的分享 ────────────────────────────────────────────
  test('★我的分享:total 对、翻页不重不漏★', async () => {
    // ⚠★这一条守的是安全,不只是体验★:分享是全系统唯一绕过项目授权的出口,
    //   列不出来的分享 = 撤不掉的分享。写死 LIMIT 500 时,第 501 条起就是这个状态。
    const t = tag(), api = await 接口()
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-分页-分享-${t}` } })).json()).id as number
      const up = await api.post(`/api/projects/${pid}/upload`,
        { multipart: { file: { name: `E2E-分享源-${t}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') } } })
      const iid = (await up.json()).id as number
      const 令牌 = new Set<string>()
      for (let i = 0; i < 5; i++) {
        const r = await api.post(`/api/items/${iid}/shares`, { data: {} })
        expect(r.status(), await r.text()).toBe(200)
        令牌.add((await r.json()).token as string)
      }
      const 首 = await (await api.get('/api/shares/mine?page=1&size=2')).json()
      // 这个身份名下可能还有别的分享,所以 total 只能判「至少这么多」
      expect(首.total, '★我的分享的 total 比实际还少 —— 有链接列不出来就撤不掉★')
        .toBeGreaterThanOrEqual(令牌.size)
      await 逐页核对({
        页数: Math.ceil((首.total as number) / 2), 名: '我的分享', 期望: 令牌,
        取一页: async (p) => ((await (await api.get(`/api/shares/mine?page=${p}&size=2`)).json())
          .items as { token: string }[]).map((x) => x.token),
      })
    } finally { await api.dispose() }
  })

  // ── 前端分页 ①:项目文件列表(每页 20)────────────────────────────────
  test('★项目文件列表:界面上翻页不重不漏★', async ({ page }) => {
    test.slow()   // 要造 22 个文件才跨得过 20 一页
    const t = tag(), api = await 接口()
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-分页-文件-${t}` } })).json()).id as number
      const 名字 = new Set<string>()
      for (let i = 1; i <= 22; i++) {
        const n = `E2E-文-${String(i).padStart(2, '0')}-${t}.txt`
        await api.post(`/api/projects/${pid}/upload`,
          { multipart: { file: { name: n, mimeType: 'text/plain', buffer: Buffer.from('x') } } })
        名字.add(n)
      }
      await 开项目(page, `E2E-分页-文件-${t}`)
      await 走遍所有页(page, '.ant-table-row', new RegExp(`E2E-文-\\d+-${t}\\.txt`), '项目文件列表', 名字)
    } finally { await api.dispose() }
  })

  // ── 前端分页 ②:访客分享页(每页 20)──────────────────────────────────
  test('★访客分享页:界面上翻页不重不漏★', async ({ page }) => {
    test.slow()
    const t = tag(), api = await 接口()
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-分页-访客-${t}` } })).json()).id as number
      const fid = (await (await api.post(`/api/projects/${pid}/items`,
        { data: { kind: 'folder', name: `E2E-夹-${t}`, parent_id: null } })).json()).id as number
      const 名字 = new Set<string>()
      for (let i = 1; i <= 22; i++) {
        const n = `E2E-客-${String(i).padStart(2, '0')}-${t}.txt`
        await api.post(`/api/projects/${pid}/upload?parent_id=${fid}`,
          { multipart: { file: { name: n, mimeType: 'text/plain', buffer: Buffer.from('y') } } })
        名字.add(n)
      }
      const token = (await (await api.post(`/api/items/${fid}/shares`, { data: {} })).json()).token as string
      await 开页(page)   // 访客页本身不需要身份,但网关那层要 key(见文件头注)
      await page.goto(`/s/${token}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(`E2E-夹-${t}`).first(), '分享页没打开').toBeVisible({ timeout: 15_000 })
      await 走遍所有页(page, '.ant-table-row', new RegExp(`E2E-客-\\d+-${t}\\.txt`), '访客分享页', 名字)
    } finally { await api.dispose() }
  })

  // ── 前端分页 ③:项目回收站(每页 10)──────────────────────────────────
  test('★项目回收站:界面上翻页不重不漏★', async ({ page }) => {
    test.slow()   // 造 12 个项目再逐个删,本身就要十几秒
    // ★这是**第二个**回收站★(删掉的**项目**,不是项目里删掉的文件)。
    //   2026-08-14 之前它一直没分页,实拍时已经堆到 37 条滚不完 ——
    //   ★「回收站」这个词在界面上有两个入口,我上一轮只改了叫得出名字的那个。★
    const t = tag(), api = await 接口()
    try {
      const 名字 = new Set<string>()
      for (let i = 1; i <= 12; i++) {
        const n = `E2E-删项-${String(i).padStart(2, '0')}-${t}`
        const r = await api.post('/api/projects', { data: { name: n } })
        await api.delete(`/api/projects/${(await r.json()).id}`)
        名字.add(n)
      }
      await 开页(page)
      await page.getByText('项目', { exact: true }).first().click(); await page.waitForTimeout(1500)
      await page.getByRole('button', { name: /回收站 \d+/ }).first().click(); await page.waitForTimeout(1800)
      await 走遍所有页(page, '.ant-drawer .ant-list-item', new RegExp(`E2E-删项-\\d+-${t}`), '项目回收站', 名字)
    } finally { await api.dispose() }
  })
})

// ══════════════════════════════════════════════════════════════════════
async function 开项目(page: Page, 名: string) {
  await 开页(page)
  await page.getByText('项目', { exact: true }).first().click(); await page.waitForTimeout(1500)
  await page.getByText(名).first().click(); await page.waitForTimeout(1800)
}

/// ★一路点「下一页」走遍所有页★,而不是按页码点（2026-08-14 改）。
/// antd 的分页条**只渲染有限几个页码按钮**(实测 6 个),数据一多,第 7 页那个按钮根本不存在 ——
/// 按页码定位会在中间某一页突然点不到,而症状是「后面几页一行都没读到」= 报成「分页吞数据」。
/// ★下一页箭头永远只有一个,且它 disabled 的那一刻就是最后一页★ —— 这是稳定的终止条件,
/// 也正是人翻页的走法。
async function 走遍所有页(page: Page, 行选择器: string, 认: RegExp, 名: string, 期望: Set<string>) {
  // 先退到第一页(可能上一条断言把它留在了别处)
  for (let i = 0; i < 20; i++) {
    const 上 = page.locator('.ant-pagination-prev:not(.ant-pagination-disabled)')
    if (!(await 上.count())) break
    await 上.first().click(); await page.waitForTimeout(500)
  }
  const 页 : string[][] = []
  const 见过 = new Set<string>()
  for (let i = 0; i < 40; i++) {
    const 文 = await page.locator(行选择器).allTextContents()
    // ★只收我这一轮造的行★:库里有别人的数据,混进来会把「不重复」判据误伤
    const 本页 = 文.map((x) => (x.match(认) ?? [])[0]).filter((x): x is string => !!x)
    页.push(本页); 本页.forEach((x) => 见过.add(x))
    // ★找齐自己造的那些就停★(2026-08-14 修:这条用例在项目回收站上 30 秒超时)。
    //   原来是「一路翻到最后一页」—— 而项目回收站里的删除项目**随每轮测试累积**
    //   (实拍时已经 65 个 / 7 页,只会更多),★于是用例的运行时间随残留数据无限增长★。
    //   判据本身只关心「我造的那些有没有被吞、有没有重复」,翻过它们之后再翻下去
    //   是**纯粹的额外功**。早停不削弱任何一条断言:三段判据全都只针对 `期望` 里的东西。
    //   ⚠ 但**至少要翻过两页**,否则「跨页」这个前提就没验到(下面 `页数 > 1` 会红)。
    if (见过.size >= 期望.size && 页.length > 1) break
    const 下 = page.locator('.ant-pagination-next:not(.ant-pagination-disabled)')
    if (!(await 下.count())) break
    await 下.first().click(); await page.waitForTimeout(800)
  }
  await 逐页核对({ 页数: 页.length, 名, 期望, 取一页: async (p) => 页[p - 1] })
}
