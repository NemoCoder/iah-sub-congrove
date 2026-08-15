// ★公开分享的**界面**闭环★（2026-08-13 liaoruili:「还有就是分享连接测试了吗？？？」）
//
// ══ 补这一条之前的覆盖状况 ══
// `safety-net.spec.ts` 里关于分享有 20 处断言 —— ★但全是接口层的★:建链接回没回 token、
// 撤销之后 pub 面回不回 404、提取码错了限不限速。而**人真正走的那条路** ——
// 「拿着链接在浏览器里打开、输提取码、看到内容、点下载」—— 一条用例都没有。
//
// ★这和「建议改期日期选不了」是同一族盲区★:那个功能的接口一直是对的,
// 坏的是界面上那个控件根本选不中 —— 接口测试全绿,而人做不成事。
// 「接口对」和「人能用」是两件事,而只有前者有人守着。
//
// ══ 这条用例的身份安排(重要) ══
// 分享的**全部意义**是「不是项目成员也能看到」——所以判据必须由**外人**来演:
//   · 项目 owner = `e2e-owner`（造数据用,和 teardown 的清扫名单对齐,不留垃圾）
//   · 访客       = 默认身份 `e2e`（对这个项目**没有任何角色**,先用接口证明它确实进不去）
// ⚠★dev 上演不了「完全没登录」★:平台 dev 网关只要收到合法 X-IAH-E2E-Key 就会注入一个身份,
//   不带 key 的请求在**到达 congrove 之前**就被 302 去 Keycloak 了(实测)。
//   所以这里能证的是「**对本项目无权的人**照样打得开」,证不了「浏览器里没有任何会话的人」。
//   ★这是环境的边界,不是判据的偷懒 —— 写出来,免得后人以为这条已经覆盖了匿名访问。★
//   ⚠★别以为 `browser.newContext()` 就是「干净访客」★(2026-08-13 实测推翻):
//     我先前在 ui.spec 里写过一版,注释信誓旦旦写着「用一个全新的、没有任何身份头的
//     上下文 —— 访客就是这样的」,★而 @playwright/test 的 `browser` fixture 创建的上下文
//     **会继承 config 里 use.extraHTTPHeaders**★:探针实测它请求 `/api/me` 回 200 且带身份。
//     那条用例照样绿 —— 因为它**根本没在测它自称在测的东西**。
//     ★注释里的断言也是断言,它同样会撒谎,而且没有任何门禁去核它。★
//     真要验匿名:整条链在网关就断了(不带 key 的 `/s/{token}` 实测 302 去 Keycloak),
//     dev 上做不到,只能等 prod 通道。
//   (前端那一半另有保证:`app.tsx` 的 `sharePageToken()` 在 `/api/me` **之前**就把
//    `/s/{token}` 这条路由劫走,所以未登录也不会被弹去登录。)
import { expect, request as pwRequest, test } from '@playwright/test'
import { 每条都留图 } from './_shot'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const 主 = (who: string) => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who },
})

const 正文 = '这是分享出去的正文。E2E-分享-闭环'

/// ⚠★AntD 给「两个汉字」的按钮自动插一个空格★:页面上是「打 开」不是「打开」。
///   第一次跑就栽在这:`getByRole('button',{name:'打开'})` 等到 90s 超时,
///   ★而失败信息只说「等 button 打开 超时」,看起来像按钮没渲染出来★。
///   acceptance-v05 里早有同一个 `btn()` 助手 —— ★同一个坑在两份 spec 里各踩一次,
///   就是「一条只在一处执行的规矩等于没有规矩」的又一例★。

/// 造一份「项目 + 一个文件 + 一条分享链接」,返回访客要用的东西。
/// ★走接口造前置数据是可以的★(见 acceptance-v05 头注①):判据说的是**访客**能不能用,
/// 分享方那半边由 safety-net 的接口用例守着,这里不重复。
async function 造一条分享(opts: { code?: string; allow_download?: boolean }) {
  const t = `${Date.now()}`.slice(-6)
  const api = await 主('e2e-owner')
  const pr = await api.post('/api/projects', { data: { name: `E2E-分享UI-${t}` } })
  expect(pr.status(), await pr.text()).toBe(200)
  const pid = (await pr.json()).id as number
  const up = await api.post(`/api/projects/${pid}/upload`, {
    multipart: { file: { name: `E2E-分享-${t}.txt`, mimeType: 'text/plain', buffer: Buffer.from(正文) } },
  })
  expect(up.status(), await up.text()).toBe(200)
  const iid = (await up.json()).id as number
  const sh = await api.post(`/api/items/${iid}/shares`, {
    data: { code: opts.code ?? null, allow_download: opts.allow_download ?? true },
  })
  expect(sh.status(), await sh.text()).toBe(200)
  const token = (await sh.json()).token as string
  expect(token, '★没拿到 token,后面全是空跑★').toMatch(/^[0-9a-f]{32}$/)
  return { api, pid, iid, token, 文件名: `E2E-分享-${t}.txt` }
}

