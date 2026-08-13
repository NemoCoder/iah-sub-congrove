#!/usr/bin/env node
// 给 liaoruili 的「待我处理」造一批**各种类型**的待办（2026-08-13 他要求：
// 「你给我留点需要处理的各种事项呀，现在就只有纪要」）。
//
// ★造的人是 e2e-* 测试身份，不是他自己★：邀请要别人发、转移要别人转、私聊要别人说 ——
// 这几类待办**结构上都不可能自己给自己造**。
import { request } from '@playwright/test'
const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY, ME = 'liaoruili'
const as = (u) => request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': u } })
const t = String(Date.now()).slice(-5)
const 会议 = 1, 个人日程 = 2
const ok = async (r, what) => { const s = r.status(); console.log(`  ${s === 200 ? '✓' : '✗ ' + s} ${what}${s === 200 ? '' : ' — ' + (await r.text()).slice(0, 120)}`); return s === 200 ? r.json().catch(() => ({})) : null }

const host = await as('e2e-host'), mate = await as('e2e-b')
console.log('\n为 liaoruili 造各类待办：\n')

// ① 项目转移待答复（e2e-host 把项目转给他）
for (const [i, name] of [['1', `课题组·空间计量 ${t}`], ['2', `横向课题·数据治理 ${t}`]]) {
  const p = await ok(await host.post('/api/projects', { data: { name } }), `建项目「${name}」`)
  if (p?.id) {
    // ★转移只能转给本项目的成员★（后端的真闸，第一版没先拉人就 400 —— 合理的产品行为）
    await ok(await host.put(`/api/projects/${p.id}/members`, { data: { usernames: [ME], role: 'admin' } }), '  → 先把你加成管理员')
    await ok(await host.post(`/api/projects/${p.id}/transfer`, { data: { to: ME } }), `  → 转移主持人给你（第 ${i} 个）`)
  }
}

// ② 活动邀请待答复（e2e-host 发会并邀请他）
const proj = await ok(await host.post('/api/projects', { data: { name: `联合项目·因果推断 ${t}` } }), '建一个联合项目')
if (proj?.id) {
  await ok(await host.put(`/api/projects/${proj.id}/members`, { data: { usernames: [ME], role: 'editor' } }), '  → 把你拉进项目')
  const 明天 = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.toISOString() }
  for (const [标题, 起, 止] of [
    [`组会：下周实验安排 ${t}`, 明天(10), 明天(11)],
    [`与合作方对齐口径 ${t}`, 明天(15), 明天(16)],
    [`论文投稿终审 ${t}`, 明天(19), 明天(20)],
  ]) {
    const a = await ok(await host.post('/api/activities', {
      // ★记录员写成你★:私聊有真闸「只能发给发起人或记录员」(D13,不做任意点对点),
      //   所以要让你收到私聊未读,你必须是这两者之一 —— 顺带也给你造出「待整理纪要」。
      data: { type_id: 会议, title: 标题, recorder: ME, project_ids: [proj.id],
              starts_at: 起, ends_at: 止, agenda: '一、进度\n二、下一步' } }), `发会「${标题}」`)
    if (a?.id) {
      await ok(await host.put(`/api/activities/${a.id}/participants`, { data: { usernames: [ME], kind: 'attendee' } }), '  → 邀请你参会（待你答复）')
      // ③ 私聊未读（参会人私聊发起人…这里反过来：发起人私聊你）
      await ok(await host.post(`/api/activities/${a.id}/messages`, { data: { body: `${标题}：你方便的话把上次那版数据发我一下`, channel: 'private', peer: ME } }), '  → 私聊你一句（未读）')
    }
  }
}
console.log('\n完成。去「日程」页看右上角那张「待我处理」。\n')
await Promise.all([host.dispose(), mate.dispose()])
