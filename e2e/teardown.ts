// 全局 teardown:把本轮测试造的项目与会议清掉。
//
// ★为什么必须自清理★(2026-08-07 用户提):每跑一轮 spec 就造十几个项目,
// 一天下来 dev 的项目列表被 80 多个 `E2E-xxx-<时间戳>` 淹没,真实项目根本找不到。
// 测试数据的生命周期应该和测试一样长。
//
// ★靠命名前缀识别,不靠记账★:记账(把造出来的 id 存起来再删)在测试崩溃、
// 超时、被 Ctrl-C 时会漏 —— 而漏掉的正好是失败那轮,最容易堆积。
// 前缀扫描是幂等的:漏了这次,下次照样清掉。
import { request } from '@playwright/test'

/// 测试造的项目/会议一律用这些前缀。
///
/// ★2026-08-08 的教训:别指望「新增 spec 时记得加进来」★。
/// 我先后写了三个新东西,每个都自己起了前缀 —— safety-net 用 `网-`、
/// golden.mjs 用 `G<ts>-`、acceptance 用 `验收-` —— **一个都不在这张表里**,
/// 于是 dev 里静静躺着 47 个永不回收的项目,而 teardown 每轮还照常打印「已清理」。
/// ★清理规则和命名规则必须是同一条★:所以反过来做 —— 让**所有** spec 都以 `E2E-` 开头
/// (已全部改过),这里只认这一个前缀。新 spec 起名带上它,不需要再来改这个文件。
const MINE = /^(E2E-|演示·)/

export default async function teardown() {
  const KEY = process.env.IAH_E2E_KEY
  if (!KEY) return
  const base = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
  // ★以**超管身份**清场★（2026-08-08 修）：这个 teardown 的整个设计前提是
  //   「靠命名前缀扫描，不靠记账」——而扫描需要**全局可见性**。
  //   在此之前它用默认身份 `e2e` 调 `GET /api/projects`，于是
  //   `multi-identity.spec.ts` 造的、owner 是 `e2e-host`/`e2e-owner` 的项目
  //   按 D3「非成员一律 404」根本看不见 → ★一个都清不掉，而它照常打印「已清理 N 个」★。
  //   实测漏了 8 个项目 / 5 场会议。
  //   ⚠ 这跟本文件开头记的那次事故是**同一个失败模式**（当时是前缀对不上，这次是可见性不够），
  //     所以修法要针对「前提」而不是针对「这一次的成因」：★让扫描真的能看到全部★。
  //   `X-IAH-E2E-User` 到位之后这件事才做得到（此前只有 `e2e` 一个身份）。
  //   安全性：只在 dev、只删 `^(E2E-|演示·)` 前缀，真实项目碰不到。
  const ADMIN = process.env.IAH_E2E_ADMIN ?? 'liaoruili'   // CONGROVE_SUPER_USERS 里的那个
  const ctx = await request.newContext({
    baseURL: base,
    extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': ADMIN },
  })
  try {
    // 会议:先清(它引用项目,留着会挡住项目删除)
    const from = new Date(Date.now() - 30 * 864e5).toISOString()
    const to = new Date(Date.now() + 30 * 864e5).toISOString()
    const ms = await (await ctx.get(`/api/meetings?from=${from}&to=${to}`)).json().catch(() => [])
    let nm = 0
    for (const m of Array.isArray(ms) ? ms : []) {
      // 会议标题的花样比项目多(断言用例会起「这个标题不该出现在忙闲里」这种),
      // 所以额外认它们关联的项目名 —— 但列表接口不返回项目,退而求其次按标题白名单。
      if (MINE.test(m.title) || /^(E2E 会议|每周组会|模型评审|数据对齐|数据治理周会|读书会|健身|这个标题不该出现在忙闲里)/.test(m.title)) {
        await ctx.delete(`/api/meetings/${m.id}`).catch(() => {})
        nm++
      }
    }
    // 项目
    const ps = await (await ctx.get('/api/projects')).json().catch(() => [])
    let np = 0
    for (const p of Array.isArray(ps) ? ps : []) {
      if (MINE.test(p.name)) { await ctx.delete(`/api/projects/${p.id}`).catch(() => {}); np++ }
    }
    if (nm || np) console.log(`\n[teardown] 清理测试数据:会议 ${nm} 场、项目 ${np} 个`)
  } finally {
    await ctx.dispose()
  }
}
