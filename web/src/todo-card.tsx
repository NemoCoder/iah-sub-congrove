// 「🔔 待我处理」—— 日程页与活动页**共用同一张卡**（原型两处长得就是一样的）。
//
// ★为什么非抽出来不可★：此前日程页只能点进详情才答复、活动页却能就地答复，
// 同一件事两页两套。上一轮已经因为「双击编辑 vs 编辑按钮」被用户指出过一次
// （见 inline-edit.tsx 头注）—— 同一个动作两套交互，比丑更糟。
//
// 卡里几类条目，判据不同：
//   · 📩 **邀请**：我的答复还是 pending 且会还没开始 —— 要我做的是「答不答应」；
//   · 💬 **私聊未读**：有人在活动里私聊我且我没看过 —— 要我做的是「回一句」。
//     ★公开讨论区的新消息不进这张卡★（后端就没给）：那是「群里有人说话」，
//     混进来会让这卡天天有红点，红点天天有就等于没有。
//   · 👑 **主持人转移**：等我答复的转让请求。
//   · 📝 **待整理的纪要**（2026-08-10 补）：我是记录员、活动已开完、纪要还不是 done。
//     ⚠★liaoruili：「其实纪要也是待我处理，但是通知里面没有出现」★ ——
//     记录员是 D14 明确指派的角色（「AI 转写只是原材料，记录员才是作者」），
//     却是全系统唯一一件**被指派了却不提醒**的活儿。
//     ★把责任指派给某个人、又不给他一条看得见的待办，那条责任在实践中就等于没指派。★
//     判据在后端的 `activities_owing_minutes` 视图里（与个人面板「待写纪要」同源）。
//
// ★冲突提示在前端本地算★（D1/D2）：私密项目的日程对发起人完全隐形，他不知道你那时段忙，
// 所以必须在**你自己**收到邀请时标红，并把「改期」放在手边 —— 不提醒就一定会漏。
// 本地算是因为列表里已经有我全部的会（含私密项目的），不必再打一次接口。
import { App as AntdApp, Badge, Button, Card, Empty, Space, Typography } from 'antd'
import { Fragment, useCallback, useEffect, useState, type Key, type ReactNode } from 'react'
import { api, type Activity, type RespondStatus } from './api'
import { fmtDay, fmtHM } from './tz'

// ⚠★这三个函数原来在这里抄了一份★(activities-list / upcoming-bar / activity-minutes 各还有一份)。
//   2026-08-12 收敛进 tz.ts —— 复制出来的格式化器是时区支持最先撞上的墙:
//   ★改一处、漏三处,而漏掉的那三处不会报错,只会有几个视图默默显示错的时间。★

const overlaps = (a: Activity, b: Activity) =>
  new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)

type Unread = { activity_id: number; title: string; sender: string; body: string; created_at: string; count: number }
/// 等我答复的主持人转移(PRD ⑨.5)。★放这张卡而不是项目页里★:
/// 被转让人可能压根不打开那个项目,只在项目内部可见的请求多半永远不会被答复。
type Transfer = { id: number; project_id: number; project_name: string; from: string; created_at: string }
/// 等我整理的纪要。`has_draft` 区分「连草稿都没有」与「草稿写了一半」——
/// 两种都是欠着，但前者要说的是「去建一份」，后者是「去写完」，文案不该一样。
type MinutesTodo = { activity_id: number; title: string; starts_at: string; ends_at: string; has_draft: boolean }

/// 每一段默认展开几条。
///
/// ★2026-08-13 liaoruili 改成 5★：「待处理 提醒最多显示 2 条太少，修改为最多显示 5 条，
/// 5 条以上的折叠」。
/// ⚠ 我原来定 2 的理由是「3 条以上就又开始吃卡了」—— ★那是在**每段各出一条折叠行**的年代★:
///   四段各露 2 条 + 四行汇总,卡片确实会被撑长。而现在整张卡只有**一条**折叠行(见 `折叠段`),
///   同样的高度预算下每段能露得更多 —— ★上一个决定的前提没了,数字就该跟着改，
///   而不是守着一个当时算对、现在算错的值。★
const 每段展开条数 = 5

