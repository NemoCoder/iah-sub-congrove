import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { 算提醒态 } from './remind-status.ts'

const p = (status: string, reminded_at: string | null) => ({ status, reminded_at })
const T1 = '2026-08-16T10:00:00Z'
const T2 = '2026-08-16T10:00:30Z'

test('★拒绝了的人不进分母★——这是最容易写错、而且错了会静默误导的一条', () => {
  // 4 个人,1 个拒绝;剩下 3 个全提醒过 ⇒ 应当是「全发完了」。
  // 分母若用 4(全部参会人),这里会显示「3 / 4」,看着像漏了一个人,★而系统完全正确★。
  // 判据来源:remind.rs 的 `AND p.status <> 'declined'`。
  const r = 算提醒态([
    p('accepted', T1), p('accepted', T1), p('pending', T1), p('declined', null),
  ])
  assert.deepEqual(r, { kind: 'done', total: 3, at: T1 })
})

test('一个都没投 → pending,而且分母也不算拒绝的人', () => {
  assert.deepEqual(算提醒态([p('accepted', null), p('declined', null)]),
    { kind: 'pending', total: 1 })
})

test('★投了一半要如实说 partial,不能当成已发★', () => {
  // 一跳最多 200 条,剩下的下一跳补 —— 中间态是正常的,谎报成「已发」才是问题。
  assert.deepEqual(算提醒态([p('accepted', T1), p('accepted', null), p('pending', null)]),
    { kind: 'partial', sent: 1, total: 3, at: T1 })
})

test('★没人该收提醒时回 none★:「0 人已提醒」读起来像坏了,而事实是没有可提醒的对象', () => {
  assert.deepEqual(算提醒态([]), { kind: 'none' })
  assert.deepEqual(算提醒态([p('declined', null), p('declined', null)]), { kind: 'none' })
})

test('★时刻取最早那条★:取最晚的话,分批补投时这个时间会一路往后跳', () => {
  // 先投的 T1、下一跳补的 T2 —— 显示的应当是 T1(「什么时候开始提醒的」)
  const r = 算提醒态([p('accepted', T2), p('accepted', T1)])
  assert.equal(r.kind, 'done')
  assert.equal((r as { at: string }).at, T1)
})
