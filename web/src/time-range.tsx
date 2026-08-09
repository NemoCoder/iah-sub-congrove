// 「选一段时间」—— ★全站唯一的时间区间选择器★。
//
// ⚠★2026-08-09 第二版:整块重写成「扁平时间列」★(liaoruili:「要的不是这样的分钟。
//   而是选择几点,后面只有 00 15 30 45 这几个分钟,现在还要下拉。我做这样的目的
//   就是为了方便用户选择时间,减少工作」)。
//
// 第一版只是把 AntD 的分钟列裁到 4 个值,★交互步数一点没少★:
//   展开 → 滚小时列 → 点小时 → 滚分钟列 → 点分钟 = 5 步。
// 现在照腾讯会议 / Google 日历那套:**一列现成的时刻**,点一下同时定下时与分 = 2 步。
//   · 开始:`08:00 / 08:15 / 08:30 …` 一列到底;
//   · 结束:★只列开始之后的时刻,并在右边直接标出时长★(「1小时」「1.5小时」)——
//     人心里想的是「开多久」,让他自己从两个时刻里心算时长是白饶的一步;
//   · 再加一排持续时长按钮,连结束时间那一列都不用点。
//
// ★为什么不继续用 DatePicker.RangePicker★:它的时间面板天生是「时/分/秒」分列滚动的,
// 那是**为任意精度设计的**;而排会只需要 96 个候选,把它们摆平比让人在两列里对齐快得多。
// 日期仍然用 DatePicker(日历比列表更适合选日期)。
import { Button, DatePicker, Select, Space, Typography } from 'antd'
import { useMemo } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
// ★纯逻辑在 time-slots.ts★:那边有单测(候选必须落在整刻钟上等),这边只管渲染。
import { DURATIONS, STEP_MIN, fmtDur, hhmm, slots } from './time-slots'


