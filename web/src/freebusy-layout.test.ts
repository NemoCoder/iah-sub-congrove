import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DAY_END_H, DAY_START_H, overlaps, ticks, toBar } from './freebusy-layout.ts'

const DAY = new Date(2026, 7, 13)
/// 造当天某时段(本地时区,与组件渲染一致)
const at = (h: number, durH = 1) => {
  const s = new Date(DAY); s.setHours(h, 0, 0, 0)
  const e = new Date(s); e.setMinutes(e.getMinutes() + durH * 60)
  return { start: s.toISOString(), end: e.toISOString() }
}

test('窗口正中的一小时:8–20 共 12 小时，14:00 应在正中', () => {
  const b = toBar(at(14), DAY)!
  assert.equal(b.left, '50%')
  assert.equal(b.width, `${(1 / 12) * 100}%`)
})

test('窗口起点对齐 0%', () => {
  assert.equal(toBar(at(DAY_START_H), DAY)!.left, '0%')
})

/// ★早于 8:00 的部分裁掉,但不能因此丢掉整段★
test('跨窗口起点:只画窗口内的那半截', () => {
  const b = toBar(at(7, 2), DAY)!      // 07:00–09:00
  assert.equal(b.left, '0%', '被裁的部分应当从 0 开始画')
  assert.equal(b.width, `${(1 / 12) * 100}%`, '只画 08:00–09:00 这一小时')
})

test('完全在窗口外的返回 null', () => {
  assert.equal(toBar(at(5), DAY), null, '凌晨的会不该出现在 8–20 的图里')
  assert.equal(toBar(at(DAY_END_H + 1), DAY), null)
})

/// ★短会也要看得见★:15 分钟只占 2%,不给最小宽度就是一条看不见的线
test('极短的会有最小可见宽度', () => {
  const s = new Date(DAY); s.setHours(10, 0, 0, 0)
  const e = new Date(s); e.setMinutes(5)
  const b = toBar({ start: s.toISOString(), end: e.toISOString() }, DAY)!
  assert.ok(parseFloat(b.width) >= 1, '短会窄到看不见等于没画')
})

test('与本次活动重叠的标记为冲突', () => {
  const pick = at(10, 2)                       // 本次 10:00–12:00
  assert.equal(toBar(at(11), DAY, pick)!.clash, true, '11:00 落在本次时段内')
  assert.equal(toBar(at(14), DAY, pick)!.clash, false)
})

/// ★端点相接不算冲突★:上一个会 10:00 结束、这个 10:00 开始,是可以的
test('端点相接不算冲突', () => {
  assert.equal(overlaps(at(9), at(10)), false, '9–10 与 10–11 不冲突')
  assert.equal(overlaps(at(9, 1.5), at(10)), true, '9–10:30 与 10–11 冲突')
})

test('刻度覆盖整个窗口', () => {
  const t = ticks()
  assert.equal(t[0].left, '0%')
  assert.equal(t[t.length - 1].h, DAY_END_H)
  assert.equal(t[t.length - 1].left, '100%')
})

/// ★左+宽不许越过 100%★(2026-08-09 用户:「其他人的忙闲超出了边界」)。
/// 越界不是画错位置,而是**画到轨道外面**去 —— 在卡片里表现为一条糊出边框的灰条。
/// 起因是「至少 1% 宽」这个为了可见性加的下限:靠窗口末尾的短会被它顶出去。
test('贴着窗口末尾的短会不越界', () => {
  const s = new Date(DAY); s.setHours(DAY_END_H - 1, 58, 0, 0)   // 19:58
  const e = new Date(DAY); e.setHours(DAY_END_H, 0, 0, 0)        // 20:00
  const b = toBar({ start: s.toISOString(), end: e.toISOString() }, DAY)!
  assert.ok(parseFloat(b.width) >= 1, '仍然要看得见')
  assert.ok(parseFloat(b.left) + parseFloat(b.width) <= 100 + 1e-9,
    `left+width=${parseFloat(b.left) + parseFloat(b.width)} 超出轨道`)
})

/// 反向:正常时段的坐标不能因为夹逼而挪位(夹逼只该在越界时生效)
test('不越界的条坐标不受影响', () => {
  const b = toBar(at(10, 2), DAY)!               // 10:00–12:00
  assert.equal(b.left, `${((10 - DAY_START_H) / (DAY_END_H - DAY_START_H)) * 100}%`)
  assert.equal(b.width, `${(2 / (DAY_END_H - DAY_START_H)) * 100}%`)
})
