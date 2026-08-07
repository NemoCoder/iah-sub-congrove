// 会议详情 —— 左:会议信息 + 议程 + 参会人;右:我的答复 / 建议改期 / 讨论区。
// 对应 docs/prototype-m1.html 的 `meet` 视图。
//
// ★用户在原型上定的两处布局,别改回去★:
//   · **讨论也挪到右边**,而且**放在「建议改期」下面**——答复是主动作,讨论是它的延伸;
//   · 会议与议程内容区**高度要够**(原型里嫌太矮),所以议程用大块留白而不是挤成一行。
//
// ★旁听者(D9)拿到的是裁剪版★:后端就不返回 participants,这里也不能画出名单占位——
// 「有个名单但看不到」比「压根没有这块」更容易让人以为是 bug。
import { App as AntdApp, Alert, Button, Card, DatePicker, Descriptions, Empty, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Typography, Upload } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, showUser, type LinkChange, type MeetingDetail, type MeetingItem, type MeetingMessage, type Participant, type RespondStatus } from './api'
import { fmtSize, ItemIcon } from './preview'

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (s: string) => {
  const d = new Date(s)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtHM = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
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

export function MeetingDetailView({ id, onBack, onOpenMinutes }: {
  id: number; onBack: () => void; onOpenMinutes: (id: number) => void
}) {
  const [d, setD] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /// ★与我已接受的会撞了吗★:D1 决定了发起人看不见我私密项目里的安排,
  /// 所以冲突只能在**我这边**算、在**我这边**提醒。用我自己的会议列表本地比,不必新接口。
  const [clash, setClash] = useState<{ title: string; starts_at: string; ends_at: string } | null>(null)
  /// 编辑弹窗。★线上会议区的「修改」也开它★——两个入口一个实现,免得改链接和改会议是两套逻辑。
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setD(await api<MeetingDetail>(`/api/meetings/${id}`)); setErr(null) }
    catch (e) { setErr((e as Error).message) }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { void load() }, [load])

  // 冲突检测:拉这场会前后一天的会议,找时间重叠且我已接受的
  useEffect(() => {
    if (!d?.meeting || d.meeting.my_status !== 'pending') { setClash(null); return }
    const mm = d.meeting
    const from = new Date(new Date(mm.starts_at).getTime() - 864e5).toISOString()
    const to = new Date(new Date(mm.ends_at).getTime() + 864e5).toISOString()
    api<{ id: number; title: string; starts_at: string; ends_at: string; my_status: string | null }[]>(
      `/api/meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((all) => setClash(all.find((x) => x.id !== mm.id && x.my_status === 'accepted'
        && new Date(x.starts_at) < new Date(mm.ends_at) && new Date(mm.starts_at) < new Date(x.ends_at)) ?? null))
      .catch(() => setClash(null))
  }, [d])

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
        <span style={{ flex: 1 }} />
        {/* ★纪要入口★(原型评审时用户问「整理会议纪要的入口是不是还没有」)。
            旁听者拿不到纪要,所以跟着 participants 一起判断有没有这块。 */}
        {d.participants && (
          <Button size="small" type="primary" ghost onClick={() => onOpenMinutes(id)}>会议纪要</Button>
        )}
        {d.can_edit && !canceled && (
          <Button size="small" onClick={() => setEditing(true)}>编辑</Button>
        )}
        {d.can_edit && !canceled && (
          <Popconfirm title="取消这场会议？" description="记录会保留下来（谁邀了谁、谁拒了是协作事实），只是标记为已取消。"
            onConfirm={async () => {
              try { await api(`/api/meetings/${id}`, { method: 'DELETE' }); await load() } catch (e) { /* 失败由下方错误区呈现 */ }
            }}>
            <Button size="small" danger>取消会议</Button>
          </Popconfirm>
        )}
      </Space>

      {canceled && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="这场会已取消" description="记录保留下来,是因为「谁邀了谁、谁拒了」是协作事实,删掉之后没人说得清当时发生过什么。" />
      )}

      {/* ★冲突提示条★(原型位置:信息卡之前,红底,抢注意力)。
          D1 定了私密项目的日程对发起人完全隐形 —— 他不知道你这个时段忙,
          所以必须在**你自己**打开这场会时把话挑明,并把四个动作放在手边。 */}
      {!canceled && m.my_status === 'pending' && clash && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
          message={<span>此时段你有个人安排「{clash.title}」{fmtHM(new Date(clash.starts_at))}–{fmtHM(new Date(clash.ends_at))}</span>} />
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左:会议信息 + 议程 + 材料 + 参会人 */}
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

          {/* ★线上会议区★:链接 + 复制 + 改动历史(开会前十分钟改链接是真实场景,事后要能追溯) */}
          {m.online_url && d.participants && (
            <OnlineCard id={id} url={m.online_url} canEdit={!!d.can_edit && !canceled} onEdit={() => setEditing(true)} />
          )}

          {/* ★材料 / 录制★(D5:录制 ≠ 材料,只有录制会被转写、并作为会议时长依据) */}
          {d.participants && (
            <MaterialsCard id={id} projectId={d.projects?.[0]?.id ?? null}
              canEdit={!canceled && !!d.projects?.length} onOpenMinutes={onOpenMinutes} />
          )}

          {/* 旁听者拿不到名单,那就整块不渲染 */}
          {d.participants && (
            <Card size="small" title={`参会人（${d.participants.length}）`}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {d.participants.map((p) => (
                  <ParticipantRow key={p.username} p={p} mid={id} canHost={!!d.can_edit && !canceled} onDone={load} />
                ))}
              </Space>
            </Card>
          )}
        </div>

        {/* ★右:答复 → 建议改期 → 讨论★(顺序是用户定的) */}
        <div style={{ width: 340, flexShrink: 0 }}>
          {!canceled && m.my_status && <RespondCard id={id} mine={m.my_status} onDone={load} />}
          {d.participants && <DiscussionCard id={id} organizer={m.organizer} recorder={m.recorder} />}
        </div>
      </div>

      {editing && <EditModal m={m} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load() }} />}
    </div>
  )
}

/// 会议编辑弹窗。★线上会议区的「修改」也开它★——两个入口一个实现,
/// 免得「改链接」和「改会议」变成两套逻辑。不改关联项目:换项目等于换材料归属与判权范围,
/// 那是另一件事(M1 不做)。
function EditModal({ m, onClose, onSaved }: {
  m: MeetingDetail['meeting']; onClose: () => void; onSaved: () => void
}) {
  const { message } = AntdApp.useApp()
  const [title, setTitle] = useState(m.title)
  const [agenda, setAgenda] = useState(m.agenda)
  const [loc, setLoc] = useState(m.location)
  const [url, setUrl] = useState(m.online_url)
  const [range, setRange] = useState<[string, string] | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api(`/api/meetings/${m.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title, agenda, location: loc, online_url: url,
          ...(range ? { starts_at: range[0], ends_at: range[1] } : {}),
        }),
      })
      message.success('已保存'); onSaved()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal open title="编辑会议" onCancel={onClose} onOk={save} confirmLoading={busy} okText="保存">
      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
        <Input addonBefore="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }}
          placeholder={['开始（不改就留空）', '结束']}
          onChange={(v) => setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)} />
        {/* ★改时间会把所有人的答复清回待应答★:说在前面,别让人改完才发现大家要重答一遍 */}
        {range && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            改了时间，所有人的答复都会清回「待应答」——他们当初接受的是旧时间。
          </Typography.Text>
        )}
        <Input addonBefore="地点" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="如：3 号楼 401" />
        <Input addonBefore="线上" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="腾讯会议 / Zoom 链接" />
        <Input.TextArea rows={5} value={agenda} onChange={(e) => setAgenda(e.target.value)}
          placeholder="议题与议程，一行一条" />
      </Space>
    </Modal>
  )
}

