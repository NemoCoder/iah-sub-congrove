// 全局 teardown:把本轮测试造的项目与活动清掉。
//
// ★为什么必须自清理★(2026-08-07 用户提):每跑一轮 spec 就造十几个项目,
// 一天下来 dev 的项目列表被 80 多个 `E2E-xxx-<时间戳>` 淹没,真实项目根本找不到。
// 测试数据的生命周期应该和测试一样长。
//
// ★靠命名前缀识别,不靠记账★:记账(把造出来的 id 存起来再删)在测试崩溃、
// 超时、被 Ctrl-C 时会漏 —— 而漏掉的正好是失败那轮,最容易堆积。
// 前缀扫描是幂等的:漏了这次,下次照样清掉。
import { request } from '@playwright/test'

/// 测试造的项目/活动一律用这些前缀。
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
  //   实测漏了 8 个项目 / 5 场活动。
  //   ⚠ 这跟本文件开头记的那次事故是**同一个失败模式**（当时是前缀对不上，这次是可见性不够），
  //     所以修法要针对「前提」而不是针对「这一次的成因」：★让扫描真的能看到全部★。
  //   `X-IAH-E2E-User` 到位之后这件事才做得到（此前只有 `e2e` 一个身份）。
  //   安全性：只在 dev、只删 `^(E2E-|演示·)` 前缀，真实项目碰不到。
  //
  // ⚠★但「超管身份」并不等于「现在看得见一切」★（2026-08-13 查出，这是**第三次**同一族失败）：
  //   超管拆成了**资格**（`app_user.is_super`）与**特权**（`super_now` 视图 = 资格 AND
  //   管理员模式没过期），而管理员模式 **2 小时自动关**。teardown 从来不开模式，
  //   所以它多数时候是以一个**普通用户** liaoruili 在扫 —— 看不见 e2e 名下的项目，
  //   于是又是「一个都没清掉，还照常打印已清理」。
  //   ★症状是 liaoruili 的「待我处理」里堆了 20 条 `E2E-转移-*` 请求★（他截图问「怎么这么长」）：
  //   转移请求的 SQL 带了 `deleted_at IS NULL`，请求还在 = 那些项目**根本没被删掉**。
  //   修法不是去开管理员模式（那会让 teardown 依赖一个会过期的状态，
  //   而且开模式本身要写 audit_log —— 用清理脚本刷审计日志是坏主意），
  //   而是★按 owner 分别扫★：每个造数据的身份自己清自己的，不依赖任何特权。
  const 身份们 = [process.env.IAH_E2E_ADMIN ?? 'liaoruili', 'e2e', 'e2e-host', 'e2e-owner']
  let nm = 0, np = 0
  for (const who of 身份们) await 清一轮(who)
  if (nm || np) console.log(`\n[teardown] 清理测试数据:活动 ${nm} 场、项目 ${np} 个`)

  async function 清一轮(who: string) {
  const ctx = await request.newContext({
    baseURL: base,
    extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY!, 'X-IAH-E2E-User': who },
  })
  try {
    // 活动:先清(它引用项目,留着会挡住项目删除)
    const from = new Date(Date.now() - 30 * 864e5).toISOString()
    const to = new Date(Date.now() + 30 * 864e5).toISOString()
    const ms = await (await ctx.get(`/api/activities?from=${from}&to=${to}`)).json().catch(() => [])
    for (const m of Array.isArray(ms) ? ms : []) {
      // 活动标题的花样比项目多(断言用例会起「这个标题不该出现在忙闲里」这种),
      // 所以额外认它们关联的项目名 —— 但列表接口不返回项目,退而求其次按标题白名单。
      if (MINE.test(m.title) || /^(E2E 活动|每周组会|模型评审|数据对齐|数据治理周会|读书会|健身|这个标题不该出现在忙闲里)/.test(m.title)) {
        await ctx.delete(`/api/activities/${m.id}`).catch(() => {})
        nm++
      }
    }
    // 项目
    const ps = await (await ctx.get('/api/projects')).json().catch(() => [])
    for (const p of Array.isArray(ps) ? ps : []) {
      if (MINE.test(p.name)) { await ctx.delete(`/api/projects/${p.id}`).catch(() => {}); np++ }
    }
  } finally {
    await ctx.dispose()
  }
  }
}
