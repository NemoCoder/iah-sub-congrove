// 忙闲条的坐标计算 —— 抽成纯函数是为了**能单测**:
// 这段算错的表现是「条画在错的位置」,肉眼看图很难发现差一点点,而它直接影响排会决策。
//
// ★为什么这张图值得做★(D1):私密项目的日程对发起人**完全隐形**,他排会时看不到别人忙不忙。
// 忙闲图是这条限制的**正面补偿** —— 至少把「公开项目产生的忙」画出来,
// 让他在**选时间那一刻**就看见冲突,而不是等对方事后「建议改期」。
// (私密项目的忙仍然不会出现在这里 —— 那是刻意的,代价由「建议改期」兜。)

/// 显示窗口:一天里排会的时段。★不画 0–24★:凌晨三点没人开会,
/// 全画出来只会把有效区间压扁到看不清。
export const DAY_START_H = 8
export const DAY_END_H = 20

export type Span = { start: string; end: string }
export type Bar = { left: string; width: string; clash: boolean }

/// 把一个时间段映射成百分比坐标;完全落在窗口外则返回 null。
/// `day` 决定看哪一天(忙闲可能跨天,只画与所选日期相交的部分)。
export function toBar(span: Span, day: Date, pick?: Span): Bar | null {
  const winStart = new Date(day); winStart.setHours(DAY_START_H, 0, 0, 0)
  const winEnd = new Date(day); winEnd.setHours(DAY_END_H, 0, 0, 0)
  const total = winEnd.getTime() - winStart.getTime()

  const s = new Date(span.start).getTime()
  const e = new Date(span.end).getTime()
  if (e <= winStart.getTime() || s >= winEnd.getTime()) return null      // 完全在窗口外

  // 裁剪到窗口内 —— 早于 8:00 或晚于 20:00 的部分不画,但**不能因此丢掉整段**
  const from = Math.max(s, winStart.getTime())
  const to = Math.min(e, winEnd.getTime())

  // ★左+宽必须夹在 100% 以内★(2026-08-09 用户:「其他人的忙闲超出了边界」)。
  // 越界的来源是上面那个「至少 1%」的下限:一段 19:58–20:00 的忙,左边算出来 99.7%,
  // 再撑到 1% 宽就是 100.7% —— ★为了让它看得见而加的下限,反过来把它顶出了轨道★。
  // 处置:宽度优先保住(要看得见),左边往回收。
  const w = Math.min(Math.max(((to - from) / total) * 100, 1), 100)
  const l = Math.min(((from - winStart.getTime()) / total) * 100, 100 - w)
  return {
    left: `${l}%`,
    width: `${w}%`,
    clash: pick ? overlaps({ start: span.start, end: span.end }, pick) : false,
  }
}

/// 两个时间段是否重叠。★端点相接不算重叠★:10:00 结束与 10:00 开始的两个会不冲突。
export function overlaps(a: Span, b: Span): boolean {
  return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end)
}

/// 刻度线的位置(整点),给时间轴标注用。
export function ticks(): { h: number; left: string }[] {
  const out: { h: number; left: string }[] = []
  for (let h = DAY_START_H; h <= DAY_END_H; h += 4) {
    out.push({ h, left: `${((h - DAY_START_H) / (DAY_END_H - DAY_START_H)) * 100}%` })
  }
  return out
}
