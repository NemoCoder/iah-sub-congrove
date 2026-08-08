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
import { App as AntdApp, Button, Card, DatePicker, Empty, Input, Modal, Segmented, Select, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Activity, type Project } from './api'
import { TodoCard } from './todo-card'
import { HOUR_PX, layout } from './schedule-layout'

const DAY_PX = HOUR_PX * 24

/// ★时段分隔★(2026-08-07 用户:「12 点那里分隔一下,标识上下午…8 点也空一行,18 点后面也空一行」)。
/// 画的是**分隔线 + 非工作时段压暗 + 轴上的时段名**,而**不是真的空出高度**——
/// 事件的 top/height 按「小时 × HOUR_PX」算,中间插空行会让全部坐标错位
/// (schedule-layout.ts 那 20 条单测钉的就是这套坐标)。视觉上分了段,定位基准不动。
const WORK_FROM = 8
const WORK_TO = 18
const SEG_MARKS = [WORK_FROM, 12, WORK_TO]
const SEGMENTS = [
  { label: '凌晨', from: 0, to: WORK_FROM },
  { label: '上午', from: WORK_FROM, to: 12 },
  { label: '下午', from: 12, to: WORK_TO },
  { label: '晚上', from: WORK_TO, to: 24 },
]

/// 本地日期工具。★不引 dayjs★:只需要「周的起止」和格式化,原生 Date 够用,
/// 也免得把时区处理散到两套 API 里。全部按**浏览器本地时区**渲染;
/// 后端存 timestamptz、ISO 串带偏移,Date 会自己转对。
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

/// ★布局与位置计算已抽到 schedule-layout.ts 并有单测覆盖★——
/// 那里出过一个「三个以上重叠时后来者全宽盖住前面」的 bug,会让活动在界面上凭空消失。
/// 这里只留渲染,别把算法抄回来(抄回来就是第二个真相源,也就没人再跑那 9 条测试了)。
/// 活动在日历上的配色:待我应答优先(它是要我动作的),其次按项目可见性。
function evStyle(m: Activity): React.CSSProperties {
  if (m.my_status === 'pending') return { background: '#fff1f0', border: '1px solid #ff4d4f', color: '#a8071a' }
  if (m.is_private) return { background: '#f9f0ff', border: '1px dashed #722ed1', color: '#531dab' }
  return { background: '#e6fffb', border: '1px solid #0d9488', color: '#00474f' }
}

