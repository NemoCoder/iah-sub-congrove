// 超管后台的连库行为（2026-08-16，docs/TECH-DESIGN-admin-console.md §7）。
//
// ══ 为什么这几条在 E2E 而不在 cargo test ══
// 本仓 `cargo test` 是**纯的**（没有连库的测试装置），而这几条要验的恰恰是
// 「库里的值变了之后,别处的行为跟不跟着变」—— 那是连库才看得见的。
// #149 的提交信息里写明了这处对测试计划的偏离,这份就是补上的那部分。
//
// ══ ★一条自我约束:测试只往**高**了改全站默认配额★ ══
// 「改默认 → 没有 user_quota 行的人跟着变」这条必须真的改一次全站默认才验得到,
// 而全站默认影响的是 dev 上**所有人**。所以:
//   · 只把它**调高**（10 GiB → 11 GiB）再还原 —— 调高不会让任何人突然超额、传不了东西;
//   · try/finally 还原,失败也还原。
// ⚠ 反过来「调低」也确实该测(那才是危险方向),但那条留给 impact 接口的断言去覆盖 ——
//   ★问「算出来的人对不对」不需要真的把闸拉下来★。
import { expect, request as pwRequest, test, type APIRequestContext } from '@playwright/test'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const GiB = 1024 ** 3
/// 超管:这几条要 require_super,而 E2E 身份头能扮演任何人 —— 但**权限仍由后端判**。
const 超管 = 'liaoruili'
const 路人 = 'e2e-adminconsole'

const 以 = (who: string): Promise<APIRequestContext> => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY!, 'X-IAH-E2E-User': who },
})

/// 超管模式:这些接口要 `is_super`,而超管模式平时是关的(TECH-DESIGN-admin-mode)。
async function 开超管模式(c: APIRequestContext) {
  await c.post('/api/me/admin-mode', { data: { on: true } })
}