export function TimeRangePicker({ value, onChange, noPast = false, size }: {
  value?: [Dayjs, Dayjs] | null
  onChange?: (v: [Dayjs, Dayjs] | null) => void
  /// 禁掉今天以前的日期与今天已过去的时刻。
  /// ★不是默认开★ —— 后端只在**创建**时拒绝过去的时间(activities.rs 的 5 分钟容差闸),
  /// **改时间没有这条限制**,因为那也用来**补录**已经开过的会。
  /// 界面比后端更严会让人做不成后端允许的事,而这种「不知道为什么点不了」最难查。
  noPast?: boolean
  size?: 'small' | 'middle'
}) {
  const [s, e] = value ?? [null, null]
  const now = dayjs()

  /// 起点缺省:下一个整点(最常见的意图「现在建个会」)。
  const fallbackStart = useMemo(() => now.add(1, 'hour').startOf('hour'), [/* 每次渲染重算无妨 */ now])

  const emit = (ns: Dayjs, ne: Dayjs) => onChange?.([ns, ne])

  /// 改开始:★结束跟着平移,保持原时长★ —— 把会整体挪一小时,不该顺带把它变短。
  const setStart = (ns: Dayjs) => {
    const dur = s && e ? e.diff(s, 'minute') : 60
    emit(ns, ns.add(Math.max(dur, STEP_MIN), 'minute'))
  }
  const setEnd = (ne: Dayjs) => emit(s ?? fallbackStart, ne)
  const setDuration = (m: number) => {
    const ns = s ?? fallbackStart
    emit(ns, ns.add(m, 'minute'))
  }

  const curStart = s ?? null
  const curEnd = e ?? null
  const durMin = curStart && curEnd ? curEnd.diff(curStart, 'minute') : null

  // ── 开始时刻的候选 ──
  const startDay = curStart ?? fallbackStart
  const startIsToday = startDay.isSame(now, 'day')
  const startOpts = useMemo(() => {
    const after = noPast && startIsToday ? now.hour() * 60 + now.minute() : undefined
    return slots(after).map((m) => ({ value: m, label: hhmm(m) }))
  }, [noPast, startIsToday, now])

  // ── 结束时刻的候选:★只列开始之后的,右边标时长★ ──
  const endDay = curEnd ?? startDay
  const sameDay = curStart ? endDay.isSame(curStart, 'day') : true
  const endOpts = useMemo(() => {
    const base = curStart ?? fallbackStart
    // 同一天:从开始时刻的下一格起;跨天:整天都能选(时长由日期差补上)
    const after = sameDay ? base.hour() * 60 + base.minute() + STEP_MIN : undefined
    return slots(after).map((m) => {
      const cand = endDay.startOf('day').add(m, 'minute')
      const d = cand.diff(base, 'minute')
      return {
        value: m,
        label: hhmm(m),
        // ★时长直接摆在选项里★:省掉「11:30 减 10:00 等于多久」这一次心算
        title: d > 0 ? fmtDur(d) : undefined,
        dur: d > 0 ? fmtDur(d) : '',
      }
    })
  }, [curStart, endDay, sameDay, fallbackStart])

  const minOf = (d: Dayjs) => d.hour() * 60 + d.minute()
  const wide = size === 'small' ? 96 : 108

  return (
    <div>
      <Space size={8} wrap style={{ display: 'flex' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, width: 28, flexShrink: 0 }}>开始</Typography.Text>
        <DatePicker size={size} value={curStart} allowClear={false} format="YYYY-MM-DD"
          disabledDate={(d) => (noPast ? !!d && d.isBefore(now.startOf('day')) : false)}
          onChange={(d) => { if (d) setStart(d.startOf('day').add(curStart ? minOf(curStart) : minOf(fallbackStart), 'minute')) }} />
        <Select size={size} style={{ width: wide }} placeholder="时间" showSearch
          value={curStart ? minOf(curStart) : undefined}
          // 输入「930」「9:30」都能筛到 —— 键盘党比点两下更快
          filterOption={(input, opt) => (opt?.label ?? '').replace(':', '').includes(input.replace(':', ''))}
          options={startOpts}
          onChange={(m: number) => setStart(startDay.startOf('day').add(m, 'minute'))} />
      </Space>

      <Space size={8} wrap style={{ display: 'flex', marginTop: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, width: 28, flexShrink: 0 }}>结束</Typography.Text>
        <DatePicker size={size} value={curEnd} allowClear={false} format="YYYY-MM-DD"
          disabledDate={(d) => !!d && !!curStart && d.isBefore(curStart.startOf('day'))}
          onChange={(d) => { if (d) setEnd(d.startOf('day').add(curEnd ? minOf(curEnd) : minOf(startDay) + 60, 'minute')) }} />
        <Select size={size} style={{ width: wide }} placeholder="时间" showSearch
          value={curEnd ? minOf(curEnd) : undefined}
          filterOption={(input, opt) => (opt?.label ?? '').replace(':', '').includes(input.replace(':', ''))}
          options={endOpts}
          optionRender={(o) => (
            <Space size={8} style={{ display: 'flex' }}>
              <span>{o.data.label}</span>
              <span style={{ marginLeft: 'auto', color: '#8c8c8c', fontSize: 12 }}>{o.data.dur}</span>
            </Space>
          )}
          onChange={(m: number) => setEnd(endDay.startOf('day').add(m, 'minute'))} />
        {durMin !== null && durMin > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>共 {fmtDur(durMin)}</Typography.Text>
        )}
      </Space>

      {/* ★持续时长快捷★:点一下连结束那一列都不用开。
          还没选开始时间时也能用 —— 那就从「下一个整点」起算。 */}
      <Space size={4} wrap style={{ marginTop: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, width: 28, flexShrink: 0 }}>持续</Typography.Text>
        {DURATIONS.map((d) => (
          <Button key={d.m} size="small" type={durMin === d.m ? 'primary' : 'default'}
            onClick={() => setDuration(d.m)}>{d.label}</Button>
        ))}
      </Space>
    </div>
  )
}
