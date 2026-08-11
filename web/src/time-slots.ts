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
/// ⚠ 2026-08-11 补上 15 分钟档(PRD G1 列的是 15/30/1h/1.5h/2h/3h,此前少了最短那档)——
///   站会、答疑这类一刻钟的事没有快捷键,反而是最该有的:它越短,手填结束时间越不划算。
export const DURATIONS: { m: number; label: string }[] = [
  { m: 15, label: '15 分钟' }, { m: 30, label: '30 分钟' }, { m: 60, label: '1 小时' },
  { m: 90, label: '1.5 小时' }, { m: 120, label: '2 小时' }, { m: 180, label: '3 小时' },
]

/// 当前时长落在哪个快捷档上;不在任何一档 = 「自定义」(PRD G1 的双向绑定)。
/// ★做成纯函数是为了能单测★:双向绑定最容易错在边界(正好 15 分、0、负数、跨天几千分钟),
/// 而这些用界面点不出来。
export function matchDuration(mins: number | null): { m: number; label: string } | null {
  if (mins === null || mins <= 0) return null
  return DURATIONS.find((d) => d.m === mins) ?? null
}

/// 默认开始时刻(PRD G0)。★取不取整由**类型**决定,不写死★ ——
///
/// ⚠ 2026-08-11:此前恒为「下一个整点」,两类活动都不合适 ——
///   · 会议:11:00 是对的,但从 10:05 出发要跳到 11:00,白等了 55 分钟;
///   · 个人记录:「我刚做完、现在记一笔」的真实时刻是 15:37,取整反而要人手动改回去。
///
/// PRD 给的理由是★「参会人看到 15:37 会以为发起人填错了」★ —— 即**取整是为了别人看着不别扭**。
/// 所以判据用 `busy_default`(这类活动默不默认**影响别人**),不是 `has_minutes`(有没有纪要):
/// 后者只是碰巧在两个预置类型上同向,而前者才是取整这件事的**理由本身**。
/// 副作用也是对的 —— 自建一个「组内 standup」并勾了占忙闲,它同样取整,因为别人确实会看到。
///
/// `stepMin` 为 0 或负 = 不取整(返回原时刻)。向上取整:15:37 → 15:45;15:45 → 15:45(已经在格上不动)。
export function defaultStart(now: Date, roundTo = 0): Date {
  const d = new Date(now)
  d.setSeconds(0, 0)
  if (roundTo <= 0) return d
  const m = d.getHours() * 60 + d.getMinutes()
  const up = Math.ceil(m / roundTo) * roundTo
  d.setHours(0, 0, 0, 0)
  return new Date(d.getTime() + up * 60_000)
}

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
