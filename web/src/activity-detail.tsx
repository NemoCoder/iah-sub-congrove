// 活动详情 —— 左:活动信息 + 议程 + 参会人;右:我的答复 / 建议改期 / 讨论区。
// 对应 docs/prototype-m1.html 的 `meet` 视图。
//
// ★用户在原型上定的两处布局,别改回去★:
//   · **讨论也挪到右边**,而且**放在「建议改期」下面**——答复是主动作,讨论是它的延伸;
//   · 活动与议程内容区**高度要够**(原型里嫌太矮),所以议程用大块留白而不是挤成一行。
//
// ★旁听者(D9)拿到的是裁剪版★:后端就不返回 participants,这里也不能画出名单占位——
// 「有个名单但看不到」比「压根没有这块」更容易让人以为是 bug。
import { App as AntdApp, Alert, Button, Card, Descriptions, Empty, Input, Modal, Popconfirm, Select, Space, Spin, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { InlineEdit } from './inline-edit'
import { api, showUser, type LinkChange, type ActivityDetail, type ActivityItem, type ActivityMessage, type Minutes, type Participant, type RespondStatus } from './api'
import { fmtSize, ItemIcon, MarkdownView } from './preview'
import { useActivityUpload } from './activity-upload'
import { ShareModal } from './share-modal'
import { TimeRangePicker } from './time-range'

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

export function ActivityDetailView({ id, me, onBack, onOpenMinutes, backLabel = '返回' }: {
  id: number
  onBack: () => void
  /// 当前登录用户名 —— 用来判「我是不是发起人」（发起人不出「我的答复」）
  me: string
  onOpenMinutes: (id: number) => void
  /// ★从哪来就写回哪去★:这一页有两个入口(日程页点日历块 / 活动页点列表行),
  /// 写死「返回日程」的话,从活动页进来的人会以为自己点错了(2026-08-07 用户提)。
  backLabel?: string
}) {
  const { message } = AntdApp.useApp()
  const [d, setD] = useState<ActivityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /// ★与我已接受的会撞了吗★:D1 决定了发起人看不见我私密项目里的安排,
  /// 所以冲突只能在**我这边**算、在**我这边**提醒。用我自己的活动列表本地比,不必新接口。
  const [clash, setClash] = useState<{ title: string; starts_at: string; ends_at: string } | null>(null)

  /// ★所有字段走同一个 PUT★:就地编辑的统一保存口,省得每个字段各写一份请求。
  /// 改时间用的临时区间（null = 没在改）。★不做成 InlineEdit★，见时间那一行的注释。
  const [timeEdit, setTimeEdit] = useState<[Dayjs, Dayjs] | null>(null)
  /// 「再关联一个项目」弹窗。★只增不减★，见关联项目那一行的注释。
  const [addProj, setAddProj] = useState(false)
  const [pickProj, setPickProj] = useState<number[]>([])
  const [myProjects, setMyProjects] = useState<{ id: number; name: string }[]>([])
  useEffect(() => {
    if (!addProj) return
    // 只列我有编辑权的（后端也会逐个再判一次）
    api<{ id: number; name: string; my_role: string | null }[]>('/api/projects')
      .then((ps) => setMyProjects(ps.filter((x) => x.my_role === 'editor' || x.my_role === 'admin')))
      .catch(() => {})
  }, [addProj])

  const patch = async (body: Record<string, unknown>) => {
    await api(`/api/activities/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    // ★静默刷新★:不走 loading 态 —— 见 load() 的注释
    await load(true)
  }

  /// `silent=true` 时**不切 loading 态**。
  ///
  /// ⚠★这就是「点开关页面会抖」的原因★(2026-08-09 用户):原来任何改动都走同一个
  /// `load()`,它 `setLoading(true)` → 整块详情被换成 Spin → 再换回来,
  /// 页面**塌一下又撑开**。首屏加载该有 loading,而「切一个开关」不该 ——
  /// 用户已经在看着内容了,把内容抽走再放回去是纯粹的噪声。
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try { setD(await api<ActivityDetail>(`/api/activities/${id}`)); setErr(null) }
    catch (e) { setErr((e as Error).message) }
    finally { if (!silent) setLoading(false) }
  }, [id])
  useEffect(() => { void load() }, [load])

  // 冲突检测:拉这场会前后一天的活动,找时间重叠且我已接受的
  useEffect(() => {
    if (!d?.activity || d.activity.my_status !== 'pending') { setClash(null); return }
    const mm = d.activity
    const from = new Date(new Date(mm.starts_at).getTime() - 864e5).toISOString()
    const to = new Date(new Date(mm.ends_at).getTime() + 864e5).toISOString()
    api<{ id: number; title: string; starts_at: string; ends_at: string; my_status: string | null }[]>(
      `/api/activities?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((all) => setClash(all.find((x) => x.id !== mm.id && x.my_status === 'accepted'
        && new Date(x.starts_at) < new Date(mm.ends_at) && new Date(mm.starts_at) < new Date(x.ends_at)) ?? null))
      .catch(() => setClash(null))
  }, [d])

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (err || !d)
    return (
      <Card>
        {/* 看不见的活动后端回 404(与「不存在」同一回应,防按 id 探测),这里不区分原因 */}
        <Empty description={err === '404' ? '这个活动不存在,或你没有权限查看' : err} />
        <div style={{ textAlign: 'center', marginTop: 12 }}><Button onClick={onBack}>{backLabel}</Button></div>
      </Card>
    )

  const m = d.activity
  const canceled = m.status === 'canceled'

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button size="small" onClick={onBack}>‹ {backLabel}</Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          <InlineEdit value={m.title} canEdit={!!d.can_edit && !canceled} onSave={(v) => patch({ title: v })} />
        </Typography.Text>
        {canceled && <Tag color="default">已取消</Tag>}
        {m.visibility === 'public' && <Tag color="blue">公开活动</Tag>}
        {m.is_private && <Tag color="purple">私密项目</Tag>}
        {d.observer && <Tag>旁听</Tag>}
        <span style={{ flex: 1 }} />
        {/* ★取消旁听在这里做★(2026-08-07):广场只列「我还没有关系的会」,
            旁听之后它就从广场消失、进了我的日历 —— 要退出自然该来它自己的页面,
            而不是回广场上找一个已经不在那儿的条目。 */}
        {d.observer && !canceled && (
          <Popconfirm title="不再旁听这场会？" description="它会从你的日历里移除；之后想听可以从公开活动里再加回来。"
            onConfirm={async () => {
              try {
                await api(`/api/activities/${id}/observe`, { method: 'POST', body: JSON.stringify({ observe: false }) })
                message.success('已取消旁听'); onBack()
              } catch (e) { message.error((e as Error).message) }
            }}>
            <Button size="small">取消旁听</Button>
          </Popconfirm>
        )}
        <Modal open={addProj} title="再关联一个项目" okText="添加" cancelText="取消"
        onCancel={() => { setAddProj(false); setPickProj([]) }}
        onOk={async () => {
          if (pickProj.length) await patch({ add_project_ids: pickProj })
          setAddProj(false); setPickProj([])
        }}>
        <Select mode="multiple" style={{ width: '100%' }} placeholder="选一个或多个项目"
          value={pickProj} onChange={setPickProj} optionFilterProp="label"
          options={myProjects
            .filter((x) => !d.projects?.some((p) => p.id === x.id))
            .map((x) => ({ value: x.id, label: x.name }))} />
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          ★只能加，不能取消★：关联之后那个项目的成员就看得到这场活动的材料，
          事后解除并不能把「他已经知道」收回去。
        </Typography.Text>
      </Modal>
      {/* 改时间。★确认文案里写清连带后果★：改了时间所有人的答复会清回待定，
          那是 update 的既有行为（上次的「接受」是对**旧时间**的），不该让人事后才发现。 */}
      <Modal open={!!timeEdit} title="改时间" okText="保存" cancelText="取消"
        onCancel={() => setTimeEdit(null)}
        onOk={async () => {
          if (!timeEdit) return
          const [a, b] = timeEdit
          if (!b.isAfter(a)) { message.error('结束时间必须晚于开始时间'); return }
          await patch({ starts_at: a.toISOString(), ends_at: b.toISOString() })
          setTimeEdit(null)
        }}>
        {/* ⚠★这里原来是个裸 `showTime` 的 RangePicker★(2026-08-09 用户:「改时间怎么到了时分秒。。。。
            我的 00 15 30 45 呢」):有秒、分钟 60 格、还要点一次确认 —— 因为「一刻钟粒度」
            当初只写进了「发起活动」那一处。现在三处共用 time-range.tsx。
            ★这里**不加** noPast★:后端只在创建时拒绝过去的时间,改时间还用来**补录**已经开过的会。 */}
        <TimeRangePicker value={timeEdit}
          onChange={(v) => setTimeEdit(v)} />
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          ★所有人的答复会清回「待定」★，并收到一条改期通知。
        </Typography.Text>
      </Modal>
      {/* ★纪要入口已挪到材料卡片的第三个 tab★(2026-08-09 用户):
            同一件事原来有三个入口(顶栏「活动纪要」、右上角「整理纪要」、原型里的 tab),
            留一个就够。旁听者拿不到纪要 —— 那块卡片本来就只对参会人渲染。 */}
        {d.can_edit && !canceled && (
          <Popconfirm title="取消这场活动？" description="记录会保留下来（谁邀了谁、谁拒了是协作事实），只是标记为已取消。"
            onConfirm={async () => {
              try { await api(`/api/activities/${id}`, { method: 'DELETE' }); await load(true) } catch (e) { /* 失败由下方错误区呈现 */ }
            }}>
            <Button size="small" danger>取消活动</Button>
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
        {/* 左:活动信息 + 议程 + 线上 + 材料。★参会人不在这里★——按原型它在右栏顶上 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card size="small" style={{ marginBottom: 12 }}>
            <Descriptions column={1} size="small" items={[
              {
                key: 't', label: '时间',
                // ★时间要有明确的编辑入口★（2026-08-09 用户）：地点/线上是「双击编辑」，
                // 而时间是只读文本 —— 用户按同样的手势双击它，什么也没发生。
                // ⚠ 时间不适合做成 InlineEdit（要选起止两个时刻、还要校验先后），
                // 所以给一个**看得见的**铅笔按钮，点开日期区间选择器。
                // ★不一致的交互比不能编辑更糟★：它让人以为是坏了。
                children: (
                  <Space size={6}>
                    <span>{fmtRange(m.starts_at, m.ends_at)}</span>
                    {!!d.can_edit && !canceled && (
                      <Button type="text" size="small" style={{ padding: '0 4px', height: 20 }}
                        title="改时间（所有人的答复会清回待定）"
                        onClick={() => setTimeEdit([dayjs(m.starts_at), dayjs(m.ends_at)])}>✎</Button>
                    )}
                  </Space>
                ),
              },
              {
                key: 'l', label: '地点',
                children: <InlineEdit value={m.location} canEdit={!!d.can_edit && !canceled}
                  placeholder="（双击填写，如：3 号楼 401）" onSave={(v) => patch({ location: v })} />,
              },
              {
                key: 'u', label: '线上',
                children: <InlineEdit value={m.online_url} canEdit={!!d.can_edit && !canceled}
                  placeholder="（双击填写腾讯活动 / Zoom 链接）" onSave={(v) => patch({ online_url: v })}
                  renderView={(v) => <a href={v} target="_blank" rel="noreferrer">{v}</a>} />,
              },
              { key: 'o', label: '发起人', children: m.organizer },
              // ★只在会开完之后才出现★(D5 第 2 级):会还没开就问「实际开了多久」是荒谬的,
              // 而且那一栏摆在那里只会让人以为要预填。
              ...(new Date(m.ends_at).getTime() < Date.now() ? [{
                key: 'am', label: '实际时长',
                // ⚠★双击后那句说明会掉到下一行★(2026-08-09 用户:「怎么点击后这段话在下面?」)。
                //   原因:只读态是个 inline-block 的 <span>,说明跟在它右边;
                //   一进编辑态换成 AntD 的 <Input> —— 它**默认占满整行宽度**,
                //   于是把说明挤到了下面,整行还跟着变高。
                //   ★根子是「只读态和编辑态的盒子宽度不一样」★ —— 给它一个固定宽度的格子,
                //   两态都住在里面,外面用 flex 摆位,点不点它都不动。
                children: (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ width: 200, flexShrink: 0 }}>
                      <InlineEdit value={m.actual_minutes ? String(m.actual_minutes) : ''}
                        canEdit={!!d.can_edit && !canceled} placeholder="（双击填分钟数）"
                        onSave={(v) => patch({ actual_minutes: v.trim() ? Number(v.trim()) : null })}
                        renderView={(v) => `${v} 分钟`} />
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {/* 说清它有什么用,否则没人会去填 */}
                      没录屏时统计按这个算；都不填就按排程时长估
                    </Typography.Text>
                  </div>
                ),
              }] : []),
              // ★记录员是必填字段(D14)★:正式纪要由他按模板整理,AI 转写只是原材料
              ...(m.type_name ? [{ key: 'ty', label: '类型', children: <Tag>{m.type_name}</Tag> }] : []),
              // 记录员只有「要出纪要」的类型才有（ADR-0002 的 has_minutes）
              ...(m.recorder ? [{ key: 'r', label: '记录员', children: <Tag color="cyan">{m.recorder}</Tag> }] : []),
              {
                key: 'p', label: '关联项目',
                children: (
                  <Space wrap size={4}>
                    {d.projects?.map((p) => <Tag key={p.id}>{p.name}</Tag>)}
                    {/* ★只增不减★（2026-08-09 用户）：关联一旦建立，那个项目的成员就已经
                        收到通知、看得到材料 —— 事后解除并不能把「他已经知道」收回去，
                        只会让他手里的入口突然 404。所以这里**没有删除按钮**，只有「+」。
                        真要收回，走删活动（软删、留痕）。 */}
                    {!!d.can_edit && !canceled && (
                      <Button type="text" size="small" style={{ padding: '0 6px', height: 22 }}
                        title="再关联一个项目（★只能加，不能取消★）"
                        onClick={() => setAddProj(true)}>＋</Button>
                    )}
                  </Space>
                ),
              },
            ]} />
          </Card>

          {/* ★议程区要留足高度★(原型评审:内容高度太矮) */}
          <Card size="small" title="议题与议程" style={{ marginBottom: 12 }}>
            <InlineEdit value={m.agenda} canEdit={!!d.can_edit && !canceled} multiline rows={7}
              placeholder="（双击填写议题与议程，一行一条）"
              style={{ minHeight: 160, fontSize: 13, lineHeight: 1.8 }}
              onSave={(v) => patch({ agenda: v })} />
          </Card>

          {/* ★线上活动区★:链接 + 复制 + 改动历史(开会前十分钟改链接是真实场景,事后要能追溯) */}
          {m.online_url && d.participants && (
            <OnlineCard id={id} url={m.online_url} />
          )}

          {/* ★材料 / 录制★(D5:录制 ≠ 材料,只有录制会被转写、并作为活动时长依据) */}
          {d.participants && (
            <MaterialsCard id={id} projectId={d.projects?.[0]?.id ?? null}
              canEdit={!canceled && !!d.projects?.length} onOpenMinutes={onOpenMinutes}
              policy={d.can_edit ? { no_download: m.no_download, no_share: m.no_share } : null}
              onPolicy={(v) => patch(v)} />
          )}

        </div>

        {/* ★右栏:参会人 → 我的答复 → 讨论★
            ⚠ 顺序与位置**照 docs/prototype-m1.html 的 meet 视图**(右栏 max-width:320px,
            里面是「参会人(8)」→「zhaoliu 建议改期」→「讨论(4)」)。
            2026-08-07 用户第二次指出我没按原型:参会人本该在右上角,我把它放在了左主栏底下 ——
            ★又是「只验代码不验设计」★(见记忆 verify-against-design-not-just-code)。
            改期建议目前长在 RespondCard 里(它同时是「我的答复」入口),没有单独一张卡。 */}
        <div style={{ width: 340, flexShrink: 0 }}>
          {/* 旁听者拿不到名单,那就整块不渲染 */}
          {d.participants && (
            <PeopleCard people={d.participants} mid={id} organizer={m.organizer}
              // ★静默刷新★(2026-08-09 liaoruili:「参会人点击催办的时候页面抖动」):
              // 催办 / 移出 / 加人 全走这一个回调,而 `load()` 不带参数 = 非静默,
              // 于是整块详情被 <Spin/> 换掉再换回来。★这是同一个根因的第三处★
              // (前两处:点开关、点转写)—— 「刷新数据」和「重建界面」是两件事。
              canHost={!!d.can_edit && !canceled} onDone={() => load(true)} />
          )}
          {/* ★发起人不出「我的答复」★(2026-08-09 用户):他是定这个时间的人,
              create 时就是 accepted。让他答复等于允许「拒绝自己发起的活动」这种
              自相矛盾的状态。想改时间直接改、去不了就取消 —— 后端也会拒。 */}
          {!canceled && m.my_status && m.organizer !== me
            && <RespondCard id={id} mine={m.my_status} onDone={() => load(true)} />}
          {d.participants && <DiscussionCard id={id} organizer={m.organizer} recorder={m.recorder} />}
        </div>
      </div>

    </div>
  )
}

