// 时间区间选择器的**纯逻辑** —— 抽出来是为了**能单测**(与 schedule-layout / freebusy-layout 同一个套路)。
// 组件在 time-range.tsx,那边只管渲染。
//
// ⚠★2026-08-09 第二版的由来★(liaoruili:「要的不是这样的分钟。而是选择几点,后面只有
//   00 15 30 45 这几个分钟,现在还要下拉。我做这样的目的就是为了方便用户选择时间,减少工作」)。
// 第一版只把 AntD 的分钟列裁到 4 个值,★交互步数一点没少★:
//   展开 → 滚小时 → 点 → 滚分钟 → 点 = 5 步。
// 现在照腾讯会议 / Google 日历:**一列现成的时刻**,一次点击同时定下时与分 = 2 步。

/// ★一刻钟四格★:00 / 15 / 30 / 45。会不会约在 8:07？不会。
/// (「60」就是下一小时的 00 —— 在扁平列表里它本来就在下一行,不需要单独是个选项。)
export const STEP_MIN = 15
/// 一天里的候选时刻数(96)
export const SLOTS_PER_DAY = (24 * 60) / STEP_MIN

/// 持续时长快捷。★先定「开多久」再算结束时刻★ ——
/// 人脑里想的是「开一小时」,不是「10:00 到 11:00」。
export const DURATIONS: { m: number; label: string }[] = [
  { m: 30, label: '30 分钟' }, { m: 60, label: '1 小时' },
  { m: 90, label: '1.5 小时' }, { m: 120, label: '2 小时' }, { m: 180, label: '3 小时' },
]

/// 分钟偏移 → `HH:mm`
export function hhmm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

/// 时长的人话。★整小时不写「1.0 小时」★;半小时写「1.5 小时」;不足一小时用分钟。
export function fmtDur(mins: number): string {
  if (mins < 60) return `${mins} 分钟`
  const h = mins / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`
}

/// 一天里的候选时刻(分钟偏移)。`afterMin` 给「今天不能选过去」和「结束必须晚于开始」用。
/// ★不做成「从 afterMin 开始按步长生成」★:那样会得到 09:07 / 09:22 这种错位的刻度 ——
/// 候选必须始终落在整刻钟上,只是把早于 afterMin 的**筛掉**。
export function slots(afterMin?: number): number[] {
  const out: number[] = []
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const m = i * STEP_MIN
    if (afterMin !== undefined && m < afterMin) continue
    out.push(m)
  }
  return out
}
