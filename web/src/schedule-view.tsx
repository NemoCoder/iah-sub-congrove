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
//   公开的活动 = 青色实框 / 非公开的活动 = 紫色虚框 / 待应答 = 红色。
//   ★判据是活动自己的 visibility(M0 起),不是「关联了什么项目」★——用词别再写「私密项目」。
import { App as AntdApp, Button, Card, Empty, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { EditOutlined, StarFilled } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Activity } from './api'
import { TodoCard } from './todo-card'
import { HOUR_PX, NIGHT_END_H, layout, nightHiddenCount } from './schedule-layout'
import { MINE_TEXT, mineOf, type Mine } from './activity-mine'

/// 网格总高。★凌晨折叠时从 8 点起画★（2026-08-09 用户）——
/// 0–8 点几乎永远是空的，却白占整屏三分之一，把真正有事的白天挤扁。
const dayPx = (fromH: number) => (24 - fromH) * HOUR_PX

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
/// 身份图标。★AntD 图标,不用 emoji★(C2):容器里没有 emoji 字体时会显示成豆腐块 ——
/// `e2e/shot.mjs` 已经踩过这个坑。
/// 「旁听」那个**空心圈** AntD 没有现成的,用 CSS 画一个 —— 它同样不是 emoji,
/// 而且原型定的就是圈(★发起 / ✎记录员 / ○旁听)。
function MineIcon({ mine }: { mine: NonNullable<Mine> }) {
  const st: React.CSSProperties = { fontSize: 10, marginRight: 3, flexShrink: 0 }
  if (mine === 'organizer') return <StarFilled style={st} />
  if (mine === 'recorder') return <EditOutlined style={st} />
  return <span style={{
    ...st, display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    border: '1.5px solid currentColor', verticalAlign: 'middle',
  }} />
}

function evStyle(m: Activity): React.CSSProperties {
  // ★归档项目的活动:淡化★(PRD B1)。它照常出现在日历里(B0——日程也是「我做过什么」的记录),
  // 但归档项目是**只读**的:不淡化的话人会点进去想改时间才发现动不了。
  // ⚠ 判在最前面:归档是「这场会已经封存了」,比「我还没答复」更该主导它的观感 ——
  //   一场封存项目里的历史会,不该再用红色催我答复。
  if (m.archived) return { background: '#fafafa', border: '1px dashed #d9d9d9', color: '#8c8c8c' }
  if (m.my_status === 'pending') return { background: '#fff1f0', border: '1px solid #ff4d4f', color: '#a8071a' }
  if (m.is_private) return { background: '#f9f0ff', border: '1px dashed #722ed1', color: '#531dab' }
  return { background: '#e6fffb', border: '1px solid #0d9488', color: '#00474f' }
}

