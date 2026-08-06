// 会议详情 —— 左:会议信息 + 议程 + 参会人;右:我的答复 / 建议改期 / 讨论区。
// 对应 docs/prototype-m1.html 的 `meet` 视图。
//
// ★用户在原型上定的两处布局,别改回去★:
//   · **讨论也挪到右边**,而且**放在「建议改期」下面**——答复是主动作,讨论是它的延伸;
//   · 会议与议程内容区**高度要够**(原型里嫌太矮),所以议程用大块留白而不是挤成一行。
//
// ★旁听者(D9)拿到的是裁剪版★:后端就不返回 participants,这里也不能画出名单占位——
// 「有个名单但看不到」比「压根没有这块」更容易让人以为是 bug。
import { App as AntdApp, Alert, Button, Card, DatePicker, Descriptions, Empty, Input, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type MeetingDetail, type MeetingMessage, type Participant, type RespondStatus } from './api'

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (s: string) => {
  const d = new Date(s)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtRange = (a: string, b: string) => {
  const s = new Date(a), e = new Date(b)
  const sameDay = s.toDateString() === e.toDateString()
  return sameDay
    ? `${fmtTime(a)} – ${pad(e.getHours())}:${pad(e.getMinutes())}`
    : `${fmtTime(a)} – ${fmtTime(b)}`
}

const STATUS_META: Record<RespondStatus, { label: string; color: string }> = {
  pending: { label: '待应答', color: 'red' },
  accepted: { label: '接受', color: 'green' },
  declined: { label: '拒绝', color: 'default' },
  tentative: { label: '待定', color: 'orange' },
  counter: { label: '建议改期', color: 'purple' },
}

export function MeetingDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const [d, setD] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setD(await api<MeetingDetail>(`/api/meetings/${id}`)); setErr(null) }
    catch (e) { setErr((e as Error).message) }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { void load() }, [load])

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (err || !d)
    return (
      <Card>
        {/* 看不见的会议后端回 404(与「不存在」同一回应,防按 id 探测),这里不区分原因 */}
        <Empty description={err === '404' ? '这个会议不存在,或你没有权限查看' : err} />
        <div style={{ textAlign: 'center', marginTop: 12 }}><Button onClick={onBack}>返回日程</Button></div>
      </Card>
    )

  const m = d.meeting
  const canceled = m.status === 'canceled'

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button size="small" onClick={onBack}>‹ 返回日程</Button>
        <Typography.Text strong style={{ fontSize: 16 }}>{m.title}</Typography.Text>
        {canceled && <Tag color="default">已取消</Tag>}
        {m.visibility === 'public' && <Tag color="blue">公开会议</Tag>}
        {m.is_private && <Tag color="purple">私密项目</Tag>}
        {d.observer && <Tag>旁听</Tag>}
      </Space>

      {canceled && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="这场会已取消" description="记录保留下来,是因为「谁邀了谁、谁拒了」是协作事实,删掉之后没人说得清当时发生过什么。" />
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左:会议信息 + 议程 + 参会人 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card size="small" style={{ marginBottom: 12 }}>
            <Descriptions column={1} size="small" items={[
              { key: 't', label: '时间', children: fmtRange(m.starts_at, m.ends_at) },
              { key: 'l', label: '地点', children: m.location || <Typography.Text type="secondary">未填</Typography.Text> },
              {
                key: 'u', label: '线上',
                children: m.online_url
                  ? <a href={m.online_url} target="_blank" rel="noreferrer">{m.online_url}</a>
                  : <Typography.Text type="secondary">未填</Typography.Text>,
              },
              { key: 'o', label: '发起人', children: m.organizer },
              // ★记录员是必填字段(D14)★:正式纪要由他按模板整理,AI 转写只是原材料
              { key: 'r', label: '记录员', children: <Tag color="cyan">{m.recorder}</Tag> },
              ...(d.projects?.length
                ? [{ key: 'p', label: '关联项目', children: <Space wrap>{d.projects.map((p) => <Tag key={p.id}>{p.name}</Tag>)}</Space> }]
                : []),
            ]} />
          </Card>

          {/* ★议程区要留足高度★(原型评审:内容高度太矮) */}
          <Card size="small" title="议题与议程" style={{ marginBottom: 12 }}>
            <div style={{ minHeight: 160, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>
              {m.agenda || <Typography.Text type="secondary">还没写议程。</Typography.Text>}
            </div>
            {m.visibility === 'public' && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                这是公开会议,议程对全平台可见 —— ★但材料不公开★,只有关联项目的成员能看。
              </Typography.Text>
            )}
          </Card>

          {/* 旁听者拿不到名单,那就整块不渲染 */}
          {d.participants && (
            <Card size="small" title={`参会人（${d.participants.length}）`}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {d.participants.map((p) => <ParticipantRow key={p.username} p={p} />)}
              </Space>
            </Card>
          )}
        </div>

        {/* ★右:答复 → 建议改期 → 讨论★(顺序是用户定的) */}
        <div style={{ width: 340, flexShrink: 0 }}>
          {!canceled && m.my_status && <RespondCard id={id} mine={m.my_status} onDone={load} />}
          {d.participants && <DiscussionCard id={id} />}
        </div>
      </div>
    </div>
  )
}

