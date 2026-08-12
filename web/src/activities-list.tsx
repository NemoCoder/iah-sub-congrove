// 活动页 —— 对应 docs/prototype-m1.html 的 `meets` 视图。
//
// ★2026-08-07 补做★:此前整页缺失(导航里连「活动」这个 tab 都没有),
// 因为我当初只照着原型的日历那一段实现,其余页面凭自己想 —— 用户对着原型一眼看出来了。
// 现在严格按原型:三 tab + 搜索/筛选 + 即将进行/已结束分组 + 右栏「待我应答」「我负责的纪要」。
//
// ★右栏的冲突提示是这一页的灵魂★(D1/D2):私密项目的日程对发起人完全隐形,
// 他不知道你那个时段忙 —— 所以必须在**你自己**收到邀请时标红提醒,并把「改期」放在手边。
// 冲突**在前端本地算**:列表里已经有我全部的会(含我私密项目的),不必再打接口。
import { App as AntdApp, Button, Card, Empty, Input, Segmented, Select, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Activity, type Me, type RespondStatus } from './api'
import { fmtDay, fmtHM } from './tz'
import { TodoCard } from './todo-card'

// ⚠ 原来这里也抄了一份 fmtDay/fmtHM,2026-08-12 收敛进 tz.ts(见 todo-card 的注释)。