/// ★每一段都要折叠，不是只折纪要那一段★
/// （2026-08-13 liaoruili 截图：待我处理 24 条转移请求全量铺开，「怎么这么长，没有做分页呢」）。
///
/// ⚠ 这是同一个设计判断第二次没落到位。2026-08-11 纪要那段被 6 条吃满时，我写下的理由是
/// 「★这张卡的用途是让人看得见**全部**待办，而它自己被**一类**待办淹掉时这个用途就没了★」——
/// 理由完全成立，但我只把它实现在**当时正在冒烟的那一段**上，另外三段照旧全量渲染。
/// 于是同一个毛病换一类待办又复发一次，而且更狠（24 条）。
/// ★一条只在一处执行的原则，等于没有原则★：现在四段共用这一个组件，
/// 下一类待办加进来时，它是折叠的默认就是对的，不必再想起这条教训。
/// ★一张卡只有**一条**折叠行,文案统一★（2026-08-13 liaoruili：
/// 「不要写什么，直接写还有 X 条需要处理事项即可，不一定都是整理纪要」）。
///
/// ⚠ 上一版是**每段各出一条**折叠行（「还有 N 场邀请等你答复」「还有 N 场欠着纪要（最久 5 天）」…）。
///   四段各说各的,一张卡上最多能冒出四条折叠行 —— ★这张卡是让人**一眼看清还剩多少事**的,
///   而不是让人读四行统计★。而且分段的文案还会误导:折起来的那 X 条**不一定都是纪要**,
///   人看到「还有 3 场欠着纪要」就以为剩下的全是纪要,于是根本不点开。
/// 所以:每段照旧只展开 head 条(★这一条不动★——不然一类待办多起来会把别的类挤没),
/// 但折叠行只有一条、放在卡片最后,说的是**总数**。
function 折叠段<T>({ items, keyOf, render, open, head = 每段展开条数 }: {
  items: T[]
  keyOf: (x: T) => Key
  render: (x: T) => ReactNode
  /// 开合由卡片统一控制 —— 四段要么一起展开、要么一起收起
  open: boolean
  head?: number
}) {
  return (
    <>
      {(open ? items : items.slice(0, head)).map((x) => (
        <Fragment key={keyOf(x)}>{render(x)}</Fragment>
      ))}
    </>
  )
}
export function TodoCard({ all, onOpen, onOpenMinutes, onDone, style }: {
  /// 我能看到的活动（两页各自已经加载好的那份），卡自己筛出 pending 与冲突
  all: Activity[]
  onOpen: (id: number) => void
  /// ★纪要那一路直接进整理页★（2026-08-09 liaoruili 对已删的「我负责的纪要」卡定的）：
  /// 点它的人下一步一定是去写，先落到活动详情再点一次「纪要」是白饶的一跳。
  /// ⚠ 删那张专卡时这个捷径差点跟着丢掉 —— ★删一个界面要连它承载的决定一起搬走★。
  onOpenMinutes: (id: number) => void
  /// 答复成功后让宿主页重新加载（日历颜色、列表状态都要跟着变）
  onDone: () => void
  style?: React.CSSProperties
}) {
  const { message } = AntdApp.useApp()
  const [unread, setUnread] = useState<Unread[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [minutes, setMinutes] = useState<MinutesTodo[]>([])
  /// 四段共用一个开合 —— 一张卡只有一条折叠行(见 `折叠段` 的头注)
  const [open, setOpen] = useState(false)

  const loadUnread = useCallback(() => {
    api<Unread[]>('/api/me/unread').then(setUnread).catch(() => setUnread([]))
    api<Transfer[]>('/api/me/transfers').then(setTransfers).catch(() => setTransfers([]))
    api<MinutesTodo[]>('/api/me/minutes-todo').then(setMinutes).catch(() => setMinutes([]))
  }, [])
  useEffect(loadUnread, [loadUnread])

  const now = Date.now()
  // ★只列还没开始的★：会已经开完了再问「接不接受」没有意义，只会占着这张卡不走
  const pending = all
    .filter((m) => m.my_status === 'pending' && new Date(m.starts_at).getTime() > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const accepted = all.filter((m) => m.my_status === 'accepted')

  const total = pending.length + unread.length + transfers.length + minutes.length
  /// ★被折起来的总条数★:四段各自超出 head 的部分加起来 —— 折叠行只报这一个数。
  const 折起 = [pending, transfers, minutes, unread]
    .reduce((n, xs) => n + Math.max(0, xs.length - 每段展开条数), 0)

  const markAll = async () => {
    try {
      await api('/api/me/unread/read', { method: 'POST', body: JSON.stringify({}) })
      setUnread([])
    } catch (e) { message.error((e as Error).message) }
  }

  return (
    <Card
      style={style}
      styles={{ body: { padding: 14 } }}
      title={
        <Space>
          <span>🔔 待我处理</span>
          <Badge count={total} showZero color={total ? '#ff4d4f' : '#d9d9d9'} />
        </Space>
      }
      extra={unread.length > 0 && (
        <a style={{ fontSize: 12 }} onClick={markAll}>全部标记已读</a>
      )}
    >
      {total === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待办" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <折叠段 items={pending} keyOf={(m) => m.id} open={open}
            render={(m) => (
              <InviteRow m={m} onOpen={onOpen} onDone={onDone}
                clash={accepted.find((x) => x.id !== m.id && overlaps(x, m))} />
            )} />
          <折叠段 items={transfers} keyOf={(t) => t.id} open={open}
            render={(t) => <TransferRow t={t} onDone={() => { loadUnread(); onDone() }} />} />
          {/* ★排在私聊未读之前★：欠一份纪要是**有交付物的活儿**，
              而未读消息多半只是「看一眼」——把重的排在轻的后面，重的就会被划走。 */}
          {/* ★只展开最新两条,其余折起来★（2026-08-11 liaoruili 看到 6 条把整张卡吃满）。
              ⚠ 这是我上一版设计判断失误的收口:我写「不设时间下限——欠着的纪要不会因为
              放久了就不欠」,逻辑没错,但漏了另一半 ——★这张卡的用途是让人**看得见全部
              待办**,而它自己被一类待办淹掉时,这个用途就没了★。
              所以不删账(加时间下限等于系统替人把旧账勾了,而欠得越久越该提醒),
              只是把它折起来:默认两条 + 一行汇总,想算总账点一下全出来。 */}
          <折叠段 items={minutes} keyOf={(m) => m.activity_id} open={open}
            render={(m) => <MinutesRow m={m} onOpen={onOpenMinutes} />} />
          <折叠段 items={unread} keyOf={(u) => u.activity_id} open={open}
            render={(u) => (
            <div style={{ borderTop: pending.length ? '1px solid #f5f5f5' : undefined, paddingTop: pending.length ? 10 : 0 }}>
              <div style={{ fontSize: 13 }}>
                💬 <b>{u.sender}</b> 在「{u.title}」私聊了你
                {u.count > 1 && <Typography.Text type="secondary">（{u.count} 条）</Typography.Text>}
              </div>
              {/* 引用一句原文:光说「有人私聊你」得点进去才知道急不急 */}
              <div style={{
                marginTop: 4, padding: '4px 8px', background: '#fafafa', borderRadius: 4,
                fontSize: 12, color: '#595959', borderLeft: '2px solid #d9d9d9',
              }}>{u.body.length > 60 ? `${u.body.slice(0, 60)}…` : u.body}</div>
              {/* 与「去整理」同类:只是跳过去,不改任何状态 —— 同样用轻样式(见 MinutesRow 的注释) */}
              <div style={{ display: 'flex', marginTop: 4 }}>
                <Button size="small" type="link" onClick={() => onOpen(u.activity_id)}
                  style={{ marginLeft: 'auto', padding: 0, height: 'auto', fontSize: 12 }}>回复 ›</Button>
              </div>
            </div>
          )} />
          {折起 > 0 && (
            <a style={{ fontSize: 12 }} onClick={() => setOpen((v) => !v)}>
              {open ? '收起 ▴' : `还有 ${折起} 条需要处理事项 展开 ▾`}
            </a>
          )}
        </Space>
      )}
    </Card>
  )
}

/// 一条邀请：★冲突提示 + 四个动作★
function InviteRow({ m, clash, onOpen, onDone }: {
  m: Activity; clash?: Activity; onOpen: (id: number) => void; onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const s = new Date(m.starts_at), e = new Date(m.ends_at)
  const reply = async (status: RespondStatus) => {
    setBusy(true)
    try {
      await api(`/api/activities/${m.id}/respond`, { method: 'POST', body: JSON.stringify({ status }) })
      message.success('已答复'); onDone()
    } catch (err) {
      message.error((err as Error).message)
      onDone()          // 同上:答复失败多半是「这条已经不在了」,刷新掉比留着强
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div onClick={() => onOpen(m.id)} style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
        📩 {m.title}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {fmtDay(s)} {fmtHM(s)}–{fmtHM(e)}
      </Typography.Text>
      <div style={{ fontSize: 12, color: '#8c8c8c' }}>
        {(m.projects ?? []).map((p) => p.name).join(' · ')}
        {m.organizer && ` | ${m.organizer} 发起`}
        {!!m.participant_count && ` | ${m.participant_count} 人`}
      </div>
      {clash && (
        <div style={{
          marginTop: 4, padding: '3px 8px', borderRadius: 4, fontSize: 12,
          background: '#fff1f0', border: '1px solid #ffccc7', color: '#cf1322',
        }}>
          ⚠ 撞「{clash.title}」{fmtHM(new Date(clash.starts_at))}–{fmtHM(new Date(clash.ends_at))}
        </div>
      )}
      {/* ★busy 时四个按钮全禁★：只给被点的那个加 loading，连点会打出多个请求（2026-08-07 用户提） */}
      <Space size={4} style={{ marginTop: 6 }} wrap>
        <Button size="small" type="primary" loading={busy} disabled={busy} onClick={() => reply('accepted')}>接受</Button>
        <Button size="small" loading={busy} disabled={busy} onClick={() => reply('tentative')}>待定</Button>
        <Button size="small" loading={busy} disabled={busy} onClick={() => reply('declined')}>拒绝</Button>
        {/* 改期要填具体时间，去详情页做 —— 不在窄栏里塞时间选择器 */}
        <Button size="small" type={clash ? 'primary' : 'default'} ghost={!!clash} disabled={busy}
          onClick={() => onOpen(m.id)}>建议改期</Button>
      </Space>
    </div>
  )
}

/// 一条待整理的纪要。★只给一个动作:去整理★ ——
/// 这件事没有「拒绝」也没有「稍后」:纪要要么写完(status=done)要么还欠着,
/// 加一个「忽略」按钮等于让人把自己的账勾掉,而卡上的账本来就是给别人看的。
function MinutesRow({ m, onOpen }: { m: MinutesTodo; onOpen: (id: number) => void }) {
  const s = new Date(m.starts_at)
  /// 拖了多久 —— 光说「待整理」看不出急不急,而「3 天前开完的」会。
  const days = Math.floor((Date.now() - new Date(m.ends_at).getTime()) / 86400_000)
  const ago = days <= 0 ? '今天开完' : days === 1 ? '昨天开完' : `${days} 天前开完`
  /// ★欠得久了标在**事实**上,不标在按钮上★（2026-08-10 liaoruili：
  /// 「接着写、去整理、去整理，只有最后一个是有颜色的」）。
  /// 原来按 `days >= 3` 给按钮上主色，于是同一张卡上三个同类动作两白一蓝 ——
  /// 读起来像随机的，因为**颜色的理由不在按钮上**（按钮文字完全一样，凭什么一个蓝一个白）。
  /// 「拖了 5 天」是事实，把红色给这句话，颜色的理由就在它旁边；
  /// 动作则保持同一个样子 —— 同类的事长得一样，才看得出它们是同类。
  const overdue = days >= 3
  return (
    <div>
      <div onClick={() => onOpen(m.activity_id)} style={{ cursor: 'pointer', fontSize: 13 }}>
        📝 <b>{m.title}</b> 的纪要等你整理
      </div>
      {/* ★按钮就跟在这一行后面★（liaoruili：「按钮单独放一行有点浪费空间」）——
          这张卡在右栏里本来就窄，一条待办占三行的话，四五条就把整栏吃满、
          后面的看不见了。而「看得见全部待办」正是这张卡唯一的用途。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {fmtDay(s)} {fmtHM(s)} ·{' '}
          <span style={overdue ? { color: '#cf1322' } : undefined}>{ago}</span>
          {' '}· {m.has_draft ? '已有草稿' : '还没建'}
        </Typography.Text>
        {/* ★导航类动作用轻样式★（2026-08-12 liaoruili：「这些按钮的风格有点突兀，比较丑」）。
            两处一起改的理由是**它们本来就不是一类东西**：
            「接受/待定/拒绝」当场改状态，点错了要去别处撤 —— 值一个实心方框；
            「去整理/接着写/回复」只是把你送到另一个页面，什么也没发生 —— 不该长得一样重。
            五行同类动作各画一个描边方框，卡片就变成一列方块了。
            ⚠★另一半丑在右边缘参差★：按钮跟在长短不一的元信息后面，
            每行起点都不同。`marginLeft:auto` 把它们推齐成一列，右边缘就干净了。 */}
        <Button size="small" type="link" onClick={() => onOpen(m.activity_id)}
          style={{ marginLeft: 'auto', padding: 0, height: 'auto', fontSize: 12 }}>
          {m.has_draft ? '接着写' : '去整理'} ›
        </Button>
      </div>
    </div>
  )
}

/// 一条待答复的主持人转移。★两个按钮都要有★:只给「接受」会让不想接的人无处可去,
/// 那条请求就永远躺在卡上;而拒绝是要通知发起人的正当动作,不是「不理它」。
function TransferRow({ t, onDone }: { t: Transfer; onDone: () => void }) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const reply = async (accept: boolean) => {
    setBusy(true)
    try {
      await api(`/api/projects/${t.project_id}/transfer/respond`, {
        method: 'POST', body: JSON.stringify({ accept }),
      })
      message.success(accept ? `你现在是「${t.project_name}」的主持人` : '已拒绝')
      onDone()
    } catch (e) {
      message.error((e as Error).message)
      // ⚠★出错也要刷新★（2026-08-12 liaoruili 撞到：「我已经点击拒绝或者接受了，但是待处理没有消失」）。
      //   这里最常见的错误恰恰是「没有待答复的转移」—— 也就是**它已经被处理过了**，
      //   而卡上这一行是过期的。原来只弹一句错、不刷新，于是★那一行永远卡在那里，
      //   每点一次错一次★，人只会以为功能坏了。
      //   ★「这个操作失败了」和「这一行本来就不该在」是两回事，而错误提示只说了前者。★
      onDone()
    } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ fontSize: 13 }}>
        👑 <b>{t.from}</b> 想把项目「{t.project_name}」的主持人转给你
      </div>
      {/* 说清接手意味着什么 —— 主持人是有责任的位置,别让人稀里糊涂点了接受 */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        接手后由你负责这个项目：成员治理、归档、可见性都归你。
      </Typography.Text>
      <Space size={4} style={{ marginTop: 6 }} wrap>
        <Button size="small" type="primary" loading={busy} disabled={busy} onClick={() => reply(true)}>接受</Button>
        <Button size="small" loading={busy} disabled={busy} onClick={() => reply(false)}>拒绝</Button>
      </Space>
    </div>
  )
}
