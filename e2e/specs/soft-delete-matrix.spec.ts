// ★删进回收站之后,**每一个**读它的入口都必须闭上★（2026-08-14；审计 I1 的落地）
//
// ══ 它守的是哪次事故 ══
// 软删除是后加的,加的时候只有 `tree`/`precheck` 补了 `deleted_at IS NULL` 过滤,
// 而 `download` / `content_get` / `/play` / `detail` **以及整个公开分享面**全漏了 ——
// 结果是「删进回收站的材料,墙外的公开链接照样列得出、下得到」。v0.3.55 一次补齐 11 处。
// CLAUDE.md 把它立成了硬纪律:★凡是读内容的路径,SQL 都必须带 `deleted_at IS NULL`★。
//
// ══ 为什么不做成「静态检查 SQL 里有没有那句」 ══
// 审计 I1 原本就是这么提的,我照着做了一遍**发现它是枚举橡皮图章**:
// 全仓 73 条读 items 的 SQL 里,不带那句的有 40 条,收窄到「SELECT 且完全没提 deleted_at」
// 还剩 18 条 —— 而这 18 条**逐条看下来全是该读到已删行的**:
//   · 引用计数(不数上回收站里的引用,purge 会删掉还被引用着的 blob = 数据丢失);
//   · 配额(「回收站里的内容仍占用项目配额」是明写的规矩);
//   · 还原时上溯父链、purge 时下推子树;上传中的占位行。
// ★于是这道闸的产出是「18 条豁免、0 个发现」,此后每加一个内部查询还要再盖一次章。★
// 盖章盖成习惯,闸子就废了 —— 而且它守的是**语法**,而事故出在**行为**:
// 一条 SQL 完全可以带着 `deleted_at IS NULL` 却查错了表/走错了分支。
//
// ══ 改成行为矩阵,并且**入口清单从 apidoc.rs 现读** ══
// ★这一条是它比静态检查强的地方★:明天有人加一个新的读 item 的 GET 接口,
// 只要它登记进 `APIS`(本仓已有一条 cargo test 强制「改路由必须同步改那里」),
// 这份矩阵**自动覆盖它**,不依赖任何人记得回来加用例。
//
// ⚠★先证明活着的时候打得通★:否则「删掉之后 404」这条断言可能只是因为
//   那个入口**本来就是坏的/路径拼错了** —— 那样它会一直绿,而且绿得毫无意义。
import { expect, request as pwRequest, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { 每条都留图 } from './_shot'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const 我 = 'e2e-owner'

/// 从 `src/http/apidoc.rs` 里现读所有 `GET /api/items/{id}…` 的入口。
/// ★只取 GET★:POST 里有 `undelete`,它**必须**能对已删的东西起作用。
/// ★只取除 `{id}` 外不再带占位符的★:`/restore/{version_id}` 那种要额外造数据,不在本矩阵。
function 读item的入口(): string[] {
  const src = readFileSync(new URL('../../src/http/apidoc.rs', import.meta.url), 'utf8')
  const out = new Set<string>()
  for (const m of src.matchAll(/"GET",\s*"(\/api\/items\/\{id\}[^"]*)"/g)) {
    const p = m[1]
    if ((p.match(/\{/g) ?? []).length === 1) out.add(p)
  }
  return [...out].sort()
}

test.describe('软删除之后,所有读它的入口都闭上', () => {

  test('★每个 GET /api/items/{id}… 在删除后都必须 404★', async () => {
    test.slow()
    const t = `${Date.now()}`.slice(-6)
    const api = await pwRequest.newContext({
      baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 我 },
    })
    try {
      const 入口 = 读item的入口()
      // ★清单本身要有下限★:正则写坏了会返回空数组,而空数组的 for 循环一次都不进 —— 全绿。
      expect(入口.length, '★从 apidoc.rs 里一个入口都没读出来 —— 正则坏了,这条用例是空跑★')
        .toBeGreaterThanOrEqual(5)

      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-软删矩阵-${t}` } })).json()).id as number
      // ★造两种条目★:入口是**按 kind 分工**的 —— `/content` 只对 `doc` 有意义,
      //   拿一个 .txt 去打它,东西还活着的时候就 404。第一版就这么栽了,
      //   ★而那个 404 会被下一步的「删掉后 404」白捡成绿的★(防呆正是为此)。
      const up = await api.post(`/api/projects/${pid}/upload`, {
        multipart: { file: { name: `E2E-软删-${t}.txt`, mimeType: 'text/plain', buffer: Buffer.from('hello') } },
      })
      expect(up.status(), await up.text()).toBe(200)
      const 文件 = (await up.json()).id as number
      const dr = await api.post(`/api/projects/${pid}/items`,
        { data: { kind: 'doc', name: `E2E-软删文档-${t}`, parent_id: null } })
      expect(dr.status(), await dr.text()).toBe(200)
      const 文档 = (await dr.json()).id as number

      // ① 活着的时候:每个入口至少要有**一种** kind 打得通。★不查这一步,后面的 404 断言就是白捡的★
      const 选中: Record<string, number> = {}
      const 都404: string[] = []
      for (const p of 入口) {
        let 选: number | null = null
        for (const iid of [文件, 文档]) {
          if ((await api.get(p.replace('{id}', String(iid)))).status() !== 404) { 选 = iid; break }
        }
        if (选 == null) 都404.push(p); else 选中[p] = 选
      }
      expect(都404,
        `★这些入口对两种 kind 都是 404 —— 「删掉后 404」在它们身上证明不了任何事★`).toEqual([])

      // ② 删进回收站(两个都删)
      for (const iid of [文件, 文档]) {
        expect((await api.delete(`/api/items/${iid}`)).status(), '删除本身失败,后面全是空跑').toBe(200)
      }

      // ③ 每个入口都必须闭上。★判据是 404 而不是「非 200」★:
      //   share.rs 头注那条 fail-closed 说得很清楚 —— 区分「不存在」和「没权限」本身就是信息。
      const 还开着: string[] = []
      for (const p of 入口) {
        const r = await api.get(p.replace('{id}', String(选中[p])))
        if (r.status() !== 404) 还开着.push(`${p} → ${r.status()}`)
      }
      expect(还开着,
        '★删进回收站的东西,这些入口还读得到 —— 正是 v0.3.55 补的那 11 处的同一个洞★').toEqual([])
    } finally { await api.dispose() }
  })

  test('★公开分享面:删掉之后墙外既列不出也下不到★', async () => {
    // 这一半单列,因为它是**唯一绕过项目授权的出口**(share.rs 头注),
    // 也是当年漏得最狠的一处:项目成员看不到了,而墙外拿着链接的人照样下得到。
    const t = `${Date.now()}`.slice(-6)
    const api = await pwRequest.newContext({
      baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 我 },
    })
    try {
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-软删分享-${t}` } })).json()).id as number
      const fid = (await (await api.post(`/api/projects/${pid}/items`,
        { data: { kind: 'folder', name: `E2E-夹-${t}`, parent_id: null } })).json()).id as number
      const up = await api.post(`/api/projects/${pid}/upload?parent_id=${fid}`, {
        multipart: { file: { name: `E2E-夹内-${t}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') } },
      })
      const iid = (await up.json()).id as number
      const token = (await (await api.post(`/api/items/${fid}/shares`, { data: {} })).json()).token as string
      const 票 = (await (await api.post(`/pub/share/${token}/open`, { data: { code: null } })).json()).ticket as string
      expect(票, '解锁票没拿到').toBeTruthy()

      // 活着时:列得出、下得到（同样先证明这条路本来是通的）
      const 列 = async () => (await (await api.get(`/pub/share/${token}/list?k=${encodeURIComponent(票)}&parent=${fid}`)).json()) as { id: number }[]
      expect((await 列()).some((x) => x.id === iid), '★活着的时候就列不出来,后面证明不了什么★').toBe(true)
      expect((await api.get(`/pub/share/${token}/file/${iid}?k=${encodeURIComponent(票)}`)).status()).toBe(200)

      // 删掉里面那个文件（★链接没撤销、文件夹还在★ —— 这正是当年漏掉的那个形状）
      expect((await api.delete(`/api/items/${iid}`)).status()).toBe(200)
      expect((await 列()).some((x) => x.id === iid),
        '★删进回收站的文件,墙外还列得出来★').toBe(false)
      expect((await api.get(`/pub/share/${token}/file/${iid}?k=${encodeURIComponent(票)}`)).status(),
        '★删进回收站的文件,墙外还下得到 —— v0.3.55 补的就是这一处★').toBe(404)
    } finally { await api.dispose() }
  })

  // ══════════════════════════════════════════════════════════════════
  test('★界面上也够不着:独立查看窗 /viewer/{id} 打不开已删的内容★', async ({ page }) => {
    // liaoruili 2026-08-14:「已经所有都使用 playwright 有头浏览器 进行过验证了吗」——
    // 上面两条验的是 HTTP 404,★那是「接口闭上了」,不是「人在界面上够不着」★。
    // 这条补的正是这一段:`/viewer/{id}` 是**独立查看窗**(video-player 里 window.open 出来的,
    // 可以拖到第二块屏)。它是全站唯一一个★只凭 item id 就能直达内容★的页面 ——
    // 别人把这个链接发给你、或者你自己收藏了,东西删了之后再打开,它必须什么也给不出来。
    test.slow()
    const t = `${Date.now()}`.slice(-6)
    const api = await pwRequest.newContext({
      baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 我 },
    })
    try {
      await page.context().setExtraHTTPHeaders({
        'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': 我 })
      const pid = (await (await api.post('/api/projects', { data: { name: `E2E-查看窗-${t}` } })).json()).id as number
      const 文件名 = `E2E-查看窗-${t}.txt`
      const up = await api.post(`/api/projects/${pid}/upload`, {
        multipart: { file: { name: 文件名, mimeType: 'text/plain', buffer: Buffer.from('这是内容') } },
      })
      expect(up.status(), await up.text()).toBe(200)
      const iid = (await up.json()).id as number

      // ★先证明活着的时候这个窗口是打得开的★ —— 否则「删了打不开」可能只是因为
      //   这个页面本来就坏了/路径拼错了,那样这条用例会一直绿而且毫无意义。
      await page.goto(`/viewer/${iid}`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(文件名).first(),
        '★活着的时候查看窗就打不开 —— 后面「删了打不开」证明不了任何事★')
        .toBeVisible({ timeout: 15_000 })

      // 删进回收站,再用**同一个链接**打开
      expect((await api.delete(`/api/items/${iid}`)).status()).toBe(200)
      await page.goto(`/viewer/${iid}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      await expect(page.getByText(文件名),
        '★删进回收站了,拿着 /viewer 链接还看得到它 —— 内容并没有真的够不着★').toHaveCount(0)
      // 而且不能是一片白:白屏时人会一直刷新,以为是网断了
      const 正文 = (await page.locator('body').textContent()) ?? ''
      expect(正文.trim().length, '★打不开也得说句话,别给一片白屏★').toBeGreaterThan(0)
    } finally { await api.dispose() }
  })
})


// ★每条界面用例都留一张全页图★(见 _shot.ts:他要能逐张看)
每条都留图('软删矩阵')