export function ScheduleView({ onOpenActivity, onNewActivity }: {
  onOpenActivity: (id: number) => void
  onNewActivity: () => void
}) {
  const { message } = AntdApp.useApp()
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()))
  /// 视图模式(原型:日/周/月/列表)。★周是默认★——排会看的是一周。
  const [mode, setMode] = useState<'day' | 'week' | 'month' | 'list'>('week')
  const [items, setItems] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)

  /// 一屏显示几天 + 翻页步长。★月视图不做成 6×7 网格★:那是另一套布局,
  /// 而这一页的价值在「看得清每个小时」;月按 4 周连排,仍然是同一套时间轴。
  const span = mode === 'day' ? 1 : mode === 'month' ? 28 : 7
  const step = span
  const [quickOpen, setQuickOpen] = useState(false)
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(anchor, i)), [anchor, span])
  const today = new Date()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = anchor.toISOString()
      const to = addDays(anchor, 7).toISOString()
      setItems(await api<Activity[]>(`/api/activities?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))
    } catch (e) {
      message.error((e as Error).message)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [anchor, message])
  useEffect(() => { void load() }, [load])

  // 「待我处理」的筛选与排序搬进 TodoCard —— ★两页共用同一张卡★,
  // 免得日程页和活动页各筛一套(此前就是各写各的,连能不能就地答复都不一样)。

  const title = `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月 ${anchor.getDate()} – ${addDays(anchor, 6).getDate()} 日`

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 主体:日历 */}
      <Card style={{ flex: 1, minWidth: 0 }} styles={{ body: { padding: 16 } }}>
        <Space wrap style={{ marginBottom: 12, width: '100%' }}>
          <Typography.Text strong style={{ fontSize: 15 }}>{title}</Typography.Text>
          <Button size="small" onClick={() => setAnchor(addDays(anchor, -step))}>‹</Button>
          <Button size="small" onClick={() => setAnchor(startOfWeek(new Date()))}>今天</Button>
          <Button size="small" onClick={() => setAnchor(addDays(anchor, step))}>›</Button>
          <Segmented size="small" value={mode} onChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: 'day', label: '日' }, { value: 'week', label: '周' },
              { value: 'month', label: '月' }, { value: 'list', label: '列表' },
            ]} />
          <span style={{ flex: 1 }} />
          {/* ★+ 个人日程★(原型):私事不该走「发起活动」那套(要选项目、指记录员、邀请人)。
              它落在「我的日程」私密项目里 —— 不产生忙闲、对别人完全隐形(D1)。 */}
          <Button size="small" onClick={() => setQuickOpen(true)}>+ 个人日程</Button>
          <Button size="small" type="primary" onClick={onNewActivity}>+ 发起活动</Button>
        </Space>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : mode === 'list' ? (
          /* ★列表视图★:日程密的时候网格反而难读 —— 一行一条按时间排,一眼看完 */
          <div>
            {items.length === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这段时间没有安排" />
              : [...items].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((m) => (
                <div key={m.id} onClick={() => onOpenActivity(m.id)} style={{
                  display: 'flex', gap: 12, padding: '8px 4px', cursor: 'pointer',
                  borderBottom: '1px solid #f5f5f5',
                }}>
                  <div style={{ width: 150, flexShrink: 0, fontSize: 12, color: '#8c8c8c' }}>
                    {WEEK_LABEL[new Date(m.starts_at).getDay()]}
                    {' '}{new Date(m.starts_at).getMonth() + 1}/{new Date(m.starts_at).getDate()}
                    {' '}{hhmm(new Date(m.starts_at))}–{hhmm(new Date(m.ends_at))}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {m.title}
                    {m.is_private && <Tag color="purple" style={{ marginLeft: 6 }}>私密</Tag>}
                    {m.my_status === 'pending' && <Tag color="red" style={{ marginLeft: 4 }}>待应答</Tag>}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {/* 表头:时间轴列 + 7 天 */}
            <div style={{ display: 'grid', gridTemplateColumns: `92px repeat(7, minmax(90px, 1fr))`, minWidth: 700 }}>
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
                {/* ★时段名并进刻度文字★(2026-08-07 截图核对后改):
                    第一版把「凌晨/上午/下午/晚上」竖排在轴左边,在 48px 宽的列里被挤成
                    几乎读不出的小字 —— 一个看不清的标识等于没有标识。
                    现在写成「上午 8:00」,横排、和刻度同一行,列宽相应加到 74px。 */}
                {Array.from({ length: 24 }, (_, h) => {
                  const seg = SEGMENTS.find((x) => x.from === h)
                  return (
                    <div key={h}>
                      {/* ★时段名与时间拆成左右两个独立元素★(2026-08-07 第三版):
                          拼成一个字符串右对齐时,列宽不够就从**左边**裁 ——
                          「下午 12:00」被切成「午 12:00」、「晚上 18:00」切成「上 18:00」。
                          裁掉的恰恰是要传达的那两个字,而时间反倒完整。分开放就不会互相挤。 */}
                      {seg && (
                        <div style={{
                          position: 'absolute', top: h * HOUR_PX, left: 6,
                          // ⚠ 列宽 92px 是量出来的:74px 时「上午」和「8:00」贴成了
                          // 「上午8:00」一个词(2026-08-07 第四版才看准 —— 前三版分别是
                          // 竖排看不清、拼串被左裁、贴太紧)。字号比时间小一号,拉开层次。
                          fontSize: 10, color: '#8c8c8c', fontWeight: 600,
                          transform: 'translateY(-6px)', whiteSpace: 'nowrap',
                        }}>{seg.label}</div>
                      )}
                      <div style={{
                        position: 'absolute', top: h * HOUR_PX, right: 6, fontSize: 11,
                        // 时段起点(8/12/18)加深:它们是右边那三条分隔线的锚
                        color: seg ? '#595959' : '#bfbfbf',
                        fontWeight: seg ? 600 : 400,
                        transform: 'translateY(-6px)',
                      }}>{h === 0 ? '' : `${h}:00`}</div>
                    </div>
                  )
                })}
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
                    {/* ★时段分隔线★(8 / 12 / 18):把一天划成 凌晨/上午/下午/晚上。
                        ⚠ 用**线**而不是真的空出高度 —— 事件的 top 是按「小时 × 30px」算的,
                        中间插空行会让所有坐标错位(那套计算有 20 条单测钉着)。
                        视觉上分段的目的达到了,定位不动。 */}
                    {SEG_MARKS.map((h) => (
                      <div key={h} style={{
                        position: 'absolute', left: 0, right: 0, top: h * HOUR_PX,
                        borderTop: '1px solid #d9d9d9', pointerEvents: 'none',
                      }} />
                    ))}
                    {/* 工作时段(8–18)之外压暗:一眼看出「正常不会在这儿排会」 */}
                    <div style={{
                      position: 'absolute', left: 0, right: 0, top: 0, height: WORK_FROM * HOUR_PX,
                      background: 'rgba(0,0,0,.015)', pointerEvents: 'none',
                    }} />
                    <div style={{
                      position: 'absolute', left: 0, right: 0, top: WORK_TO * HOUR_PX,
                      height: (24 - WORK_TO) * HOUR_PX,
                      background: 'rgba(0,0,0,.015)', pointerEvents: 'none',
                    }} />
                    {layout(items, d).map(({ item: m, top, height, left, width }) => (
                      <div
                        key={m.id}
                        onClick={() => onOpenActivity(m.id)}
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

      {/* 右栏:待我处理 + 公开活动广场 */}
      <div style={{ width: 320, flexShrink: 0 }}>
      <TodoCard all={items} onOpen={onOpenActivity} onDone={() => void load()} style={{ width: 320 }} />

      <PublicBoard onOpen={onOpenActivity} />
      </div>

      {quickOpen && <QuickPersonal onClose={() => setQuickOpen(false)} onDone={() => { setQuickOpen(false); void load() }} />}
    </div>
  )
}

/// 公开活动广场(D9)。★这是「全平台可旁听」的入口★——没有它,visibility=public
/// 就只是数据库里的一个字段:没人知道有哪些会可以听。
///
/// 默认只看**近 7 天**(日程右栏的定位是「接下来」,不是全量目录),可切「全部未来」。
/// ★只列还没结束的★:旁听的意义是「我要去听」,开完的会列在这里只是噪音。
function PublicBoard({ onOpen }: { onOpen: (id: number) => void }) {
  const { message } = AntdApp.useApp()
  const [days, setDays] = useState<7 | 0>(7)      // 0 = 全部未来
  const [rows, setRows] = useState<Activity[]>([])
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async () => {
    try { setRows(await api<Activity[]>(`/api/activities/public${days ? `?days=${days}` : ''}`)) }
    catch { setRows([]) }
  }, [days])
  useEffect(() => { void load() }, [load])

  const observe = async (m: Activity) => {
    setBusy(m.id)
    try {
      // ★广场里的会我必然与之无关★(后端已滤掉我参与/旁听的),所以这里只会是「加入」一个方向。
      // 取消旁听在**活动详情页**做 —— 那时它已经进了我的日历,本来就该去那儿管。
      await api(`/api/activities/${m.id}/observe`, {
        method: 'POST', body: JSON.stringify({ observe: true }),
      })
      message.success('已加入我的日程')
      await load()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <Card size="small" style={{ marginTop: 12 }}
      title={<Space><span>公开活动</span><Tag color="blue">可旁听</Tag></Space>}
      extra={
        <Segmented size="small" value={days} onChange={(v) => setDays(v as 7 | 0)}
          options={[{ value: 7, label: '近 7 天' }, { value: 0, label: '全部' }]} />
      }>
      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={days ? '近 7 天没有公开活动' : '暂无公开活动'} />
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {rows.map((m) => (
            <div key={m.id} style={{ borderBottom: '1px solid #f5f5f5', paddingBottom: 8 }}>
              <div onClick={() => onOpen(m.id)} style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {m.title}
              </div>
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                {new Date(m.starts_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                {' '}{hhmm(new Date(m.starts_at))}–{hhmm(new Date(m.ends_at))}
                {' · '}{m.organizer}
              </div>
              <Space size={4} style={{ marginTop: 4 }} wrap>
                {(m.projects ?? []).map((p) => <Tag key={p.id} color="cyan">{p.name}</Tag>)}
                <Button size="small" type={m.my_status ? 'default' : 'primary'} ghost={!m.my_status}
                  loading={busy === m.id} disabled={busy === m.id}
                  onClick={() => observe(m)}>
                  旁听
                </Button>
              </Space>
              {/* ★旁听 ≠ 拿到材料★(D9 与 D3 正交):说在按钮旁边,免得有人以为旁听就能看资料 */}
              {!m.my_status && (
                <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                  旁听可看议程与地点，看不到活动材料
                </Typography.Text>
              )}
            </div>
          ))}
        </Space>
      )}
    </Card>
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

/// 快速建个人日程(原型「+ 个人日程」)。
///
/// ★为什么不复用「发起活动」★:私事不需要选项目成员、指记录员、发邀请 —— 那套表单对
/// 「下午三点去医院」这种事太重,★重到人宁可不记★,而不记就等于让别人以为你有空。
/// 这里只问三件:叫什么、什么时候、放哪个项目。
///
/// ★放进私密项目才隐形★(D1):个人日程不产生忙闲、对别人完全看不见。
/// 所以下面那句提示不能省 —— 选了公开项目,这条私事就变成了别人眼里的「忙」。
function QuickPersonal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp()
  const [projects, setProjects] = useState<Project[]>([])
  const [pid, setPid] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [range, setRange] = useState<[string, string] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Project[]>('/api/projects')
      .then((ps) => {
        const mine = ps.filter((p) => !p.archived_at && (p.my_role === 'editor' || p.my_role === 'admin'))
        setProjects(mine)
        setPid((cur) => cur ?? mine[0]?.id ?? null)
      })
      .catch(() => setProjects([]))
  }, [])

  const submit = async () => {
    if (!title.trim() || !range || !pid) { message.warning('填标题、选时间、选项目'); return }
    setBusy(true)
    try {
      // 记录员填自己:后端要求非空(D14),而个人日程本来就没有别的记录员
      const me = await api<{ username: string }>('/api/me')
      await api('/api/activities', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(), agenda: '', recorder: me.username,
          starts_at: range[0], ends_at: range[1], project_ids: [pid], participants: [],
        }),
      })
      message.success('已加入日程')
      onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal open title="加一条个人日程" onCancel={onClose} onOk={submit} confirmLoading={busy} okText="加入">
      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
        <Input placeholder="做什么，如：去医院 / 读书会" value={title} onChange={(e) => setTitle(e.target.value)} />
        <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }}
          onChange={(v) => setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)} />
        <Select style={{ width: '100%' }} value={pid} onChange={setPid} placeholder="放进哪个项目"
          options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          放进<b>私密项目</b>的日程不占别人眼里的忙闲，对他人完全隐形。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
