// 活动页 —— 对应 docs/prototype-m1.html 的 `meets` 视图。
//
// ★2026-08-07 补做★:此前整页缺失(导航里连「活动」这个 tab 都没有),
// 因为我当初只照着原型的日历那一段实现,其余页面凭自己想 —— 用户对着原型一眼看出来了。
// 现在严格按原型:三 tab + 搜索/筛选 + 即将进行/已结束分组 + 右栏「待我应答」「我负责的纪要」。
//
// ★右栏的冲突提示是这一页的灵魂★(D1/D2):私密项目的日程对发起人完全隐形,
// 他不知道你那个时段忙 —— 所以必须在**你自己**收到邀请时标红提醒,并把「改期」放在手边。
// 冲突**在前端本地算**:列表里已经有我全部的会(含我私密项目的),不必再打接口。
import { App as AntdApp, Button, Card, Empty, Input, Pagination, Segmented, Select, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, showUser, type Activity, type Me } from './api'
import { annotate, fmtDay, fmtHM } from './tz'
import { STATUS_LABEL, isEnded } from './activity-state'
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
  /// ⚠ 换 tab / 改搜索词时**回到第一页**:否则停在第 5 页去看一份新筛出来的短列表,
  ///   人看到的是空白,而原因(「你还停在第 5 页」)一个字都没写在屏幕上。
  const [tab, setTab] = useState<'joined' | 'mine' | 'declined' | 'past'>('joined')
  const [kw, setKw] = useState('')
  const [proj, setProj] = useState<number | 'all'>('all')
  const [页, setPage] = useState(1)

  /// `silent=true` 不掀 loading（同 activity-detail / schedule-view）：
  /// 右栏「待我处理」就地答复后只需要刷新数据，不需要把整页重建一次。
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      // ★范围要大★:这一页是「我的全部活动」,不是日历那一屏。前后各半年。
      // ⚠ 与 `todo-card.tsx` 的 `卡片天数` 是**同一个 183**,而两边各自拉一次
      //   `/api/activities?from…to…` —— ★这一页因此把同样的请求打了两遍★(2026-08-16 审计)。
      //   没改成共用:卡要能在**任何**宿主页里自足(那正是 2026-08-15 收它数据的理由),
      //   而这一页要的是「全部活动」用来分 tab/搜索/分页,两者只是**恰好**同一个范围。
      //   ★为「碰巧一样」建立依赖,是下一次漂移的起点★;代价是一次内网 GET,认了。
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
    // ★我拒绝掉的只归「已拒绝」这一格★（2026-08-14 liaoruili:「现在我拒绝的与我接受的放到一起了」）。
    //   ⚠ 它同时要从 `joined` **和** `past` 里摘掉 —— 只摘前一格的话,拒绝掉的会在时间过去之后
    //     又从「已结束」里冒出来,★人会以为「我不是拒了吗，怎么还记在我账上」★。
    //   「已拒绝」不按时间切:拒掉的多半已经过去了,再按「即将进行」筛一遍就永远是空的。
    //   排序也反过来 —— 这一格是回看,最近拒的最该在最前面。
    if (tab === 'declined') {
      return all
        .filter((m) => m.my_status === 'declined')
        .filter((m) => proj === 'all' || (m.projects ?? []).some((p) => p.id === proj))
        .filter((m) => !k || m.title.toLowerCase().includes(k) || m.agenda.toLowerCase().includes(k))
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    }
    return all
      .filter((m) => m.my_status !== 'declined')
      .filter((m) => (tab === 'past' ? isEnded(m, now)
        : new Date(m.ends_at).getTime() >= now && (tab !== 'mine' || m.organizer === me?.username)))
      .filter((m) => proj === 'all' || (m.projects ?? []).some((p) => p.id === proj))
      .filter((m) => !k || m.title.toLowerCase().includes(k) || m.agenda.toLowerCase().includes(k))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  }, [all, tab, kw, proj, me, now])

  const upcoming = rows.filter((m) => new Date(m.ends_at).getTime() >= now)
  const past = rows.filter((m) => isEnded(m, now)).reverse()

  // 待我应答与冲突计算都搬进 TodoCard(★两页共用★),这里不再各算一套。
  // ⚠ 2026-08-15 起连**数据**也归卡自己拉 —— 共用组件却各喂各的数据不算共用,
  //   详见 todo-card.tsx 的 `卡片天数`。

  // ⚠★「我负责的纪要」这张专卡已删★（2026-08-11 liaoruili：「这上下不是一样的吗」）。
  //   它 2026-08-08 就在这儿，而我 08-10 往「待我处理」里也加了一路纪要待办 ——
  //   ★同一页上下两张卡列同一批数据，是我加之前没先看它有没有归宿造成的。★
  //   更实质的是这两张卡当时用的是**两套判据**：这里前端本地算（且漏了 has_minutes），
  //   那边走后端 activities_owing_minutes 视图。删掉这张，判据就只剩视图一处。

  /// ★每页 20 场★:这一栏是**主列表**(宽 ~900px、一行一场),不是右栏的小卡片,
  /// 20 场刚好一屏多一点 —— 少了翻页太勤,多了又回到「一直下滑」。
  const 每页 = 20
  const 当前 = tab === 'past' ? past : tab === 'declined' ? rows : upcoming
  /// ★生效页码是派生的★(与公开活动广场同一处教训):换 tab / 改搜索词之后总数会变,
  /// 存着的页码可能已经越界 → 一片空白且看不出为什么。
  const 总页 = Math.max(1, Math.ceil(当前.length / 每页))
  const 有效页 = Math.min(页, 总页)

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
            size="small" value={tab} onChange={(v) => { setTab(v as typeof tab); setPage(1) }}
            options={[{ value: 'joined', label: '我参与的' }, { value: 'mine', label: '我发起的' },
                      { value: 'declined', label: '已拒绝' }, { value: 'past', label: '已结束' }]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>共 {rows.length} 场</Typography.Text>
          <span style={{ flex: 1 }} />
          <Input.Search size="small" allowClear placeholder="搜索标题、议程…" style={{ width: 220 }}
            onChange={(e) => { setKw(e.target.value); setPage(1) }} />
          <Select size="small" style={{ width: 140 }} value={proj} onChange={(v) => { setProj(v); setPage(1) }}
            options={[{ value: 'all' as const, label: '全部项目' }, ...projectOpts]} />
        </div>

        {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : (
          <>
            {/* 一个 tab 一组，不再上下并排两组 —— 分组标题也就不必了：
                tab 上写着「已结束」，下面再写一遍「已结束」是复读。 */}
            {/* ★分页★（2026-08-13 liaoruili:「活动页面也没有做分页；我参与的现在超级多；
                已结束以后会更多」）—— ★这是同一个形状的第三处★:
                待我处理、公开活动广场、这里。共同点是**条数不由我们控制**:
                参与的会只会越来越多,已结束的更是只增不减。
                ★一个只增不减的列表,不分页就是「迟早滚不完」,不是「暂时还好」。★
                所以这次不等第四处被指出来,顺手把全站还剩的无界列表一起查了(见提交信息)。 */}
            <Group title={tab === 'past' ? '已结束' : tab === 'declined' ? '已拒绝' : '即将进行'}
              items={当前.slice((有效页 - 1) * 每页, 有效页 * 每页)}
              onOpen={onOpen} me={me} />
            {当前.length > 每页 && (
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <Pagination size="small" current={有效页} pageSize={每页} total={当前.length}
                  showSizeChanger={false}
                  showTotal={(t, r) => `第 ${r[0]}–${r[1]} 场，共 ${t} 场`}
                  onChange={setPage} />
              </div>
            )}
            {rows.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                // ★空态要回答「这个筛选下为什么是空的」,不是笼统说时间★(2026-08-15 巡检截图看出来的):
                //   原来只特判了 past / declined,`mine`(我发起的)落进默认分支 ——
                //   于是「我发起的」筛出 0 条时说「接下来没有安排」,
                //   ★而这里的 0 是「你没发起过活动」,和「接下来」半点关系没有。★
                description={tab === 'past' ? '还没有结束的活动'
                  : tab === 'declined' ? '你还没有拒绝过任何活动'
                  : tab === 'mine' ? '你还没有发起过活动'
                  : '接下来没有安排'} />
            )}
          </>
        )}
      </Card>

      <div style={{ width: 340, flexShrink: 0 }}>
        {/* ★待我应答 + 冲突提示 + 私聊未读★:与日程页**同一张卡**(todo-card.tsx)。
            此前两页各写各的 —— 日程页只能点进详情才答复、这页能就地答复,
            同一个动作两套交互,比丑更糟。 */}
        <TodoCard onOpen={onOpen} onOpenMinutes={onOpenMinutes} onDone={() => load(true)} style={{ marginBottom: 12 }} />

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