test.describe('超管后台 · 连库行为', () => {

  test('★非超管一个都进不去★（权限,逐个接口）', async () => {
    const 他 = await 以(路人)
    try {
      // 让这个用户先存在(登录一次即落 app_user)
      await 他.get('/api/me')
      for (const [法, 路] of [
        ['GET', '/api/admin/settings'],
        ['GET', '/api/admin/settings/default-quota/impact?bytes=1073741824'],
        ['GET', '/api/admin/users'],
        ['GET', '/api/admin/audit'],
      ] as const) {
        const r = await 他.fetch(路, { method: 法 })
        expect(r.status(), `★${法} ${路} 对非超管必须 403★`).toBe(403)
      }
      for (const [法, 路, 体] of [
        ['PUT', '/api/admin/settings/default_quota_bytes', { value: '1' }],
        ['DELETE', `/api/admin/users/${路人}/quota`, undefined],
      ] as const) {
        const r = await 他.fetch(路, { method: 法, data: 体 })
        expect(r.status(), `★${法} ${路} 对非超管必须 403★`).toBe(403)
      }
    } finally { await 他.dispose() }
  })

  test('★白名单外的 key、以及不存在的用户,都要 400★', async () => {
    const c = await 以(超管)
    try {
      await 开超管模式(c)
      // 正向对照:白名单内的 key 用合法值是能过的 —— 否则下面的 400 可能只是「我连不上」
      const 好 = await c.put('/api/admin/settings/default_remind_minutes', { data: { value: '15' } })
      expect(好.status(), await 好.text()).toBe(200)

      // llm_model 确实是 app_setting 里的一个 key,但★不在这条通用路径的白名单里★
      for (const k of ['llm_model', 'nope', 'DEFAULT_QUOTA_BYTES']) {
        const r = await c.put(`/api/admin/settings/${k}`, { data: { value: 'x' } })
        expect(r.status(), `★${k} 不该能从这条路径写进去★`).toBe(400)
      }
      // ══ ★这一段的正向对照不是可选的★(2026-08-16 它当场抓到一个已上线的 bug)══
      // 只断言「名单里有假名字 → 400」的话,在**这一项根本存不进去**(任何值都 400)时
      // 也会绿 —— 而那正是当时的实情:`SELECT 1` 被当 i64 收,PG 的 1 是 INT4,
      // 解码报错 → 走到同一个 400。★那个 400 是因为完全错误的理由才"对"的。★
      // ⇒ 必须先证明「合法的名单存得进去」,那句拒绝才有意义。
      const 好名单 = await c.put('/api/admin/settings/project_creators', { data: { value: 超管 } })
      expect(好名单.status(), `★正向对照:合法名单必须存得进去(回了 ${await 好名单.text()})★`).toBe(200)
      // 存完立刻读回来,确认真的落库了(200 也可能什么都没写)
      const 读回 = await (await c.get('/api/admin/settings')).json()
      expect(读回.project_creators.value, '★存进去的要读得回来★').toContain(超管)
      expect(读回.project_creators.source, '来源该变成 db').toBe('db')

      // 打错用户名的后果是「那个人从此建不了项目」而没有任何地方报错 ⇒ 写入这一刻就拦
      const 坏人 = await c.put('/api/admin/settings/project_creators',
        { data: { value: `${超管},肯定没有这个用户名-9f3a` } })
      expect(坏人.status(), '★名单里有不存在的用户必须 400★').toBe(400)
      // ★断言消息内容,不只断言状态码★:400 可以来自任何地方(上面那个 bug 就是)
      expect(await 坏人.text()).toContain('没有这个用户')

      // ⚠ 还原成「人人可建」——★别把 dev 留在收紧状态★(空串是有效值 = 清空名单)
      expect((await c.put('/api/admin/settings/project_creators', { data: { value: '' } })).status()).toBe(200)
      const 还原后 = await (await c.get('/api/admin/settings')).json()
      expect(还原后.project_creators.value, '★清空要真的生效(空串是有效值,不是「没设过」)★').toEqual([])
      // 越界值
      for (const [k, v] of [['default_quota_bytes', '0'], ['default_quota_bytes', '-1'],
                            ['default_remind_minutes', '0'], ['default_remind_minutes', '10081']] as const) {
        const r = await c.put(`/api/admin/settings/${k}`, { data: { value: v } })
        expect(r.status(), `★${k}=${v} 必须 400★`).toBe(400)
      }
    } finally { await c.dispose() }
  })

  test('★改全站默认:没单独设过的人跟着变,设过的人不变;恢复默认又跟上★', async () => {
    test.setTimeout(120_000)
    const c = await 以(超管)
    const 甲 = await 以(路人)      // 这个人不单独设配额 → 应当跟随
    let 原值: number | null = null
    try {
      await 开超管模式(c)
      await 甲.get('/api/me')      // 确保他在 app_user 里

      const s0 = await (await c.get('/api/admin/settings')).json()
      原值 = s0.default_quota_bytes.value as number

      // ── 找一个「单独设过」的对照组:给超管自己设一个显式配额 ──
      const 固定额 = 77 * GiB
      expect((await c.put(`/api/admin/users/${超管}/quota`, { data: { quota_bytes: 固定额 } })).status()).toBe(200)

      const 查 = async (u: string) => {
        const rows = await (await c.get('/api/admin/users')).json() as
          { username: string; quota_bytes: number; quota_is_default: boolean }[]
        const r = rows.find((x) => x.username === u)
        expect(r, `用户列表里没有 ${u}`).toBeTruthy()
        return r!
      }

      expect((await 查(路人)).quota_is_default, '★路人本来就该是「跟随默认」★').toBe(true)
      expect((await 查(超管)).quota_is_default, '★刚设过的人不该再标默认★').toBe(false)
      expect((await 查(超管)).quota_bytes).toBe(固定额)

      // ── ★只往高了改★(见文件头注):调高不会让任何人突然超额 ──
      const 新值 = 原值 + GiB
      expect((await c.put('/api/admin/settings/default_quota_bytes',
        { data: { value: String(新值) } })).status()).toBe(200)

      expect((await 查(路人)).quota_bytes, '★跟随默认的人必须跟着变★').toBe(新值)
      expect((await 查(超管)).quota_bytes, '★单独设过的人必须**不**变★').toBe(固定额)

      // ── 恢复为默认:他应当重新跟上 ──
      expect((await c.fetch(`/api/admin/users/${超管}/quota`, { method: 'DELETE' })).status()).toBe(204)
      const 后 = await 查(超管)
      expect(后.quota_is_default, '★恢复之后该重新标为默认★').toBe(true)
      expect(后.quota_bytes, '★而且额度要等于当前的全站默认★').toBe(新值)
      // 幂等:再删一次仍 204
      expect((await c.fetch(`/api/admin/users/${超管}/quota`, { method: 'DELETE' })).status()).toBe(204)
    } finally {
      // ★失败也要还原全站默认★:它影响 dev 上所有人,不能留着
      if (原值 != null) {
        await c.put('/api/admin/settings/default_quota_bytes', { data: { value: String(原值) } }).catch(() => {})
      }
      await c.dispose(); await 甲.dispose()
    }
  })

  test('★影响面算出来的人,必须就是真的会超额的那些人★', async () => {
    const c = await 以(超管)
    try {
      await 开超管模式(c)
      const users = await (await c.get('/api/admin/users')).json() as
        { username: string; quota_is_default: boolean }[]
      const 跟随数 = users.filter((u) => u.quota_is_default).length

      // 给一个大得没人够得着的数:following_default 要对得上,would_exceed 必须是 0
      const 大 = 900 * 1024 * GiB
      const a = await (await c.get(`/api/admin/settings/default-quota/impact?bytes=${大}`)).json()
      expect(a.following_default, '★跟随默认的人数要和用户列表数出来的一致★').toBe(跟随数)
      expect(a.would_exceed, '给一个天文数字,不该有人超额').toBe(0)

      // ★正向对照★:给 1 字节。除非 dev 上一个字节都没存过,否则必须有人超额 ——
      //   没有这一条,上面那句 `would_exceed === 0` 在**接口永远返回 0** 时也会绿。
      const b = await (await c.get('/api/admin/settings/default-quota/impact?bytes=1')).json()
      expect(b.would_exceed, '★1 字节都容不下,必须报出超额的人;报 0 说明这个数根本没在算★')
        .toBeGreaterThan(0)
      expect(b.exceeding.length, '要给出具体是谁(界面靠它列名字)').toBeGreaterThan(0)
      expect(b.exceeding[0].used_bytes).toBeGreaterThan(1)

      expect((await c.get('/api/admin/settings/default-quota/impact?bytes=0')).status(),
        '0 不是合法配额').toBe(400)
    } finally { await c.dispose() }
  })
})