function ParticipantRow({ p, mid, canHost, onDone }: {
  p: Participant; mid: number; canHost: boolean; onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const meta = STATUS_META[p.status]
  const act = async (path: string, ok: string) => {
    setBusy(true)
    try {
      await api(`/api/meetings/${mid}/${path}`, { method: 'POST', body: JSON.stringify({ username: p.username }) })
      message.success(ok); onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span style={{ flex: 1 }}>
          {showUser(p.username, p.name)}
          {/* ★临时参会人能参会但看不到材料(D8)★——名单里要标出来,否则发起人以为他能看 */}
          {p.kind === 'guest' && <Tag style={{ marginLeft: 6 }}>临时</Tag>}
          {p.kind === 'observer' && <Tag style={{ marginLeft: 6 }}>旁听</Tag>}
        </span>
        <Tag color={meta.color}>{meta.label}</Tag>
        {/* ★催办只对还没答复的人出现★:已接受/已拒绝的人不该再被打扰 */}
        {canHost && p.status === 'pending' && (
          <Button size="small" loading={busy} onClick={() => act('remind', '已催办')}>催办</Button>
        )}
      </div>
      {/* ★建议改期要能一键采纳★(D2):他给了具体时间,发起人却只能手动重填一遍的话,
          这条「私事冲突唯一的结构化出口」就断在最后一步。 */}
      {p.status === 'counter' && p.counter_starts_at && (
        <div style={{ margin: '4px 0 6px 8px', padding: '6px 10px', background: '#f9f0ff', borderRadius: 4 }}>
          <div style={{ fontSize: 12 }}>建议改到 <b>{fmtTime(p.counter_starts_at)}</b></div>
          {p.counter_reason && <div style={{ fontSize: 12, color: '#8c8c8c' }}>理由：{p.counter_reason}</div>}
          {canHost && (
            <Popconfirm title="采纳这个时间？"
              description="会议时间会改成他提议的时间，所有人的答复都会清回「待应答」——包括他本人。"
              onConfirm={() => act('accept-counter', '已改期')}>
              <Button size="small" type="primary" loading={busy} style={{ marginTop: 6 }}>采纳并改期</Button>
            </Popconfirm>
          )}
        </div>
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
function DiscussionCard({ id, organizer, recorder }: { id: number; organizer: string; recorder: string }) {
  const { message } = AntdApp.useApp()
  const [msgs, setMsgs] = useState<MeetingMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /// ★发送至★:公开 or 私聊。私聊对象只限发起人与记录员(D13:不做任意点对点,否则长成 IM)。
  const [to, setTo] = useState<string>('public')
  const load = useCallback(async () => {
    try {
      const q = to === 'public' ? '' : `?channel=private&peer=${encodeURIComponent(to)}`
      setMsgs(await api<MeetingMessage[]>(`/api/meetings/${id}/messages${q}`))
    } catch { setMsgs([]) }
  }, [id, to])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try {
      await api(`/api/meetings/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify(to === 'public' ? { body } : { body, channel: 'private', peer: to }),
      })
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
      <Select size="small" value={to} onChange={setTo} style={{ width: '100%', marginBottom: 6 }}
        options={[
          { value: 'public', label: '所有参会人' },
          // ★私聊对象只有这两位★(D13):不做任意点对点,否则这里会长成一个 IM
          { value: organizer, label: `私聊 ${organizer}（发起人）` },
          ...(recorder !== organizer ? [{ value: recorder, label: `私聊 ${recorder}（记录员）` }] : []),
        ]} />
      <Input.TextArea rows={2} value={text} placeholder="说点什么…（Enter 发送）"
        onChange={(e) => setText(e.target.value)}
        onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send() } }} />
      <Button size="small" type="primary" block style={{ marginTop: 8 }} loading={busy}
        disabled={!text.trim()} onClick={send}>发送</Button>
    </Card>
  )
}

/// 线上会议:链接 + 复制 + 改动历史。
/// ★改动历史不是装饰★:临开会前换链接很常见,事后「我进的是旧链接」要能查清是谁什么时候改的。
function OnlineCard({ id, url, canEdit, onEdit }: {
  id: number; url: string; canEdit: boolean; onEdit: () => void
}) {
  const { message } = AntdApp.useApp()
  const [hist, setHist] = useState<LinkChange[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    api<LinkChange[]>(`/api/meetings/${id}/link-history`).then(setHist).catch(() => setHist([]))
  }, [id])
  return (
    <Card size="small" title="线上会议" style={{ marginBottom: 12 }}>
      <Space wrap>
        <a href={url} target="_blank" rel="noreferrer">{url}</a>
        <Button size="small" onClick={async () => {
          try { await navigator.clipboard.writeText(url); message.success('已复制') }
          catch { message.info(url) }
        }}>复制</Button>
        {canEdit && <Button size="small" onClick={onEdit}>修改</Button>}
        {hist.length > 0 && (
          <Button size="small" type="link" onClick={() => setOpen((v) => !v)}>
            改动历史 {hist.length}
          </Button>
        )}
      </Space>
      {open && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#8c8c8c' }}>
          {hist.map((h, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              {fmtTime(h.changed_at)} · {h.changed_by} 改成 <code>{h.new_url || '(清空)'}</code>
              {h.old_url && <span>（原 <code>{h.old_url}</code>）</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/// 材料 / 录制 两个 tab(原型还有第三个「纪要」,这里做成跳转按钮 —— 纪要有自己一整页)。
/// ★录制单独一个 tab★:它不是普通材料,是**会被转写、并决定会议时长**的东西(D5),
/// 混在材料里会让人不知道该传哪儿。
function MaterialsCard({ id, projectId, canEdit, onOpenMinutes }: {
  id: number; projectId: number | null; canEdit: boolean; onOpenMinutes: (id: number) => void
}) {
  const { message } = AntdApp.useApp()
  const [items, setItems] = useState<MeetingItem[]>([])
  const [tab, setTab] = useState('mat')
  const load = useCallback(async () => {
    try { setItems(await api<MeetingItem[]>(`/api/meetings/${id}/items`)) } catch { setItems([]) }
  }, [id])
  useEffect(() => { void load() }, [load])

  const mats = items.filter((i) => !i.is_recording)
  const recs = items.filter((i) => i.is_recording)

  const table = (rows: MeetingItem[], empty: string) => (
    <Table<MeetingItem> size="small" rowKey="id" dataSource={rows} pagination={false}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      columns={[
        { title: '名称', render: (_, it) => <span><ItemIcon it={it} />{it.name}</span> },
        { title: '大小', dataIndex: 'size', width: 90, render: (v) => fmtSize(v) },
        { title: '上传', width: 150, render: (_, it) => `${it.created_by} · ${fmtTime(it.created_at).slice(5, 16)}` },
        {
          title: '', width: 70,
          render: (_, it) => <a href={`/api/items/${it.id}/download`}>下载</a>,
        },
      ]} />
  )

  return (
    <Card size="small" style={{ marginBottom: 12 }}
      styles={{ body: { paddingTop: 4 } }}>
      <Tabs size="small" activeKey={tab} onChange={setTab}
        items={[
          { key: 'mat', label: `材料 ${mats.length}`, children: table(mats, '还没有材料') },
          { key: 'rec', label: `录制 ${recs.length}`, children: table(recs, '还没有录屏或录音') },
        ]}
        tabBarExtraContent={canEdit && (
          <Space size={6}>
            {/* ★上传录屏单独一个入口★(原型评审:「最好单独有个上传录屏的入口」)——
                因为它决定「会不会被转写」,和传一份参考资料完全是两件事。 */}
            <Upload showUploadList={false} multiple
              customRequest={({ file, onSuccess, onError }) => {
                // ★走项目上传接口 + meeting_id★:会议材料是「只读区」指的是**入口唯一**(D10),
                // 不必为它另写一套流式上传。落在关联项目之一,靠 meeting_id 让所有关联项目都看得到(D4)。
                const fd = new FormData()
                fd.append('file', file as File)
                const qs = `meeting_id=${id}&is_recording=${tab === 'rec'}`
                fetch(`/api/projects/${projectId}/upload?${qs}`, { method: 'POST', body: fd })
                  .then((r) => r.ok ? (onSuccess?.({}), load()) : r.text().then((t) => { message.error(t); onError?.(new Error(t)) }))
                  .catch((e) => { message.error(String(e)); onError?.(e as Error) })
              }}>
              <Button size="small" type={tab === 'rec' ? 'primary' : 'default'}>
                {tab === 'rec' ? '上传录屏 / 录音' : '上传材料'}
              </Button>
            </Upload>
            <Button size="small" onClick={() => onOpenMinutes(id)}>整理纪要</Button>
          </Space>
        )} />
    </Card>
  )
}
