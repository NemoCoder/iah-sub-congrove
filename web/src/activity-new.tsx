// 发起活动 —— 对应 docs/prototype-m1.html 的 `new` 视图。
//
// ★两个必填项都不是形式★,表单上要把「为什么」说出来,别让人以为是啰嗦的字段:
//   · **关联项目(至少一个)**:材料权限来自项目成员身份(D3),没有项目就没人管得了这场会的材料;
//   · **记录员**:正式纪要由他按固定模板整理,AI 转写只是给他的原材料(D14)。
//
// 参会人用 chips-combobox(输入即过滤、选中清空、★空输入时 Backspace 删最后一个 chip★),
// 与项目成员管理那套一致 —— 同一个交互在两处长得不一样,比丑更糟。
import { App as AntdApp, Button, Card, Form, Input, Select, Space, Spin, Switch, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, isMaterials, showUser, type ActivityType, type FreeBusy, type Me, type MemberList, type Project, type UserOpt } from './api'
import { ticks, toBar } from './freebusy-layout'
import { TimeRangePicker } from './time-range'


export function ActivityNewView({ me, onCreated, onCancel }: {
  me: Me | null
  onCreated: (id: number) => void
  onCancel: () => void
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [projects, setProjects] = useState<Project[]>([])
  const [found, setFound] = useState<UserOpt[]>([])
  const [busy, setBusy] = useState(false)
  const [pub, setPub] = useState(false)
  const [projOpen, setProjOpen] = useState(false)
  /// ★参会人与时间提到组件级★:右栏的 chips 与忙闲图都要用它们,
  /// 留在 Form 内部的话右栏读不到(原型就是左表单/右面板并排)。
  const [people, setPeople] = useState<string[]>([])
  const [range, setRange] = useState<[string, string] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /// 当前输入的关键词。★候选只覆盖登录过汇流的人★(/api/users 查本地 app_user),
  /// 而后端能拉任何平台用户 —— 所以搜不到时要允许直接用输入的用户名。
  const [typed, setTyped] = useState('')

  useEffect(() => {
    // ★只列我能建会的项目★:后端要求每个关联项目 ≥editor,前端先过滤掉 viewer 的,
    // 免得选了才被拒(选项里放一个必然失败的选择 = 引导人犯错)。
    // ★「我的活动材料」不进这个下拉★(PRD §J1):它是个人存档区不是协作项目。
    // 后端也拒(材料区在 require_role 上全只读,关联项目要 ≥editor),这里只是别引导人去点。
    api<Project[]>('/api/projects')
      .then((ps) => setProjects(ps.filter((p) => !isMaterials(p) && (p.my_role === 'editor' || p.my_role === 'admin'))))
      .catch(() => setProjects([]))
  }, [])

  /// ★/api/users 是「输入即搜」的接口:不带 q 时返回空数组★(admin.rs user_options)。
  /// 2026-08-07 这里原本不带 q 调一次就把结果当全部候选,于是下拉框永远「暂无数据」——
  /// 而记录员是**必填**,等于根本建不了活动。是用户在真实界面上点出来的。
  /// ⚠ 这类「前端把接口用错了」的 bug,API 层测试一条都抓不到(接口本身完全正常)。
  const search = useCallback((kw: string) => {
    if (timer.current) clearTimeout(timer.current)
    const q = kw.trim()
    setTyped(q)          // 记住当前输入:候选搜不到时把它本身当一个可选项(见 userOpts)
    if (!q) { setFound([]); return }
    timer.current = setTimeout(() => {
      api<UserOpt[]>(`/api/users?q=${encodeURIComponent(q)}`).then(setFound).catch(() => setFound([]))
    }, 250)
  }, [])

  /// 候选 = 搜到的 + ★我自己★。
  /// 「记录员也可以是发起人本身」是最常见的情形(用户 2026-08-07 指出),
  /// 所以不搜也要能选到自己;记录员字段还默认填上自己,省一次操作。
  const userOpts = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    const push = (u: string, n?: string | null) => {
      if (!u || seen.has(u)) return
      seen.add(u)
      out.push({ value: u, label: n && n !== u ? `${n}（${u}）` : u })
    }
    if (me?.username) push(me.username, me.name ? `${me.name}· 我` : '我')
    for (const u of found) push(u.username, u.name)
    // 搜不到就把输入本身给出来:平台没有用户搜索接口,候选只有登录过的人,
    // 但后端 ensure_platform_user 能校验并拉任何平台用户(真伪由它判)。
    if (typed && !seen.has(typed)) out.push({ value: typed, label: `使用「${typed}」` })
    return out
  }, [me, found, typed])

  // ★活动类型决定这张表单长什么样★（ADR-0002）：
  // 记录员与关联项目**是否必填**由类型的能力位决定，不再写死。
  const [types, setTypes] = useState<ActivityType[]>([])
  const [typeId, setTypeId] = useState<number | undefined>()
  useEffect(() => {
    api<ActivityType[]>('/api/activity-types')
      .then((ts) => { setTypes(ts); setTypeId((cur) => cur ?? ts[0]?.id) })
      .catch(() => {})
  }, [])
  /// ★参会人候选 = 已选关联项目的成员并集★（2026-08-09 用户：「不要从其他项目导入成员，
  /// 直接根据关联成员的并集多选即可」）。原来是「一个搜索框 + 一个『从其它项目导入』下拉」
  /// 两截,既丑又绕:导入是个**批量动作**,却长得像个筛选器。
  /// 现在关联项目一选定,能请的人就自动摆在这儿 —— ★选项目本来就已经回答了「有哪些人」★。
  const projIds: number[] = Form.useWatch('project_ids', form) ?? []
  const projKey = projIds.join(',')          // ← 依赖用字符串,数组每次渲染都是新引用
  const [pool, setPool] = useState<UserOpt[]>([])
  useEffect(() => {
    const ids = projKey ? projKey.split(',').map(Number) : []
    if (!ids.length) { setPool([]); return }
    let dead = false
    Promise.all(ids.map((id) => api<MemberList>(`/api/projects/${id}/members`).catch(() => null)))
      .then((rs) => {
        if (dead) return
        // 并集:同一个人出现在多个项目里只留一次(★项目重叠是常态,不是例外★)
        const seen = new Map<string, string | null | undefined>()
        for (const r of rs) for (const m of r?.members ?? []) if (!seen.has(m.username)) seen.set(m.username, m.name)
        setPool([...seen].map(([username, name]) => ({ username, name: name ?? null })))
      })
    return () => { dead = true }
  }, [projKey])

  /// 参会人下拉的候选:并集 + 我自己(发起人常常也参会,而他未必是成员表里的人)。
  const peopleOpts = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    const push = (u: string, n?: string | null) => {
      if (!u || seen.has(u)) return
      seen.add(u); out.push({ value: u, label: showUser(u, n) })
    }
    if (me?.username) push(me.username, me.name)
    for (const u of pool) push(u.username, u.name)
    return out
  }, [me, pool])

  const cap = types.find((t) => t.id === typeId)
  // ⚠ 类型还没拉回来时**按最严的算**（两样都要）——先松后紧会让人填到一半突然多出必填项。
  const needRecorder = cap?.has_minutes ?? true
  const needProject = cap?.needs_project ?? true

  const submit = async (v: {
    title: string; agenda?: string; recorder: string
    range: [{ toISOString(): string }, { toISOString(): string }]
    project_ids: number[]; participants?: string[]
    location?: string; online_url?: string
  }) => {
    setBusy(true)
    try {
      const r = await api<{ id: number }>('/api/activities', {
        method: 'POST',
        body: JSON.stringify({
          type_id: typeId,
          title: v.title,
          agenda: v.agenda ?? '',
          recorder: needRecorder ? v.recorder : '',
          starts_at: v.range[0].toISOString(),
          ends_at: v.range[1].toISOString(),
          project_ids: needProject ? v.project_ids : [],
          participants: people,
          location: v.location ?? '',
          online_url: v.online_url ?? '',
          visibility: pub ? 'public' : 'private',
        }),
      })
      message.success('活动已创建')
      onCreated(r.id)
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
    <Card title="发起活动" style={{ flex: 1, minWidth: 0 }}
      extra={<Button size="small" onClick={onCancel}>取消</Button>}>
      <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 720 }}
        initialValues={{ recorder: me?.username }}>
        {/* ★类型放在最前★：它决定下面哪些字段出现、哪些必填，放后面会让人先填后改。 */}
        <Form.Item label="活动类型" required>
          <Select
            value={typeId}
            // ⚠★守住 -1★：那是「＋ 新建类型…」这个入口项的哨兵值，不是真类型。
            //   不守的话选它会把 typeId 设成 -1，表单当场废掉（提交必然 400）。
            onChange={(v) => { if (v !== -1) setTypeId(v) }}
            style={{ maxWidth: 260 }}
            // ★下拉里带「＋ 新建类型…」入口★（原型）：想不起来先建类型再回来发起活动，
            // 是很自然的顺序 —— 但**不能在这里直接建**（那要嵌一整套增删改），
            // 所以指向管理页，并明说去哪。
            options={[
              ...types.map((t) => ({
                value: t.id,
                label: t.owner === null ? t.name : `${t.name}（我建的）`,
              })),
              { value: -1, label: '＋ 新建类型…（去「我的活动类型」）', disabled: false },
            ]}
            onSelect={(v) => {
              if (v === -1) {
                message.info('在右上角头像菜单里的「我的活动类型」新建，建完回来即可选到')
              }
            }}
          />
          {/* ★能力位徽章★（原型「新建活动」视图）：选了类型之后，
              「这类活动要不要纪要 / 要不要项目 / 占不占忙闲」必须**一眼看见** ——
              否则用户是靠「下面少了一栏」去猜的。 */}
          {cap && (
            <Space size={4} style={{ marginLeft: 10 }}>
              <Tag color={cap.has_minutes ? 'blue' : undefined}>
                {cap.has_minutes ? '有纪要' : '无纪要'}
              </Tag>
              <Tag color={cap.needs_project ? 'blue' : undefined}>
                {cap.needs_project ? '须关联项目' : '可不关联项目'}
              </Tag>
              <Tag color={cap.busy_default ? 'orange' : undefined}>
                {cap.busy_default ? '占忙闲' : '不占忙闲'}
              </Tag>
            </Space>
          )}
        </Form.Item>
        <Form.Item name="title" label="活动标题" rules={[{ required: true, message: '写个标题' }]}>
          <Input placeholder="如：8 月第二次组会" />
        </Form.Item>

        <Form.Item label="时间" required>
          <Form.Item name="range" noStyle rules={[{ required: true, message: '选时间' }]}>
            {/* ★不让选过去的时间★(2026-08-07 用户):`noPast` 打开日期与时刻两级限制。
                后端另有 5 分钟容差的真闸(activities.rs)。
                粒度、扁平时间列、持续时长快捷都在 time-range.tsx 里,三处共用。 */}
            <TimeRangePicker noPast
              onChange={(v) => setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)} />
          </Form.Item>
        </Form.Item>

        <Form.Item
          name="project_ids" label="关联项目"
          // ★必填与否由类型的 needs_project 决定★（ADR-0002），不再写死
          rules={needProject ? [{ required: true, message: '至少关联一个项目' }] : []}
        >
          {/* ★选完一个就收起下拉、已选的不再出现在候选里★（2026-08-09 用户）。
              多选框默认「选完不关、已选项打个勾留在原地」,于是列表越用越长、
              还要自己去分辨哪几个已经选过 —— 而**这台机器是知道的**。
              想再选就点一下空白处,下拉重新展开(此时列表里只剩没选过的)。
              ⚠ 已选项从 options 里摘掉后,它的中文名靠 rc-select 的 label 缓存显示;
              缓存是它专为「options 变了但已选项还要显示」做的,不是我们在碰运气。 */}
          <Select mode="multiple" placeholder="选一个或多个项目" optionFilterProp="label"
            open={projOpen} onDropdownVisibleChange={setProjOpen} onSelect={() => setProjOpen(false)}
            options={projects.filter((p) => !projIds.includes(p.id)).map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>

        {/* ★不出纪要的类型直接隐藏这一项★（不是只去掉必填）：
            留一个填了也没用的下拉在那儿，比不显示更让人困惑。 */}
        {needRecorder && <Form.Item
          name="recorder" label="记录员"
          rules={needRecorder ? [{ required: true, message: '必须指定记录员' }] : []}
        >
          <Select showSearch placeholder="谁来整理纪要（默认是你自己）" options={userOpts}
            onSearch={search} filterOption={false} notFoundContent="输入用户名或姓名搜索" />
        </Form.Item>}

        {/* ★议题与议程★（原型「新建活动」有这一栏，而代码里一直没有 —— 2026-08-09 并排对照才发现）。
            ⚠ 这不是 M0 弄丢的:提交体里一直写着 `agenda: v.agenda ?? ''`、类型里也声明了,
            **就是没有输入框** —— 于是它永远送空串,后端那一列永远是空。
            ★一个「字段声明了却接不到输入」的洞,类型检查看不见、E2E 也看不见★
            (E2E 自己在 data 里塞 agenda,走的不是表单)。只有对着原型看才照得出来。 */}
        <Form.Item name="agenda" label="议题与议程">
          <Input.TextArea rows={4} placeholder="一行一条" />
        </Form.Item>

        {/* ★参会人挪到右栏★(原型):这里只留一个隐藏字段与 Form 打通,
            真正的选择在右侧「参会人」卡片里 —— 它要和忙闲图并排看。 */}
        <Form.Item name="participants" hidden><Input /></Form.Item>

        <Space size={16} style={{ display: 'flex' }}>
          <Form.Item name="location" label="线下地点" style={{ flex: 1 }}>
            <Input placeholder="如：明德主楼 1016" />
          </Form.Item>
          <Form.Item name="online_url" label="线上链接" style={{ flex: 1 }}>
            <Input placeholder="腾讯活动 / Zoom 链接" />
          </Form.Item>
        </Space>

        {/* ⚠★这里原来有两句说明,2026-08-09 用户点名删掉★:「全平台可见并旁听（仅活动信息）」
            与开关打开后那句「公开的只是活动信息;材料仍然只有关联项目的成员能看」。
            后一句当年是 PRD 专门为「公开」这个词的歧义加的 —— 现在按用户要求去掉,
            **这条歧义的兜底只剩后端**(材料权限一律走项目成员身份,与 visibility 无关)。
            记在这儿,免得下一个人以为是漏写的又给加回来。 */}
        <Form.Item label="公开活动">
          <Switch checked={pub} onChange={setPub} />
        </Form.Item>

        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>创建活动</Button>
          <Button onClick={onCancel}>取消</Button>
        </Space>
      </Form>
    </Card>

    {/* ★右栏:参会人 + 忙闲★(原型 new 视图)。两者必须并排 ——
        选人和看他们忙不忙是**同一个决策**,分开就得来回切。 */}
    <div style={{ width: 420, flexShrink: 0 }}>
      <Card size="small" title={`参会人（${people.length}）`} style={{ marginBottom: 12 }}
        // ★批量请人只留这一颗按钮★:候选本来就是「关联项目成员的并集」,
        // 「全请」就是这张卡片最常见的一次点击(一场组会的参会人往往正好是组里所有人)。
        extra={peopleOpts.length > 0 && (
          <Button type="link" size="small" onClick={() => setPeople(peopleOpts.map((o) => o.value))}>
            全选 {peopleOpts.length} 人
          </Button>
        )}>
        {/* ★候选 = 关联项目成员的并集★(2026-08-09 用户):选完项目,能请谁就已经确定了。
            ★仍然是 tags 模式★ —— 不关联项目的活动类型(needs_project=false)候选是空的,
            那时只能靠手输用户名;去掉 tags 会让这类活动**一个人都请不了**。
            (平台不提供用户搜索接口,手输的真伪由后端 ensure_platform_user 判。) */}
        <Select id="participants-picker" mode="tags" value={people} onChange={setPeople}
          filterOption={(input, opt) => (opt?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          style={{ width: '100%' }} notFoundContent={null}
          placeholder={projIds.length ? '从关联项目成员里选，或直接输用户名' : '先选关联项目，或直接输用户名'}
          options={peopleOpts} />
      </Card>
      <FreeBusyPanel users={people} range={range} />
    </div>
    </div>
  )
}

// ⚠★「从其它项目导入成员」这个控件 2026-08-09 删掉了★(用户:「不要从其他项目导入成员,
// 直接根据关联成员的并集多选即可」)。它做的事现在由**候选列表本身**承担 ——
// 关联项目一选定,那些人就已经在下拉里了,不需要再有一个「导入」动作。
// 它原来批量请人的价值由卡片右上角的「全选 N 人」接手,一次点击,没有丢。

/// 忙闲图(D1 的正面补偿)。
///
/// ★这张图存在的理由★:D1 决定了**私密项目的日程对发起人完全隐形** —— 他排会时看不到别人的私事。
/// 那至少要把「公开项目产生的忙」画出来,让他在**选时间那一刻**就看见冲突,
/// 而不是等对方事后「建议改期」。⚠ 图上空着**不代表真空**(可能是私密安排),
/// 这句必须写在图下面,否则这张图会给人虚假的确定感。
function FreeBusyPanel({ users, range }: { users: string[]; range: [string, string] | null }) {
  const [fb, setFb] = useState<FreeBusy['busy']>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!users.length || !range) { setFb({}); return }
    setLoading(true)
    // 查所选那天的整天忙闲(不只是活动时段)——要看的是「这天他还有什么别的安排」
    const day = new Date(range[0])
    const from = new Date(day); from.setHours(0, 0, 0, 0)
    const to = new Date(day); to.setHours(23, 59, 59, 0)
    api<FreeBusy>(`/api/freebusy?users=${encodeURIComponent(users.join(','))}` +
      `&from=${from.toISOString()}&to=${to.toISOString()}`)
      .then((r) => setFb(r.busy)).catch(() => setFb({})).finally(() => setLoading(false))
  }, [users, range])

  if (!users.length || !range) {
    return (
      <Card size="small" title="忙闲">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          选好时间与参会人后，这里显示他们那天的忙闲。
        </Typography.Text>
      </Card>
    )
  }
  const day = new Date(range[0])
  const pick = { start: range[0], end: range[1] }
  const pickBar = toBar(pick, day)

  return (
    <Card size="small" title="忙闲" extra={loading && <Spin size="small" />}>
      {/* 时间刻度。★最后一个刻度靠右贴齐★:它的位置是 left:100%,
          按 left 定位会整块跑到轨道**外面**去(截图里「20:00」溢出到卡片外)。 */}
      <div style={{ display: 'flex', marginBottom: 4 }}>
        <div style={{ width: 72, flexShrink: 0 }} />
        <div style={{ position: 'relative', flex: 1, height: 14 }}>
          {ticks().map((t, i, arr) => (
            <span key={t.h} style={{
              position: 'absolute', fontSize: 11, color: '#bfbfbf', whiteSpace: 'nowrap',
              ...(i === arr.length - 1 ? { right: 0 } : { left: t.left }),
            }}>{t.h}:00</span>
          ))}
        </div>
      </div>

      {users.map((u) => (
        <div key={u} style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          {/* ★用户名列要能省略★:手输的用户名可以很长,不截断就把轨道挤出卡片。 */}
          <div style={{
            width: 72, flexShrink: 0, fontSize: 12, textAlign: 'right', paddingRight: 8,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }} title={u}>
            {u}
          </div>
          {/* ★轨道自己兜住越界★(2026-08-09 用户「其他人的忙闲超出了边界」):
              toBar 已经把坐标夹在 0–100% 里,这里再加一层 overflow:hidden ——
              坐标算错时宁可**画不全**,也不要糊到卡片外面去。 */}
          <div style={{
            position: 'relative', flex: 1, minWidth: 0, height: 18,
            background: '#fafafa', borderRadius: 3, overflow: 'hidden',
          }}>
            {(fb[u] ?? []).map((sp, i) => {
              const b = toBar(sp, day, pick)
              if (!b) return null
              return <div key={i} style={{
                position: 'absolute', top: 2, height: 14, left: b.left, width: b.width, borderRadius: 2,
                // ★冲突用红、普通忙用灰★:一眼看出「这个人这个点不行」
                background: b.clash ? '#ffa39e' : '#d9d9d9',
              }} />
            })}
            {/* 本次活动时段:青色描边,压在最上层 */}
            {pickBar && <div style={{
              position: 'absolute', top: 0, height: 18, left: pickBar.left, width: pickBar.width,
              border: '1px solid #0d9488', background: 'rgba(13,148,136,.18)', borderRadius: 3,
            }} />}
          </div>
        </div>
      ))}

      <Space size={12} style={{ marginTop: 8, fontSize: 11 }} wrap>
        <span><i style={{ display: 'inline-block', width: 12, height: 8, background: '#d9d9d9' }} /> 忙</span>
        <span><i style={{ display: 'inline-block', width: 12, height: 8, background: '#ffa39e' }} /> 冲突</span>
        <span><i style={{ display: 'inline-block', width: 12, height: 8, background: 'rgba(13,148,136,.18)', border: '1px solid #0d9488' }} /> 本次</span>
      </Space>
      {/* ⚠★2026-08-09 用户点名删掉「只显示 8–20 点。空着不等于一定有空——私密项目的安排不占忙闲」★。
          那句话描述的事实没变:图上空着**仍然**不代表真空(私密项目的安排不进忙闲,D1),
          「建议改期」依旧是这条限制唯一的结构化出口。只是这句话不再写在界面上。 */}
    </Card>
  )
}
