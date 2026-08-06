// 日程页 —— 周视图日历(左/主)+ 待我处理(右)。对应 docs/prototype-m1.html 的 `cal` 视图。
//
// ★这几条布局是用户在原型上逐条敲定的,别"顺手优化"回去★:
//   · **日历在上、通知在下**——日历是主体,通知是「接下来要我做的事」;
//   · **待我处理放右边**,不是左边(左边留给日历,它需要横向空间);
//   · ★0–24 点全部展开、不滚动★——「我建议不要做成可滑动的」。行高 30px,24 小时共 720px;
//   · ★周末也要显示,且周日是每周第一天★;
//   · 12–14 点**不折叠**(午休也可能排会)。
//
// 颜色三分(与后端 is_private / my_status 对齐,图例在日历下方):
//   公开项目的会 = 青色实框 / 私密项目的会 = 紫色虚框 / 待你应答 = 红色。
import { App as AntdApp, Badge, Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Meeting } from './api'

/// 一天在日历里的高度:24 小时 × 30px。★改这个值要同时改 HOUR_PX★
const HOUR_PX = 30
const DAY_PX = HOUR_PX * 24

/// 本地日期工具。★不引 dayjs 之类的库★:只需要「周的起止」和「格式化」两件事,
/// 而 AntD 已经带了 dayjs —— 但这里刻意只用原生 Date,免得把时区处理散到两套 API 里。
/// ⚠ 全部按**浏览器本地时区**渲染;后端存的是 timestamptz,ISO 串带偏移,Date 会自己转对。
function startOfWeek(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  // ★周日为每周第一天★(用户明确要求):getDay() 周日=0,直接减即可
  x.setDate(x.getDate() - x.getDay())
  return x
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/// 会议在某一天的纵向位置。跨天会议按当天可见的那段裁剪。
function slot(m: Meeting, day: Date): { top: number; height: number } | null {
  const s = new Date(m.starts_at)
  const e = new Date(m.ends_at)
  const dayStart = new Date(day)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = addDays(dayStart, 1)
  if (e <= dayStart || s >= dayEnd) return null
  const from = Math.max(s.getTime(), dayStart.getTime())
  const to = Math.min(e.getTime(), dayEnd.getTime())
  const top = ((from - dayStart.getTime()) / 3600_000) * HOUR_PX
  // ★最小高度 18px★:15 分钟的会只有 7.5px,连标题都放不下,点都点不中
  const height = Math.max(18, ((to - from) / 3600_000) * HOUR_PX)
  return { top, height }
}

/// 同一天里时间重叠的会并排放,避免完全盖住。
/// ★只做两列★(原型也是 half-l / half-r):三个以上重叠属于极端情况,
/// 再细分就窄到看不清了,那种情况本来就该去看列表。
function layout(items: Meeting[], day: Date) {
  const placed = items
    .map((m) => ({ m, pos: slot(m, day) }))
    .filter((x): x is { m: Meeting; pos: { top: number; height: number } } => x.pos !== null)
    .sort((a, b) => a.pos.top - b.pos.top)
  const out: { m: Meeting; top: number; height: number; left: string; width: string }[] = []
  for (const cur of placed) {
    const overlap = out.find((o) => cur.pos.top < o.top + o.height && o.top < cur.pos.top + cur.pos.height)
    if (overlap && overlap.width === '100%') {
      // 前一个让出右半边,自己占右半 —— 两个并排,都还看得见标题
      overlap.width = '50%'
      out.push({ m: cur.m, top: cur.pos.top, height: cur.pos.height, left: '50%', width: '50%' })
    } else {
      out.push({ m: cur.m, top: cur.pos.top, height: cur.pos.height, left: '0', width: '100%' })
    }
  }
  return out
}

/// 会议在日历上的配色:待我应答优先(它是要我动作的),其次按项目可见性。
function evStyle(m: Meeting): React.CSSProperties {
  if (m.my_status === 'pending') return { background: '#fff1f0', border: '1px solid #ff4d4f', color: '#a8071a' }
  if (m.is_private) return { background: '#f9f0ff', border: '1px dashed #722ed1', color: '#531dab' }
  return { background: '#e6fffb', border: '1px solid #0d9488', color: '#00474f' }
}

export function ScheduleView({ onOpenMeeting, onNewMeeting }: {
  onOpenMeeting: (id: number) => void
  onNewMeeting: () => void
}) {
  const { message } = AntdApp.useApp()
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()))
  const [items, setItems] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor])
  const today = new Date()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = anchor.toISOString()
      const to = addDays(anchor, 7).toISOString()
      setItems(await api<Meeting[]>(`/api/meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))
    } catch (e) {
      message.error((e as Error).message)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [anchor, message])
  useEffect(() => { void load() }, [load])

  // 待我处理:待应答的会 = 需要我动作的事。★按开始时间排,最近的在最上★
  const todo = useMemo(
    () => items.filter((m) => m.my_status === 'pending').sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [items],
  )

  const title = `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月 ${anchor.getDate()} – ${addDays(anchor, 6).getDate()} 日`

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 主体:日历 */}
      <Card style={{ flex: 1, minWidth: 0 }} styles={{ body: { padding: 16 } }}>
        <Space wrap style={{ marginBottom: 12, width: '100%' }}>
          <Typography.Text strong style={{ fontSize: 15 }}>{title}</Typography.Text>
          <Button size="small" onClick={() => setAnchor(addDays(anchor, -7))}>‹</Button>
          <Button size="small" onClick={() => setAnchor(startOfWeek(new Date()))}>今天</Button>
          <Button size="small" onClick={() => setAnchor(addDays(anchor, 7))}>›</Button>
          <span style={{ flex: 1 }} />
          <Button size="small" type="primary" onClick={onNewMeeting}>+ 发起会议</Button>
        </Space>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {/* 表头:时间轴列 + 7 天 */}
            <div style={{ display: 'grid', gridTemplateColumns: `48px repeat(7, minmax(90px, 1fr))`, minWidth: 700 }}>
              <div />
              {days.map((d, i) => {
                const weekend = i === 0 || i === 6
                const isToday = isSameDay(d, today)
                return (
                  <div key={i} style={{
                    padding: '6px 4px', textAlign: 'center', fontSize: 12,
                    borderBottom: '1px solid #f0f0f0',
                    background: isToday ? '#e6fffb' : weekend ? '#fafafa' : undefined,
                    fontWeight: isToday ? 600 : 400,
                    color: isToday ? '#00474f' : weekend ? '#8c8c8c' : undefined,
                  }}>
                    {WEEK_LABEL[d.getDay()]} {d.getDate()}{isToday && ' · 今天'}
                  </div>
                )
              })}
            </div>

            {/* 网格:★0–24 点全展开,不滚动★ */}
            <div style={{ display: 'grid', gridTemplateColumns: `48px repeat(7, minmax(90px, 1fr))`, minWidth: 700 }}>
              {/* 时间轴 */}
              <div style={{ position: 'relative', height: DAY_PX }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{
                    position: 'absolute', top: h * HOUR_PX, right: 6, fontSize: 11, color: '#bfbfbf',
                    transform: 'translateY(-6px)',
                  }}>{h === 0 ? '' : `${h}:00`}</div>
                ))}
              </div>
              {days.map((d, i) => {
                const weekend = i === 0 || i === 6
                return (
                  <div key={i} style={{
                    position: 'relative', height: DAY_PX,
                    borderLeft: '1px solid #f0f0f0',
                    background: weekend ? '#fafafa' : undefined,
                    // 每小时一条横线:用 repeating gradient,省掉 24 个 DOM 节点 × 7 列
                    backgroundImage: `repeating-linear-gradient(#f5f5f5 0 1px, transparent 1px ${HOUR_PX}px)`,
                  }}>
                    {layout(items, d).map(({ m, top, height, left, width }) => (
                      <div
                        key={m.id}
                        onClick={() => onOpenMeeting(m.id)}
                        title={`${m.title} ${hhmm(new Date(m.starts_at))}–${hhmm(new Date(m.ends_at))}${m.is_private ? ' · 私密' : ''}`}
                        style={{
                          position: 'absolute', top, height, left, width,
                          borderRadius: 3, padding: '1px 4px', fontSize: 11, lineHeight: 1.3,
                          overflow: 'hidden', cursor: 'pointer', boxSizing: 'border-box',
                          ...evStyle(m),
                        }}
                      >
                        {m.title}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 图例:三种颜色各是什么 */}
        <Space size={16} style={{ marginTop: 12, fontSize: 12, flexWrap: 'wrap' }}>
          <LegendDot style={{ background: '#e6fffb', border: '1px solid #0d9488' }} text="公开项目" />
          <LegendDot style={{ background: '#f9f0ff', border: '1px dashed #722ed1' }} text="私密项目" />
          <LegendDot style={{ background: '#fff1f0', border: '1px solid #ff4d4f' }} text="待你应答" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            私密项目的会不占别人眼里的忙闲
          </Typography.Text>
        </Space>
      </Card>

      {/* ★待我处理在右边★(用户明确要求),固定窄栏 */}
      <Card
        style={{ width: 320, flexShrink: 0 }}
        styles={{ body: { padding: 14 } }}
        title={<Space><span>🔔 待我处理</span><Badge count={todo.length} showZero color={todo.length ? '#ff4d4f' : '#d9d9d9'} /></Space>}
      >
        {todo.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待你应答的会议" />
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {todo.map((m) => (
              <div key={m.id} onClick={() => onOpenMeeting(m.id)} style={{
                border: '1px solid #ffccc7', background: '#fff7f6', borderRadius: 6,
                padding: '8px 10px', cursor: 'pointer',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{m.title}</div>
                <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                  {new Date(m.starts_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                  {' '}{hhmm(new Date(m.starts_at))}–{hhmm(new Date(m.ends_at))}
                </div>
                <div style={{ marginTop: 6 }}>
                  <Tag color="red">待应答</Tag>
                  {m.is_private && <Tag color="purple">私密</Tag>}
                </div>
              </div>
            ))}
          </Space>
        )}
      </Card>
    </div>
  )
}

function LegendDot({ style, text }: { style: React.CSSProperties; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#595959' }}>
      <i style={{ width: 12, height: 12, borderRadius: 2, display: 'inline-block', ...style }} />
      {text}
    </span>
  )
}