export function ScheduleView({ me, onOpenActivity, onOpenMinutes, onNewActivity }: {
  /// 当前登录用户名 —— 判「我在这场活动里是什么身份」要用(C0)
  me: string
  onOpenActivity: (id: number) => void
  /// 待办卡里的纪要那一路直接进整理页(见 todo-card.tsx 的同名 prop)
  onOpenMinutes: (id: number) => void
  onNewActivity: () => void
}) {
  const { message } = AntdApp.useApp()
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()))
  /// 视图模式(原型:日/周/月/列表)。★周是默认★——排会看的是一周。
  const [mode, setMode] = useState<'week' | 'month' | 'list'>('week')
  const [items, setItems] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  /// ★凌晨 0–8 点默认折叠★。那一段真有活动时，上面给一条提示让用户自己展开 ——
  /// 不自动展开：自动展开会让「今天有个 3 点的会」把整周的布局都撑高一截。
  const [nightOpen, setNightOpen] = useState(false)

  /// 一屏显示几天 + 翻页步长。
  /// ★月视图就是月历★(2026-08-09 用户改的):原来它把 28 天塞进同一套小时时间轴,
  /// 于是「看一个月」变成「横着滚 28 列」—— 月视图要回答的是「哪天有事、有几件」,
  /// 不是「几点到几点」。所以格子里★只显示数量★,细节点进去看。。
  /// 月视图从「anchor 所在月的 1 号」起铺满整月(前后补齐到整周)。
  const monthStart = useMemo(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1), [anchor])
  const gridStart = useMemo(() => startOfWeek(monthStart), [monthStart])
  const span = mode === 'month' ? 42 : 7   // 6 周 × 7 天,任何月份都装得下
  /// ★月视图按「月」翻,不按天★:span=42 是为了铺满 6 周,拿它当步长会一次跳过一个半月。
  const stepMonth = (n: number) => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1))
  const step = span
  const days = useMemo(
    () => Array.from({ length: span }, (_, i) => addDays(mode === 'month' ? gridStart : anchor, i)),
    [anchor, gridStart, mode, span],
  )
  const today = new Date()
  /// 网格从几点开始画。折叠时 = 8。
  const fromH = nightOpen ? 0 : NIGHT_END_H
  /// 折叠区里到底有没有东西 —— 有才提示，没有就安静。
  /// ⚠ 判据是「有没有落在 0–8 这一段」而不是「几点开始」——见 nightHiddenCount 的头注:
  /// 23:00 跨到次日凌晨的活动,起点不在折叠区里,可它次日那一段确实被藏了。
  const nightCount = useMemo(
    () => (nightOpen ? 0 : nightHiddenCount(items, days)),
    [items, nightOpen, days],
  )

  /// `silent=true` 不掀 loading —— 见 activity-detail 里同名函数的那段。
  /// ★「待我处理」就地答复走的就是它★:不静默的话答一条整页塌一下(2026-08-09 同一族)。
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      // ⚠★原来这里写死 7 天★:月视图于是只加载了一周的数据,后面三周永远是空的
      //   —— 而它看起来「就是没安排」,没有任何报错。(2026-08-09 改月视图时发现。)
      const from = days[0].toISOString()
      const to = addDays(days[days.length - 1], 1).toISOString()
      setItems(await api<Activity[]>(`/api/activities?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))
    } catch (e) {
      message.error((e as Error).message)
      setItems([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [days, message])
  useEffect(() => { void load() }, [load])

  // 「待我处理」的筛选与排序搬进 TodoCard —— ★两页共用同一张卡★,
  // 免得日程页和活动页各筛一套(此前就是各写各的,连能不能就地答复都不一样)。

  const title = mode === 'month'
    ? `${monthStart.getFullYear()} 年 ${monthStart.getMonth() + 1} 月`
    : `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月 ${anchor.getDate()} – ${addDays(anchor, 6).getDate()} 日`

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 主体:日历 */}
      <Card style={{ flex: 1, minWidth: 0 }} styles={{ body: { padding: 16 } }}>
        {/* ★工具栏按主流日历的排法★（2026-08-09 用户：「今天有个左右按键，目前这样的布局有点奇怪」）。
            查了 Google Calendar 与 FullCalendar 的默认/常见配置，三者一致的一条是：
            ★两个箭头**挨在一起**，「今天」在这一对旁边，而不是夹在中间★。
            我们原来是 `‹ 今天 ›` —— 把一对方向键劈开，读起来像三个不相干的按钮；
            而「上一页/下一页」是**同一个维度的两端**，视觉上就该是一组。
            布局取 Google 那套：左边 `[今天][‹][›] 标题`，右边视图切换 + 主操作。

            ⚠★顺带修掉一个真 bug★：原来整条工具栏是 `<Space>`，里面塞了个
            `<span style={{flex:1}}/>` 想把右侧顶开 —— **不起作用**。Space 会把每个
            子元素包进自己的 item 容器，flex:1 加在被包住的 span 上撑不开外面那层，
            于是所有按钮全挤在左边（截图里就是这样）。改成普通 flex 容器。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Button size="small" onClick={() => setAnchor(startOfWeek(new Date()))}>今天</Button>
          {/* Space.Compact:两个箭头连成一体,中间不留缝 —— 它们是一组 */}
          <Space.Compact size="small">
            <Button size="small" onClick={() => (mode === 'month' ? stepMonth(-1) : setAnchor(addDays(anchor, -step)))}>‹</Button>
            <Button size="small" onClick={() => (mode === 'month' ? stepMonth(1) : setAnchor(addDays(anchor, step)))}>›</Button>
          </Space.Compact>
          <Typography.Text strong style={{ fontSize: 15, marginLeft: 4 }}>{title}</Typography.Text>
          <span style={{ flex: 1 }} />
          <Segmented size="small" value={mode} onChange={(v) => setMode(v as typeof mode)}
            options={[
              // ★没有「日」视图★(2026-08-09 用户):周视图本来就是一天一列,
              // 单看一天只是把同样的东西放大;多一个模式就多一处要维护、要测。
              { value: 'week', label: '周' },
              { value: 'month', label: '月' }, { value: 'list', label: '列表' },
            ]} />
          {/* ★「+ 个人日程」已删★(2026-08-09 用户):它和「发起活动」是同一件事 ——
              M0 之后「个人日程」只是**一个活动类型**(不要纪要、不要项目、不占忙闲),
              在发起活动那张表单里选类型就到了。留两个入口等于让人先猜「我这事算哪种」,
              而那个判断本来就该由类型下拉承担。 */}
          <Button size="small" type="primary" onClick={onNewActivity}>+ 发起活动</Button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : mode === 'month' ? (
          /* ★月视图 = 整月日历,格子里只显示活动数量★（2026-08-09 用户）。
             一个月的信息量放不进小时刻度，硬塞只会变成横向滚动；月这一层要回答的是
             「哪天有事、有几件」，细节点进去看。 */
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 4 }}>
              {WEEK_LABEL.map((w) => (
                <div key={w} style={{ textAlign: 'center', fontSize: 12, color: '#8c8c8c', padding: '4px 0' }}>{w}</div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: '#f0f0f0' }}>
              {days.map((d) => {
                const inMonth = d.getMonth() === monthStart.getMonth()
                const isToday = d.toDateString() === today.toDateString()
                const of = items.filter((m) => new Date(m.starts_at).toDateString() === d.toDateString())
                const pending = of.filter((m) => m.my_status === 'pending').length
                // ★今天要整格高亮★（2026-08-09 用户）：原来只把日期数字染成青色，
                // 在 42 个格子里那点色差根本找不到 —— ★「今天在哪」是月视图上唯一的锚点★，
                // 没有它，人得先在心里数到第几周才知道自己站在哪儿。
                // 做法照通用日历：底色 + 描边 + 日期数字反白成实心圆点。
                return (
                  <div key={d.toISOString()} style={{
                    background: isToday ? '#e6fffb' : '#fff', minHeight: 78, padding: '6px 8px',
                    // ★本月之外的日子淡化但**不隐藏**★：整周对齐比「只画本月」更好读，
                    // 而完全空着会让人以为那几天加载失败了。
                    opacity: inMonth ? 1 : 0.38,
                    boxShadow: isToday ? 'inset 0 0 0 2px #0d9488' : undefined,
                    cursor: of.length ? 'pointer' : 'default',
                  }} onClick={() => { if (of.length === 1) onOpenActivity(of[0].id); else if (of.length) { setAnchor(startOfWeek(d)); setMode('week') } }}>
                    <div style={{
                      fontSize: 12, fontWeight: isToday ? 700 : 500,
                      color: isToday ? '#fff' : '#111827',
                      // 实心圆点:和周视图表头的「· 今天」是同一套青色语言
                      background: isToday ? '#0d9488' : undefined,
                      width: isToday ? 20 : undefined, height: isToday ? 20 : undefined,
                      borderRadius: isToday ? '50%' : undefined,
                      display: isToday ? 'flex' : undefined,
                      alignItems: 'center', justifyContent: 'center',
                    }}>{d.getDate()}</div>
                    {of.length > 0 && (
                      <div style={{ marginTop: 6, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Tag color="cyan" style={{ margin: 0 }}>{of.length} 项</Tag>
                        {/* 待应答单独标出来：它是唯一**需要我动手**的状态 */}
                        {pending > 0 && <Tag color="red" style={{ margin: 0 }}>待答 {pending}</Tag>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
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
                    {m.is_private && <Tag color="purple" style={{ marginLeft: 6 }}>非公开</Tag>}
                    {m.my_status === 'pending' && <Tag color="red" style={{ marginLeft: 4 }}>待应答</Tag>}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {/* 表头:时间轴列 + 7 天 */}
            {/* ⚠★折叠条只有一条,就在网格正上方★:2026-08-09 第一版把这段**贴了两遍**
                (表头上方一条、网格上方一条),截图里读作两条「凌晨 0–8 点已折叠」。
                它是**网格的**折叠开关,所以只能贴在网格那一侧;贴在表头之上时它和星期行
                中间还隔着一行,语义上更像是整个卡片的横幅。 */}
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
            {/* ⚠★列宽必须和上面表头那行一致(92px)★:原来这里是 48px 而表头是 92px ——
                两层网格对不齐,更要命的是时间轴只有 48px,于是「上午」(left:6)与「8:00」(right:6)
                ★叠在一起★,截图里读作「上午8:00」。
                ★注释里明明写着「列宽相应加到 74px」「92px 是量出来的」—— 那件事从没执行过★,
                只有注释在描述意图。(2026-08-09 用户截图指出;和「设计了 ≠ 执行了」是同一族。) */}
            {/* ★凌晨折叠条★：折叠区里有活动才出现。不自动展开 ——
                自动展开会让「今天有个 3 点的会」把整周的布局都撑高一截。 */}
            {!nightOpen && (
              <div onClick={() => setNightOpen(true)} style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                padding: '4px 8px', marginBottom: 4, borderRadius: 4,
                background: nightCount ? '#fffbe6' : '#fafafa',
                border: `1px solid ${nightCount ? '#ffe58f' : '#f0f0f0'}`,
                fontSize: 12, color: '#8c8c8c',
              }}>
                <span>{nightCount ? '★凌晨这一段有活动被折叠了★' : '凌晨 0–8 点已折叠'}</span>
                {nightCount > 0 && <Tag color="orange" style={{ margin: 0 }}>这段有 {nightCount} 项</Tag>}
                <span style={{ marginLeft: 'auto', color: '#0d9488' }}>展开 ▾</span>
              </div>
            )}
            {nightOpen && (
              <div onClick={() => setNightOpen(false)} style={{
                cursor: 'pointer', padding: '4px 8px', marginBottom: 4, fontSize: 12, color: '#0d9488',
              }}>收起凌晨 ▴</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: `92px repeat(7, minmax(90px, 1fr))`, minWidth: 700 }}>
              {/* 时间轴 */}
              <div style={{ position: 'relative', height: dayPx(fromH) }}>
                {/* ★时段名并进刻度文字★(2026-08-07 截图核对后改):
                    第一版把「凌晨/上午/下午/晚上」竖排在轴左边,在 48px 宽的列里被挤成
                    几乎读不出的小字 —— 一个看不清的标识等于没有标识。
                    现在写成「上午 8:00」,横排、和刻度同一行,列宽相应加到 74px。 */}
                {Array.from({ length: 24 - fromH }, (_, k) => {
                  const h = k + fromH
                  const seg = SEGMENTS.find((x) => x.from === h)
                  return (
                    <div key={h}>
                      {/* ★时段名与时间拆成左右两个独立元素★(2026-08-07 第三版):
                          拼成一个字符串右对齐时,列宽不够就从**左边**裁 ——
                          「下午 12:00」被切成「午 12:00」、「晚上 18:00」切成「上 18:00」。
                          裁掉的恰恰是要传达的那两个字,而时间反倒完整。分开放就不会互相挤。 */}
                      {seg && (
                        <div style={{
                          position: 'absolute', top: (h - fromH) * HOUR_PX, left: 6,
                          // ⚠ 列宽 92px 是量出来的:74px 时「上午」和「8:00」贴成了
                          // 「上午8:00」一个词(2026-08-07 第四版才看准 —— 前三版分别是
                          // 竖排看不清、拼串被左裁、贴太紧)。字号比时间小一号,拉开层次。
                          fontSize: 10, color: '#8c8c8c', fontWeight: 600,
                          transform: 'translateY(-6px)', whiteSpace: 'nowrap',
                        }}>{seg.label}</div>
                      )}
                      <div style={{
                        position: 'absolute', top: (h - fromH) * HOUR_PX, right: 6, fontSize: 11,
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
                    position: 'relative', height: dayPx(fromH),
                    borderLeft: '1px solid #f0f0f0',
                    background: weekend ? '#fafafa' : undefined,
                    // 每小时一条横线:用 repeating gradient,省掉 24 个 DOM 节点 × 7 列
                    backgroundImage: `repeating-linear-gradient(#f5f5f5 0 1px, transparent 1px ${HOUR_PX}px)`,
                  }}>
                    {/* ★时段分隔线★(8 / 12 / 18):把一天划成 凌晨/上午/下午/晚上。
                        ⚠ 用**线**而不是真的空出高度 —— 事件的 top 是按「小时 × 30px」算的,
                        中间插空行会让所有坐标错位(那套计算有 20 条单测钉着)。
                        视觉上分段的目的达到了,定位不动。 */}
                    {SEG_MARKS.filter((h) => h >= fromH).map((h) => (
                      <div key={h} style={{
                        position: 'absolute', left: 0, right: 0, top: (h - fromH) * HOUR_PX,
                        borderTop: '1px solid #d9d9d9', pointerEvents: 'none',
                      }} />
                    ))}
                    {/* 工作时段(8–18)之外压暗:一眼看出「正常不会在这儿排会」 */}
                    {/* 凌晨压暗:折叠时这一段根本不在网格里,别画 */}
                    {fromH === 0 && (
                      <div style={{
                        position: 'absolute', left: 0, right: 0, top: 0, height: WORK_FROM * HOUR_PX,
                        background: 'rgba(0,0,0,.015)', pointerEvents: 'none',
                      }} />
                    )}
                    <div style={{
                      position: 'absolute', left: 0, right: 0, top: (WORK_TO - fromH) * HOUR_PX,
                      height: (24 - WORK_TO) * HOUR_PX,
                      background: 'rgba(0,0,0,.015)', pointerEvents: 'none',
                    }} />
                    {layout(items, d, fromH).map(({ item: m, top, height, left, width }) => {
                      const mine = mineOf(m, me)
                      const projs = (m.projects ?? []).map((p) => p.name).join(' · ')
                      return (
                      // ★hover 出完整信息★(C3,原型 `.tip`):块小的时候标题常被截成「模型评…」,
                      // **hover 是看全它的唯一机会** —— tooltip 里只放项目的话,
                      // 那个被截断的标题就永远看不全了。
                      // 不放参与人数/地点/链接:tooltip 一大就会遮住相邻的时间格,而那些点进去就有。
                      <Tooltip key={m.id} mouseEnterDelay={0.35} title={
                        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                          <div style={{ fontWeight: 600 }}>{m.title}</div>
                          <div>{hhmm(new Date(m.starts_at))}–{hhmm(new Date(m.ends_at))}
                            {projs ? ` · ${projs}` : '（不关联项目）'}</div>
                          <div style={{ color: '#bfbfbf' }}>
                            {mine ? MINE_TEXT[mine] : m.my_status === 'pending' ? '待你应答' : '参与人'}
                            {m.archived ? ' · 已归档，只读' : ''}
                            {m.is_private ? ' · 不公开' : ''}
                          </div>
                        </div>
                      }>
                      <div
                        onClick={() => onOpenActivity(m.id)}
                        style={{
                          position: 'absolute', top, height, left, width,
                          borderRadius: 3, padding: '1px 4px', fontSize: 11, lineHeight: 1.3,
                          overflow: 'hidden', cursor: 'pointer', boxSizing: 'border-box',
                          ...evStyle(m),
                        }}
                      >
                        {/* ★身份图标在标题前★(C1/C2,原型 `.ic`):
                            发起=星 / 记录员=笔 / 旁听=空心圈;★普通参与人不标★ */}
                        {mine && <MineIcon mine={mine} />}
                        {m.title}
                      </div>
                      </Tooltip>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 图例:三种颜色各是什么。
            ★用词是「公开 / 非公开」,不带「项目」二字,更不许出现「私密」★
            (PRD §J4 + 2026-08-09 liaoruili 第二次点名)。两个理由都硬:
              ① ★判据早就不是项目了★ —— M0 起 `is_private` = **活动自己的** visibility,
                 不再从关联项目反推;而活动可以一个项目都不关联(A4),「私密项目」
                 对它根本不适用;
              ② 「私密」听起来像「藏起来的私事」,可它只是「没公开」—— 一场普通的组会
                 也是这个色。措辞把用户往错的方向引。 */}
        <Space size={16} style={{ marginTop: 12, fontSize: 12, flexWrap: 'wrap' }}>
          <LegendDot style={{ background: '#e6fffb', border: '1px solid #0d9488' }} text="公开" />
          <LegendDot style={{ background: '#f9f0ff', border: '1px dashed #722ed1' }} text="非公开" />
          <LegendDot style={{ background: '#fff1f0', border: '1px solid #ff4d4f' }} text="待应答" />
          {/* ★归档也进图例★:它现在是日历上第四种观感,不解释的话人会以为那条会「坏了」 */}
          <LegendDot style={{ background: '#fafafa', border: '1px dashed #d9d9d9' }} text="已归档 · 只读" />
          {/* ★身份图标也要进图例★(原型图例末尾那一行):三个符号不解释,人只会当成装饰 */}
          <span style={{ color: '#8c8c8c', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span><StarFilled style={{ fontSize: 10, marginRight: 3 }} />我发起</span>
            <span><EditOutlined style={{ fontSize: 10, marginRight: 3 }} />我是记录员</span>
            <span><MineIcon mine="observer" />我旁听</span>
          </span>
        </Space>
      </Card>

      {/* 右栏:待我处理 + 公开活动广场 */}
      <div style={{ width: 320, flexShrink: 0 }}>
      <TodoCard all={items} onOpen={onOpenActivity} onOpenMinutes={onOpenMinutes} onDone={() => void load(true)} style={{ width: 320 }} />

      <PublicBoard onOpen={onOpenActivity} />
      </div>

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
