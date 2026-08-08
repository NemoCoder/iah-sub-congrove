// 活动纪要整理 —— ★按 docs/prototype-m1.html 的 `min` 视图重做★(2026-08-07)。
//
// 布局是原型定的**两栏**,不是我自己想的:
//   左(430px)= AI 参考稿,★只读原材料★:AI 摘要 / 逐字稿 / 录制;
//   右       = 正式纪要:信息与人员 / 纪要正文。
//
// ★为什么必须并排而不是上下★:记录员的动作是「**看着**逐字稿**写**正文」——
// 上下排就得来回滚,并排才是这一页存在的理由。
//
// ★D14 的边界在这里体现得最清楚★:AI 是原材料、记录员是作者。所以
//   · 左边那三块**只读**,不能在那儿直接改;
//   · 「从 AI 摘要导入」是**一个按钮** —— ★可以导入,但必须他自己点★。
//     我此前把「不自动」做成了「不提供」,反而逼记录员手抄一遍 —— 那是理解偏了(docs/UI-GAP.md 有记)。
//
// 用户在原型评审时定的两条交互仍然成立:**双击才进编辑**(不是一上来就是输入框)、
// 播放器**不常驻**、切到「录制」标签才出现。
import { App as AntdApp, Button, Card, Empty, Space, Spin, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, showUser, type ActivityDetail, type ActivityItem, type Minutes } from './api'
import { InlineEdit } from './inline-edit'
import { fmtSize, ItemIcon } from './preview'

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (s: string) => {
  const d = new Date(s)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const mmss = (sec: number) => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`

type Analysis = {
  job: { status: string; stage: string; progress: number; error: string | null } | null
  transcript: { text: string; segments: { start: number; end: number; text: string; speaker?: string | null }[] } | null
  summaries: { kind: string; content: string }[]
  asr_ready: boolean
}

export function ActivityMinutesView({ activityId, onBack }: { activityId: number; onBack: () => void }) {
  const { message } = AntdApp.useApp()
  const [m, setM] = useState<Minutes | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [detail, setDetail] = useState<ActivityDetail | null>(null)
  const [items, setItems] = useState<ActivityItem[]>([])
  const [ana, setAna] = useState<Analysis | null>(null)
  const [playing, setPlaying] = useState<ActivityItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pane, setPane] = useState('info')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mi, d, its] = await Promise.all([
        api<{ minutes: Minutes | null; can_edit: boolean }>(`/api/activities/${activityId}/minutes`),
        api<ActivityDetail>(`/api/activities/${activityId}`),
        api<ActivityItem[]>(`/api/activities/${activityId}/items`).catch(() => [] as ActivityItem[]),
      ])
      setM(mi.minutes); setCanEdit(mi.can_edit); setDetail(d); setItems(its); setErr(null)
      // 只有**录制**才有转写(D5);取第一个录制的分析结果当参考稿
      const rec = its.find((x) => x.is_recording)
      if (rec) {
        setPlaying((p) => p ?? rec)
        api<Analysis>(`/api/items/${rec.id}/analysis`).then(setAna).catch(() => setAna(null))
      }
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [activityId])
  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<Minutes>) => {
    try {
      await api(`/api/activities/${activityId}/minutes`, { method: 'PUT', body: JSON.stringify(patch) })
      await load()
    } catch (e) { message.error((e as Error).message) }
  }

  /// 逐字稿的时间戳点击 → 跳到录制的那一刻。
  /// 「看着逐字稿写正文」时要能随时回去核对原话,这是这一页的核心动作之一。
  const seek = (sec: number) => {
    const el = document.querySelector<HTMLVideoElement>('#minutes-player')
    if (el) { el.currentTime = sec; void el.play() }
    else message.info(`录制在「录制」标签页里，跳到 ${mmss(sec)}`)
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (err) return <Card><Empty description={err === '403' ? '你没有权限查看这份纪要' : err} /></Card>

  // 后端没有纪要时回 null(不是 404),用空壳渲染,前端不必分支
  const v = m ?? {
    status: 'draft' as const, attendees: '', observers: '', absentees: '',
    agenda_text: '', content_md: '', resolutions: '', todos: '',
  }
  const done = v.status === 'done'
  const mt = detail?.activity
  const sum = (k: string) => ana?.summaries.find((x) => x.kind === k)?.content ?? ''
  const recs = items.filter((x) => x.is_recording)

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '10px 16px' } }}>
        <Space wrap>
          <Button size="small" onClick={onBack}>‹ 返回活动</Button>
          <Typography.Text strong style={{ fontSize: 15 }}>活动纪要</Typography.Text>
          <Tag color={done ? 'green' : 'orange'}>{done ? '已完成' : '草稿'}</Tag>
          {mt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>记录员 {mt.recorder}</Typography.Text>}
          {m?.updated_at && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>最后保存 {fmtTime(m.updated_at)}</Typography.Text>
          )}
          <span style={{ flex: 1 }} />
          {canEdit && (
            <Button size="small" type={done ? 'default' : 'primary'}
              onClick={() => save({ status: done ? 'draft' : 'done' })}>
              {done ? '改回草稿' : '标记完成'}
            </Button>
          )}
        </Space>
      </Card>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* ── 左:AI 参考稿(只读原材料)── */}
        <Card size="small" style={{ width: 430, flexShrink: 0 }} styles={{ body: { paddingTop: 4 } }}>
          <Tabs size="small" items={[
            {
              key: 's', label: 'AI 摘要',
              children: sum('summary')
                ? <div style={{ fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-wrap', maxHeight: 460, overflow: 'auto' }}>{sum('summary')}</div>
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={ana?.job ? `转写中：${ana.job.stage}` : '还没有 AI 摘要（上传录制并转写后生成）'} />,
            },
            {
              key: 't', label: '逐字稿',
              children: ana?.transcript?.segments?.length
                ? (
                  <div style={{ fontSize: 13, lineHeight: 1.9, maxHeight: 460, overflow: 'auto' }}>
                    {ana.transcript.segments.map((sg, i) => (
                      <div key={i}>
                        <a onClick={() => seek(sg.start)} style={{ marginRight: 6 }}>{mmss(sg.start)}</a>
                        {sg.speaker && <b style={{ marginRight: 4 }}>{sg.speaker}：</b>}
                        {sg.text}
                      </div>
                    ))}
                  </div>
                )
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有逐字稿" />,
            },
            {
              key: 'r', label: `录制 ${recs.length}`,
              children: <RecordingPane items={recs} playing={playing} onPlay={setPlaying}
                projectId={detail?.projects?.[0]?.id ?? null} activityId={activityId}
                canEdit={canEdit} onChanged={load} />,
            },
          ]} />
        </Card>

        {/* ── 右:正式纪要 ── */}
        <Card size="small" style={{ flex: 1, minWidth: 0 }} styles={{ body: { paddingTop: 4 } }}>
          <Tabs size="small" activeKey={pane} onChange={setPane} items={[
            {
              key: 'info', label: '信息与人员',
              children: (
                <div>
                  {mt && (
                    <table style={{ fontSize: 13, marginBottom: 16, lineHeight: 2 }}>
                      <tbody>
                        <tr><td style={{ width: 84, color: '#8c8c8c' }}>活动主题</td><td><b>{mt.title}</b></td></tr>
                        <tr><td style={{ color: '#8c8c8c' }}>时间</td><td>{fmtTime(mt.starts_at)} – {fmtTime(mt.ends_at).slice(11)}</td></tr>
                        <tr><td style={{ color: '#8c8c8c' }}>地点</td><td>{mt.location || mt.online_url || '—'}</td></tr>
                        <tr><td style={{ color: '#8c8c8c' }}>所属项目</td>
                            <td>{detail?.projects?.map((p) => <Tag key={p.id} color="cyan">{p.name}</Tag>)}</td></tr>
                        <tr><td style={{ color: '#8c8c8c' }}>主持人</td><td>{mt.organizer}</td></tr>
                        <tr><td style={{ color: '#8c8c8c' }}>记录人</td><td>{mt.recorder}</td></tr>
                      </tbody>
                    </table>
                  )}
                  {/* ★到场/旁听/缺席是**会后补录的事实**★(D11):不是邀请名单、也不等于答复状态 ——
                      答应了没来、没答应却来了都是常事。所以给「带入」当起点,再由记录员改。 */}
                  <Field label="参会人" hint="会后补录的事实，不是邀请名单" value={v.attendees} canEdit={canEdit}
                    onSave={(x) => save({ attendees: x })}
                    pull={detail ? { label: '按答复带入', text: peopleOf(detail, 'accepted') } : undefined} />
                  <Field label="旁听人" value={v.observers} canEdit={canEdit} rows={2}
                    onSave={(x) => save({ observers: x })}
                    pull={detail ? { label: '带入旁听者', text: peopleOf(detail, 'observer') } : undefined} />
                  <Field label="缺席人" value={v.absentees} canEdit={canEdit} rows={2}
                    onSave={(x) => save({ absentees: x })}
                    pull={detail ? { label: '带入未应答/拒绝', text: peopleOf(detail, 'absent') } : undefined} />
                  {canEdit && (
                    <Button type="primary" size="small" style={{ marginTop: 8 }} onClick={() => setPane('body')}>
                      核对完了，去写正文 →
                    </Button>
                  )}
                </div>
              ),
            },
            {
              key: 'body', label: '纪要正文',
              children: (
                <div>
                  <Field label="议题" value={v.agenda_text} canEdit={canEdit} rows={4}
                    onSave={(x) => save({ agenda_text: x })}
                    pull={mt?.agenda ? { label: '从活动议程带入', text: mt.agenda } : undefined} />
                  <Field label="主要内容" hint="支持 Markdown；出 PDF 时由平台的 LaTeX 服务排版"
                    value={v.content_md} canEdit={canEdit} rows={12}
                    onSave={(x) => save({ content_md: x })}
                    pull={sum('summary') ? { label: '从 AI 摘要导入', text: sum('summary') } : undefined} />
                  <Field label="决议事项" value={v.resolutions} canEdit={canEdit} rows={4}
                    onSave={(x) => save({ resolutions: x })}
                    pull={sum('decisions') ? { label: '从 AI 决议导入', text: sum('decisions') } : undefined} />
                  <Field label="待办事项" hint="谁、做什么、什么时候之前" value={v.todos} canEdit={canEdit} rows={4}
                    onSave={(x) => save({ todos: x })} />
                </div>
              ),
            },
          ]} />
        </Card>
      </div>
    </div>
  )
}

/// 按答复状态取人名,给「带入」按钮当默认值。
/// ★absent = 未应答 + 已拒绝★:两者都是「没答应来」,会后补录时都要核对一遍。
function peopleOf(d: ActivityDetail, kind: 'accepted' | 'observer' | 'absent') {
  const ps = d.participants ?? []
  const pick = kind === 'observer'
    ? ps.filter((p) => p.kind === 'observer')
    : kind === 'accepted'
      ? ps.filter((p) => p.kind !== 'observer' && p.status === 'accepted')
      : ps.filter((p) => p.kind !== 'observer' && (p.status === 'pending' || p.status === 'declined'))
  return pick.map((p) => showUser(p.username, p.name)).join('、')
}

/// 纪要里的一块:标签 +（可选）「带入」按钮 + 双击就地编辑。
function Field({ label, hint, value, canEdit, rows = 3, onSave, pull }: {
  label: string; hint?: string; value: string; canEdit: boolean; rows?: number
  onSave: (v: string) => Promise<void>
  /// 「从某处带入」。★可以导入,但必须记录员自己点★(D14):
  /// 追加而不是覆盖 —— 他可能已经写了几行,导入不该把它冲掉。
  pull?: { label: string; text: string }
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>{label}</Typography.Text>
        {hint && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}
        <span style={{ flex: 1 }} />
        {canEdit && pull && pull.text && (
          <Button size="small" onClick={() => onSave(value ? `${value}\n${pull.text}` : pull.text)}>
            {pull.label}
          </Button>
        )}
      </div>
      <InlineEdit value={value} canEdit={canEdit} multiline rows={rows} onSave={onSave}
        style={{ fontSize: 13, lineHeight: 1.8 }} />
    </div>
  )
}

/// 录制面板:播放器 + 上传 + 文件列表(点行切换播放 / 单独转写)。
/// ★播放器不常驻★(原型评审时用户定的):切到「录制」标签才出现。
function RecordingPane({ items, playing, onPlay, projectId, activityId, canEdit, onChanged }: {
  items: ActivityItem[]; playing: ActivityItem | null; onPlay: (i: ActivityItem) => void
  projectId: number | null; activityId: number; canEdit: boolean; onChanged: () => void
}) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState<number | null>(null)
  return (
    <div>
      {playing && (
        <video id="minutes-player" controls preload="metadata" src={`/api/items/${playing.id}/play`}
          style={{ width: '100%', maxHeight: 220, background: '#000', borderRadius: 6, marginBottom: 10 }} />
      )}
      {canEdit && projectId && (
        <div style={{ marginBottom: 10 }}>
          <input type="file" id="rec-up" style={{ display: 'none' }} accept="video/*,audio/*"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const fd = new FormData()
              fd.append('file', f)
              // ★is_recording=true★:只有录制会被转写、并作为活动时长依据(D5)
              const r = await fetch(`/api/projects/${projectId}/upload?activity_id=${activityId}&is_recording=true`,
                { method: 'POST', body: fd })
              if (r.ok) { message.success('已上传'); onChanged() } else message.error(await r.text())
              e.target.value = ''
            }} />
          <Button size="small" type="primary" onClick={() => document.getElementById('rec-up')?.click()}>
            上传录屏 / 录音
          </Button>
        </div>
      )}
      <Table<ActivityItem> size="small" rowKey="id" dataSource={items} pagination={false} showHeader={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有录屏或录音" /> }}
        onRow={(it) => ({ onClick: () => onPlay(it), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: '', render: (_, it) => (
              <span>
                <ItemIcon it={it} />
                <b>{it.name}</b>
                <div style={{ fontSize: 12, color: '#8c8c8c' }}>{it.created_by} · {fmtSize(it.size)}</div>
              </span>
            ),
          },
          {
            title: '', width: 80,
            render: (_, it) => (
              <Button size="small" loading={busy === it.id} disabled={busy === it.id}
                onClick={async (e) => {
                  e.stopPropagation()
                  setBusy(it.id)
                  try {
                    await api(`/api/items/${it.id}/analyze`, { method: 'POST' })
                    message.success('已排队转写')
                    onChanged()
                  } catch (err) { message.error((err as Error).message) } finally { setBusy(null) }
                }}>转写</Button>
            ),
          },
        ]} />
    </div>
  )
}
