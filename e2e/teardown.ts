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

/// 测试造的项目/会议一律用这些前缀。★新增 spec 时如果起了别的名字,记得加进来★
const MINE = /^(E2E-|演示·)/

export default async function teardown() {
  const KEY = process.env.IAH_E2E_KEY
  if (!KEY) return
  const base = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
  const ctx = await request.newContext({ baseURL: base, extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY } })
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