function ParticipantRow({ p, mid, organizer, canHost, onDone }: {
  p: Participant; mid: number; organizer: string; canHost: boolean; onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const meta = STATUS_META[p.status]
  const act = async (path: string, ok: string) => {
    setBusy(true)
    try {
      await api(`/api/activities/${mid}/${path}`, { method: 'POST', body: JSON.stringify({ username: p.username }) })
      message.success(ok); onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span style={{ flex: 1 }}>
          {showUser(p.username, p.name)}
          {p.username === organizer && <Tag color="cyan" style={{ marginLeft: 6 }}>发起人</Tag>}
        </span>
        {/* ★不再有「改参会人类型」这个下拉★(2026-08-07 liaoruili,推翻 D8):
            删掉「临时参会人」之后类型只剩一种 —— 一个只有一个选项的下拉是纯粹的噪音,
            还会让人以为这里有什么要决定的。旁听者本来也不给改(他是自助来听的,
            把他改成参会人等于替他答应「我要参会」)。 */}
        {p.kind === 'observer' && <Tag color="blue">旁听</Tag>}
        {/* ★只标「选参」,不标「必参」★:必参是默认,全标出来满屏都是标签,
            反而看不出哪个是特殊的。这里要的是「谁可来可不来」一眼可见。 */}
        {p.kind !== 'observer' && p.required === false && <Tag>选参</Tag>}
        {/* 旁听者不需要答复,显示答复状态只会让人以为他欠一个回复 */}
        {p.kind !== 'observer' && <Tag color={meta.color}>{meta.label}</Tag>}
        {/* ★催办只对还没答复的人出现★:已接受/已拒绝的人不该再被打扰 */}
        {canHost && p.status === 'pending' && (
          <Button size="small" loading={busy} onClick={() => act('remind', '已催办')}>催办</Button>
        )}
        {/* ★发起人不能被移出★(后端也拦):他被移出就没人改得了这场会 */}
        {canHost && p.username !== organizer && (
          <Popconfirm title={`把 ${p.username} 移出这场活动？`}
            onConfirm={async () => {
              try {
                await api(`/api/activities/${mid}/participants`, {
                  method: 'DELETE', body: JSON.stringify({ username: p.username }),
                })
                message.success('已移出'); onDone()
              } catch (e) { message.error((e as Error).message) }
            }}>
            <Button size="small" type="text" danger disabled={busy}>移出</Button>
          </Popconfirm>
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
              description="活动时间会改成他提议的时间，所有人的答复都会清回「待应答」——包括他本人。"
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
      await api(`/api/activities/${id}/respond`, {
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
      {/* ★当前状态的那个按钮禁用★:已经接受了还能再点「接受」是无意义的重复请求
          (2026-08-07 用户:「可以一直点接受」)。busy 时全部禁用,防连点打出多个请求。
          ⚠ 其余按钮保持可点 —— 改主意是正当操作,不能因为答过一次就锁死。 */}
      <Space wrap style={{ marginBottom: showCounter ? 12 : 0 }}>
        <Button size="small" type={mine === 'accepted' ? 'primary' : 'default'} loading={busy}
          disabled={busy || mine === 'accepted'}
          onClick={() => send('accepted')}>接受</Button>
        <Button size="small" type={mine === 'tentative' ? 'primary' : 'default'} loading={busy}
          disabled={busy || mine === 'tentative'}
          onClick={() => send('tentative')}>待定</Button>
        <Button size="small" danger={mine === 'declined'} loading={busy}
          disabled={busy || mine === 'declined'}
          onClick={() => send('declined')}>拒绝</Button>
        <Button size="small" type={showCounter ? 'primary' : 'dashed'} disabled={busy}
          onClick={() => setShowCounter((v) => !v)}>建议改期</Button>
      </Space>

      {showCounter && (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 8px' }}>
            发起人**看不到**你私密项目里的安排,所以他不知道你这个时段忙。
            给一个你方便的具体时间,比只说「不行」有用得多。
          </Typography.Paragraph>
          {/* 建议一个**将来**的时段才有意义,所以这里 noPast */}
          <div style={{ marginBottom: 8 }}>
            <TimeRangePicker noPast size="small"
              onChange={(v) => setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)} />
          </div>
          <Input.TextArea rows={2} size="small" placeholder="原因（选填）" value={reason}
            onChange={(e) => setReason(e.target.value)} style={{ marginBottom: 8 }} />
          <Button size="small" type="primary" block loading={busy} disabled={!range}
            onClick={() => send('counter')}>提交改期建议</Button>
        </div>
      )}
    </Card>
  )
}

/// 活动讨论区(D13)。★放在答复下面★(用户定的位置)。
/// 只做 public 频道:私聊只能发给发起人/记录员,入口放在参会人行上更自然,M1 先不做。
function DiscussionCard({ id, organizer, recorder }: { id: number; organizer: string; recorder: string }) {
  const { message } = AntdApp.useApp()
  const [msgs, setMsgs] = useState<ActivityMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /// ★发送至★:公开 or 私聊。私聊对象只限发起人与记录员(D13:不做任意点对点,否则长成 IM)。
  const [to, setTo] = useState<string>('public')
  const load = useCallback(async () => {
    try {
      const q = to === 'public' ? '' : `?channel=private&peer=${encodeURIComponent(to)}`
      setMsgs(await api<ActivityMessage[]>(`/api/activities/${id}/messages${q}`))
    } catch { setMsgs([]) }
  }, [id, to])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try {
      await api(`/api/activities/${id}/messages`, {
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
      {/* ★禁掉右下角那个缩放手柄★:它正好落在输入框与下面一行的接缝上,
          两个描边框加一个手柄挤在几个像素里,看着像两个控件粘住了。 */}
      <Input.TextArea rows={2} value={text} placeholder="说点什么…（Enter 发送）"
        style={{ resize: 'none' }}
        onChange={(e) => setText(e.target.value)}
        onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send() } }} />
      {/* ★「发给谁」和「发送」并排★(2026-08-09 用户):它们是同一个动作的两半 ——
          「发给谁 + 发」。分成上下两截时,选择器顶在输入框上方,读起来像一个独立的筛选器,
          而且发送按钮通栏占了整行宽度,视觉分量比它该有的重。
          ⚠★选择器不描边★(2026-08-09 用户再指):第一版给它 flex:1 + 默认描边,
          于是输入框下面紧接着又是一个同宽的描边框 —— 两个长得一样的框上下贴着,
          读起来像**同一个控件被切成了两截**。它是这次发送的一个修饰语,不是一个独立输入,
          所以去掉边框、宽度按内容收,让描边框在这一小块里**只出现一次**。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <Select size="small" value={to} onChange={setTo} variant="borderless"
          style={{ flex: '0 1 auto', minWidth: 0, marginLeft: -8 }}
          options={[
            { value: 'public', label: '所有参会人' },
            // ★私聊对象只有这两位★(D13):不做任意点对点,否则这里会长成一个 IM
            { value: organizer, label: `私聊 ${organizer}（发起人）` },
            ...(recorder !== organizer ? [{ value: recorder, label: `私聊 ${recorder}（记录员）` }] : []),
          ]} />
        <Button size="small" type="primary" loading={busy} style={{ marginLeft: 'auto' }}
          disabled={!text.trim()} onClick={send}>发送</Button>
      </div>
    </Card>
  )
}

/// 参会人卡片。★位置在右栏顶上★(照 docs/prototype-m1.html 的 meet 视图)。
///
/// ★参会人与旁听者分开列★(2026-08-07 用户:「没有显示谁要旁听的人的地方」):
/// 两者性质完全不同 —— 参会人是被**邀请**来的、要答复;旁听者是自己**跑来听**的(D9),
/// 不需要答复、也拿不到材料。混在一张名单里,发起人分不清「谁欠我一个答复」。
///
/// ★旁听那一栏**没人时也显示**★(2026-08-07 用户:「加个想要旁听人的显示」):
/// 只在有人时才出现的区块,发起人根本不知道这个位置存在,也就不会去看 ——
/// 公开活动开出去之后「有没有人要来听」是他真正关心的事。
function PeopleCard({ people, mid, organizer, canHost, onDone }: {
  people: Participant[]; mid: number; organizer: string; canHost: boolean; onDone: () => void
  /// 私密活动不会有人旁听(D9),空栏的文案要说清是「还没人来」还是「本来就不会有」
}) {
  const joined = people.filter((p) => p.kind !== 'observer')
  const observers = people.filter((p) => p.kind === 'observer')
  return (
    <Card size="small" title={`参会人（${joined.length}）`}
      extra={canHost && <AddParticipants mid={mid} onDone={onDone} />}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        {joined.map((p) => (
          <ParticipantRow key={p.username} p={p} mid={mid} organizer={organizer} canHost={canHost} onDone={onDone} />
        ))}
      </Space>
      <div style={{ margin: '12px 0 6px', fontSize: 12, color: '#8c8c8c', borderTop: '1px solid #f0f0f0', paddingTop: 10 }}>
        旁听（{observers.length}）
      </div>
      {observers.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>
      ) : (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {observers.map((p) => (
            <ParticipantRow key={p.username} p={p} mid={mid} organizer={organizer} canHost={canHost} onDone={onDone} />
          ))}
        </Space>
      )}
    </Card>
  )
}

/// 加参会人。★会前临时拉人是常态★——后端一直有 PUT /participants,
/// 但详情页没露出入口,等于这个能力不存在(2026-08-07 用户提)。
///
/// ★候选允许手输★:/api/users 查的是本地 app_user(只有登录过汇流的人),
/// 而后端 ensure_platform_user 能拉任何平台用户 —— 用 multiple 会把新同事挡在外面。
function AddParticipants({ mid, onDone }: { mid: number; onDone: () => void }) {
  const { message } = AntdApp.useApp()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [kind, setKind] = useState<'attendee' | 'guest'>('attendee')
  const [found, setFound] = useState<{ username: string; name: string | null }[]>([])
  const [busy, setBusy] = useState(false)
  /// ★选中/回车之后收起下拉★(2026-08-09 liaoruili:「添加参会人 回车后,下拉框还不消失」)。
  /// tags 模式默认「加完一个继续开着」,那是为连着输很多人准备的;
  /// 但候选列表挂在输入框下面**盖住了「参会人 / 临时参会人」那个下拉和确定按钮** ——
  /// 加完一个人还得先点一下别处才能继续。与关联项目那处用同一套做法。
  const [dropOpen, setDropOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = (kw: string) => {
    if (timer.current) clearTimeout(timer.current)
    const q = kw.trim()
    if (!q) { setFound([]); return }
    timer.current = setTimeout(() => {
      api<{ username: string; name: string | null }[]>(`/api/users?q=${encodeURIComponent(q)}`)
        .then(setFound).catch(() => setFound([]))
    }, 250)
  }
  const submit = async () => {
    if (!picked.length) { message.warning('先选人'); return }
    setBusy(true)
    try {
      await api(`/api/activities/${mid}/participants`, {
        method: 'PUT', body: JSON.stringify({ usernames: picked, kind }),
      })
      message.success(`已添加 ${picked.length} 人`)
      setPicked([]); setOpen(false); onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  if (!open) return <Button size="small" onClick={() => setOpen(true)}>+ 添加</Button>
  return (
    <Modal open title="添加参会人" onCancel={() => setOpen(false)} onOk={submit} confirmLoading={busy} okText="添加">
      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
        <Select mode="tags" value={picked} onChange={setPicked} onSearch={search} filterOption={false}
          open={dropOpen} onDropdownVisibleChange={setDropOpen} onSelect={() => setDropOpen(false)}
          style={{ width: '100%' }} placeholder="输入用户名（没搜到也能直接输入）" notFoundContent={null}
          options={found.map((u) => ({ value: u.username, label: showUser(u.username, u.name) }))} />
        <Select value={kind} onChange={setKind} style={{ width: '100%' }}
          options={[
            { value: 'attendee', label: '参会人' },
            // ★临时参会人能参会、看不到材料★(D8):选项里就把区别说清楚
            { value: 'guest', label: '临时参会人（能参会，看不到材料）' },
          ]} />
      </Space>
    </Modal>
  )
}

/// 线上活动:链接 + 复制 + 改动历史。
/// ★改动历史不是装饰★:临开会前换链接很常见,事后「我进的是旧链接」要能查清是谁什么时候改的。
function OnlineCard({ id, url }: { id: number; url: string }) {
  const { message } = AntdApp.useApp()
  const [hist, setHist] = useState<LinkChange[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    api<LinkChange[]>(`/api/activities/${id}/link-history`).then(setHist).catch(() => setHist([]))
  }, [id])
  return (
    <Card size="small" title="线上活动" style={{ marginBottom: 12 }}>
      <Space wrap>
        <a href={url} target="_blank" rel="noreferrer">{url}</a>
        <Button size="small" onClick={async () => {
          try { await navigator.clipboard.writeText(url); message.success('已复制') }
          catch { message.info(url) }
        }}>复制</Button>
        {/* ★没有「修改」按钮★:改链接在上面「线上」那一行双击即可(全站统一的就地编辑) */}
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

/// 「纪要」tab 的内容 —— ★这里给的是**成品**,不是编辑器★（2026-08-09 用户）。
///
/// 之前点这个 tab 会直接把人扔进整理页,对**大多数人**是错的:
/// 他们来这儿是想**读**这次会的纪要,而不是去整理它 —— 整理是记录员一个人的活(D14)。
/// 现在按身份分岔:
///   · 已完成 → 就地显示成品（有 PDF 就给 PDF，没有就渲染正文）;
///   · 还没整理完 → 记录员看到「去整理纪要 →」;其他人只看到「纪要还没有整理完」。
///
/// ⚠★PDF 导出本身还没做★:`activity_minutes.pdf_item_id` 这一列建了、类型里也有,
/// 但**全仓库没有任何地方写过它**(2026-08-09 查证)。正文里那句「出 PDF 时由平台的
/// LaTeX 服务排版」描述的是设计意图,不是已实现的功能。所以这里两条路都留着:
/// 有 pdf_item_id 就给下载/预览,没有就退回渲染 Markdown 正文 —— 等 PDF 做出来自动生效。
function MinutesTab({ id, canEdit, onOpen }: {
  id: number; canEdit: boolean; onOpen: (id: number) => void
}) {
  const [m, setM] = useState<Minutes | null>(null)
  const [mine, setMine] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let dead = false
    api<{ minutes: Minutes | null; can_edit: boolean }>(`/api/activities/${id}/minutes`)
      .then((r) => { if (!dead) { setM(r.minutes); setMine(r.can_edit) } })
      .catch(() => { if (!dead) { setM(null); setMine(false) } })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
  }, [id])

  if (loading) return <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>

  const done = m?.status === 'done'
  // 能整理的人 = 纪要接口说的 can_edit(记录员/主持人),不是「能改这场活动的人」
  const editor = mine || canEdit

  if (!done) {
    return (
      <div style={{ padding: '16px 4px' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={editor ? '这份纪要还是草稿' : '纪要还没有整理完'} />
        {editor && (
          <div style={{ textAlign: 'center' }}>
            <Button type="primary" size="small" onClick={() => onOpen(id)}>去整理纪要 →</Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <Tag color="green">已完成</Tag>
        {m?.completed_at && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(m.completed_at)}</Typography.Text>
        )}
        <span style={{ flex: 1 }} />
        {m?.pdf_item_id && <a href={`/api/items/${m.pdf_item_id}/download`}>下载 PDF</a>}
        {editor && <Button size="small" onClick={() => onOpen(id)}>修改</Button>}
      </Space>
      <MinutesSection label="议题" text={m!.agenda_text} />
      <MinutesSection label="主要内容" text={m!.content_md} md />
      <MinutesSection label="决议事项" text={m!.resolutions} />
      <MinutesSection label="待办事项" text={m!.todos} />
      <MinutesSection label="参会人" text={m!.attendees} />
      <MinutesSection label="旁听人" text={m!.observers} />
      <MinutesSection label="缺席人" text={m!.absentees} />
    </div>
  )
}

/// 成品纪要里的一段;空的那几段**不显示**(读成品时,空标题只是噪音)。
function MinutesSection({ label, text, md }: { label: string; text: string; md?: boolean }) {
  if (!text?.trim()) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>{label}</Typography.Text>
      {md
        ? <div style={{ fontSize: 13 }}><MarkdownView text={text} /></div>
        : <div style={{ fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{text}</div>}
    </div>
  )
}

/// 材料 / 录制 / 纪要 三个 tab。
/// ★录制单独一个 tab★:它不是普通材料,是**会被转写、并决定活动时长**的东西(D5),
/// 混在材料里会让人不知道该传哪儿。
function MaterialsCard({ id, projectId, canEdit, onOpenMinutes, policy, onPolicy }: {
  id: number; projectId: number | null; canEdit: boolean; onOpenMinutes: (id: number) => void
  /// 活动粒度的材料策略(PRD 6.3.2);null = 我看不到这场会的可编辑信息
  policy: { no_download?: boolean; no_share?: boolean } | null
  onPolicy: (p: { no_download?: boolean; no_share?: boolean }) => void
}) {
  const { message } = AntdApp.useApp()
  const [items, setItems] = useState<ActivityItem[]>([])
  const [tab, setTab] = useState('mat')
  // 要分享的那一项(D7:材料有两个入口,分享自然也有两个 —— 同一份材料
  // 从项目进能分享、从活动进不能,那纯粹是代码住哪儿决定的,不是产品决定的)
  const [shareFor, setShareFor] = useState<ActivityItem | null>(null)
  const load = useCallback(async () => {
    try { setItems(await api<ActivityItem[]>(`/api/activities/${id}/items`)) } catch { setItems([]) }
  }, [id])
  useEffect(() => { void load() }, [load])

  const mats = items.filter((i) => !i.is_recording)
  const recs = items.filter((i) => i.is_recording)

  // ★两个 tab 各一份上传器★:`is_recording` 不同,后端据它决定要不要转写(D5),
  // 共用一个的话切 tab 时正在传的那份会被算成另一类。
  const upMat = useActivityUpload({
    projectId: projectId ?? 0, activityId: id, isRecording: false,
    label: '上传材料', onDone: load,
  })
  const upRec = useActivityUpload({
    projectId: projectId ?? 0, activityId: id, isRecording: true,
    accept: 'video/*,audio/*', label: '上传录屏 / 录音', onDone: load,
  })
  const up = tab === 'rec' ? upRec : upMat

  const table = (rows: ActivityItem[], empty: string) => (
    <Table<ActivityItem> size="small" rowKey="id" dataSource={rows} pagination={false}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      columns={[
        { title: '名称', render: (_, it) => <span><ItemIcon it={it} />{it.name}</span> },
        { title: '大小', dataIndex: 'size', width: 90, render: (v) => fmtSize(v) },
        { title: '上传', width: 150, render: (_, it) => `${it.created_by} · ${fmtTime(it.created_at).slice(5, 16)}` },
        {
          title: '', width: 110,
          render: (_, it) => <Space size={8}>
            <a href={`/api/items/${it.id}/download`}>下载</a>
            {/* ★分享只给能编辑的人★:建公开链接是**绕过项目授权**的动作(share.rs 头注),
                只读成员不该有这个能力;后端也会再判一次(前端隐藏不是安全边界)。 */}
            {canEdit && <a onClick={() => setShareFor(it)}>分享</a>}
            {/* ★删除只在这里★（2026-08-09 liaoruili:「要去会议里面删除」）:
                项目树里那条通用删除接口会拒绝活动材料(D10 的只读区),
                所以这份材料的唯一删除入口就是这一行。 */}
            {canEdit && (
              <Popconfirm title={`删除「${it.name}」？`}
                description="进项目回收站，30 天内可由项目管理员还原。"
                okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
                onConfirm={async () => {
                  try {
                    await api(`/api/activities/${id}/items/${it.id}`, { method: 'DELETE' })
                    message.success('已删除'); await load()
                  } catch (e) { message.error((e as Error).message) }
                }}>
                <a style={{ color: '#ff4d4f' }}>删除</a>
              </Popconfirm>
            )}
          </Space>,
        },
      ]} />
  )

  return (
    <Card size="small" style={{ marginBottom: 12 }}
      styles={{ body: { paddingTop: 4 } }}>
      <Tabs size="small" activeKey={tab} onChange={setTab}
        items={[
          // ★拖放区包住列表★(2026-08-09 用户「可以拖动上传」):平时不显形,拖进来才亮边框。
          { key: 'mat', label: `材料 ${mats.length}`, children: upMat.zone(table(mats, '还没有材料')) },
          { key: 'rec', label: `录制 ${recs.length}`, children: upRec.zone(table(recs, '还没有录屏或录音')) },
          // ★纪要是第三个 tab★（2026-08-09 用户）：它和材料/录制是同一层的东西 ——
          // 「这场活动留下了什么」。原来做成右上角一个「整理纪要」按钮，读起来像个动作，
          // 而它其实是**一块内容**。
          { key: 'min', label: '纪要', children: <MinutesTab id={id} canEdit={canEdit} onOpen={onOpenMinutes} /> },
        ]}
        tabBarExtraContent={canEdit && projectId != null && tab !== 'min' && (
          // ★上传录屏单独一个入口★(原型评审:「最好单独有个上传录屏的入口」)——
          // 因为它决定「会不会被转写」,和传一份参考资料完全是两件事。
          <Space size={6}>{up.button}</Space>
        )} />
      {/* ★活动粒度的材料策略★(PRD 6.3.2):「这次会涉及敏感内容,想让大家能看但不能下载」——
          说的是**这一次会**,不是把整个项目锁上。只有能改这场会的人看得到这两个开关。 */}
      {canEdit && policy && (
        <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 8, paddingTop: 8 }}>
          <Space size={16} wrap>
            <Space size={6}>
              <Switch size="small" checked={!!policy.no_download}
                onChange={(v: boolean) => onPolicy({ no_download: v })} />
              <Typography.Text style={{ fontSize: 12 }}>禁止下载原件</Typography.Text>
            </Space>
            <Space size={6}>
              <Switch size="small" checked={!!policy.no_share}
                onChange={(v: boolean) => onPolicy({ no_share: v })} />
              <Typography.Text style={{ fontSize: 12 }}>禁止对外分享</Typography.Text>
            </Space>
          </Space>
        </div>
      )}
      {shareFor && <ShareModal key={shareFor.id} items={[shareFor]} onClose={() => setShareFor(null)} />}
    </Card>
  )
}
