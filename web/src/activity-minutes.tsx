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
import { App as AntdApp, Button, Card, Empty, Popconfirm, Progress, Space, Spin, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, showUser, type ActivityDetail, type ActivityItem, type Minutes } from './api'
import { InlineEdit } from './inline-edit'
import { useActivityUpload } from './activity-upload'
import { fmtSize, ItemIcon, MarkdownView } from './preview'

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (s: string) => {
  const d = new Date(s)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const mmss = (sec: number) => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`

type Job = { status: string; stage: string; progress: number; error: string | null }
type Analysis = {
  job: Job | null
  transcript: { text: string; segments: { start: number; end: number; text: string; speaker?: string | null }[] } | null
  summaries: { kind: string; content: string }[]
  asr_ready: boolean
}
/// ★纪要的三份 AI 产物,kind 由 `media_ai.rs` 写死★:`brief` / `outline` / `decisions`。
/// ⚠ 2026-08-09 用户报「AI 摘要没写出来」——真因是**前端一直在问一个不存在的 kind**(`summary`)。
/// 后端把三份都生成了、也都入库了,前端拿 `summary` 去找,永远是空:
///   · 「AI 摘要」页永远空着(还配着一句自相矛盾的「转写中:完成」);
///   · 「从 AI 摘要导入」按钮因此永不出现 —— 而「从 AI 决议导入」出现了,
///     ★正是这个不对称暴露了它★(kind 对得上的那个能显示)。
///   · `outline`(分段大纲)更惨:**生成了、付了 GPU 和 LLM 的钱,却从没有任何界面读它**。
/// 教训:这类「两端各写各的字符串常量」的错,类型检查看不见、后端测试也看不见。
const K_BRIEF = 'brief', K_OUTLINE = 'outline', K_DECISIONS = 'decisions'
const isRunning = (j: Job | null | undefined) => j?.status === 'queued' || j?.status === 'running'

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

  /// ★silent=true 时不掀起整页 loading★(2026-08-09 用户:「点完转写自动回到 AI 摘要，页面抖动了」)。
  /// 根因不是动画,是**整页被 <Spin/> 换掉又换回来**:这一换,左右两组 Tabs 全部重挂载,
  /// 于是左边从「录制」弹回「AI 摘要」、右边滚动位置也丢。
  /// ★「刷新数据」和「重建界面」是两件事★ —— 带入人员、排队转写、存字段都只需要前者。
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [mi, d, its] = await Promise.all([
        api<{ minutes: Minutes | null; can_edit: boolean }>(`/api/activities/${activityId}/minutes`),
        api<ActivityDetail>(`/api/activities/${activityId}`),
        api<ActivityItem[]>(`/api/activities/${activityId}/items`).catch(() => [] as ActivityItem[]),
      ])
      setM(mi.minutes); setCanEdit(mi.can_edit); setDetail(d); setItems(its); setErr(null)
      // 只有**录制**才有转写(D5);取第一个录制的分析结果当参考稿
      const rec = its.find((x) => x.is_recording)
      if (rec) setPlaying((p) => p ?? rec)
    } catch (e) { setErr((e as Error).message) } finally { if (!silent) setLoading(false) }
  }, [activityId])
  useEffect(() => { void load() }, [load])

  /// ★参考稿看的就是「当前在播的那一段」★:不再是一个能和选中项走散的独立状态。
  /// (它曾经是个独立的 `anaFor` state —— 两份真相迟早对不上,而这里没有第二份的理由。)
  const anaFor = playing?.id ?? null

  /// 取某个录制的分析结果。
  const pullAna = useCallback((iid: number) =>
    api<Analysis>(`/api/items/${iid}/analysis`).then(setAna).catch(() => setAna(null)), [])
  useEffect(() => { if (anaFor) void pullAna(anaFor) }, [anaFor, pullAna])

  const job = ana?.job ?? null
  /// ★转写在跑就轮询★(2026-08-09 用户:「转写可以多次点击,且没有进度提示」)。
  /// 转写要好几分钟,不轮询的话页面停在「还没有 AI 摘要」一动不动 ——
  /// 人只能靠手动刷新去猜它到底在不在跑。跑完了顺手静默刷一次纪要。
  useEffect(() => {
    if (!anaFor || !isRunning(job)) return
    const t = setInterval(() => {
      void api<Analysis>(`/api/items/${anaFor}/analysis`).then((a) => {
        setAna(a)
        if (!isRunning(a.job)) void load(true)
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [anaFor, job, load])

  const save = async (patch: Partial<Minutes>) => {
    try {
      await api(`/api/activities/${activityId}/minutes`, { method: 'PUT', body: JSON.stringify(patch) })
      await load(true)                       // ★静默★:见 load 上面那段
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
  /// 三个 AI 来源置灰时的同一句解释(为什么还没得导)
  const aiWhy = !recs.length ? '先上传录制并点「转写」'
    : isRunning(job) ? `转写还在跑：${job!.stage}`
      : job?.status === 'failed' ? '这次转写失败了，可以重新转写'
        : job ? '转写完成，但没有生成这一份' : '还没有转写过这份录制'

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
        {/* ⚠★2026-08-09 用户指出的结构错误,已改★:原来「AI 摘要 / 逐字稿 / 录制」是**三个平级标签**,
            而摘要和逐字稿是**某一段录制**的产物 —— 一场会传了 4 段录制时,
            「AI 摘要」到底是哪一段的?界面**答不上来**(实现上悄悄取的是第一段)。
            现在改成两层:上面选录制(播放器 + 列表),下面才是**这一段**的三份稿。
            ★层级要跟着数据的从属关系走★:摘要从属于录制,就不能和录制并排。 */}
        <Card size="small" style={{ width: 430, flexShrink: 0 }} styles={{ body: { paddingTop: 4 } }}>
          <RecordingPane items={recs} playing={playing} onPlay={setPlaying}
            projectId={detail?.projects?.[0]?.id ?? null} activityId={activityId}
            canEdit={canEdit} onChanged={() => load(true)}
            job={job} jobFor={anaFor} onWatch={(it) => setPlaying(it)} />
          {/* 进度条与失败原因贴在录制列表和稿子之间:它讲的正是「这一段」的转写状态。 */}
          {isRunning(job) && (
            <div style={{ margin: '8px 0' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>转写中：{job!.stage}</Typography.Text>
              <Progress percent={job!.progress} size="small" status="active" />
            </div>
          )}
          {job?.status === 'failed' && (
            <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', margin: '8px 0' }}>
              转写失败：{job.error || '未知原因'}
            </Typography.Text>
          )}
          {recs.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="传一段录制,这里会出现它的 AI 摘要与逐字稿" />
            : <Tabs size="small" items={[
            {
              key: 's', label: 'AI 摘要',
              children: sum(K_BRIEF)
                ? <div style={{ fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-wrap', maxHeight: 460, overflow: 'auto' }}>{sum(K_BRIEF)}</div>
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyWhy(job, '摘要')} />,
            },
            {
              // ★分段大纲★:后端一直在生成 `outline`,但**从来没有任何界面读过它**
              //（2026-08-09 查「AI 摘要没写出来」时顺带发现）。它是这三份里最好用的一份:
              // 每行以 [mm:ss] 开头,点一下就跳到录制的那一刻。
              key: 'o', label: '分段大纲',
              children: sum(K_OUTLINE)
                ? (
                  <div style={{ fontSize: 13, lineHeight: 1.9, maxHeight: 460, overflow: 'auto' }}>
                    {sum(K_OUTLINE).split('\n').filter((l) => l.trim()).map((line, i) => {
                      // 行首 [mm:ss] 变成可点的跳转;认不出时间戳就原样显示
                      const mm = /^\s*\[?(\d{1,2}):(\d{2})\]?\s*(.*)$/.exec(line)
                      if (!mm) return <div key={i}>{line}</div>
                      const sec = Number(mm[1]) * 60 + Number(mm[2])
                      return (
                        <div key={i}>
                          <a onClick={() => seek(sec)} style={{ marginRight: 6 }}>{mmss(sec)}</a>
                          {mm[3]}
                        </div>
                      )
                    })}
                  </div>
                )
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyWhy(job, '分段大纲')} />,
            },
            {
              // ★决议与待办也要能在左栏直接读★（2026-08-09 用户：「这里少了 AI 决议，也少了 AI 代办」）。
              // 此前这一份只能通过右栏的「带入」按钮**盲导**进正文 —— 记录员在按下那个按钮之前
              // 根本没机会先看看它写了什么。★让人先读、再决定导不导，才是 D14 说的「他自己点」。★
              // ⚠ 决议与待办是**同一份** AI 产物（media_ai.rs 的 `decisions` 一次生成两者），
              //   拆成两个标签会得到两块一模一样的内容，所以这里是一个标签。
              key: 'd', label: '决议·待办',
              // ★按 Markdown 渲染★(2026-08-09 liaoruili:「决议代办 应该前端使用 markdown 解析展示」)。
              // 这一份 AI 产物**本来就是 Markdown**:提示词让它「列出关键决议与待办事项
              // (谁负责、做什么、何时)」,模型给回来的就是 `- ` 列表 + `**加粗**`
              // (提示词自己都写着 `**关键决议**`)。而这里一直是 `white-space: pre-wrap` 直出 ——
              // ★于是满屏的星号和减号,该分层的地方全平着★,一份三层的清单读起来像一堆字符。
              // 组件是现成的(preview.tsx 的 MarkdownView,react-markdown + GFM,项目文档一直在用),
              // 缺的只是在这里用上它。
              children: sum(K_DECISIONS)
                ? <div style={{ fontSize: 13, maxHeight: 460, overflow: 'auto' }}><MarkdownView text={sum(K_DECISIONS)} /></div>
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyWhy(job, '决议与待办')} />,
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
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyWhy(job, '逐字稿')} />,
            },
          ]} />}
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
                    pull={detail ? { label: '按答复带入', text: peopleOf(detail, 'accepted'), why: '还没有人答应参加' } : undefined} />
                  <Field label="旁听人" value={v.observers} canEdit={canEdit} rows={2}
                    onSave={(x) => save({ observers: x })}
                    pull={detail ? { label: '带入旁听者', text: peopleOf(detail, 'observer'), why: '本次还没有人报名旁听' } : undefined} />
                  <Field label="缺席人" value={v.absentees} canEdit={canEdit} rows={2}
                    onSave={(x) => save({ absentees: x })}
                    pull={detail ? { label: '带入未应答/拒绝', text: peopleOf(detail, 'absent'), why: '所有人都已答应参加' } : undefined} />
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
                  {/* ★这四块的「带入」按钮 2026-08-09 全部重接了一遍★:
                      议题来自活动本身的议程,其余三块来自 AI 的三份产物 ——
                      而在此之前只有「决议」那颗真的会出现(kind 恰好对得上),
                      用户的问题「主要内容、决议事项、待办事项不都有 AI 总结吗」问的就是这个。 */}
                  <Field label="议题" value={v.agenda_text} canEdit={canEdit} rows={4}
                    onSave={(x) => save({ agenda_text: x })}
                    pull={{ label: '从活动议程带入', text: mt?.agenda ?? '', why: '这次活动没有填议题与议程' }} />
                  <Field label="主要内容" hint="支持 Markdown；出 PDF 时由平台的 LaTeX 服务排版"
                    value={v.content_md} canEdit={canEdit} rows={12}
                    onSave={(x) => save({ content_md: x })}
                    pull={{ label: '从 AI 摘要导入', text: sum(K_BRIEF), why: aiWhy }}
                    pull2={{ label: '从分段大纲导入', text: sum(K_OUTLINE), why: aiWhy }} />
                  <Field label="决议事项" value={v.resolutions} canEdit={canEdit} rows={4}
                    onSave={(x) => save({ resolutions: x })}
                    pull={{ label: '从 AI 决议导入', text: sum(K_DECISIONS), why: aiWhy }} />
                  {/* AI 的 `decisions` 一份里同时写了决议**和**待办(见 media_ai.rs 的提示词),
                      所以待办这一栏也给同一份当起点,由记录员自己删掉不属于这里的行。 */}
                  <Field label="待办事项" hint="谁、做什么、什么时候之前" value={v.todos} canEdit={canEdit} rows={4}
                    onSave={(x) => save({ todos: x })}
                    pull={{ label: '从 AI 决议/待办导入', text: sum(K_DECISIONS), why: aiWhy }} />
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

/// 参考稿为什么是空的 —— ★把「在跑 / 失败 / 跑完但没出 / 还没开始」区分开★。
/// ⚠ 旧文案是 `转写中：${job.stage}`,而任务跑完后 stage 正是「完成」,
/// 于是屏幕上写着「转写中：完成」—— ★一句自相矛盾的话,还恰好把真正的问题
/// (kind 对不上,摘要其实拿不到)伪装成了「还在跑,再等等」。★
function emptyWhy(job: Job | null, what: string) {
  if (!job) return `还没有 AI ${what}（上传录制后点「转写」）`
  if (isRunning(job)) return `转写中：${job.stage}`
  if (job.status === 'failed') return `转写失败：${job.error || '未知原因'}`
  return `转写已完成，但没有生成${what}`
}

/// 纪要里的一块:标签 +（可选）「带入」按钮 + 双击就地编辑。
function Field({ label, hint, value, canEdit, rows = 3, onSave, pull, pull2 }: {
  label: string; hint?: string; value: string; canEdit: boolean; rows?: number
  onSave: (v: string) => Promise<void>
  /// 「从某处带入」。★可以导入,但必须记录员自己点★(D14):
  /// 追加而不是覆盖 —— 他可能已经写了几行,导入不该把它冲掉。
  /// `why` = 没内容时置灰按钮上的说明。
  pull?: { label: string; text: string; why: string }
  /// 第二个来源(「主要内容」可以从摘要或分段大纲来,两份各有用)。
  pull2?: { label: string; text: string; why: string }
}) {
  const add = (t: string) => onSave(value ? `${value}\n${t}` : t)
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>{label}</Typography.Text>
        {hint && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}
        <span style={{ flex: 1 }} />
        {/* ★按钮在不在,不随数据变★(2026-08-09 用户:「旁听其实也有人员信息的,可以直接填入」)。
            原来是「没内容就不渲染」,于是同样三栏人员里旁听那栏**光秃秃的**,
            读起来像是这一栏不支持带入 —— 而它支持,只是这次恰好没人旁听。
            改成常驻 + 置灰 + 说明为什么灰:★「暂时没有」和「不支持」必须长得不一样。★ */}
        {canEdit && pull2 && (
          <Button size="small" disabled={!pull2.text} title={pull2.text ? undefined : pull2.why}
            onClick={() => add(pull2.text)}>{pull2.label}</Button>
        )}
        {canEdit && pull && (
          <Button size="small" disabled={!pull.text} title={pull.text ? undefined : pull.why}
            onClick={() => add(pull.text)}>{pull.label}</Button>
        )}
      </div>
      <InlineEdit value={value} canEdit={canEdit} multiline rows={rows} onSave={onSave}
        style={{ fontSize: 13, lineHeight: 1.8 }} />
    </div>
  )
}

/// 录制面板:播放器 + 上传 + 文件列表(点行切换播放 / 单独转写)。
/// ★播放器不常驻★(原型评审时用户定的):切到「录制」标签才出现。
function RecordingPane({ items, playing, onPlay, projectId, activityId, canEdit, onChanged, job, jobFor, onWatch }: {
  items: ActivityItem[]; playing: ActivityItem | null; onPlay: (i: ActivityItem) => void
  projectId: number | null; activityId: number; canEdit: boolean; onChanged: () => void
  /// 当前被轮询的那个任务(只有 `jobFor` 这一条录制的状态是实时的)
  job: Job | null; jobFor: number | null; onWatch: (it: ActivityItem) => void
}) {
  const { message } = AntdApp.useApp()
  /// 刚点过「转写」但还没轮到第一次轮询的那些 —— 只用来盖住那一两秒的空窗。
  const [justQueued, setJustQueued] = useState<number[]>([])
  const up = useActivityUpload({
    projectId, activityId, isRecording: true,
    accept: 'video/*,audio/*', label: '上传录屏 / 录音', onDone: onChanged,
  })
  return (
    <div>
      {/* ⚠★播放器高度写死★(2026-08-09 用户:「选中后页面抖动」):原来是 `maxHeight: 220`,
          没有下限 —— 换一段录制时 src 一变,浏览器把已加载的画面丢掉、回到
          <video> 的默认 150px,等 metadata 到了再按新片子的宽高比撑回去。
          ★于是每点一次列表,播放器都要塌一下再弹起来,底下整列跟着上下跳。★
          高度固定 + object-fit: contain:画面比例不同就留黑边,但**框子不动**。 */}
      {playing && (
        <video id="minutes-player" controls preload="metadata" src={`/api/items/${playing.id}/play`}
          style={{
            width: '100%', height: 220, objectFit: 'contain',
            background: '#000', borderRadius: 6, marginBottom: 10, display: 'block',
          }} />
      )}
      {canEdit && <div style={{ marginBottom: 10 }}>{up.button}</div>}
      {up.zone(
      <Table<ActivityItem> size="small" rowKey="id" dataSource={items} pagination={false} showHeader={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有录屏或录音" /> }}
        // ★选中的那一行要看得出来★(2026-08-09 用户:「选中后没有高亮」):
        // 下面三份稿讲的是**哪一段**,全靠这一行的高亮回答 —— 没有它,
        // 「AI 摘要」就又变回了那个「说不清是谁的摘要」的状态(刚修过的那个问题)。
        onRow={(it) => ({
          onClick: () => onPlay(it),
          style: {
            cursor: 'pointer',
            background: playing?.id === it.id ? '#e6fffb' : undefined,
            boxShadow: playing?.id === it.id ? 'inset 3px 0 0 #0d9488' : undefined,
          },
        })}
        columns={[
          {
            // ★文件名只占一行,超出用 …★(2026-08-09 用户):录屏文件名普遍很长
            // (日期 + 课程 + 主讲人 + 序号),换行会让每一行高度不等,
            // ★一列高矮不齐的行,眼睛没法当列表扫★。完整名字给 title(悬停可见)。
            title: '', render: (_, it) => (
              <div style={{ minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }} title={it.name}>
                  <ItemIcon it={it} />
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</b>
                </div>
                <div style={{ fontSize: 12, color: '#8c8c8c' }}>{it.created_by} · {fmtSize(it.size)}</div>
              </div>
            ),
          },
          {
            // ★录制也要能删★(2026-08-09 liaoruili):和材料同一条规则 ——
            // 项目树里删不掉,唯一入口在活动这边。
            // ⚠★width: 40 装不下「删除」两个字★(2026-08-09 liaoruili:「这里的删除也是」)——
            // 它折成了「删 / 除」上下两行。width 只是建议值,真正管用的是 nowrap;
            // 宽度也一并给够(与活动详情那张材料表同一次修的同一个毛病)。
            title: '', width: 60,
            onCell: () => ({ style: { whiteSpace: 'nowrap' as const } }),
            render: (_, it) => canEdit && (
              <Popconfirm title={`删除「${it.name}」？`} description="进项目回收站，30 天内可还原。"
                okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
                onConfirm={async () => {
                  try {
                    await api(`/api/activities/${activityId}/items/${it.id}`, { method: 'DELETE' })
                    message.success('已删除'); onChanged()
                  } catch (e) { message.error((e as Error).message) }
                }}>
                <a style={{ color: '#ff4d4f' }} onClick={(e) => e.stopPropagation()}>删除</a>
              </Popconfirm>
            ),
          },
          {
            title: '', width: 96,
            render: (_, it) => {
              // ★这一行的任务状态★:只有正被轮询的那条是实时的;刚点过的用 justQueued 兜住空窗。
              const jb = jobFor === it.id ? job : null
              const running = isRunning(jb) || justQueued.includes(it.id)
              return (
                <Button size="small" loading={running} disabled={running}
                  // ★转写中禁点★(2026-08-09 用户:「转写可以多次点击,且没有进度提示」)。
                  // 原来 busy 在 POST 返回的那一刻就清了 —— 而那只代表**排队成功**,
                  // 真正的活儿才刚开始。于是按钮立刻恢复可点,连点几下就是几条
                  // 「已排队转写」的提示叠在角上(后端靠唯一索引挡住了重复排队,
                  // 所以没造成真损害,但界面在**撒谎**:它表现得像每点一次就多排了一个)。
                  onClick={async (e) => {
                    e.stopPropagation()
                    setJustQueued((q) => [...q, it.id])
                    try {
                      await api(`/api/items/${it.id}/analyze`, { method: 'POST' })
                      onWatch(it)                 // 选中它:参考稿与进度都跟着这一段走
                      onChanged()
                    } catch (err) {
                      message.error((err as Error).message)
                      setJustQueued((q) => q.filter((x) => x !== it.id))
                      return
                    }
                    // 首次轮询把真状态取回来之前,先兜 4 秒(轮询间隔 3 秒)
                    setTimeout(() => setJustQueued((q) => q.filter((x) => x !== it.id)), 4000)
                  }}>
                  {running ? `${jb?.progress ?? 0}%` : jb?.status === 'done' ? '重转' : '转写'}
                </Button>
              )
            },
          },
        ]} />)}
    </div>
  )
}
