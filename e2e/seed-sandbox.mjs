#!/usr/bin/env node
// 给**沙箱账号 e2e** 铺一套够巡检点的数据（2026-08-13）。
// ★为什么必须先铺★:全量 E2E 的 teardown 会把 `E2E-` 前缀的东西清光,
//   紧接着跑巡检就是在一个空账号上点 —— 报告会很好看,而它什么都没覆盖到。
//   ★空账号上的「0 异常」是最没有信息量的一种绿。★
import { request } from '@playwright/test'
const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const as = (u) => request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': u } })
const t = String(Date.now()).slice(-5)
const 会议 = 1
const ok = async (r, what) => { const s = r.status(); console.log(`  ${s===200?'✓':'✗ '+s} ${what}`); return s===200 ? r.json().catch(()=>({})) : null }
const me = await as('e2e'), 同事 = await as('e2e-b')
console.log('\n给沙箱账号 e2e 铺数据：\n')

// 项目:一个正常的、一个归档的、一个删进回收站的
const P = {}
for (const [k, name] of [['a', `E2E-巡检-主项目-${t}`], ['b', `E2E-巡检-归档用-${t}`], ['c', `E2E-巡检-回收站用-${t}`]]) {
  const p = await ok(await me.post('/api/projects', { data: { name } }), `建项目 ${name}`)
  if (p?.id) P[k] = p.id
}
// 拉个同事进主项目 → 成员 tab 有内容
await ok(await me.put(`/api/projects/${P.a}/members`, { data: { usernames: ['e2e-b'], role: 'editor' } }), '拉 e2e-b 进主项目')
// 主项目里建文件夹 + 文档 → 文档 tab 有内容,还能点进去
const f = await ok(await me.post(`/api/projects/${P.a}/items`, { data: { name: `E2E-巡检-文件夹-${t}`, kind: 'folder' } }), '建文件夹')
await ok(await me.post(`/api/projects/${P.a}/items`, { data: { name: `E2E-巡检-说明-${t}.md`, kind: 'doc', parent_id: f?.id ?? null } }), '建文档')
// 删一个 → 项目内回收站有内容
const 待删 = await ok(await me.post(`/api/projects/${P.a}/items`, { data: { name: `E2E-巡检-待删-${t}`, kind: 'folder' } }), '建一个待删的')
if (待删?.id) await ok(await me.delete(`/api/items/${待删.id}`), '删进回收站')
// 归档一个项目 → 「已归档」那一档有内容
await ok(await me.post(`/api/projects/${P.b}/archive`, { data: { archived: true } }), '归档一个项目')
// 删一个项目 → 项目级回收站有内容
await ok(await me.delete(`/api/projects/${P.c}`), '删一个项目进项目回收站')
// 活动:未来一场(可改)、公开一场(广场)、已结束一场(纪要待整理)
const 明天 = (h) => { const d=new Date(); d.setDate(d.getDate()+1); d.setHours(h,0,0,0); return d.toISOString() }
const 前天 = (h) => { const d=new Date(); d.setDate(d.getDate()-2); d.setHours(h,0,0,0); return d.toISOString() }
for (const [标题, 起, 止, vis] of [
  [`E2E-巡检-明天的会-${t}`, 明天(10), 明天(11), 'private'],
  [`E2E-巡检-公开会-${t}`, 明天(14), 明天(15), 'public'],
]) {
  const a = await ok(await me.post('/api/activities', { data: { type_id: 会议, title: 标题, recorder: 'e2e',
    project_ids: [P.a], starts_at: 起, ends_at: 止, visibility: vis, agenda: '一、进度\n二、下一步',
    location: '明德 1016', online_url: 'https://meeting.tencent.com/e2e' } }), `发会 ${标题}`)
  if (a?.id) await ok(await me.put(`/api/activities/${a.id}/participants`, { data: { usernames: ['e2e-b'], kind: 'attendee' } }), '  邀请 e2e-b')
}
// 已开完的一场:补录到过去 → 「待整理纪要」有内容
const 旧 = await ok(await me.post('/api/activities', { data: { type_id: 会议, title: `E2E-巡检-上周的会-${t}`,
  recorder: 'e2e', project_ids: [P.a], starts_at: 明天(9), ends_at: 明天(10) } }), '发一场准备补录的会')
if (旧?.id) await ok(await me.put(`/api/activities/${旧.id}`, { data: { starts_at: 前天(9), ends_at: 前天(10) } }), '  补录到前天(已结束→欠纪要)')
// 同事发一场并邀请我 → 「待我处理」有邀请
const 他的 = await ok(await 同事.post('/api/projects', { data: { name: `E2E-巡检-同事的项目-${t}` } }), '同事建项目')
if (他的?.id) {
  await ok(await 同事.put(`/api/projects/${他的.id}/members`, { data: { usernames: ['e2e'], role: 'editor' } }), '  拉我进去')
  const a = await ok(await 同事.post('/api/activities', { data: { type_id: 会议, title: `E2E-巡检-同事约的会-${t}`,
    recorder: 'e2e-b', project_ids: [他的.id], starts_at: 明天(16), ends_at: 明天(17) } }), '  同事发会')
  if (a?.id) await ok(await 同事.put(`/api/activities/${a.id}/participants`, { data: { usernames: ['e2e'], kind: 'attendee' } }), '  邀请我(待我答复)')
}
console.log('\n铺好了。\n')
await Promise.all([me.dispose(), 同事.dispose()])