test.describe('公开分享·访客界面', () => {

  // ⚠★别用 `page.request`,要用 `request` fixture★(2026-08-13 第一次跑就撞上):
  //   `page.request` 是**远端浏览器那台机器(.14)**上的 Node 发出去的,而内网 CA 只装在
  //   ①本机的 NODE_EXTRA_CA_CERTS ②.14 上 Chromium 的 NSS 库 —— ★偏偏没装在 .14 的 Node 里★,
  //   于是 `unable to verify the first certificate`。★报错看着像证书坏了,其实是「谁发的请求」变了。★
  //   `request` fixture 在本机跑,带的头和页面一样(config 里的 extraHTTPHeaders),
  //   而分享的提取票本来就写在 URL 的 `k=` 里、不依赖浏览器会话 —— 拿它验内容是等价的。
  test('★外人拿链接:输提取码 → 看得到内容 → 下得下来★', async ({ page, request }) => {
    // 这条要走完「建 → 无权确认 → 开页 → 输错 → 输对 → 下载 → 撤销 → 失效」八段
    test.slow()
    const 提取码 = 'k7m2'
    const { api, iid, token, 文件名 } = await 造一条分享({ code: 提取码 })
    try {
      // ① ★先证明访客本来进不去★——否则「他看到了内容」可能只是因为他本来就有权,
      //    这条用例就什么也没证明。(★空断言比不测更坏★,同一族的防呆。)
      const 直取 = await request.get(`/api/items/${iid}/download`)
      expect([401, 403, 404], `★外人竟然直接读得到这个文件(${直取.status()}),分享链接就不是「唯一的门」了★`)
        .toContain(直取.status())

      // ② 打开分享页 —— ★访客不该被弹去登录★(app.tsx 在 /api/me 之前劫走这条路由)
      await page.goto(`/s/${token}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('请输入提取码'), '★分享页没出来,或者被弹去登录了★')
        .toBeVisible({ timeout: 15_000 })
      expect(page.url(), '★跳去 Keycloak 了 = 访客路径根本没生效★').toContain('/s/')

      // ③ 输错的提取码:要给人一句能懂的话,而不是白屏或 404
      await page.getByPlaceholder('提取码').fill('wrong')
      await page.getByRole('button', { name: /打\s*开/ }).click()
      await expect(page.getByText(/提取码不对/), '★错码没给出可重试的提示★').toBeVisible({ timeout: 10_000 })
      // ★仍然停在输入页★:错一次就把人踢到「链接已失效」是不能接受的
      await expect(page.getByPlaceholder('提取码')).toBeVisible()

      // ④ 输对 → 看得到文件名
      await page.getByPlaceholder('提取码').fill(提取码)
      await page.getByRole('button', { name: /打\s*开/ }).click()
      await expect(page.getByText(文件名), '★码对了却没打开★').toBeVisible({ timeout: 15_000 })

      // ⑤ ★下载按钮不只是「在」,点下去得真拿到那份内容★
      //   (只断言按钮可见 = 又一条「点开了 ≠ 里面能用」。)
      const 下载 = page.getByRole('link', { name: /下载/ })
      await expect(下载, '★允许下载的分享上没有下载入口★').toBeVisible()
      const href = await 下载.getAttribute('href')
      expect(href, '下载链接是空的').toBeTruthy()
      // ★取的是页面上那个 href 本身★,不是自己拼的 URL —— 拼出来的一定对,
      //   而「页面给的这条链接对不对」才是这一步要验的东西。
      const 文件 = await request.get(href!)
      expect(文件.status(), await 文件.text()).toBe(200)
      expect(await 文件.text(), '★下下来的内容和原件对不上★').toBe(正文)

      // ⑥ 撤销之后,同一条链接当场变成「已失效」——★这才是撤销的意义★
      const rv = await api.delete(`/api/shares/${token}`)
      expect(rv.status(), await rv.text()).toBe(200)
      await page.goto(`/s/${token}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('链接已失效'), '★撤销了还打得开★').toBeVisible({ timeout: 15_000 })
      // ★撤销之后连「这里曾经有个叫什么的文件」都不该露★:文件名本身就是信息
      //   (share.rs 的整章 fail-closed 就是这个意思 —— 不存在/过期/撤销一律 404 不区分)。
      const 屏 = (await page.locator('body').textContent()) ?? ''
      expect(屏, `★撤销后仍然露出了文件名★`).not.toContain(文件名)
      // 也不能是白屏 —— 白屏时人只会以为网断了,一直刷新
      expect(屏.trim().length, '★撤销后一片白屏★').toBeGreaterThan(0)
    } finally { await api.dispose() }
  })

  test('★链接里带 ?pwd= 就免输码直接开★', async ({ page }) => {
    // 「把码写进链接」是分享对话框里明确提供的一种复制方式,坏了没人会发现 ——
    // 因为另一种(手输)是好的,而两段复制文案长得几乎一样。
    const 提取码 = 'p9q4'
    const { api, token, 文件名 } = await 造一条分享({ code: 提取码 })
    try {
      await page.goto(`/s/${token}?pwd=${提取码}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(文件名), '★带 pwd 的链接没有自动打开★').toBeVisible({ timeout: 15_000 })
      // ★不该再停在输入框上★:自动开了却还显示「请输入提取码」等于没自动
      await expect(page.getByText('请输入提取码')).toHaveCount(0)
    } finally { await api.dispose() }
  })

  test('★禁下载的分享:能看,但不给下载入口★', async ({ page }) => {
    // allow_download=false 是「只让看不让拿」。★这条判据必须由界面来验★:
    // 后端那半边(pub_file 拦不拦)safety-net 里有;界面这半边如果照样给了一个下载链接,
    // 分享者以为自己关上了,实际上没有 —— 而接口测试全绿。
    const { api, token, 文件名 } = await 造一条分享({ allow_download: false })
    try {
      await page.goto(`/s/${token}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(文件名), '★不带提取码的分享该直接打开★').toBeVisible({ timeout: 15_000 })
      await expect(page.getByText(/未开放下载/), '★关了下载却没说明★').toBeVisible()
      await expect(page.getByRole('link', { name: /下载/ }),
        '★分享者关了下载,界面上却还有下载入口★').toHaveCount(0)
    } finally { await api.dispose() }
  })
})


// ★每条界面用例都留一张全页图★(见 _shot.ts:他要能逐张看)
每条都留图('分享访客页')
