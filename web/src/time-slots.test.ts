import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DURATIONS, SLOTS_PER_DAY, STEP_MIN, fmtDur, hhmm, slots } from './time-slots.ts'

test('一天 96 个候选,全部落在整刻钟上', () => {
  const all = slots()
  assert.equal(all.length, SLOTS_PER_DAY)
  assert.equal(all.length, 96)
  assert.ok(all.every((m) => m % STEP_MIN === 0), '★候选必须都在整刻钟上★')
  assert.equal(hhmm(all[0]), '00:00')
  assert.equal(hhmm(all[all.length - 1]), '23:45')
})

/// ★这条是这个文件的重点★:筛而不是重新起算。
/// 从 09:07 开始按步长生成会得到 09:07 / 09:22 / 09:37 —— 刻度错位,
/// 而错位之后每一个时间看着都「像个时间」,不会有任何报错。
test('筛掉早于下限的,而不是从下限重新起算', () => {
  const after = slots(9 * 60 + 7)          // 09:07 之后
  assert.equal(hhmm(after[0]), '09:15', '第一个候选应是 09:15,不是 09:07')
  assert.ok(after.every((m) => m % STEP_MIN === 0), '★仍然全在整刻钟上★')
})

test('下限恰好落在刻度上时,该刻度本身保留', () => {
  const after = slots(9 * 60)
  assert.equal(hhmm(after[0]), '09:00')
})

test('时长的人话', () => {
  assert.equal(fmtDur(15), '15 分钟')
  assert.equal(fmtDur(45), '45 分钟')
  assert.equal(fmtDur(60), '1 小时', '★整小时不写 1.0★')
  assert.equal(fmtDur(90), '1.5 小时')
  assert.equal(fmtDur(120), '2 小时')
  assert.equal(fmtDur(180), '3 小时')
})

/// 快捷按钮的时长必须都能被刻度整除,否则点完之后结束时间落在候选之外 ——
/// 下拉里选不中自己刚设的值,看着像 bug。
test('每个快捷时长都落在刻度上', () => {
  for (const d of DURATIONS) {
    assert.equal(d.m % STEP_MIN, 0, `${d.label} = ${d.m} 分钟,不是 ${STEP_MIN} 的整数倍`)
    assert.equal(fmtDur(d.m), d.label.replace(/\s/g, ' '), `按钮文案与 fmtDur 应当一致:${d.label}`)
  }
})
