// 门禁行为验证 —— ★这一组故意**不依赖** E2E key★,它验的就是「没有 key 时该被拦住」。
//
// 为什么先写这个而不是先写功能测试:E2E 通道是一条**真实的身份旁路**,
// 上线前必须先确认它没有把不该开的口子一起开了。
//
// ★2026-08-07 实跑校正了我两个错误假设,记在这里免得下次再踩★:
//   ① Playwright 的 `maxRedirects: 0` 遇到重定向是**抛异常**,不是返回 302 响应对象。
//      要断言「被重定向走了」,改成跟随重定向后看 `r.url()` 落在哪个域。
//   ② ★dev 通道下 `/healthz` 也被网关拦★——整个域名都在 SSO 门禁后,
//      没有「开放端点」这回事。我原以为探针是放行的,实测是 302 到 Keycloak。
//      (k8s 的存活/就绪探针走 pod 内部直连、不经网关,所以不受影响,不用改子系统。)
//      **推论:没有 E2E key,Playwright 一个页面都测不了**,这不是配置问题,是设计如此。
import { expect, test } from '@playwright/test'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KC = 'auth.ruciah.com'

/// 「这个请求有没有被拦住」——★判据是没进到应用,不是某个具体状态码★。
/// 网关有两种拒绝方式,都算拦住:落回 SSO 路由 → 302 跳 Keycloak;走 E2E 路由但 key 不对 → 403。
const blocked = (status: number, url: string) => url.includes(KC) || status === 403 || status === 401

test.describe('dev 门禁', () => {
  // 这一组自己控制 header,不要配置里那把真 key
  test.use({ extraHTTPHeaders: {} })

  test('不带 E2E key 访问首页 → 被平台网关拦去 Keycloak', async ({ request }) => {
    const r = await request.get(`${BASE}/`)
    // 跟随重定向后应当落在 Keycloak 的登录页,而不是 congrove 自己。
    expect(r.url(), '未带 key 却进了应用 = 门禁失效').toContain(KC)
  })

  test('带一把伪造的 E2E key → 仍被拦住', async ({ request }) => {
    const r = await request.get(`${BASE}/`, {
      // ★header 值必须是 ASCII★:写中文的话 Node 直接抛 "Invalid character in header content",
      // 请求根本发不出去 —— 于是这条测试会以一个**与安全无关**的理由失败(我 2026-08-07 踩过,
      // curl 放行了同样的值,所以先入为主以为没问题)。
      headers: { 'X-IAH-E2E-Key': 'e2e_forged-key-must-not-pass' },
    })
    // ★这条是这一组里最重要的★:Traefik 的路由按 header **存在性**匹配、真值在 forwardAuth 里比,
    // 所以「带了这个头就放行」是一种很容易写出来的实现错误。它必须被拦。
    //
    // ⚠ **别把「被拦」写死成某个具体状态码**(我 2026-08-07 就这么写红过一次):
    // 平台修好路由前,伪造 key 落回 SSO 路由 → 302 跳 Keycloak;
    // 修好之后走 E2E 路由、forwardAuth 拒掉 → **403**。两者都是「被拦住」,
    // 而这条用例要守的是**没被放行**,不是某种拒绝方式。
    expect(blocked(r.status(), r.url()), '★伪造 key 被放行 = 通道形同虚设★').toBe(true)
  })

  test('congrove 的 key 进不了别的子系统(跨系统越权)', async ({ request }) => {
    const key = process.env.IAH_E2E_KEY
    test.skip(!key, '没配 IAH_E2E_KEY')
    // ★key 是 per-子系统的★:平台声称「别的 slug 借你的 key 会 403」。
    // 这条不是重复平台的测试 —— 它守的是**我这把 key 泄露时的爆炸半径**:
    // 万一 congrove 的 key 漏了,它不该成为进别人 dev 的通行证。
    const r = await request.get('https://netlog-dev.sub.ruciah.com/', {
      headers: { 'X-IAH-E2E-Key': key! },
    })
    expect(blocked(r.status(), r.url()), '★一把 key 能进别人的 dev = 爆炸半径失控★').toBe(true)
  })

  test('/healthz 同样在门禁后(记录事实,不是缺陷)', async ({ request }) => {
    const r = await request.get(`${BASE}/healthz`)
    // dev 是邀请制,整个域名都在 SSO 后。★这条断言的是现状★:
    // 哪天它变成可匿名访问了,这里会红 —— 那时要问的是「为什么探针对公网开了」。
    expect(r.url()).toContain(KC)
  })
})

// ★2026-08-07 平台修好 HeaderRegexp 后补★:验「带对的 key 确实能进」。
// 这一组用配置里那把真 key(不 override extraHTTPHeaders)。
test.describe('E2E 通道(带真 key)', () => {
  test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过')

  test('带真 key → 直达 congrove,不再跳 SSO', async ({ request }) => {
    const r = await request.get(`${BASE}/`)
    expect(r.status()).toBe(200)
    expect(r.url(), '还在跳 Keycloak = 第一层没通').not.toContain(KC)
  })

  test('第二层已接通:进来就是身份 e2e', async ({ request }) => {
    // congrove v0.3.60 起接上第二层(信任平台注入的身份头 + 双重门闩,见 docs/E2E-CHANNEL.md)。
    // 在此之前这里是 401,那一版的用例特地写成断言 401 并附了「接通后请来改我」——
    // ★结果它真的在接通那一刻红了,提示语原样打了出来★。这种「记录现状」的用例值得多写:
    // 它把「行为变了但没人注意到」变成一次必然的红灯。
    const r = await request.get(`${BASE}/api/me`)
    expect(r.status()).toBe(200)
    const me = await r.json()
    expect(me.username).toBe('e2e')
    // ★E2E 身份不该自带超管★:它是给自动化测试用的普通身份,
    // 哪天它变成 is_super=true,权限相关的用例会全部失去意义(超管短路一切判权)。
    expect(me.is_super, '★E2E 身份成了超管 = 所有权限用例失效★').toBe(false)
  })
})