function ParticipantRow({ p }: { p: Participant }) {
  const meta = STATUS_META[p.status]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span style={{ flex: 1 }}>
        {p.username}
        {/* ★临时参会人能参会但看不到材料(D8)★——名单里要标出来,否则发起人以为他能看 */}
        {p.kind === 'guest' && <Tag style={{ marginLeft: 6 }}>临时</Tag>}
        {p.kind === 'observer' && <Tag style={{ marginLeft: 6 }}>旁听</Tag>}
      </span>
      <Tag color={meta.color}>{meta.label}</Tag>
      {p.status === 'counter' && p.counter_starts_at && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提议 {fmtTime(p.counter_starts_at)}
        </Typography.Text>
      )}
    </div>
  )
}

/// 我的答复 + 建议改期。
/// ★「建议改期」必须给出具体的替代时间★——只说「我不行」等于把问题丢回发起人(D2)。
/// 后端也会拒(400),这里不是唯一防线,但要在**提交之前**就说清楚,别让人白填一轮。
function RespondCard({ id, mine, onDone }: { id: number; mine: RespondStatus; onDone: () => void }) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const [showCounter, setShowCounter] = useState(mine === 'counter')
  const [range, setRange] = useState<[string, string] | null>(null)
  const [reason, setReason] = useState('')

  const send = async (status: RespondStatus) => {
    if (status === 'counter' && !range) { message.warning('请先选一个你方便的时间段'); return }
    setBusy(true)
    try {
      await api(`/api/meetings/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          ...(status === 'counter' && range
            ? { counter_starts_at: range[0], counter_ends_at: range[1], counter_reason: reason || null }
            : {}),
        }),
      })
      message.success('已答复')
      onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  const meta = STATUS_META[mine]
  return (
    <Card size="small" title="我的答复" style={{ marginBottom: 12 }}
      extra={<Tag color={meta.color}>{meta.label}</Tag>}>
      <Space wrap style={{ marginBottom: showCounter ? 12 : 0 }}>
        <Button size="small" type={mine === 'accepted' ? 'primary' : 'default'} loading={busy}
          onClick={() => send('accepted')}>接受</Button>
        <Button size="small" type={mine === 'tentative' ? 'primary' : 'default'} loading={busy}
          onClick={() => send('tentative')}>待定</Button>
        <Button size="small" danger={mine === 'declined'} loading={busy}
          onClick={() => send('declined')}>拒绝</Button>
        <Button size="small" type={showCounter ? 'primary' : 'dashed'}
          onClick={() => setShowCounter((v) => !v)}>建议改期</Button>
      </Space>

      {showCounter && (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 8px' }}>
            发起人**看不到**你私密项目里的安排,所以他不知道你这个时段忙。
            给一个你方便的具体时间,比只说「不行」有用得多。
          </Typography.Paragraph>
          <DatePicker.RangePicker
            showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" size="small"
            style={{ width: '100%', marginBottom: 8 }}
            onChange={(v) => setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)}
          />
          <Input.TextArea rows={2} size="small" placeholder="原因（选填）" value={reason}
            onChange={(e) => setReason(e.target.value)} style={{ marginBottom: 8 }} />
          <Button size="small" type="primary" block loading={busy} disabled={!range}
            onClick={() => send('counter')}>提交改期建议</Button>
        </div>
      )}
    </Card>
  )
}

/// 会议讨论区(D13)。★放在答复下面★(用户定的位置)。
/// 只做 public 频道:私聊只能发给发起人/记录员,入口放在参会人行上更自然,M1 先不做。
function DiscussionCard({ id }: { id: number }) {
  const { message } = AntdApp.useApp()
  const [msgs, setMsgs] = useState<MeetingMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setMsgs(await api<MeetingMessage[]>(`/api/meetings/${id}/messages`)) } catch { setMsgs([]) }
  }, [id])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try {
      await api(`/api/meetings/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) })
      setText('')
      await load()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card size="small" title="讨论">
      <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 10 }}>
        {msgs.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有人说话" />
          : msgs.map((m) => (
            <div key={m.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                {m.sender} · {fmtTime(m.created_at)}
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          ))}
      </div>
      <Input.TextArea rows={2} value={text} placeholder="说点什么…（Enter 发送）"
        onChange={(e) => setText(e.target.value)}
        onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send() } }} />
      <Button size="small" type="primary" block style={{ marginTop: 8 }} loading={busy}
        disabled={!text.trim()} onClick={send}>发送</Button>
    </Card>
  )
}
