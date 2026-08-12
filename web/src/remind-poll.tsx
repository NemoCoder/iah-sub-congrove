// 页面内提醒弹窗（PRD F2 的后半截，设计 docs/TECH-DESIGN-M1-remind.md §5）。
//
// 后台循环（src/remind.rs）到点把提醒写进站内信，但站内信要人主动去看；
// F2 要的是**开着页面就能弹出来**。这里每 60 秒问一次「从上次到现在有没有新提醒发给我」。
//
// ★不做 SSE/WebSocket★（设计 §5）：为一个分钟级、低频的提醒拉一条长连接不划算，
// 而且长连接在网关后面还要处理重连、心跳、pod 重启断流 —— 那是比这个功能本身更大的工程。

import { notification, Select } from 'antd'
import { useEffect, useRef } from 'react'
import { api } from './api'

/// 单场提醒的值域（PRD F3 / 设计 §4）。★三态★：
///   `null` = 跟随个人默认（个人也没设则后端兜底 15 分钟，见 remind.rs 的 DEFAULT_REMIND_MIN）
///   `0`    = ★这场不提醒★（拿 0 当哨兵：「提前 0 分钟提醒」本来就无意义，不会和真实值撞）
///   `>0`   = 提前这么多分钟
///
/// ⚠★和「发起」「详情」两个页面共用同一份★：这个列表写两遍的那一刻就已经分叉了 ——
/// 建的时候能选「提前一天」、改的时候选不了，是同一类 bug 里最难发现的那种
/// （两处各自都对，只有并排看才看得出来）。
const REMIND_OPTIONS = [
  { value: null as number | null, label: '跟随个人默认' },
  { value: 0, label: '这场不提醒' },
  { value: 5, label: '提前 5 分钟' },
  { value: 15, label: '提前 15 分钟' },
  { value: 30, label: '提前 30 分钟' },
  { value: 60, label: '提前 1 小时' },
  { value: 1440, label: '提前 1 天' },
]

/// 单场提醒下拉。`null` 与 `0` 是两个不同的意思，所以★不能用 allowClear★——
/// 清空和「这场不提醒」会被读成同一个动作，而它们的行为相反。
export function RemindSelect({ value, onChange, size = 'small', style }: {
  value: number | null | undefined
  onChange: (v: number | null) => void
  size?: 'small' | 'middle'
  style?: React.CSSProperties
}) {
  return (
    <Select
      size={size} style={style}
      value={value ?? null}
      onChange={(v) => onChange(v)}
      options={REMIND_OPTIONS}
    />
  )
}

type Item = { activity_id: number; title: string; starts_at: string; reminded_at: string }
type Resp = { now: string; items: Item[] }

/// 轮询间隔。★60 秒不是随手定的★：后台循环本身 30 秒扫一次，
/// 前端再快也快不过它；而提醒的精度需求是分钟级，60 秒的额外延迟无感。
const TICK_MS = 60_000

/// 提醒轮询。挂在 app.tsx 的登录态里，不渲染任何东西。
export function RemindPoll({ onOpen }: { onOpen: (id: number) => void }) {
  /// ★服务端时间，不是 `Date.now()`★（设计 §5①，后端 `my_reminders` 头注也写了）。
  /// 浏览器时钟比服务器快几秒 → since 一直在未来 → **永远查不到**刚发的提醒；
  /// 慢几秒 → **每轮重弹**同一条。两种偏差都无声无息，用户只会觉得
  /// 「提醒时灵时不灵」，而我们查不出为什么。所以 since 一律用服务端回的 now 原样送回。
  const since = useRef<string | null>(null)
  /// 已经弹过的，防同一条弹两次（两次轮询的窗口理论上不重叠，但网络重试会）。
  const shown = useRef(new Set<number>())

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const q = since.current ? `?since=${encodeURIComponent(since.current)}` : ''
        const r = await api<Resp>(`/api/me/reminders${q}`)
        if (!alive) return
        const first = since.current === null
        since.current = r.now
        // ★首轮只用来对时★：不给 since 时后端回空列表，这里再挡一道，
        // 免得将来后端改了行为、一进页面就被一堆早已开完的会糊脸。
        if (first) return
        for (const it of r.items) {
          if (shown.current.has(it.activity_id)) continue
          // ★已经开始的不弹★：与 remind.rs 的 `starts_at > now()` 同一条判据。
          // 标签页在后台挂了两小时再切回来时，这一条是唯一挡住「一次弹五条早开完的会」的东西。
          // 提醒的价值全在「提前」，会都开始了再弹不只是没用，是**误导**。
          const mins = Math.round((new Date(it.starts_at).getTime() - Date.now()) / 60_000)
          if (mins <= 0) continue
          shown.current.add(it.activity_id)
          notification.open({
            // ⚠★这条原来是一张素白的小卡片★（2026-08-12 liaoruili：「这个通知一点都不醒目！！」）。
            //   它和「已保存」那类顺手提示长得一模一样，而它要说的是**你还有 14 分钟就要开会了** ——
            //   ★重要程度差一个数量级，视觉重量却相同，于是它被当成背景噪声划走。★
            //   三处加重：橙色警示图标 + 把「还有 N 分钟」放大成主角 + 停留不自动消失（本来就是）。
            icon: <span style={{ fontSize: 22 }}>⏰</span>,
            message: <span style={{ fontWeight: 700, fontSize: 15 }}>活动即将开始</span>,
            description: (
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 600 }}>{it.title}</div>
                {/* ★数字是这条通知唯一要人立刻读到的东西★，所以它最大、最红 */}
                <div>还有 <b style={{ fontSize: 22, color: '#cf1322' }}>{mins}</b> 分钟开始</div>
                <div style={{ color: '#8c8c8c', fontSize: 12 }}>点这里直接打开这场活动 ›</div>
              </div>
            ),
            /// ★带一点底色和红边★：白底白卡在浅色页面上几乎看不见
            style: { background: '#fff7e6', border: '1px solid #ffbb96', width: 340, cursor: 'pointer' },
            // ★不自动消失★：人可能刚好离开座位十秒。自动关掉的提醒等于没提醒，
            // 而这里最多同时存在几条（已开始的上面已经滤掉了），不会糊满屏。
            duration: 0,
            onClick: () => { onOpen(it.activity_id); notification.destroy() },
          })
        }
      } catch {
        // ★静默★：轮询失败（网络抖动、pod 滚动更新）不该弹报错打断人。
        // 下一轮自然重试；而 since 没有前进，这一轮该发的下一轮还在。
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), TICK_MS)
    return () => { alive = false; window.clearInterval(t) }
  }, [onOpen])

  return null
}
