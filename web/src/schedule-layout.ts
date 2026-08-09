// 日历布局的纯函数部分 —— 抽出来是为了**能单测**(schedule-layout.test.ts)。
//
// ★为什么值得单测★:2026-08-07 这里有过一个会**隐藏活动**的 bug ——
// 三个以上重叠时,后来的事件以全宽盖住前面的,用户界面上直接看不到自己的会,
// 而且不报任何错。这种「静默丢东西」的逻辑,靠肉眼看截图是抓不稳的
// (当时两次渲染盖住的还不是同一个)。

/// 布局只关心「什么时候开始、什么时候结束」,不关心活动的其它字段 ——
/// 用最小接口而不是 import Activity,免得纯函数被业务类型绑住(测试里也好造数据)。
export type Span = { starts_at: string; ends_at: string }

export type Box<T> = { item: T; top: number; height: number; left: string; width: string }

/// 一小时多少像素。★与 schedule-view.tsx 的 HOUR_PX 必须一致★
export const HOUR_PX = 30
/// 最小可见高度:15 分钟的会只有 7.5px,连标题都放不下、也点不中
export const MIN_H = 18

/// ★凌晨默认折叠★（2026-08-09 用户）：0–8 点几乎永远是空的，却白占整屏三分之一，
/// 把真正有事的白天挤扁。折叠之后网格从 8 点起画；那一段有活动时，页面顶上给一条提示。
///
/// ⚠ 为什么是「折叠」而不是「压成 2 小时一格」：后者要改**坐标映射**（`hour × HOUR_PX`
/// 不再线性），刻度、事件、分隔线全得走同一个映射函数，而这套坐标有 20 条单测钉着。
/// 折叠只是把原点从 0 点挪到 8 点 —— 一个减法，改动面小得多。★简单的做法先做。★
export const NIGHT_END_H = 8

/// 事件在某一天的纵向位置;不在这一天则 null。跨天事件按当天可见的那段裁剪。
///
/// `fromH` = 网格从几点开始画（折叠凌晨时是 8，展开时是 0）。
/// 完全落在 `fromH` 之前的事件返回 null —— 它在折叠状态下本来就不该出现。
export function slot(s: Span, day: Date, fromH = 0): { top: number; height: number } | null {
  const from0 = new Date(s.starts_at).getTime()
  const to0 = new Date(s.ends_at).getTime()
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1)
  if (to0 <= dayStart.getTime() || from0 >= dayEnd.getTime()) return null
  const gridStart = dayStart.getTime() + fromH * 3600_000
  if (to0 <= gridStart) return null          // 整段都在折叠区里
  const from = Math.max(from0, gridStart)
  const to = Math.min(to0, dayEnd.getTime())
  const gridH = (24 - fromH) * HOUR_PX
  const top0 = ((from - gridStart) / 3600_000) * HOUR_PX
  const h = Math.max(MIN_H, ((to - from) / 3600_000) * HOUR_PX)
  // ★底边必须夹进网格★（2026-08-09 用户：「跨天的会议下面会多出来一节，
  // 导致多了上下滑动的滚轮」）。两种情况都会伸出去：
  //   · 跨天活动：起点在今天、终点在明天 —— 上面按天裁过了，但……
  //   · ★真正的元凶是 MIN_H★：23:50 开始的活动只有 5px，被抬到 18px，
  //     底边就越过午夜 3px；容器被撑高 → 整页多一条竖滚动条。
  // 处置是**把块顶上去**（保住最小可见高度），而不是压扁它 ——
  // 压到 5px 的话既读不出标题也点不中，那正是 MIN_H 当初存在的理由。
  // ⚠ 夹在**纯函数**里而不是靠 CSS 的 overflow 遮住：布局有单测，遮罩没有；
  //   而且「被遮住」和「没算对」在截图上长得一模一样。
  return { top: Math.max(0, Math.min(top0, gridH - h)), height: Math.min(h, gridH) }
}

/// 把一天里的事件排成互不遮挡的盒子。两步:
///   ① **聚簇**——时间上连成一片的归为一簇(簇与簇之间没有任何重叠);
///   ② **簇内分列**——每个事件放进第一个已空出的列,放不下就新开一列,最后按列数平分宽度。
///
/// ★不做「最多两列」这种退化★(上一版的教训):声称退化却没实现,
/// 结果是第三个开始的事件全宽覆盖前面的 —— 活动在界面上凭空消失。
/// 列多了确实窄,但**窄总比看不见强**,而且窄本身就是「这天排太满了」的正确信号。
export function layout<T extends Span>(items: T[], day: Date, fromH = 0): Box<T>[] {
  const placed = items
    .map((item) => ({ item, pos: slot(item, day, fromH) }))
    .filter((x): x is { item: T; pos: { top: number; height: number } } => x.pos !== null)
    // 同起点时短的排前面,让它先占到列,视觉上更稳
    .sort((a, b) => a.pos.top - b.pos.top || a.pos.height - b.pos.height)

  const out: Box<T>[] = []
  let cluster: typeof placed = []
  let clusterEnd = -1

  const flush = () => {
    if (!cluster.length) return
    const colEnds: number[] = []          // colEnds[c] = 第 c 列当前的底边
    const assigned = cluster.map((p) => {
      let c = colEnds.findIndex((end) => p.pos.top >= end)
      if (c === -1) { c = colEnds.length; colEnds.push(0) }
      colEnds[c] = p.pos.top + p.pos.height
      return { p, col: c }
    })
    const n = colEnds.length
    for (const { p, col } of assigned) {
      out.push({
        item: p.item, top: p.pos.top, height: p.pos.height,
        left: `${(col * 100) / n}%`, width: `${100 / n}%`,
      })
    }
    cluster = []
    clusterEnd = -1
  }

  for (const p of placed) {
    if (cluster.length && p.pos.top >= clusterEnd) flush()   // 与当前簇不重叠 → 上一簇收口
    cluster.push(p)
    clusterEnd = Math.max(clusterEnd, p.pos.top + p.pos.height)
  }
  flush()
  return out
}

/// 折叠区(0–`NIGHT_END_H` 点)里藏了几项 —— ★判据是「有没有落在这一段」,不是「几点开始」★。
///
/// ⚠★2026-08-09 liaoruili:「凌晨有活动,没有提醒呢!!」★
/// 提示条一直在,只是数不出来:原来的判据是 `new Date(starts_at).getHours() < NIGHT_END_H`,
/// 而他那两条是 **23:00 跨到次日凌晨**的 —— 起点 23 点不小于 8,数出来是 0;
/// 可它们在次日 00:00–01:00 的那一段**确实被折叠藏了**(`slot` 对整段落在折叠区的返回 null)。
/// ★「几点开始」和「哪一段可见」是两件事,跨天活动把它们劈开了。★
///
/// 按**可见的那几天**逐天判重叠;同一条活动跨两天只算一次(用 index 去重,调用方传的是同一个数组)。
export function nightHiddenCount(items: Span[], days: Date[], nightEndH = NIGHT_END_H): number {
  const hit = new Set<number>()
  for (const d of days) {
    const bandStart = new Date(d); bandStart.setHours(0, 0, 0, 0)
    const bandEnd = new Date(bandStart); bandEnd.setHours(nightEndH, 0, 0, 0)
    items.forEach((m, i) => {
      const from = new Date(m.starts_at).getTime()
      const to = new Date(m.ends_at).getTime()
      // 半开区间求交:结束正好等于 08:00 的不算(它在网格里从 8 点那条线开始,看得见)
      if (from < bandEnd.getTime() && to > bandStart.getTime()) hit.add(i)
    })
  }
  return hit.size
}
