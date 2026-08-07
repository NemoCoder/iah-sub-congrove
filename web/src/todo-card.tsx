// 「🔔 待我处理」—— 日程页与会议页**共用同一张卡**（原型两处长得就是一样的）。
//
// ★为什么非抽出来不可★：此前日程页只能点进详情才答复、会议页却能就地答复，
// 同一件事两页两套。上一轮已经因为「双击编辑 vs 编辑按钮」被用户指出过一次
// （见 inline-edit.tsx 头注）—— 同一个动作两套交互，比丑更糟。
//
// 卡里两类条目，判据不同：
//   · 📩 **邀请**：我的答复还是 pending 且会还没开始 —— 要我做的是「答不答应」；
//   · 💬 **私聊未读**：有人在会议里私聊我且我没看过 —— 要我做的是「回一句」。
//     ★公开讨论区的新消息不进这张卡★（后端就没给）：那是「群里有人说话」，
//     混进来会让这卡天天有红点，红点天天有就等于没有。
//
// ★冲突提示在前端本地算★（D1/D2）：私密项目的日程对发起人完全隐形，他不知道你那时段忙，
// 所以必须在**你自己**收到邀请时标红，并把「改期」放在手边 —— 不提醒就一定会漏。
// 本地算是因为列表里已经有我全部的会（含私密项目的），不必再打一次接口。
import { App as AntdApp, Badge, Button, Card, Empty, Space, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type Meeting, type RespondStatus } from './api'

const pad = (n: number) => String(n).padStart(2, '0')
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const fmtDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`
const fmtHM = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

const overlaps = (a: Meeting, b: Meeting) =>
  new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)

type Unread = { meeting_id: number; title: string; sender: string; body: string; created_at: string; count: number }
/// 等我答复的主持人转移(PRD ⑨.5)。★放这张卡而不是项目页里★:
/// 被转让人可能压根不打开那个项目,只在项目内部可见的请求多半永远不会被答复。
type Transfer = { id: number; project_id: number; project_name: string; from: string; created_at: string }

export function TodoCard({ all, onOpen, onDone, style }: {
  /// 我能看到的会议（两页各自已经加载好的那份），卡自己筛出 pending 与冲突
  all: Meeting[]
  onOpen: (id: number) => void
  /// 答复成功后让宿主页重新加载（日历颜色、列表状态都要跟着变）
  onDone: () => void
  style?: React.CSSProperties
}) {
  const { message } = AntdApp.useApp()
  const [unread, setUnread] = useState<Unread[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])

  const loadUnread = useCallback(() => {
    api<Unread[]>('/api/me/unread').then(setUnread).catch(() => setUnread([]))
    api<Transfer[]>('/api/me/transfers').then(setTransfers).catch(() => setTransfers([]))
  }, [])
  useEffect(loadUnread, [loadUnread])

  const now = Date.now()
  // ★只列还没开始的★：会已经开完了再问「接不接受」没有意义，只会占着这张卡不走
  const pending = all
    .filter((m) => m.my_status === 'pending' && new Date(m.starts_at).getTime() > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const accepted = all.filter((m) => m.my_status === 'accepted')

  const total = pending.length + unread.length + transfers.length

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
          {pending.map((m) => (
            <InviteRow key={m.id} m={m} onOpen={onOpen} onDone={onDone}
              clash={accepted.find((x) => x.id !== m.id && overlaps(x, m))} />
          ))}
          {transfers.map((t) => (
            <TransferRow key={t.id} t={t} onDone={() => { loadUnread(); onDone() }} />
          ))}
          {unread.map((u) => (
            <div key={u.meeting_id} style={{ borderTop: pending.length ? '1px solid #f5f5f5' : undefined, paddingTop: pending.length ? 10 : 0 }}>
              <div style={{ fontSize: 13 }}>
                💬 <b>{u.sender}</b> 在「{u.title}」私聊了你
                {u.count > 1 && <Typography.Text type="secondary">（{u.count} 条）</Typography.Text>}
              </div>
              {/* 引用一句原文:光说「有人私聊你」得点进去才知道急不急 */}
              <div style={{
                marginTop: 4, padding: '4px 8px', background: '#fafafa', borderRadius: 4,
                fontSize: 12, color: '#595959', borderLeft: '2px solid #d9d9d9',
              }}>{u.body.length > 60 ? `${u.body.slice(0, 60)}…` : u.body}</div>
              <Button size="small" style={{ marginTop: 6 }} onClick={() => onOpen(u.meeting_id)}>回复</Button>
            </div>
          ))}
        </Space>
      )}
    </Card>
  )
}

/// 一条邀请：★冲突提示 + 四个动作★
function InviteRow({ m, clash, onOpen, onDone }: {
  m: Meeting; clash?: Meeting; onOpen: (id: number) => void; onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const s = new Date(m.starts_at), e = new Date(m.ends_at)
  const reply = async (status: RespondStatus) => {
    setBusy(true)
    try {
      await api(`/api/meetings/${m.id}/respond`, { method: 'POST', body: JSON.stringify({ status }) })
      message.success('已答复'); onDone()
    } catch (err) { message.error((err as Error).message) } finally { setBusy(false) }
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
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
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
