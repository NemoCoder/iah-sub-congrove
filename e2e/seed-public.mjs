#!/usr/bin/env node
// 造一批**公开活动**给「公开活动 · 可旁听」那张卡看效果（2026-08-13 liaoruili 要求）。
//
// ★必须由**别人**发起★：广场按设计滤掉「我已经与之有关」的会（我发起/我参与/我已旁听），
// 所以 liaoruili 自己发的公开会**永远不会**出现在他自己的广场里 —— 用他的身份造等于白造。
import { request } from '@playwright/test'
const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const as = (u) => request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': u } })
const t = String(Date.now()).slice(-4)
const 会议 = 1
const 主办 = ['e2e-host', 'e2e-b', 'e2e-lab']
// 标题写得像真的 —— ★卡片观感跟文字长度强相关★，全是「E2E-测试-123」看不出真实效果
const 场次 = [
  ['公开讲座：因果推断入门', '经济学院·计量方法', 1, 14],
  ['论文工作坊：如何回应审稿人', '写作训练营', 1, 19],
  ['读书会：Acemoglu《国家为什么会失败》', '政治经济学读书会', 2, 10],
  ['方法课：面板数据与固定效应', '经济学院·计量方法', 2, 15],
  ['开放组会：空间计量最新进展', '课题组·空间计量', 3, 9],
  ['讲座：大模型在社会科学中的应用', 'AI 与社科', 3, 16],
  ['研讨：数据治理与隐私合规', '横向课题·数据治理', 4, 13],
  ['学术午餐会：博士生开题互评', '研究生培养', 4, 12],
]
const ctxs = {}
for (const u of 主办) ctxs[u] = await as(u)
const 项目 = {}
let n = 0
for (const [标题, 组, 天后, 点] of 场次) {
  const 谁 = 主办[n % 主办.length]
  const api = ctxs[谁]
  if (!项目[组 + 谁]) {
    const p = await api.post('/api/projects', { data: { name: `${组} ${t}` } })
    项目[组 + 谁] = (await p.json()).id
  }
  const d = new Date(); d.setDate(d.getDate() + 天后); d.setHours(点, 0, 0, 0)
  const r = await api.post('/api/activities', {
    data: { type_id: 会议, title: `${标题}`, recorder: 谁, project_ids: [项目[组 + 谁]],
            visibility: 'public', starts_at: d.toISOString(),
            ends_at: new Date(d.getTime() + 2 * 3600e3).toISOString(),
            agenda: '一、引言\n二、主体\n三、讨论', location: '明德主楼 1016' },
  })
  console.log(`  ${r.status() === 200 ? '✓' : '✗ ' + r.status()} ${标题}（${谁} 发起）`)
  n++
}
console.log(`\n造好 ${场次.length} 场公开活动。去日程页右栏看「公开活动 · 可旁听」。\n`)
await Promise.all(Object.values(ctxs).map((c) => c.dispose()))
