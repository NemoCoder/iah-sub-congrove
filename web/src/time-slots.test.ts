import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DURATIONS, SLOTS_PER_DAY, STEP_MIN, fmtDur, hhmm, slots } from './time-slots.ts'

test('一天 96 个候选，全部落在整刻钟上', () => {
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
test('筛掉早于下限的，而不是从下限重新起算', () => {
  const after = slots(9 * 60 + 7)          // 09:07 之后
  assert.equal(hhmm(after[0]), '09:15', '第一个候选应是 09:15，不是 09:07')
  assert.ok(after.every((m) => m % STEP_MIN === 0), '★仍然全在整刻钟上★')
})

test('下限恰好落在刻度上时，该刻度本身保留', () => {
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
    assert.equal(d.m % STEP_MIN, 0, `${d.label} = ${d.m} 分钟，不是 ${STEP_MIN} 的整数倍`)
    assert.equal(fmtDur(d.m), d.label.replace(/\s/g, ' '), `按钮文案与 fmtDur 应当一致：${d.label}`)
  }
})

// ── G0/G1（2026-08-11）──────────────────────────────────────────────
import { defaultStart, matchDuration } from './time-slots.ts'

test('★取整只发生在「别人会看到」的类型上★（G0）', () => {
  // 15:37 —— PRD 举的就是这个例子
  const t = new Date(2026, 7, 11, 15, 37, 42, 500)
  assert.equal(defaultStart(t, 0).getMinutes(), 37, '不取整时要保住真实时刻（个人记录「我刚做完，现在记」）')
  assert.equal(defaultStart(t, 0).getSeconds(), 0, '秒要抹掉——15:37:42 这种时间没人想看')
  const r = defaultStart(t, 15)
  assert.equal(`${r.getHours()}:${r.getMinutes()}`, '15:45', '会议向上取到下一个一刻钟')
})

test('已经在刻度上就别动它（G0 边界）', () => {
  // ⚠ 用 ceil 而不是「加一格再取整」——后者会把 15:45 顶到 16:00，
  //   于是「我就想 15:45 开会」的人每次都得手动改回去。
  const t = new Date(2026, 7, 11, 15, 45, 0, 0)
  const r = defaultStart(t, 15)
  assert.equal(`${r.getHours()}:${r.getMinutes()}`, '15:45')
})

test('取整跨到下一个小时 / 跨到明天（G0 边界）', () => {
  const a = defaultStart(new Date(2026, 7, 11, 15, 46), 15)
  assert.equal(`${a.getHours()}:${a.getMinutes()}`, '16:0', '15:46 → 16:00')
  const b = defaultStart(new Date(2026, 7, 11, 23, 50), 15)
  assert.equal(b.getDate(), 12, '23:50 → 次日 00:00，日期要跟着进位')
  assert.equal(`${b.getHours()}:${b.getMinutes()}`, '0:0')
})

test('时长落在哪一档 / 落不到就是「自定义」（G1 双向绑定）', () => {
  assert.equal(matchDuration(60)?.label, '1 小时')
  assert.equal(matchDuration(15)?.label, '15 分钟', '★15 分钟这一档是本次补的★')
  assert.equal(matchDuration(45), null, '45 分钟不在预设里 → 自定义')
  assert.equal(matchDuration(3 * 24 * 60), null, '跨天（出差 3 天）→ 自定义，PRD 明说快捷只覆盖小时级')
  assert.equal(matchDuration(0), null, '0 不是一个时长')
  assert.equal(matchDuration(-30), null, '负数（结束早于开始）不该匹配上任何一档')
  assert.equal(matchDuration(null), null)
})
