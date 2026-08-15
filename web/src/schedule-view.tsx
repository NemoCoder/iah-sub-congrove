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
import { App as AntdApp, Button, Card, Empty, Pagination, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { EditOutlined, StarFilled } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { UpcomingBar } from './upcoming-bar'
import { annotate, fmtDay, fmtHM, isTodayCell } from './tz'
import { api, type Activity } from './api'
import { isEnded } from './activity-state'
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
// ⚠ isSameDay / hhmm / pad / 星期表 2026-08-12 收敛进 tz.ts —— 它们全是「按浏览器本地时区」判的,
//   而「今天」这条高亮判错的表现是**高亮错一整列**(见 tz.ts 的 sameDayIn 头注)。
const isSameDay = (cell: Date, _now: Date) => isTodayCell(cell)
const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
// ⚠  已删:最后一个调用点(旁听广场)2026-08-12 换成 fmtHM 之后它就没人用了。
// ★留着一个没人调的薄封装,下一个人会以为「这里有讲究」而照抄它。★

/// ★布局与位置计算已抽到 schedule-layout.ts 并有单测覆盖★——
/// 那里出过一个「三个以上重叠时后来者全宽盖住前面」的 bug,会让活动在界面上凭空消失。
/// 这里只留渲染,别把算法抄回来(抄回来就是第二个真相源,也就没人再跑那 9 条测试了)。
/// 活动在日历上的配色:待我应答优先(它是要我动作的),其次按**活动自己的**可见性
/// (`is_private`,M0 起;不再是「关联了什么项目」——2026-08-15 订正注释)。
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

/// ★这场已经开完了没有★（2026-08-12 liaoruili：「已经结束的有个标识什么的吧？
/// 不然这么多我一看我都不知道我接下来要参加哪个」）。
///
/// ⚠★判 `ends_at` 不判 `starts_at`★：正在开的那场还没结束，它恰恰是此刻最要紧的一条，
/// 淡化掉就正好淡化错了人最需要看见的东西。

function evStyle(m: Activity): React.CSSProperties {
  // ★已结束的一律淡化，而且**压过「待应答」的红**★。
  // 会都开完了再红着催我答复是纯噪声：答复的意义在于「我去不去」，
  // 而这件事已经没有选项了。红色是这张日历上最强的信号，留给还能行动的事。
  // ⚠ 但**不压过归档**：归档是「整个项目封存了」，那是比时间更硬的状态（且它本来就是灰的）。
  // 淡化的做法是**保留原色再降透明度**，不是刷成灰：
  // 刷灰会把「公开/非公开」这层信息一起抹掉，而回头看历史时那层信息照样有用。
  if (!m.archived && isEnded(m)) {
    const base = m.is_private
      ? { background: '#f9f0ff', border: '1px dashed #722ed1', color: '#531dab' }
      : { background: '#e6fffb', border: '1px solid #0d9488', color: '#00474f' }
    return { ...base, opacity: 0.42 }
  }
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
  /// ★摘要条的刷新钥匙★:日历每次重载就 +1。
  /// 不这么做的话,「待答复 2」在你就地答完之后还会挂着 —— ★而它不会报错,只是过时★。
  const [reloadKey, setReloadKey] = useState(0)
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      // ⚠★原来这里写死 7 天★:月视图于是只加载了一周的数据,后面三周永远是空的
      //   —— 而它看起来「就是没安排」,没有任何报错。(2026-08-09 改月视图时发现。)
      const from = days[0].toISOString()
      const to = addDays(days[days.length - 1], 1).toISOString()
      // ★我拒绝掉的活动不进日程★（2026-08-14 liaoruili:「我拒绝的会议为啥出现在日程中？」）。
      //   后端 `/api/activities` 一直把 `declined` 也返回 —— 它必须返回,因为活动页新加的
      //   「已拒绝」tab 要用它;★该做过滤的是「日程」这个视图,不是接口★。
      //   语义上很直接:日程回答的是「我接下来要去哪」,而我已经说了不去。
      //   ⚠ 顺带把这些也一并干净了:顶部「接下来 7 天 N 场」的计数、重叠分栏、冲突提示 ——
      //     它们全都从 `items` 派生,★在源头滤掉比逐处判 my_status 少一整类漏网★。
      const 全部 = await api<Activity[]>(`/api/activities?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      setItems(全部.filter((m) => m.my_status !== 'declined'))
    } catch (e) {
      message.error((e as Error).message)
      setItems([])
    } finally {
      if (!silent) setLoading(false)
      setReloadKey((k) => k + 1)
    }
  }, [days, message])
  useEffect(() => { void load() }, [load])

  // 「待我处理」的筛选与排序搬进 TodoCard —— ★两页共用同一张卡★,
  // 免得日程页和活动页各筛一套(此前就是各写各的,连能不能就地答复都不一样)。
  // ⚠★卡的数据也归卡自己拉,不再从这一页传★(2026-08-15):共用了组件却各喂各的数据,
  //   等于只共用了长相 —— 这一页的 `items` 只有当前那一屏、还滤掉了 declined,
  //   于是同一张卡在日程页上少列一堆待办,详见 todo-card.tsx 的 `卡片天数`。

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

        {/* ★「接下来 7 天」摘要★（2026-08-12 liaoruili）——放在工具条**下面、网格上面**：
            它是对整张日历的一句总结，而不是工具条的一个控件。
            ⚠ 它自己取数、和当前可视范围无关（见 upcoming-bar.tsx 头注），
            所以翻到上个月时它照样说的是「从此刻起的 7 天」。
            三种视图共用一条 —— 「我接下来要干什么」跟你正在看周还是看月无关。 */}
        <UpcomingBar reloadKey={reloadKey} onOpen={onOpenActivity} />

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
                  // ★已结束的整行也退一档★:光有「已结束」标签的话,眼睛还是得逐行读标签
                  // 才分得清哪些在身后 —— 而这张列表是按时间排的,过去和未来的分界
                  // 本该一眼看到。
                  // ⚠ 这里用 0.62 而不是日历那边的 0.42:★同一个意思,两种载体★——
                  //   日历上是色块,淡到 0.42 仍认得出形状和颜色;
                  //   列表上是**正文**,淡到 0.42 就开始费眼睛了,而回头查历史时它照样要读。
                  opacity: isEnded(m) ? 0.62 : 1,
                }}>
                  <div style={{ width: 150, flexShrink: 0, fontSize: 12, color: '#8c8c8c' }}>
                    {/* ⚠★2026-08-12 补:这三样原来是从 Date 直接读部件的,即**浏览器本地**★——
                        而同一行的时间在步骤 1 已经换成按我的时区算了,于是
                        ★一行里出现了两种时区★:跨时区看跨日的会时,钟点已经退回前一天、日期还停在后一天。
                        这是步骤 1「57 处收敛」里漏掉的几处 —— 它不报错,只在跨时区时露出来,
                        而当时 setMyTz 还没接线,所以那轮「12 个视图逐字对拍」也照不出来。 */}
                    {fmtDay(m.starts_at)}
                    {' '}{fmtHM(m.starts_at)}–{fmtHM(m.ends_at)}
                    {/* E2:跨时区才标（一致时 annotate 返回空串） */}
                    {annotate(m.starts_at, m.timezone)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {m.title}
                    {/* ★列表里给明文标签★:周/月视图的格子太小,只能靠淡化;
                        而列表一行有的是地方,一个字面的「已结束」比让人去分辨深浅可靠得多。
                        ⚠ 用词是「已结束」不是「已参加」（2026-08-12 liaoruili 定）——
                        ★系统只知道会开完了，不知道人到没到★，写「已参加」就是替用户断言一件没发生过验证的事。 */}
                    {isEnded(m) && <Tag style={{ marginLeft: 6 }}>已结束</Tag>}
                    {m.is_private && <Tag color="purple" style={{ marginLeft: 6 }}>非公开</Tag>}
                    {!isEnded(m) && m.my_status === 'pending' && <Tag color="red" style={{ marginLeft: 4 }}>待应答</Tag>}
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
                    // ★表头这一格也归暖黄★:它是那一列的**顶端**,颜色必须和列身、顶线连成一条 ——
                    //   原来青底青字配暖黄的列,是同一个「今天」被涂成两种颜色。
                    background: isToday ? '#fff4d6' : weekend ? '#fafafa' : undefined,
                    fontWeight: isToday ? 600 : 400,
                    color: isToday ? '#874d00' : weekend ? '#8c8c8c' : undefined,
                  }}>
                    {/* ⚠★这里用 getDay()/getDate() 是**对的**,别顺手改成 fmtDay★:
                        `d` 是**日历格**(那一天的名字),不是一个瞬时 —— 它本来就没有时区可言。
                        拿 fmtDay(它) 反而会把它当瞬时再投影一次,整排列头错一天
                        (与 isTodayCell / sameDayIn 的区别是同一回事,见 tz.ts)。 */}
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
                <span>{nightCount ? '凌晨这一段有活动被折叠了' : '凌晨 0–8 点已折叠'}</span>
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
                // ★今天整列都要看得出来★（2026-08-13 liaoruili：「把今天整个一列看看怎么标识出来」）。
                //
                // 在此之前只有**表头那一格**是青底的,而人的视线一落进网格就没有参照了 ——
                // 七列长得一模一样,要确认「这个块是今天还是明天」得抬头去数列。
                // ⚠★只留一个记号,不要划出一条通栏★（2026-08-13 liaoruili 第二轮:
                //   「还是很丑。。。不要太明显，有个标识就行」）。
                //   我上一版给它加了**两侧 2px 青色竖线** —— 那等于在网格中间竖起一道栏杆:
                //   七列本来是等价的、连续的一张表,一道实线把它劈成「今天」和「别的」两块,
                //   ★而人要读的是**跨列的时间关系**(这周哪天空、明天几点)，栏杆恰好把它切断了。★
                //   现在只留一层几乎看不出的底色:眼睛扫过去知道「是这一列」,
                //   但它不构成边界、不抢事件块的颜色、也不打断横向阅读。
                //   ★标识 ≠ 强调。要的是「找得到」,不是「盯着它」。★
                //   表头那一格(青底 + 「· 今天」)仍在,那才是明确的标签;底色只是它向下的延伸。
                // ⚠ 变量名别叫 today —— 外层已有一个 `const today = new Date()`,
                //   同名会把它遮蔽掉,而遮蔽出来的是个 boolean:后面谁再用 today 当日期就静默错。
                const 是今天 = isSameDay(d, today)
                return (
                  <div key={i} style={{
                    position: 'relative', height: dayPx(fromH),
                    borderLeft: '1px solid #f0f0f0',
                    // ★暖黄,不是青★（2026-08-13 liaoruili:「今天的底纹还是有点淡,而且和公开活动
                    //   颜色一样了是不是？」——他说得对)。
                    //   我原来用的是极淡的青 `#fbfffe`,而★「公开」活动块本身就是青的(#e6fffb)★ ——
                    //   底色和块同色系,块面融进底色、整列发糊,「今天」反而更不跳。
                    //   ⚠ 三档并排拿 qwen3.8-max 比过:暖黄与青(公开)、紫(不公开)都拉开色相距离,
                    //     一眼认得出今天,又不淹没任何一类事件块;冷灰蓝偏冷、和青挨得太近,不行。
                    //   ★背景要和前景**不同色系**,不是「更淡一点」—— 同色系再淡也是糊。★
                    background: 是今天 ? '#fffbe8' : weekend ? '#fafafa' : undefined,
                    // ★记号是表头那条青线向下延伸的 2px★ —— 不是通栏竖线,也不是有色块。
                    //   三档并排拿 qwen3.8-max 看过:通栏竖线「把网格从中间劈开,视觉重量最大」;
                    //   只留极浅底色则「列身扫一眼分辨不出,差屏幕上等于没标」;
                    //   ★这条短线「几乎不增加醒目度,却给视线一个锚点」★ —— 正是「有个标识就行」。
                    // ★顶线也走暖黄★（2026-08-13 liaoruili:「顶线也需要是黄色系列,
                    //   不然显得不连续」）—— 底色换了色系,记号还留在旧色系上,
                    //   ★同一个「今天」被劈成两种颜色,读起来像两件事★。
                    boxShadow: 是今天 ? 'inset 0 2px 0 #faad14' : undefined,
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
                          {/* ★E2 落在 tooltip 里★:周/月视图的色块太小,塞不下「（北京 09:00）」,
                              而这条信息又不能不给 —— tooltip 本来就是「这块到底是什么」的答案处。 */}
                          <div>{fmtHM(m.starts_at)}–{fmtHM(m.ends_at)}
                            {annotate(m.starts_at, m.timezone)}
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

        {/* ★图例只在**周视图**出★（2026-08-15 逐张看巡检截图看出来的 —— 月/列表这两屏
            是修好 Segmented 枚举之后**第一次**被巡检看到,一看就是这个）:
            这七项讲的是**周视图格子的颜色编码**,另外两个视图根本不用它。
              · **列表**:一行只有三个**明文 Tag**(已结束 / 非公开 / 待应答)+ 整行淡化 ——
                「公开」「已归档 · 只读」「★我发起」「✎我是记录员」「○我旁听」**五项不出现**,
                剩下两项画法也不同(那边色块、这边 Tag);
              · **月**:一格只有一个青色的「N 项」计数块 + 可选的红色「待答 N」——
                ★那个青块是**计数**,不是「公开」★,于是七项里只有「待应答」勉强对得上。
            ★一张解释着「你看不到的东西」的图例,比没有图例更让人怀疑自己漏看了什么。★
            ⚠ 我第一版只藏了列表(`mode !== 'list'`)—— 那是**只修了一半**:
              月视图同样一项都对不上。判据应该是「这个视图用不用这套颜色编码」,
              而只有周视图用。 */}
        {mode === 'week' && (
        <>
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
          {/* ⚠★「已结束」不进图例★（2026-08-13 liaoruili：「把已结束的图例去除」）。
              淡化本身**保留**——已结束的活动照旧退到后面（evStyle 里的 opacity 0.42）,
              去掉的只是图例里这一格。
              ★我当初加它的理由(「淡化是没有文字的信号,不解释会被当成显示坏了」)在这里不成立★:
              一排图例里,「已结束」和「公开」用的是同一个青色、只差透明度 ——
              人分辨不出那点差,反而多出一格要读的东西。★图例每多一格,整排就更难扫一眼看懂★,
              而「颜色淡了 = 过去了」是不用教的常识。 */}
          {/* ★身份图标也要进图例★(原型图例末尾那一行):三个符号不解释,人只会当成装饰 */}
          <span style={{ color: '#8c8c8c', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span><StarFilled style={{ fontSize: 10, marginRight: 3 }} />我发起</span>
            <span><EditOutlined style={{ fontSize: 10, marginRight: 3 }} />我是记录员</span>
            <span><MineIcon mine="observer" />我旁听</span>
          </span>
        </Space>
        </>
        )}
      </Card>

      {/* 右栏:待我处理 + 公开活动广场 */}
      <div style={{ width: 320, flexShrink: 0 }}>
      <TodoCard onOpen={onOpenActivity} onOpenMinutes={onOpenMinutes} onDone={() => void load(true)} style={{ width: 320 }} />

      <PublicBoard onOpen={onOpenActivity} onJoined={() => void load()} />
      </div>

    </div>
  )
}

/// 公开活动广场(D9)。★这是「全平台可旁听」的入口★——没有它,visibility=public
/// 就只是数据库里的一个字段:没人知道有哪些会可以听。
///
/// 默认只看**近 7 天**(日程右栏的定位是「接下来」,不是全量目录),可切「全部未来」。
/// ★只列还没结束的★:旁听的意义是「我要去听」,开完的会列在这里只是噪音。
/// 广场默认展开几场。★5 比待办卡的 2 多★:待办是「要我做的事」,少而重;
/// 广场是「有什么可听的」,看的是**有没有值得点开的**,太少就等于没在推荐。
/// 广场每页几场。★2026-08-13 liaoruili:「公开活动没有做分页呢！！！！现在还是一长串,
/// 几十场一直下滑」——他说得对,而这是我判断错了★:
/// 我当时明确写过「不做真正的分页:广场是扫一眼有什么可听的,不是目录,翻页比展开重」,
/// 于是做成了「先露 5 场 + 展开」。★问题出在「展开」那一下:它把**全部**几十场一次性倒出来★,
/// 正是他先前为「待我处理」抱怨过的同一个形状(「怎么这么长,没有做分页呢」)。
/// ★「折叠」只在总数不多时等价于分页;总数一多,展开就等于没有折叠。★
const BOARD_PAGE = 5

function PublicBoard({ onOpen, onJoined }: {
  onOpen: (id: number) => void
  /// ★加入旁听后要让**日历**也重载★（2026-08-12 liaoruili：「加入旁听后，日历没有自动刷新加上去」）。
  /// 原来 observe 之后只 `await load()` —— 那是**广场自己**那份列表的 load，
  /// 日历从头到尾没重新拉过。于是提示说「已加入我的日程」，而日程上什么都没多出来：
  /// ★系统说它做了，屏幕上看不见 —— 用户只能理解成「没生效」。★
  onJoined: () => void
}) {
  const { message } = AntdApp.useApp()
  const [days, setDays] = useState<7 | 0>(7)      // 0 = 全部未来
  const [rows, setRows] = useState<Activity[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  /// ★广场分页★（2026-08-13 liaoruili 两次指出「没有做分页」）。
  /// 这一屏上「待我处理」和「公开活动」是同一个毛病的两个实例:
  /// 都是**条数不由我们控制**的列表(转移请求多少条看别人发多少,公开活动多少场看全平台),
  /// 而它们都住在**右栏**——右栏一长，左边的日历就被拉到滚不完的地方去。
  /// ★不设上限的列表，等于把版面的控制权交给了数据★。
  /// 这里不做真正的分页:广场是「扫一眼有什么可听的」，不是目录，翻页反而比展开重。
  const [页, setPage] = useState(1)
  /// ★生效的页码是**派生**的,不是存的那个★:旁听掉一场之后这一页可能就不存在了
  /// (最后一页只剩一条,点完旁听它就空了),而 `页` 还停在那儿 → 一片空白、且看不出为什么。
  /// ⚠ 本仓库修过同一族的 bug:「恢复最后一个归档项目之后卡在『已归档』筛选上,
  ///   列表永远空、连切回去的按钮都没有」(project-filter.ts 的头注)。
  ///   ★修法一样:不同步两份状态,而是让取值从**当前事实**推出来。★
  const 总页 = Math.max(1, Math.ceil(rows.length / BOARD_PAGE))
  const 有效页 = Math.min(页, 总页)

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
      await load()          // 广场自己的列表（这条会从「可旁听」里消失）
      onJoined()            // ★日历也要重载★，否则「已加入我的日程」是一句空话
    } catch (e) { message.error((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <Card size="small" style={{ marginTop: 12 }}
      title={<Space><span>公开活动</span><Tag color="blue">可旁听</Tag></Space>}
      extra={
        <Segmented size="small" value={days} onChange={(v) => setDays(v as 7 | 0)}
          options={[{ value: 7, label: '近 7 天' }, { value: 0, label: '全部' }]} />
      }>
      {/* ★空状态的文案必须带「可旁听」这个限定★（2026-08-13 拿 qwen3.8-max 看真页面时抓到）:
          原文写「近 7 天没有公开活动」,而**同一屏的日历上就摆着一场公开讲座** ——
          广场按设计滤掉了「我已经与之有关」的会(我发起/我参与/我已旁听,见 observe 那段注释),
          所以它对我确实是空的,可那句话说的是**另一件事**,而且是假的。
          ★空状态最容易写成谎话★:它描述的是「这个列表为什么空」,
          而写的人心里想的是「这个列表空了」—— 两者只有在没有过滤条件时才等价。
          ⚠ 注释放在三元**外面**:JSX 的花括号注释只能待在 children 位置,
            塞进 `? (` 后面会被当成一个对象字面量 → 整段语法炸(我刚这么炸过一次)。
            ⚠ 而且注释正文里**不能出现块注释的结束符**,否则它会在那儿提前闭合 ——
            我紧接着又踩了这一个(想在注释里举例写出那对符号)。 */}
      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={days ? '近 7 天没有可旁听的公开活动' : '没有可旁听的公开活动'} />
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {rows.slice((有效页 - 1) * BOARD_PAGE, 有效页 * BOARD_PAGE).map((m) => (
            <div key={m.id} style={{ borderBottom: '1px solid #f5f5f5', paddingBottom: 8 }}>
              <div onClick={() => onOpen(m.id)} style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {m.title}
              </div>
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                {/* ⚠★又一处「一行两种时区」★(2026-08-12 第二次撞到同一族):
                    日期原来走 `toLocaleDateString` = **浏览器本地**,而时间走 `hhmm` 已经按我的时区算,
                    跨时区看跨日的会时两者会打架。★同一个毛病在「57 处收敛」里漏了两次★ ——
                    第一次是列表模式,这次是旁听广场。判据只有一处(tz.ts),漏的都是**调用点**。 */}
                {fmtDay(m.starts_at)}
                {' '}{fmtHM(m.starts_at)}–{fmtHM(m.ends_at)}
                {annotate(m.starts_at, m.timezone)}
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
              {/* ⚠★这里原来每一行都挂一句「旁听可看议程与地点,看不到活动材料」★
                  (2026-08-12 liaoruili:「这一句解释不要」)。它对**每一条**重复一遍,
                  十条活动就是十遍同样的话 —— ★一句话说十遍就不再是解释,是噪声★,
                  而噪声会把旁边真正不一样的信息(标题、时间、项目)一起淹掉。
                  D9 那条「旁听 ≠ 拿到材料」的语义不变,后端照旧拦;
                  真要提示也该放在卡片标题处说一次,而不是逐行复读。 */}
            </div>
          ))}
          {rows.length > BOARD_PAGE && (
            <Pagination
              size="small" align="center" simple
              current={有效页} pageSize={BOARD_PAGE} total={rows.length}
              onChange={setPage}
              /* ★simple 模式★:右栏只有 320px 宽,标准分页器的页码 + 跳转 + 每页条数
                 会挤成两行还换行 —— 这里只需要「第几页 / 共几页 + 前后翻」。 */
            />
          )}
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
