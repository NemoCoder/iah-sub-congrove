#!/usr/bin/env node
// dev 清库之后的**样例数据**——★走真实接口,不碰 SQL★(2026-08-09 liaoruili 定)。
//
// ══════ 为什么不许直接灌 SQL ══════
// 不只是「方便」。SQL 能造出**应用本身永远产不出的状态**:漏掉某个派生字段、
// 跳过某道校验、写出一个 handler 绝不会写的组合 —— 然后你在那种状态上测出来的结论,
// 对真实用户不成立。★用真实入口铺数据,等于每次清库都顺带跑了一遍冒烟测试★:
// 这个脚本自己跑不通,就说明真实用户也走不通。
//
// 用法(清库重启之后):
//   IAH_E2E_KEY=$(cat ~/.config/iah/congrove-e2e-key) node e2e/seed-dev.mjs
//
// 身份:走平台的 `X-IAH-E2E-User` 头以 **liaoruili** 的身份创建 —— ★必须是他★,
// 否则数据挂在 `e2e` 名下,他登进去一样什么都看不到。
import { request } from '@playwright/test'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const AS = process.env.SEED_AS ?? 'liaoruili'
if (!KEY) { console.error('缺 IAH_E2E_KEY —— 见 e2e/README.md'); process.exit(2) }

const ctx = await request.newContext({
  baseURL: BASE,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': AS },
  ignoreHTTPSErrors: true,
})

