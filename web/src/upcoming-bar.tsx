// 「接下来 7 天」摘要条（2026-08-12 liaoruili 拍板）。
//
// ══════ 这条为什么存在 ══════
// 原话：「我主要是作为用户，我想知道哪些会议已经参加，然后后续大概有什么，我需要有数调整我的时间。」
// ★他要的不是一个「打卡确认」的动作，是**时间上的方位感**★：哪些在身后、哪些在身前。
// 身后那一半交给日历淡化（`isEnded` + 图例）；身前这一半靠这条。
//
// 拍板结论（相位 0/2，三问三答）：
//   ① 只做纯呈现，★不加任何新状态★ —— 不做「我到了/没到」的打卡，
//      因为它给每个人加一件天天要做的杂事，而换来的信息多数时候和「接受了且开完了」没区别；
//   ② 不做「回顾」视图；
//   ③ 前瞻**只看 7 天**。
//
// ⚠★为什么要自己取一次数，而不是复用日历已经加载的 items★：
//   日历加载的是**当前可视范围**（翻到上个月就是上个月那 42 天）。
//   而「接下来 7 天」是**相对此刻**的，跟你正在看哪一页无关 ——
//   复用 items 的话，一翻页这条就开始胡说八道，且不会报错。
import { Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Activity } from './api'
import { fmtDay, fmtHM, fmtWeek } from './tz'

/// ⚠ 原来这里也抄了一份 pad/星期表(2026-08-12 收敛进 tz.ts,见 todo-card 的注释)。
const 时刻 = (t: string) => `${fmtWeek(t)} ${fmtDay(t).split(' ')[0]} ${fmtHM(t)}`

export function UpcomingBar({ reloadKey, onOpen }: {
  /// 日历每次重载就 +1，让这条跟着刷新（答复完一条邀请，计数要当场变）
  reloadKey: number
  onOpen: (id: number) => void
}) {
  const [rows, setRows] = useState<Activity[] | null>(null)

  useEffect(() => {
    let dead = false
    const now = new Date()
    const to = new Date(now.getTime() + 7 * 864e5)
    // ★from 用「此刻」不用「今天零点」★：正在开的那场要算进来（后端判据是区间相交），
    // 而今天早上已经开完的那些不该再出现在「接下来」里。
    api<Activity[]>(`/api/activities?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then((r) => { if (!dead) setRows(r) })
      .catch(() => { if (!dead) setRows([]) })   // 静默：这是一条辅助信息，挂了不该弹错打断人
    return () => { dead = true }
  }, [reloadKey])

  if (rows === null) return null                 // 还没拉回来时不占位，免得整页跳一下

  // ⚠ 后端返回的是**区间相交**的活动，其中包含「今天早上已经开完」的那些
  //   （它们 ends_at < now 但 starts_at < to 且 ends_at > from 不成立…… 实际不会进来，
  //   但取消掉的、已结束的都再滤一道：★这条的全部价值就是「还没发生的事」★）。
  const 未来 = rows.filter((m) => new Date(m.ends_at).getTime() >= Date.now())
  const 待答复 = 未来.filter((m) => m.my_status === 'pending').length
  const 最近 = [...未来].sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0]

  const box: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    padding: '6px 10px', marginBottom: 8, borderRadius: 6,
    background: '#fafafa', border: '1px solid #f0f0f0', fontSize: 12,
  }

  if (!未来.length) {
    return (
      <div style={box}>
        <Typography.Text type="secondary">接下来 7 天没有安排。</Typography.Text>
      </div>
    )
  }

  return (
    <div style={box}>
      <span style={{ color: '#595959' }}>
        接下来 7 天 <b style={{ color: '#0d9488' }}>{未来.length}</b> 场
      </span>
      {/* ★待答复单独拎出来★：它是这 7 天里**唯一需要我现在动手**的东西。
          0 的时候不显示 —— 一个恒亮的「待答复 0」等于没有信号。 */}
      {待答复 > 0 && <Tag color="red" style={{ margin: 0 }}>待答复 {待答复}</Tag>}
      {最近 && (
        <span style={{ color: '#8c8c8c' }}>
          · 最近一场{' '}
          {/* 点得进去：看到「最近一场是周四的评审会」，下一步一定是「点开看看」 */}
          <a onClick={() => onOpen(最近.id)}>
            {时刻(最近.starts_at)} {最近.title}
          </a>
        </span>
      )}
    </div>
  )
}
