// 「选一段时间」—— ★全站唯一的时间区间选择器★。
//
// ⚠★2026-08-09 建这个文件的原因★:liaoruili 报「改时间怎么到了时分秒。。。。我的 00 15 30 45 呢」。
// 当时树里有**三个**各写各的 `DatePicker.RangePicker`:
//   · 发起活动 —— 我刚给它做了一刻钟粒度 + 免确认;
//   · 活动详情「改时间」弹窗 —— 裸 `showTime`,于是有秒、分钟 60 格、还要点一次确认;
//   · 「建议改期」—— 又是第三种写法。
// ★「一刻钟」这个规则被我写进了其中一个,另外两个当然不知道★ —— 这正是本仓库反复强调的
// 「每样东西只有一个真相源」在 UI 上的同一个坑:改一处 ≠ 改了这件事。
// 现在三处都用这个组件;要调粒度、格式、确认方式,只有这里一个地方。
import { DatePicker } from 'antd'
import dayjs from 'dayjs'

/// ★分钟只走一刻钟★:00 / 15 / 30 / 45。会不会约在 8:07？不会。
/// 而默认给 60 行分钟,常用的那四个要滚很久才够得着 —— 多出来的 56 个选项**只制造滚动**。
export const MINUTES = [0, 15, 30, 45]
const BAD_MINUTES = Array.from({ length: 60 }, (_, i) => i).filter((m) => !MINUTES.includes(m))

/// 持续时长快捷（参考腾讯会议）。★先定「开多久」再算结束时刻★ ——
/// 人脑里想的是「开一小时」，不是「10:00 到 11:00」；让人心算结束时间是白饶的一步。
export const DURATIONS: { m: number; label: string }[] = [
  { m: 30, label: '30 分钟' }, { m: 60, label: '1 小时' },
  { m: 90, label: '1.5 小时' }, { m: 120, label: '2 小时' }, { m: 180, label: '3 小时' },
]

type RangeProps = React.ComponentProps<typeof DatePicker.RangePicker>

/// `noPast`:禁掉今天以前的日期与今天已经过去的时刻。
/// ★不是默认开★ —— 后端只在**创建**时拒绝过去的时间(activities.rs 的 5 分钟容差闸),
/// **改时间没有这条限制**,因为那也用来**补录**已经开过的会。
/// 界面比后端更严会让人做不成后端允许的事,而这种「不知道为什么点不了」最难查。
export function QuarterRangePicker({ noPast = false, ...rest }: RangeProps & { noPast?: boolean }) {
  return (
    <DatePicker.RangePicker
      // ★不给秒★:排会精确到秒没有意义,而多一列就多一次滚动
      showTime={{ format: 'HH:mm' }}
      format="YYYY-MM-DD HH:mm"
      // ★needConfirm={false}★:选完分钟就算数、光标自己跳到结束时间,不再点一次「确定」。
      // 那一步是纯仪式 —— 时间已经选好了,再确认一遍只是在问「你确定你刚才点的是你点的吗」。
      needConfirm={false}
      disabledDate={(d) => (noPast ? !!d && d.isBefore(dayjs().startOf('day')) : false)}
      disabledTime={(d) => {
        const isToday = noPast && !!d && d.isSame(dayjs(), 'day')
        const now = dayjs()
        return {
          disabledHours: () => (isToday ? Array.from({ length: now.hour() }, (_, i) => i) : []),
          // ★两条限制在这里合流★:不是一刻钟的分钟一律禁;今天的当前小时里,
          // 还要额外禁掉已经过去的那几个。漏掉后半句就能选出「过去的整点」。
          disabledMinutes: (h: number) => (isToday && h === now.hour()
            ? [...new Set([...BAD_MINUTES, ...Array.from({ length: now.minute() }, (_, i) => i)])]
            : BAD_MINUTES),
        }
      }}
      {...rest}
    />
  )
}
