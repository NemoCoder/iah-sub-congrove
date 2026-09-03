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
import { annotate, fmtHM, fmtStamp, myTz, pickedToUtc, sameDayIn, utcToPicked } from './tz'
import { RemindSelect } from './remind-poll'
import { api, isMaterials, showUser, showUserWithAccount, type LinkChange, type ActivityDetail, type ActivityItem, type ActivityMessage, type Minutes, type Participant, type RespondStatus } from './api'
import { fmtSize, ItemIcon, MarkdownView } from './preview'
import { openViewer } from './video-player'
import { 算提醒态 } from './remind-status'
import { useActivityUpload } from './activity-upload'
import { useRenameActivityItem } from './activity-item-rename'
import { ShareModal } from './share-modal'
import { TimeRangePicker } from './time-range'
import { STATUS_LABEL, isEnded } from './activity-state'

// ⚠ `fmtTime` 原来在 **3 个文件**里各抄了一份(本文件 / projects-view / activity-minutes),
//   `fmtHM` 另有 2 份 —— 2026-08-12 全部收敛进 tz.ts(见 todo-card 头上那段注释)。
const fmtTime = fmtStamp
// ⚠★「同不同一天」和「几点几分」都要按**我的时区**判★(2026-08-15):
//   这里原来是 `s.toDateString() === e.toDateString()` + `e.getHours()` —— 全是浏览器本地。
//   跨时区时两者会同时错:一场按纽约时间跨了夜的会,在北京看是同一天(或反过来),
//   于是它要么少显示一个日期、要么多显示一个,而**两种都不会报错**。
const fmtRange = (a: string, b: string) =>
  sameDayIn(a, b)
    ? `${fmtTime(a)} – ${fmtHM(b)}`
    : `${fmtTime(a)} – ${fmtTime(b)}`


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
    // 「我的活动材料」不进这个下拉(PRD §J1,与 activity-new 同一判据)
    api<{ id: number; name: string; my_role: string | null; kind?: string }[]>('/api/projects')
      .then((ps) => setMyProjects(ps.filter((x) => !isMaterials(x) && (x.my_role === 'editor' || x.my_role === 'admin'))))
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
        <Empty description={err === '404' ? '这个活动不存在，或你没有权限查看' : err} />
        <div style={{ textAlign: 'center', marginTop: 12 }}><Button onClick={onBack}>{backLabel}</Button></div>
      </Card>
    )

  const m = d.activity
  const canceled = m.status === 'canceled'
  /// ★开完了就不能再「取消」,但仍然要能「删除」★
  ///
  /// 2026-08-15 liaoruili 拍板过前半句:原来判据只有 `can_edit && !canceled`,于是一场 8/12
  /// 开完的会,到 8/15 标题栏上还摆着红色的「取消活动」。
  /// ★「取消」讲的是「这场别开了」,对一件已经发生过的事没有意义★;真按下去是把一段
  /// **已经发生的协作事实**标成 canceled,连带纪要/材料的语义一起变味 —— 那不是撤销,是改写历史。
  ///
  /// ⚠★但那一版把按钮**整个**藏了,于是顺手砍掉了另一件正当的事★(2026-08-16 liaoruili 在 prod 上撞到):
  ///   **补录**的活动按定义就在过去 —— `已结束` 永远为真 —— 所以它**从出生起就没有任何移除入口**。
  ///   补录是「手打一条记录」,打错了就该能删掉;而当时的判据把「一场真开过的会」和
  ///   「一条录错的记录」当成同一件事。★一个只在「未来」成立的规则,被用在了一个只存在于「过去」的对象上。★
  ///
  /// 现在:按钮**一直在**(只要有权限且没取消过),★变的是它的名字和语义★ ——
  ///   · 还没开:「取消活动」= 通知大家这场别开了;
  ///   · 已开完:「删除活动」= 把这条记录移走(列表/日历按 `status='active'` 过滤,取消即消失)。
  /// 两者走**同一个后端**(`DELETE /api/activities/{id}` → status=canceled + 材料区材料进回收站),
  /// 后端本来就不拦已结束的 —— ★所以这次只是把界面对齐到后端一直允许的事★。
  const 已结束 = isEnded(m)

  // ★取消了就只说「活动已取消」,别再摊开细节★（2026-08-13 liaoruili:
  //   「如果已经取消，具体信息就别显示了，直接做个取消页面，就像 404 页面那样」
  //    「这些啰嗦的解释不要了，直接活动已取消即可」）。
  //
  // ⚠ 原来是**照常渲染整页**、只在顶上挂一条带长解释的 Alert:
  //   议程、地点、链接、参会名单、讨论区、纪要……全都还摆着,而它们此刻**一条都不该再被行动**。
  //   ★一屏可操作的东西 + 一句「已取消」,读起来像「还能去」——人得读完那条提示才知道白看了。★
  //   现在换成一页话说完:标题 + 已取消 + 返回。想知道「谁邀了谁、谁拒了」那些协作事实,
  //   数据都还在库里(取消不是删除),只是**不摆在脸上**。
  // ⚠ 用词是「**活动**已取消」不是「会议」(2026-08-13 他专门纠正):
  //   M0 起「会议」只是众多活动类型里的一个,写死「会议」又是把一类的名字当成全体的名字。
  if (canceled)
    return (
      // ★在剩余空间里垂直居中★:第一版写死 `margin: 48px auto`,卡片贴在顶上、下面空一大半,
      //   头重脚轻(qwen3.8-max 看实拍时点出来的:「略显头重脚轻」)。
      //   404 那类状态页的惯用观感就是**居中**——页面上只有一句话时,它该落在视线中央。
      //   减掉的 160px 是页眉 + 外层 padding,量出来的。
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                    minHeight: 'calc(100vh - 160px)' }}>
      <Card size="small" style={{ maxWidth: 560, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 12 }}>🚫</div>
        <Typography.Title level={4} style={{ margin: '0 0 6px' }}>活动已取消</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>{m.title}</Typography.Paragraph>
        <Button onClick={onBack}>{backLabel}</Button>
      </Card>
      </div>
    )

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button size="small" onClick={onBack}>‹ {backLabel}</Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          <InlineEdit value={m.title} canEdit={!!d.can_edit && !canceled} onSave={(v) => patch({ title: v })} />
        </Typography.Text>
        {canceled && <Tag color="default">已取消</Tag>}
        {m.visibility === 'public' && <Tag color="blue">公开活动</Tag>}
        {/* ★「非公开」,不是「私密项目」★(PRD §J4):判据是活动自己的 visibility(M0 起),
            而活动可以一个项目都不关联(A4)——「私密项目」对它根本不适用。 */}
        {m.is_private && <Tag color="purple">非公开</Tag>}
        {d.observer && <Tag>旁听</Tag>}
        <span style={{ flex: 1 }} />
        {/* ★取消旁听在这里做★(2026-08-07):广场只列「我还没有关系的会」,
            旁听之后它就从广场消失、进了我的日历 —— 要退出自然该来它自己的页面,
            而不是回广场上找一个已经不在那儿的条目。 */}
        {/* ⚠★这里原来套了一层 Popconfirm★（2026-08-12 liaoruili：「取消旁听不用再次确认，
            旁边就是旁听按钮，人用户想旁听会自己按回来」）。
            ★二次确认是给**不可逆**的动作用的★，而取消旁听一秒就能加回来（广场上那条会重新出现）。
            给可逆动作加确认，只是把成本从「偶尔点错」搬到「每次都多点一下」—— 后者天天发生。 */}
        {d.observer && !canceled && (
          <Button size="small" onClick={async () => {
            try {
              await api(`/api/activities/${id}/observe`, { method: 'POST', body: JSON.stringify({ observe: false }) })
              message.success('已取消旁听'); onBack()
            } catch (e) { message.error((e as Error).message) }
          }}>取消旁听</Button>
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
          // ★与打开时对称★:选择器给的是墙上时间,按活动时区解释成瞬时(E1)
          const atz = m.timezone || myTz()
          await patch({
            starts_at: pickedToUtc(a.toDate(), atz).toISOString(),
            ends_at: pickedToUtc(b.toDate(), atz).toISOString(),
          })
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
        {/* ⚠ 取消确认原来挂着一句「记录会保留下来（谁邀了谁、谁拒了是协作事实），只是标记为已取消」
            （2026-08-13 liaoruili:「去除下面的啰嗦的解释」）。
            ★确认框要的是「点下去会发生什么」,不是「我们为什么这么设计」★ ——
            前者一句话,后者属于文档;而这句解释在**每次**取消时都读一遍,读第二遍就是噪声。
            ⚠ 注释放在这里(children 位置),★别塞进 `{cond && (` 后面★ —— 那是表达式位置,
              JSX 花括号注释在那儿是语法错(我今天第二次踩,第一次在公开活动的空状态)。 */}
        {d.can_edit && !canceled && (
          <Popconfirm
            title={已结束 ? '删除这场活动？' : '取消这场活动？'}
            description={已结束
              ? <div style={{ maxWidth: 280, fontSize: 12 }}>它会从日程与活动列表里消失。<b>材料区里属于它的材料一并进回收站</b>（30 天内可还原）；普通项目里的材料不动。</div>
              : <div style={{ maxWidth: 280, fontSize: 12 }}>参会人会收到「已被取消」的站内信。</div>}
            okText={已结束 ? '删除' : '取消活动'} cancelText="再想想"
            onConfirm={async () => {
              try { await api(`/api/activities/${id}`, { method: 'DELETE' }); await load(true) } catch (e) { /* 失败由下方错误区呈现 */ }
            }}>
            <Button size="small" danger>{已结束 ? '删除活动' : '取消活动'}</Button>
          </Popconfirm>
        )}
      </Space>


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
                    <span>
                      {fmtRange(m.starts_at, m.ends_at)}
                      {/* ★E2:只有跨时区才标★(PRD)。一致时 annotate 返回空串,
                          国内 99% 的情况看不到任何多余的字。
                          「跨时区的人看到『凌晨 3:00』会懵 —— 不知道这是对方的下午,
                          还是真要自己凌晨爬起来。★那个数字必须有个解释★。」 */}
                      {annotate(m.starts_at, m.timezone) && (
                        <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                          {annotate(m.starts_at, m.timezone)}
                        </Typography.Text>
                      )}
                    </span>
                    {!!d.can_edit && !canceled && (
                      <Button type="text" size="small" style={{ padding: '0 4px', height: 20 }}
                        title="改时间（所有人的答复会清回待定）"
                        onClick={() => setTimeEdit([
                          // ★按**活动自己的**时区还原墙上时间★(E1):直接 dayjs(瞬时) 是按浏览器还原的,
                          // 一个纽约的人打开北京的会,编辑框里会显示成他的凌晨 —— 他什么都没改就点保存,
                          // 时间也会被写回成另一个瞬时。★不做逆变换,「打开就挪」★(tz.ts::utcToPicked)。
                          dayjs(utcToPicked(m.starts_at, m.timezone || myTz())),
                          dayjs(utcToPicked(m.ends_at, m.timezone || myTz())),
                        ])}>✎</Button>
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
                  placeholder="（双击填写腾讯会议 / Zoom 链接）" onSave={(v) => patch({ online_url: v })}
                  renderView={(v) => <a href={v} target="_blank" rel="noreferrer">{v}</a>} />,
              },
              // ★别把一次「有意的隐藏」渲染成「像是坏了」★(2026-08-15 逐张看巡检截图看出来的):
              //   旁听者拿到的是**裁剪版**——后端刻意把 `organizer`/`recorder` 给空串、
              //   `projects` 给空数组(activities.rs 的 observer 分支)。而这里原样 `children: m.organizer`,
              //   于是页面上就是「发起人:」后面**一片空白**。
              //   ⚠ 坏就坏在**同一张卡里**「线上: 未填」是有灰色兜底文案的 —— 两种缺失长得不一样,
              //     读的人分不清是没填、没权限、还是加载失败。★而这类问题巡检报告永远抓不到★:
              //     不报错、HTTP 200、点得动,只有人眼看得出来。
              //   修法不是补一句「未填」(那是撒谎,它明明有发起人),而是**照实说是旁听看不到**。
              ...(d.observer ? [] : [{
                key: 'o', label: '发起人',
                children: m.organizer || <Typography.Text type="secondary">—</Typography.Text>,
              }]),
              // ★提醒摆在这里而不是收进某个设置弹窗★:它是「这一场」的属性,
              // 和地点/线上链接同级;藏起来的结果就是没人知道它可以改。
              // ⚠ 改这一项**不清 reminded_at**(后端 ActivityPatch 头注):
              //   「提前 15 分」改成「提前 30 分」时,如果 15 分钟那条已经发过了,
              //   清了就会再发一遍 —— 而人已经知道这场会了。
              ...(!canceled && d.can_edit ? [{
                key: 'rm', label: '提醒',
                children: <RemindSelect value={m.remind_minutes}
                  onChange={(v) => patch({ remind_minutes: v })} style={{ width: 180 }} />,
              }] : []),
              // ★只在会开完之后才出现★(D5 第 2 级):会还没开就问「实际开了多久」是荒谬的,
              // 而且那一栏摆在那里只会让人以为要预填。
              ...(isEnded(m) ? [{
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
              ...(m.recorder ? [{ key: 'r', label: '记录员', children: (
                <RecorderPicker mid={m.id} 当前={m.recorder} 参会人={d.participants ?? []}
                  canEdit={!!d.can_edit && !canceled} onDone={() => void load(true)} />
              ) }] : []),
              { key: 'sub', label: '会议主题', children: (
                <InlineEdit value={m.subject ?? ''} canEdit={!!d.can_edit && !canceled}
                  placeholder="（双击填写：这次要推进什么）"
                  onSave={(v) => patch({ subject: v })} />
              ) },
              // ★主讲人★(2026-08-23):自由文本,和「地点」同一种交互(双击改)——
              //   它不是选人:外请的主讲人未必是平台用户,而它只是纪要上的一行署名。
              //   ⚠ 没填也画这一行(空态提示「双击填写」),否则想补填的人找不到入口 ——
              //     这正是「记录员改不了」那个 bug 的同一个形状:能力在、入口没有。
              { key: 'sp', label: '主讲人', children: (
                <InlineEdit value={m.speakers ?? ''} canEdit={!!d.can_edit && !canceled}
                  placeholder="（双击填写，多人用顿号分隔）"
                  onSave={(v) => patch({ speakers: v })} />
              ) },
              // 同上:旁听者的 `projects` 是后端刻意给的空数组,不是「这场活动没关联项目」。
              // 摆一行空着的「关联项目:」只会让人以为数据丢了 —— 干脆不摆(顶部已有「旁听」标签,
              // 下面那句灰字也说清了裁剪范围)。
              ...(d.observer ? [] : [{
                key: 'p', label: '关联项目',
                children: (
                  <Space wrap size={4}>
                    {d.projects?.map((p) => <Tag key={p.id}>{p.name}</Tag>)}
                    {/* 真的一个都没关联时也要说话,别留一片空白 */}
                    {!d.projects?.length && <Typography.Text type="secondary">未关联项目</Typography.Text>}
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
              }]),
            ]} />
          </Card>

          {/* ★议程区要留足高度★(原型评审:内容高度太矮) */}
          <Card size="small" title="议题与议程" style={{ marginBottom: 12 }}>
            {/* ★议程只读态也按 Markdown 渲染★(2026-08-22,与纪要那几栏同一条理由):
                这里的提示语就写着「一行一条」,人自然会敲 `1.` `-` 或粗体。
                `breaks` 让他打的回车真换行(markdown 单换行本来不换行)。 */}
            <InlineEdit value={m.agenda} canEdit={!!d.can_edit && !canceled} multiline rows={7}
              placeholder="（双击填写议题与议程，一行一条）"
              renderView={(v) => <MarkdownView text={v} breaks />}
              style={{ minHeight: 160, fontSize: 13, lineHeight: 1.8 }}
              onSave={(v) => patch({ agenda: v })} />
          </Card>

          {/* ★线上活动区★:链接 + 复制 + 改动历史(开会前十分钟改链接是真实场景,事后要能追溯) */}
          {/* ★线上地址对旁听也显示★(2026-08-17,ADR-0006 决定一的反方向缺口):
              原来卡在 `d.participants`(旁听拿不到名单)上 —— 于是旁听者**拿得到 online_url
              却没有任何地方显示它**,而白名单里明确含「线上地址或者会议号」。
              ⚠ 但**不给改动历史**:那是活动内部的过程信息,不在白名单里。 */}
          {m.online_url && <OnlineCard id={id} url={m.online_url} 只读={!d.participants} />}

          {/* ★材料 / 录制★(D5:录制 ≠ 材料,只有录制会被转写、并作为活动时长依据) */}
          {/* ★不关联项目的个人活动也能传材料★(PRD §J0):落点由后端算(发起人的「我的活动材料」),
              所以 canEdit 不再拿「有没有关联项目」当判据 —— 那正是它整类传不了东西的原因。 */}
          {/* ★显隐改用后端算的 can_see_items★(2026-08-17,ADR-0006):
              原来用 `d.participants`(= 是不是参会人)当判据,而后端按「是不是关联项目成员」判权
              —— 两套判据不同源,于是「参会人但非项目成员」看到:★卡片在、列表空、上传失败★。
              ★前端隐藏不是安全边界,后端仍然逐个接口判★;这里只管别再画一张骗人的卡片。 */}
          {d.can_see_items && (
            <MaterialsCard id={id} projectId={d.projects?.[0]?.id ?? null}
              canEdit={!canceled && d.can_upload_items} onOpenMinutes={onOpenMinutes}
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
          {/* ⚠★倒计时放在 `d.participants` 判断**之外**★:旁听者拿不到参会名单,
              但「还有多久开始」对他一样要紧 —— 他也是要去开这场会的人。
              第一版顺手写进了那个条件里,等于把旁听者排除掉了。 */}
          <Countdown startsAt={m.starts_at} endsAt={m.ends_at} />
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
          {d.participants && <DiscussionCard id={id} organizer={m.organizer} recorder={m.recorder} me={me} />}
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
  const meta = STATUS_LABEL[p.status]
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
        {p.kind !== 'observer' && <Tag color={meta.color}>{meta.text}</Tag>}
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
  /// ★两份 state 是刻意的★:提交要 ISO 字符串,而 `TimeRangePicker` 是**受控**的、要 Dayjs。
  /// ⚠★这里原来只存字符串、不给控件回传 `value`★（2026-08-13 liaoruili:「建议改期的日期时间
  ///   无法选择」）—— 控件的显示完全由 `value` 决定(`const [s, e] = value ?? [null, null]`),
  ///   不回传就是:你选了日期 → onChange 触发 → 父组件确实存下了 → 而控件照旧显示空的。
  ///   ★选了等于没选,而且不报任何错。★
  ///   同一文件里「改时间」那处(TimeRangePicker value={timeEdit})是对的 ——
  ///   ★同一个组件两处用法不一致,坏的那处恰好是没人测过的那处。★
  const [range, setRange] = useState<[string, string] | null>(null)
  const [rangeD, setRangeD] = useState<[Dayjs, Dayjs] | null>(null)
  const [reason, setReason] = useState('')

  const send = async (status: RespondStatus) => {
    if (status === 'counter' && !range) { message.warning('请先选一个你方便的时间段'); return }
    setBusy(true)
    try {
      const 回 = await api<{ ok: boolean; status: string; still_recorder?: boolean }>(
        `/api/activities/${id}/respond`, {
          method: 'POST',
          body: JSON.stringify({
            status,
            ...(status === 'counter' && range
              ? { counter_starts_at: range[0], counter_ends_at: range[1], counter_reason: reason || null }
              : {}),
          }),
        })
      // ★拒绝了但我还是记录员 —— 当场告诉我★
      // （2026-08-14 liaoruili:「已拒绝为啥还看得到 纪要待整理？？？？」,他选了方案 B）。
      //   `activities_owing_minutes` 只看 `recorder = 我`,不看我的答复状态 ——
      //   所以拒绝之后这场的纪要仍然挂在我名下。★后端已经当场通知发起人另指派★,
      //   但如果只通知他、不告诉我,我就会一直纳闷「我都拒了为什么还催我写纪要」——
      //   ★而那正是他问出来的那句话。★
      if (回?.still_recorder) {
        message.warning('已拒绝。⚠ 你仍是这场的记录员，纪要还挂在你名下 —— 已通知发起人另指派', 6)
      } else {
        message.success('已答复')
      }
      onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  const meta = STATUS_LABEL[mine]
  return (
    <Card size="small" title="我的答复" style={{ marginBottom: 12 }}
      extra={<Tag color={meta.color}>{meta.text}</Tag>}>
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
            {/* ⚠ 这里原来写的是 `发起人**看不到**你私密项目里的安排` —— 两处都不对:
                ① `**...**` 是 Markdown,而这是一个 Typography.Paragraph,★星号会原样显示出来★;
                ② 用词(2026-08-09 liaoruili):不叫「私密」,叫「不公开」;判据也是活动自己的
                   visibility,不是项目的。 */}
            发起人<b>看不到</b>你不公开的安排,所以他不知道你这个时段忙。
            给一个你方便的具体时间,比只说「不行」有用得多。
          </Typography.Paragraph>
          {/* 建议一个**将来**的时段才有意义,所以这里 noPast */}
          <div style={{ marginBottom: 8 }}>
            <TimeRangePicker noPast size="small" value={rangeD}
              onChange={(v) => {
                setRangeD(v && v[0] && v[1] ? [v[0], v[1]] : null)
                setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)
              }} />
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
function DiscussionCard({ id, organizer, recorder, me }: { id: number; organizer: string; recorder: string; me: string }) {
  const { message, modal } = AntdApp.useApp()
  const [msgs, setMsgs] = useState<ActivityMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /// ★发送至★:公开 or 私聊。私聊对象只限发起人与记录员(D13:不做任意点对点,否则长成 IM)。
  const [to, setTo] = useState<string>('public')
  const load = useCallback(async () => {
    try {
      // ★一条流:公开 + 与我有关的私聊★（2026-08-12 liaoruili：「私聊和公开聊天为啥需要切换
      // 才能分别看到？腾讯会议已经有例子了」）。★「发送至」只决定**这一条发给谁**，不再决定**看哪一条**★ ——
      // 原来它兼着两件事，于是切到「私聊 X」才看得见 X 说的话，人得先猜对方在哪条频道说的。
      setMsgs(await api<ActivityMessage[]>(`/api/activities/${id}/messages`))
    } catch { setMsgs([]) }
  }, [id, to])
  useEffect(() => { void load() }, [load])

  const send = async () => {
    const body = text.trim()
    if (!body) return
    // ★防误发：刚收到的是私聊，却要发给所有人 → 确认一次★（腾讯会议同款做法）。
    //
    // ⚠ 这和刚刚**去掉**的「取消旁听二次确认」不矛盾，恰恰是同一条原则的两面：
    //   ★确认留给**不可逆**的动作★。取消旁听一秒能加回来；
    //   而把私聊里的话发给全场，发出去就收不回了。
    const 最后一条 = msgs[msgs.length - 1]
    if (to === 'public' && 最后一条?.channel === 'private' && 最后一条.sender !== me) {
      const ok = await new Promise<boolean>((res) => modal.confirm({
        title: '发给所有参会人？',
        content: `你刚收到 ${最后一条.sender} 的**私聊**，而这条要发给所有人。`,
        okText: '发给所有人', cancelText: '我改成私聊',
        onOk: () => res(true), onCancel: () => res(false),
      }))
      if (!ok) return
    }
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
          : msgs.map((m) => {
            const 私 = m.channel === 'private'
            // 「谁跟谁」的私聊:我发出去的写「→ 对方」,别人发给我的写「私聊我」
            const 私标 = !私 ? null : m.sender === me ? `私聊 → ${m.peer}` : '私聊我'
            return (
            /* ★私聊在同一条流里,靠**底色 + 标签**区分,不靠切换视图★（腾讯会议同款）。
               ⚠ 标签必须说清**方向**:只写「私聊」的话，我自己发出去的和别人发给我的长得一样，
                 而这两件事在会中要做的反应完全不同。 */
            <div key={m.id} style={{
              marginBottom: 10,
              ...(私 ? { background: '#fffbe6', borderLeft: '3px solid #ffd666', padding: '4px 8px', borderRadius: 4 } : {}),
            }}>
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                {m.sender} · {fmtTime(m.created_at)}
                {私标 && <Tag color="gold" style={{ marginLeft: 6, transform: 'scale(.85)' }}>{私标}</Tag>}
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          )})}
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
        {/* ⚠★下拉面板要比触发器宽★(2026-08-09 用户:「私聊谁谁已经看不清楚,再宽 1.5 倍」):
            AntD 的下拉默认与触发器**等宽**,而触发器为了不喧宾夺主是按内容收窄的 ——
            于是选项被截成「私聊 liaor…」「私聊（记…」,★恰恰把「私聊给谁」这个唯一有信息量的部分切掉了★。
            `popupMatchSelectWidth={false}` 让面板按内容自己撑开,再给个下限;
            触发器本身仍然窄(它只需要显示当前选中的那一项)。 */}
        <Select size="small" value={to} onChange={setTo} variant="borderless"
          popupMatchSelectWidth={false}
          styles={{ popup: { root: { minWidth: 260 } } }}
          style={{ flex: '0 1 auto', minWidth: 0, marginLeft: -8 }}
          options={[
            { value: 'public', label: '所有参会人' },
            // ★私聊对象只有这两位★(D13):不做任意点对点,否则这里会长成一个 IM。
            // ⚠★把自己排掉★（2026-08-12 liaoruili：「为啥我可以私聊自己？」）——
            //   我既是发起人又是记录员时，这里原来会列出「私聊 我自己（发起人）」。
            //   ★给自己发私信不是一个功能，是一个没人想要的状态★：
            //   它还会进「待我处理」的未读，变成自己给自己制造待办。
            ...(organizer !== me ? [{ value: organizer, label: `私聊 ${organizer}（发起人）` }] : []),
            ...(recorder !== organizer && recorder !== me
              ? [{ value: recorder, label: `私聊 ${recorder}（记录员）` }] : []),
          ]} />
        <Button size="small" type="primary" loading={busy} style={{ marginLeft: 'auto' }}
          disabled={!text.trim()} onClick={send}>发送</Button>
      </div>
    </Card>
  )
}

/// ★倒计时★（2026-08-12 liaoruili：「距离 24 小时以内的活动点进去都做个倒计时，秒表的那种，
/// 加到参会人上面」）。放在右栏最顶上 —— 它是这一页此刻**最要紧的一个数**。
///
/// ══════ 三条 ══════
///  · ★只在 24 小时以内才出现★：一场下个月的会顶着「还有 719:59:12」除了占地方没有意义，
///    而且会让真正要紧的那次失去分量（跟通知那条一个道理：处处醒目 = 无处醒目）。
///  · ★会开着的时候不消失，改说「正在进行」★：这时候人最需要知道的是「我是不是迟到了」。
///  · ★每一跳都用 `Date.now()` 重算，不做自减★：标签页在后台会被浏览器降频甚至冻结，
///    自减的计时器一睡就漂；重算则醒来即正确。
function Countdown({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  const s = new Date(startsAt).getTime(), e = new Date(endsAt).getTime()
  const 要显示 = now < e && s - now <= 24 * 3600_000
  useEffect(() => {
    if (!要显示) return                       // ★不相关时不挂定时器★，别让每个详情页都白跑一个 1s 循环
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [要显示])
  if (!要显示) return null

  const 进行中 = now >= s
  const 秒 = Math.max(0, Math.floor(((进行中 ? e : s) - now) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const 钟表 = `${pad(Math.floor(秒 / 3600))}:${pad(Math.floor((秒 % 3600) / 60))}:${pad(秒 % 60)}`
  /// 最后 5 分钟标红 —— 到这一步「快开始了」才真的要人动起来
  const 紧 = !进行中 && 秒 <= 300
  return (
    <Card size="small" style={{
      marginBottom: 12, textAlign: 'center',
      background: 进行中 ? '#e6fffb' : 紧 ? '#fff1f0' : '#fffbe6',
      borderColor: 进行中 ? '#87e8de' : 紧 ? '#ffa39e' : '#ffe58f',
    }}>
      <div style={{ fontSize: 12, color: '#8c8c8c' }}>
        {进行中 ? '正在进行 · 距结束' : '距开始'}
      </div>
      {/* 等宽数字：不等宽的话秒位每跳一次整行都在抖 */}
      <div style={{
        fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: 进行中 ? '#08979c' : 紧 ? '#cf1322' : '#d46b08',
      }}>{钟表}</div>
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
  /// ★提醒投没投,得在界面上看得出来★(2026-08-16)——判据抽在 remind-status.ts,带测试。
  ///   起因:prod 上一次「没收到提醒」的排查,界面上完全看不出提醒过没有,只能进库查。
  ///   而「没投」(我们的问题)和「投了没收到」(站内信那段的问题)处置完全不同。
  const 提醒 = 算提醒态(joined)
  return (
    <Card size="small" title={`参会人（${joined.length}）`}
      extra={canHost && <AddParticipants mid={mid} onDone={onDone} />}>
      {提醒.kind !== 'none' && (
        <div style={{ fontSize: 12, marginBottom: 8, color: '#8c8c8c' }}>
          提醒 · {提醒.kind === 'pending'
            ? <Typography.Text type="secondary">尚未发出</Typography.Text>
            : 提醒.kind === 'done'
              ? <Typography.Text type="success">已于 {fmtHM(提醒.at)} 发给 {提醒.total} 人</Typography.Text>
              : <Typography.Text type="warning">
                  已于 {fmtHM(提醒.at)} 发给 {提醒.sent} / {提醒.total} 人（其余下一轮补）
                </Typography.Text>}
        </div>
      )}
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


/// 改记录员。★后端一直支持,详情页只画了个只读 Tag★
/// (2026-08-23 liaoruili:「发起活动后,主持人可以修改记录人,现在无法修改」)。
///
/// ⚠★这是本仓第三次出现同一形状★:「能力早就有、这里没入口」——
///   前两次是 ADR-0006 的「材料/录制点不开」和发起活动页的「＋ 新建类型…」。
///   判据都一样:**后端有接口、前端没露出**,于是这个能力对用户来说等于不存在。
///
/// ★候选默认是当前参会人★:记录员通常就是在场的某个人,不该逼人先去搜。
///   同时允许搜/手输别人 —— 后端会把他拉进名单并发一条「你被指派为记录员」。
function RecorderPicker({ mid, 当前, 参会人, canEdit, onDone }: {
  mid: number; 当前: string; 参会人: Participant[]; canEdit: boolean; onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [编辑中, set编辑中] = useState(false)
  const [值, set值] = useState(当前)
  const [found, setFound] = useState<{ username: string; name: string | null }[]>([])
  const [busy, setBusy] = useState(false)
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
  if (!编辑中) {
    return (
      <Space size={6}>
        <Tag color="cyan">{showUser(当前, 参会人.find((p) => p.username === 当前)?.name)}</Tag>
        {canEdit && <Button size="small" type="link" style={{ padding: 0 }}
          onClick={() => { set值(当前); set编辑中(true) }}>改</Button>}
      </Space>
    )
  }
  // ★候选 = 参会人 ∪ 搜索结果★,按 username 去重(参会人优先,他带着姓名)
  const 候选 = [...参会人.map((p) => ({ username: p.username, name: p.name ?? null })),
                ...found.filter((u) => !参会人.some((p) => p.username === u.username))]
  const 保存 = async () => {
    const v = 值.trim()
    if (!v) { message.warning('记录员不能为空'); return }
    if (v === 当前) { set编辑中(false); return }   // 没改就不发请求
    setBusy(true)
    try {
      await api(`/api/activities/${mid}`, { method: 'PUT', body: JSON.stringify({ recorder: v }) })
      message.success(`记录员已改为 ${v}`)
      set编辑中(false); onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Space size={6}>
      <Select showSearch value={值} onChange={set值} onSearch={search} filterOption={false}
        style={{ minWidth: 220 }} placeholder="选参会人,或搜用户名" notFoundContent={null}
        options={候选.map((u) => ({ value: u.username, label: showUserWithAccount(u.username, u.name) }))} />
      <Button size="small" type="primary" loading={busy} onClick={() => void 保存()}>保存</Button>
      <Button size="small" onClick={() => set编辑中(false)}>取消</Button>
    </Space>
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
  const [kind, setKind] = useState<'attendee' | 'observer'>('attendee')
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
          style={{ width: '100%' }} placeholder="完整用户名（同项目的人可搜姓名；没搜到也能直接输入）" notFoundContent={null}
          options={found.map((u) => ({ value: u.username, label: showUserWithAccount(u.username, u.name) }))} />
        {/* ⚠★原来这里有个「临时参会人（guest）」选项，而它**选了就会报错**★
            （2026-08-12 liaoruili：「为啥还有临时参会人的概念！！！临时参会就按照旁听处理即可」）。
            `activity_participants.kind` 的 CHECK 只允许 `attendee` / `observer` ——
            guest 早在 0005 迁移就删了，理由与他说的一字不差，schema 注释里写着：
            「★没有 guest 档★：它和 observer 的可见面完全一样，两个名字装同一件事，
              只会让判权的人以为有区别」。
            ★所以这是个界面上还留着、数据库已经不认的死选项★ —— 前端没跟着删。 */}
        <Select value={kind} onChange={setKind} style={{ width: '100%' }}
          options={[
            // ⚠ 原来是「参会人（要答复，能看材料）」「旁听（不用答复，看不到材料）」
            //（2026-08-13 liaoruili:「直接是参会人和旁听，不要括号里啰嗦的解释」）。
            // ★下拉选项是**标签**不是说明书★:两个选项都拖着一句括号,读起来像两段话而不是两个选项,
            // 而「参会人 / 旁听」这两个词本身已经说清了区别。
            // ⚠ 这里是**数组字面量**不是 JSX children,只能用 `//`,写 `{/* */}` 会直接语法错(我刚踩过)。
            { value: 'attendee', label: '参会人' },
            { value: 'observer', label: '旁听' },
          ]} />
      </Space>
    </Modal>
  )
}

/// 线上活动:链接 + 复制 + 改动历史。
/// ★改动历史不是装饰★:临开会前换链接很常见,事后「我进的是旧链接」要能查清是谁什么时候改的。
function OnlineCard({ id, url, 只读 = false }: { id: number; url: string; 只读?: boolean }) {
  const { message } = AntdApp.useApp()
  const [hist, setHist] = useState<LinkChange[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    // ★旁听者不拉改动历史★:地址本身在白名单里,而「谁什么时候把链接改成了什么」不在。
    //   ⚠ 不拉是**省一次必然 403 的请求**,不是安全边界 —— 真闸在后端 link_history 上。
    if (只读) { setHist([]); return }
    api<LinkChange[]>(`/api/activities/${id}/link-history`).then(setHist).catch(() => setHist([]))
  }, [id, 只读])
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
              {fmtTime(h.changed_at)} · {h.changed_by} 改成 <code>{h.new_url || '（清空）'}</code>
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
      {/* ★哪几段是 Markdown,哪几段不是★(2026-08-23 修:此前只有「主要内容」给了 md)
          · 议题 / 决议 / 待办 —— **是** Markdown:AI 那几个「导入」按钮拉进来的就是
            带 `-` 列表的 md,记录员手写时也会用列表。不给 md 的话屏幕上是一堆字面的减号。
          · 参会人 / 旁听 / 缺席 —— **不是**:那是一行一个人的名单,`pre-wrap` 正好,
            交给 Markdown 反而会把它当成段落折行。 */}
      <MinutesSection label="议题" text={m!.agenda_text} md />
      <MinutesSection label="主要内容" text={m!.content_md} md />
      <MinutesSection label="决议事项" text={m!.resolutions} md />
      <MinutesSection label="待办事项" text={m!.todos} md />
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
        // ★breaks★:这几段都是人手写的,他打的回车必须真换行
        //   (Markdown 规范里单换行不换行 —— 见 preview.tsx 的 MarkdownView 头注)。
        ? <div style={{ fontSize: 13 }}><MarkdownView text={text} breaks /></div>
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
    projectId, activityId: id, isRecording: false,
    label: '上传材料', onDone: load,
  })
  const upRec = useActivityUpload({
    projectId, activityId: id, isRecording: true,
    accept: 'video/*,audio/*', label: '上传录屏 / 录音', onDone: load,
  })
  const up = tab === 'rec' ? upRec : upMat
  // 改名:两个 tab 的表格共用一个 Modal(见 activity-item-rename.tsx 的头注)
  const ren = useRenameActivityItem({ activityId: id, onDone: load })

  const table = (rows: ActivityItem[], empty: string) => (
    <Table<ActivityItem> size="small" rowKey="id" dataSource={rows} pagination={false}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      columns={[
        // ★名称可点开★(2026-08-17 liaoruili:「录制那里应该可以直接点开查看视频什么的」)。
        // `openViewer` + <VideoPlayer standalone>(带 Range 拖动)**早就有**,项目树里就在用 ——
        // ★又是「能力早就有、这里没入口」★(和超管后台那四个 API 是同一个形状)。
        // viewer 页按 kind 分流:video 直接播,PDF/图片/文本各按既有预览走。
        { title: '名称', render: (_, it) => (
          <a onClick={() => openViewer(it.id)} style={{ color: 'inherit' }}>
            <ItemIcon it={it} />{it.name}
          </a>
        ) },
        { title: '大小', dataIndex: 'size', width: 90, render: (v) => fmtSize(v) },
        // ★「上传」拆成两列★(2026-08-17 liaoruili 截图:「材料哪里上传跨行了,增加一个单独的
        //   列显示上传时间」)——原来是 `${created_by} · ${时间}` 挤在 150px 里,实拍折成两行。
        //   ⚠ 这个文件里就记着上一次同样的教训(「下载分享删除 成了 2 行」):
        //   ★width 只是**建议值**,拦不住换行★ —— 两样东西塞一列,迟早会挤。
        { title: '上传者', dataIndex: 'created_by', width: 110, ellipsis: true },
        { title: '上传时间', width: 130, render: (_, it) => fmtTime(it.created_at).slice(5, 16) },
        {
          // ⚠★width 只是**建议值**,拦不住换行★(2026-08-09 liaoruili:「下载分享删除 成了 2 行」)。
          // 名称列没设宽,它会把剩余宽度全吃掉;真到装不下时 AntD 压缩的是这一列,
          // 于是三个词各自折成上下两行(「下/载」「分/享」「删/除」),读起来像六个按钮。
          // 两件事一起做才管用:① 宽度给够;② ★整块 nowrap★ —— 有了它,
          // 列宽以后怎么调都不会再断行(与项目页操作列 v0.3.56 那次是同一个教训)。
          title: '', width: 150,
          onCell: () => ({ style: { whiteSpace: 'nowrap' as const } }),
          render: (_, it) => <Space size={12} style={{ whiteSpace: 'nowrap' }}>
            <a href={`/api/items/${it.id}/download`}>下载</a>
            {/* ★分享只给能编辑的人★:建公开链接是**绕过项目授权**的动作(share.rs 头注),
                只读成员不该有这个能力;后端也会再判一次(前端隐藏不是安全边界)。 */}
            {canEdit && <a onClick={() => setShareFor(it)}>分享</a>}
            {/* ★改名也只在这里★(2026-08-09 liaoruili:「上传的文件,也要支持能够重命名」):
                与删除同一条路 —— 项目树那条通用接口按 D10 拒绝活动材料。 */}
            {canEdit && <a onClick={() => ren.open(it)}>改名</a>}
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
        tabBarExtraContent={canEdit && tab !== 'min' && (
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
      {ren.modal}
    </Card>
  )
}