export function ActivitiesListView({ me, onOpen, onOpenMinutes, onNew }: {
  me: Me | null
  onOpen: (id: number) => void
  /// ★「我负责的纪要」直接进整理页★（2026-08-09 用户）：这张卡列的是**待办**，
  /// 点它的人下一步一定是去写，先落到活动详情再点一次「纪要」是白饶的一跳。
  onOpenMinutes: (id: number) => void
  onNew: () => void
}) {
  const { message } = AntdApp.useApp()
  const [all, setAll] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'joined' | 'mine' | 'past'>('joined')
  const [kw, setKw] = useState('')
  const [proj, setProj] = useState<number | 'all'>('all')

  /// `silent=true` 不掀 loading（同 activity-detail / schedule-view）：
  /// 右栏「待我处理」就地答复后只需要刷新数据，不需要把整页重建一次。
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      // ★范围要大★:这一页是「我的全部活动」,不是日历那一屏。前后各半年。
      const from = new Date(Date.now() - 183 * 864e5).toISOString()
      const to = new Date(Date.now() + 183 * 864e5).toISOString()
      setAll(await api<Activity[]>(`/api/activities?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))
    } catch (e) { message.error((e as Error).message); setAll([]) } finally { if (!silent) setLoading(false) }
  }, [message])
  useEffect(() => { void load() }, [load])

  const now = Date.now()
  const projectOpts = useMemo(() => {
    const m = new Map<number, string>()
    for (const x of all) for (const p of x.projects ?? []) m.set(p.id, p.name)
    return [...m].map(([id, name]) => ({ value: id, label: name }))
  }, [all])

  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase()
    // ⚠★「已结束」只归「已结束」那个 tab★（2026-08-11 liaoruili：
    //   「左边已经有专门已结束的 tab，为啥下面还有已结束？以后这不堆到一起了吗」）。
    //   原来 joined/mine 两个 tab **完全不按时间过滤**，下面再分成「即将进行/已结束」两组渲染 ——
    //   于是那个 tab 的存在意义被架空，而「已结束」那一组★只增不减★：
    //   半年之后打开这一页，上面两条有用的，下面几百条历史，人得先滚过全部历史才看得完今天。
    //   ★列表页的用途是「我接下来要干什么」，历史归历史那一格。★
    return all
      .filter((m) => (tab === 'past' ? new Date(m.ends_at).getTime() < now
        : new Date(m.ends_at).getTime() >= now && (tab !== 'mine' || m.organizer === me?.username)))
      .filter((m) => proj === 'all' || (m.projects ?? []).some((p) => p.id === proj))
      .filter((m) => !k || m.title.toLowerCase().includes(k) || m.agenda.toLowerCase().includes(k))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  }, [all, tab, kw, proj, me, now])

  const upcoming = rows.filter((m) => new Date(m.ends_at).getTime() >= now)
  const past = rows.filter((m) => new Date(m.ends_at).getTime() < now).reverse()

  // 待我应答与冲突计算都搬进 TodoCard(★两页共用★),这里不再各算一套

  // ⚠★「我负责的纪要」这张专卡已删★（2026-08-11 liaoruili：「这上下不是一样的吗」）。
  //   它 2026-08-08 就在这儿，而我 08-10 往「待我处理」里也加了一路纪要待办 ——
  //   ★同一页上下两张卡列同一批数据，是我加之前没先看它有没有归宿造成的。★
  //   更实质的是这两张卡当时用的是**两套判据**：这里前端本地算（且漏了 has_minutes），
  //   那边走后端 activities_owing_minutes 视图。删掉这张，判据就只剩视图一处。

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <Card style={{ flex: 1, minWidth: 0 }} styles={{ body: { padding: 16 } }}>
        {/* ★一行搞定：动作 + 分组 + 计数 …… 搜索/筛选靠右★（2026-08-09 用户）。
            原来是三行：标题「活动」/ 分组 tab / 搜索。
            ⚠ 标题去掉了 —— ★这里本来就在「活动」这个根 tab 底下★，再写一遍是复读。
            搜索与筛选是**次要动作**，靠右放让左边那条「做什么 + 看哪一组」连成一句话读。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <Button size="small" type="primary" onClick={onNew}>+ 发起活动</Button>
          <Segmented
            size="small" value={tab} onChange={(v) => setTab(v as typeof tab)}
            options={[{ value: 'joined', label: '我参与的' }, { value: 'mine', label: '我发起的' }, { value: 'past', label: '已结束' }]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>共 {rows.length} 场</Typography.Text>
          <span style={{ flex: 1 }} />
          <Input.Search size="small" allowClear placeholder="搜索标题、议程…" style={{ width: 220 }}
            onChange={(e) => setKw(e.target.value)} />
          <Select size="small" style={{ width: 140 }} value={proj} onChange={setProj}
            options={[{ value: 'all' as const, label: '全部项目' }, ...projectOpts]} />
        </div>

        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <>
            {/* 一个 tab 一组，不再上下并排两组 —— 分组标题也就不必了：
                tab 上写着「已结束」，下面再写一遍「已结束」是复读。 */}
            <Group title={tab === 'past' ? '已结束' : '即将进行'}
              items={tab === 'past' ? past : upcoming} onOpen={onOpen} me={me} />
            {rows.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={tab === 'past' ? '还没有结束的活动' : '接下来没有安排'} />
            )}
          </>
        )}
      </Card>

      <div style={{ width: 340, flexShrink: 0 }}>
        {/* ★待我应答 + 冲突提示 + 私聊未读★:与日程页**同一张卡**(todo-card.tsx)。
            此前两页各写各的 —— 日程页只能点进详情才答复、这页能就地答复,
            同一个动作两套交互,比丑更糟。 */}
        <TodoCard all={all} onOpen={onOpen} onOpenMinutes={onOpenMinutes} onDone={() => load(true)} style={{ marginBottom: 12 }} />

      </div>
    </div>
  )
}

/// 一组活动(即将进行 / 已结束)
function Group({ title, items, onOpen, me }: {
  title: string; items: Activity[]; onOpen: (id: number) => void; me: Me | null
}) {
  if (items.length === 0) return null
  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{title}</Typography.Text>
      {items.map((m) => <Row key={m.id} m={m} onOpen={onOpen} me={me} />)}
    </div>
  )
}

const STATUS_TAG: Record<RespondStatus, { t: string; c: string }> = {
  pending: { t: '待应答', c: 'red' }, accepted: { t: '已接受', c: 'green' },
  declined: { t: '已拒绝', c: 'default' }, tentative: { t: '待定', c: 'orange' },
  counter: { t: '已提改期', c: 'purple' },
}

function Row({ m, onOpen, me }: { m: Activity; onOpen: (id: number) => void; me: Me | null }) {
  const s = new Date(m.starts_at), e = new Date(m.ends_at)
  const ended = e.getTime() < Date.now()
  const tag = m.my_status ? STATUS_TAG[m.my_status] : null
  return (
    <div onClick={() => onOpen(m.id)} style={{
      display: 'flex', gap: 14, padding: '10px 4px', borderBottom: '1px solid #f5f5f5', cursor: 'pointer',
    }}>
      <div style={{ width: 92, flexShrink: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{fmtDay(s)}</div>
        <div style={{ fontSize: 12, color: '#8c8c8c' }}>{fmtHM(s)}–{fmtHM(e)}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 3 }}>{m.title}</div>
        <Space size={[6, 2]} wrap style={{ fontSize: 12, color: '#8c8c8c' }}>
          {/* ★类型放在最前★（2026-08-09）：M0 把「这是哪种活动」提成了一等概念，
              界面上却一直看不见 —— 建完就再也分不清哪条是会议、哪条是个人日程。 */}
          {m.type_name && <Tag style={{ marginInlineEnd: 0 }}>{m.type_name}</Tag>}
          {(m.projects ?? []).map((p) => <Tag key={p.id} color="cyan" style={{ marginInlineEnd: 0 }}>{p.name}</Tag>)}
          <span>{m.organizer === me?.username ? '我' : m.organizer} 发起</span>
          {/* 记录员只有「要出纪要」的类型才有 —— 空的时候别显示「记录员 」这半句 */}
          {m.recorder && <span>· 记录员 {m.recorder}</span>}
          {!!m.participant_count && <span>· {m.participant_count} 人</span>}
          {m.is_private && <Tag color="purple" style={{ marginInlineEnd: 0 }}>非公开</Tag>}
        </Space>
        {(m.location || m.online_url || m.agenda) && (
          <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 3 }}>
            {m.online_url && '🖥 线上 '}{m.location && `📍 ${m.location} `}
            {m.agenda && <span>· 议题：{m.agenda.split('\n').filter(Boolean).slice(0, 3).join(' / ')}</span>}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>
        <Space size={4} wrap>
          {/* 已结束的会看纪要状态,进行中的看我的答复 —— 两者都是「这条现在要我做什么」 */}
          {/* ⚠★徽章要先问「这个类型有没有纪要这回事」★（2026-08-11）：
              原来只判 `ended`，于是**个人日程**（`has_minutes=false`）也挂「纪要待整理」——
              截图里「读 Acemoglu 2024」「（补录）上周跑数据」都被催交一份根本不存在的纪要。
              判据与后端的 `activities_owing_minutes` 视图同源，只是这里在前端、带不进视图。 */}
          {ended
            ? (m.has_minutes
              ? (m.minutes_status === 'done' ? <Tag color="green">纪要已完成</Tag> : <Tag color="orange">纪要待整理</Tag>)
              : null)
            : tag && <Tag color={tag.c}>{tag.t}</Tag>}
        </Space>
      </div>
    </div>
  )
}
