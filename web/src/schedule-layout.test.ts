// 日历布局单测。★零依赖★:Node 24 原生 test runner + 原生跑 TS(--experimental-strip-types),
// 不引 vitest/jest —— 与 textleaf「Node 直接跑 TS,无构建步骤」的做法一致。
//
//   cd web && npm test
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { HOUR_PX, layout, slot, type Span } from './schedule-layout.ts'

/// 造当天某时段的事件。day 用固定日期,避免测试随当天日期漂。
const DAY = new Date(2026, 7, 5)                       // 2026-08-05,本地时区
const at = (h: number, durH = 1): Span => {
  const s = new Date(DAY); s.setHours(h, 0, 0, 0)
  const e = new Date(s); e.setHours(e.getHours() + durH)
  return { starts_at: s.toISOString(), ends_at: e.toISOString() }
}

test('不重叠的事件各占满宽', () => {
  const out = layout([at(9), at(14)], DAY)
  assert.equal(out.length, 2)
  for (const b of out) { assert.equal(b.width, '100%'); assert.equal(b.left, '0%') }
})

test('两个重叠 → 各占一半并排', () => {
  const out = layout([at(10), at(10)], DAY)
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((b) => b.width), ['50%', '50%'])
  assert.deepEqual(out.map((b) => b.left).sort(), ['0%', '50%'])
})

/// ★这条是那个 bug 的复现测试★(2026-08-07):
/// 旧实现在第三个开始一律推全宽,把前面的整个盖住 —— 会议在界面上凭空消失。
test('四个完全重叠 → 四列并排,谁也不许消失', () => {
  const out = layout([at(10), at(10), at(10), at(10)], DAY)
  assert.equal(out.length, 4, '有事件被丢掉了')
  // 每个宽度相同且总和是 100%
  assert.deepEqual(out.map((b) => b.width), ['25%', '25%', '25%', '25%'])
  // ★左偏移必须互不相同★——相同就意味着两个盒子叠在一起,等于看不见
  const lefts = out.map((b) => b.left).sort()
  assert.deepEqual(lefts, ['0%', '25%', '50%', '75%'])
  assert.equal(new Set(lefts).size, 4, '有盒子重叠在同一位置')
})

test('部分重叠:能复用已空出的列', () => {
  // 9–10 与 10–11 首尾相接(不重叠),两者都与 9–11 重叠 → 共 2 列
  const out = layout([at(9, 2), at(9), at(10)], DAY)
  assert.equal(out.length, 3)
  assert.deepEqual(new Set(out.map((b) => b.width)), new Set(['50%']))
  // 后两个应当落在同一列(第二列):它们彼此不重叠,可以共用
  const short = out.filter((b) => b.height === HOUR_PX)
  assert.equal(new Set(short.map((b) => b.left)).size, 1, '首尾相接的两个没能共用一列')
})

test('两簇之间互不影响', () => {
  // 上午两个重叠(→各 50%),下午一个独立(→100%)
  const out = layout([at(9), at(9), at(15)], DAY)
  const wide = out.filter((b) => b.width === '100%')
  assert.equal(wide.length, 1, '独立事件不该被别的簇拖成半宽')
})

test('不在这一天的事件被排除', () => {
  const other = new Date(DAY); other.setDate(other.getDate() + 3)
  const s = new Date(other); s.setHours(10, 0, 0, 0)
  const e = new Date(s); e.setHours(11)
  assert.equal(layout([{ starts_at: s.toISOString(), ends_at: e.toISOString() }], DAY).length, 0)
})

test('极短的会也要有可点中的高度', () => {
  const s = new Date(DAY); s.setHours(10, 0, 0, 0)
  const e = new Date(s); e.setMinutes(10)          // 10 分钟 → 只有 5px
  const [b] = layout([{ starts_at: s.toISOString(), ends_at: e.toISOString() }], DAY)
  assert.ok(b.height >= 18, '太矮会点不中也放不下标题')
})

test('跨天事件按当天可见的那段裁剪', () => {
  const s = new Date(DAY); s.setHours(23, 0, 0, 0)
  const e = new Date(DAY); e.setDate(e.getDate() + 1); e.setHours(2, 0, 0, 0)
  const [b] = layout([{ starts_at: s.toISOString(), ends_at: e.toISOString() }], DAY)
  assert.equal(b.top, 23 * HOUR_PX)
  assert.equal(b.height, HOUR_PX, '当天只该画到 24:00')
})

test('slot 对完全在别天的事件回 null', () => {
  const prev = new Date(DAY); prev.setDate(prev.getDate() - 1)
  const s = new Date(prev); s.setHours(10, 0, 0, 0)
  const e = new Date(prev); e.setHours(11, 0, 0, 0)
  assert.equal(slot({ starts_at: s.toISOString(), ends_at: e.toISOString() }, DAY), null)
})