function Row({ m, onOpen, me }: { m: Activity; onOpen: (id: number) => void; me: Me | null }) {
  const s = new Date(m.starts_at), e = new Date(m.ends_at)
  const ended = e.getTime() < Date.now()
  const tag = m.my_status ? STATUS_LABEL[m.my_status] : null
  return (
    <div onClick={() => onOpen(m.id)} style={{
      display: 'flex', gap: 14, padding: '10px 4px', borderBottom: '1px solid #f5f5f5', cursor: 'pointer',
    }}>
      <div style={{ width: 92, flexShrink: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{fmtDay(s)}</div>
        <div style={{ fontSize: 12, color: '#8c8c8c' }}>
          {fmtHM(s)}–{fmtHM(e)}
          {/* E2:跨时区才标（一致时 annotate 返回空串） */}
          {annotate(m.starts_at, m.timezone)}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 3 }}>{m.title}</div>
        <Space size={[6, 2]} wrap style={{ fontSize: 12, color: '#8c8c8c' }}>
          {/* ★类型放在最前★（2026-08-09）：M0 把「这是哪种活动」提成了一等概念，
              界面上却一直看不见 —— 建完就再也分不清哪条是会议、哪条是个人日程。 */}
          {m.type_name && <Tag style={{ marginInlineEnd: 0 }}>{m.type_name}</Tag>}
          {(m.projects ?? []).map((p) => <Tag key={p.id} color="cyan" style={{ marginInlineEnd: 0 }}>{p.name}</Tag>)}
          <span>{m.organizer === me?.username ? '我' : showUser(m.organizer, m.organizer_name)} 发起</span>
          {/* 记录员只有「要出纪要」的类型才有 —— 空的时候别显示「记录员 」这半句 */}
          {m.recorder && <span>· 记录员 {showUser(m.recorder, m.recorder_name)}</span>}
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
            : tag && <Tag color={tag.color}>{tag.text}</Tag>}
        </Space>
      </div>
    </div>
  )
}