/// 失败要**响亮**:静默跳过会让人以为「数据就该长这样」,而那正是最难查的一类问题。
async function call(method, path, body) {
  const r = await ctx.fetch(path, { method, data: body })
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`)
  return r.status() === 204 ? null : await r.json()
}
const post = (p, b) => call('POST', p, b)
const put = (p, b) => call('PUT', p, b)

// 时间都相对「现在」算 —— 固定日期的样例数据一周之后就全在过去了,日历上空空如也。
const H = 3600_000, D = 24 * H
const now = Date.now()
/// 取整到整点,再偏移 —— 样例数据里出现 15:37 这种时间会让人以为是 bug
const at = (dayOffset, hour, minute = 0) => {
  const d = new Date(now + dayOffset * D)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
/// ★保证在未来★:半夜跑这个脚本时,「今天 15:00」是过去 —— 而「会议」类型
/// 按 F0 只能排未来(allow_past=false)。第一次跑就被它当场拦住了,
/// ★这正是走真实接口而不是灌 SQL 的价值★:SQL 会静默造出一个应用永远产不出的状态。
const soon = (hoursFromNow, len = 1.5) => {
  const s = new Date(now + hoursFromNow * H)
  s.setMinutes(0, 0, 0)
  return [s.toISOString(), new Date(s.getTime() + len * H).toISOString()]
}
/// ★补录一场**会议**:先建在未来,再把时间改回过去★ ——
/// 这不是绕过校验,是 F0 的错误文案自己指的路(「先建再改时间」):
/// 创建有 allow_past 闸,改期没有(改期本来就用来修正历史记录)。
async function mkPast(body, startISO, endISO) {
  const [s, e] = soon(48, 1)
  const id = (await mk({ ...body, starts_at: s, ends_at: e })).id
  await put(`/api/activities/${id}`, { starts_at: startISO, ends_at: endISO })
  return id
}

/// ★先等它真的能服务再开灌★(2026-08-10 踩到)。
/// `kubectl rollout status` 说就绪了,第一个 POST 仍然超时 —— 就绪探针过关与「能干活」
/// 之间还有一段(连池、JWKS、registry 客户端都要起来)。
/// ★这个脚本不是幂等的★:半途失败会留下一个「三个项目、零条活动」的库,
/// 而那种库最坏 —— 它看起来像灌好了。所以宁可在门口多等几秒。
for (let i = 1; ; i++) {
  try {
    const r = await ctx.fetch('/api/activity-types', { timeout: 8000 })
    if (r.ok()) break
    if (i > 20) throw new Error(`一直是 ${r.status()}`)
  } catch (e) { if (i > 20) { console.error('等不到服务:', e.message); process.exit(1) } }
  if (i === 1) process.stdout.write('等服务起来')
  process.stdout.write('.')
  await new Promise((r) => setTimeout(r, 3000))
}
console.log(`\n向 ${BASE} 以 ${AS} 的身份灌样例数据…\n`)

// ── 类型:预置两条,取它们的 id(别写死 1/2 —— 清库后序列会变) ──
const types = await call('GET', '/api/activity-types')
const 会议 = types.find((t) => t.name === '会议').id
const 个人日程 = types.find((t) => t.name === '个人日程').id

// ── 项目 ──
const p1 = (await post('/api/projects', { name: '课题组·计量经济学', description: '组会、论文、数据' })).id
const p2 = (await post('/api/projects', { name: 'AI 模型评测', description: '模型选型与评测' })).id
const p3 = (await post('/api/projects', { name: '2025 结题项目', description: '已经做完的一个' })).id
console.log(`✓ 项目 3 个（${p1} ${p2} ${p3}）`)

// ── 活动:覆盖「每一种在界面上长得不一样的」情形 ──
const mk = (b) => post('/api/activities', b)

// ① 普通的会:今天下午,我发起 + 我是记录员 → 日历上该显示「★我发起的」
const [s1, e1] = soon(2, 1.5)
const m1 = (await mk({ type_id: 会议, title: '八月第二次组会', agenda: '1. 上周进展\n2. 数据清洗口径\n3. 下周分工',
  recorder: AS, starts_at: s1, ends_at: e1, project_ids: [p1], participants: [], location: '3 号楼 401' })).id

// ② 明天上午的会,带线上链接
await mk({ type_id: 会议, title: '模型评审会', agenda: '候选模型对比', recorder: AS,
  starts_at: at(1, 10), ends_at: at(1, 11, 30), project_ids: [p2], participants: [],
  online_url: 'https://meeting.tencent.com/dm/example' })

// ③ ★跨天★:今晚 23:00 → 明天 01:00。它同时验两件事 ——
//    日历块不该把网格撑高(v0.4.89 修的),折叠条该数出「凌晨这一段有活动」(本次修的)
const 跨天 = at(now < new Date().setHours(22, 0, 0, 0) ? 0 : 1, 23)
await mk({ type_id: 会议, title: '跨时区讨论（跨天）', agenda: '与海外合作方对齐', recorder: AS,
  starts_at: 跨天, ends_at: new Date(new Date(跨天).getTime() + 2 * H).toISOString(),
  project_ids: [p2], participants: [] })

// ④ ★纯凌晨★:后天 02:00 —— 折叠区里的活动,展开才看得见
await mk({ type_id: 个人日程, title: '赶论文', starts_at: at(2, 2), ends_at: at(2, 4), recorder: '', project_ids: [], participants: [] })

// ⑤ 个人日程(不关联项目):今天傍晚 → 日历上「不公开」,材料落「我的活动材料」
const m5 = (await mk({ type_id: 个人日程, title: '读 Acemoglu 2024', starts_at: at(0, 19), ends_at: at(0, 21),
  recorder: '', project_ids: [], participants: [] })).id

// ⑥ ★补录★:上周的一条(个人日程 allow_past=true)。会议类型排过去会被拒 —— 那是 F0 的设计
await mk({ type_id: 个人日程, title: '（补录）上周跑数据', starts_at: at(-6, 14), ends_at: at(-6, 17, 30),
  recorder: '', project_ids: [], participants: [] })

// ⑦ 公开活动:全平台可旁听(广场那一栏靠它才不是空的)
await mk({ type_id: 会议, title: '公开讲座：因果推断入门', agenda: '面向全所', recorder: AS,
  starts_at: at(3, 14), ends_at: at(3, 16), project_ids: [p1], participants: [], visibility: 'public' })

// ⑧ 已归档项目里的历史会 —— 验 B0/B1:★照常进日历,但淡化 + 标「已归档 · 只读」★
await mkPast({ type_id: 会议, title: '中期汇报', agenda: '结题材料', recorder: AS,
  project_ids: [p3], participants: [] }, at(-3, 15), at(-3, 17))

// ⑨ ★两场欠着纪要的历史会★ —— 「待我处理」里那一路(2026-08-10)要有东西可显示,
//    而且它的**两种状态文案不同**:「连草稿都没建」要说「去整理」,「草稿写了一半」要说「接着写」。
//    造一场就只能看到一种,那另一种的文案永远没人看过 —— 这正是样例数据存在的意义。
const 欠1 = await mkPast({ type_id: 会议, title: '八月第一次组会', agenda: '开题分工', recorder: AS,
  project_ids: [p1], participants: [] }, at(-5, 10), at(-5, 11, 30))
const 欠2 = await mkPast({ type_id: 会议, title: '数据口径讨论', agenda: '清洗规则对齐', recorder: AS,
  project_ids: [p1], participants: [] }, at(-2, 16), at(-2, 17))
console.log('✓ 活动 9 条（含跨天 / 纯凌晨 / 补录 / 公开 / 归档项目的历史会 / 两场欠纪要的）')

// ⑨ 归档掉 p3 —— ★必须在建完它的历史会之后★:B2 规定「有未开始的活动就不许归档」,
//    而上面那条是过去的,所以归得掉。顺序反了会被 400 拒,那正是 B2 在起作用。
await post(`/api/projects/${p3}/archive`, { archived: true })
console.log('✓ 归档「2025 结题项目」')

// ── 材料:一份进项目的会、一份进个人活动(落「我的活动材料」) ──
async function upload(pid, mid, name, text) {
  const fd = { multipart: { file: { name, mimeType: 'text/markdown', buffer: Buffer.from(text) } } }
  const r = await ctx.fetch(`/api/projects/${pid}/upload?activity_id=${mid}&is_recording=false`, { method: 'POST', ...fd })
  if (!r.ok()) throw new Error(`上传 ${name} → ${r.status()} ${await r.text()}`)
}
await upload(p1, m1, '组会议程.md', '# 八月第二次组会\n\n- 上周进展\n- 数据清洗口径\n')
const matProj = (await post(`/api/activities/${m5}/materials-project`)).project_id
await upload(matProj, m5, '读书笔记.md', '# Acemoglu 2024\n\n核心论点…\n')
console.log('✓ 材料 2 份（一份进项目、一份进「我的活动材料」）')

// ── 纪要:三种状态各一,「待我处理」与详情页才看得全 ──
// ① 未来那场的草稿(详情页「纪要」栏不是空的);
await put(`/api/activities/${m1}/minutes`, {
  attendees: AS, agenda_text: '1. 上周进展\n2. 数据清洗口径',
  content_md: '（正文待整理）', resolutions: '- 口径按 2020 年不变价', todos: '- 下周三前交清洗脚本', status: 'draft',
})
// ② 欠1 **一行都不建** —— 待办卡上应显示「还没建 / 去整理」;
// ③ 欠2 建成草稿 —— 应显示「已有草稿 / 接着写」。
await put(`/api/activities/${欠2}/minutes`, {
  attendees: AS, agenda_text: '清洗规则对齐',
  content_md: '（写了一半）', resolutions: '', todos: '', status: 'draft',
})
console.log('✓ 纪要 2 份草稿（另留一场**完全没建**，供对照两种文案）')

console.log('\n★完成★ —— 打开 https://congrove-dev.sub.ruciah.com 就能看到')
await ctx.dispose()
