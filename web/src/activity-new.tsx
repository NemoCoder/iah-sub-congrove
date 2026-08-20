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
import { api, isMaterials, showUserWithAccount, type ActivityType, type FreeBusy, type Me, type MemberList, type Project, type UserOpt } from './api'
import { ticks, toBar } from './freebusy-layout'
import { RemindSelect } from './remind-poll'
import { myTz, pickedToUtc, TZ_OPTIONS } from './tz'
import { TimeRangePicker } from './time-range'


export function ActivityNewView({ me, onCreated, onCancel, prefillProjectId }: {
  me: Me | null
  onCreated: (id: number) => void
  onCancel: () => void
  /// ★从项目页「发起活动」带过来的项目,预填进「关联项目」★
  /// (2026-08-16 liaoruili:「点进具体的项目,增加发起活动的功能,自动关联该项目」)。
  /// ⚠ 只是**初值**:人可以在表单里删掉它、也可以再加别的项目 ——
  ///   一场活动本来就能关联多个项目(D6),预填不该变成锁定。
  prefillProjectId?: number | null
}) {
  const { message, modal } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [projects, setProjects] = useState<Project[]>([])
  const [found, setFound] = useState<UserOpt[]>([])
  const [busy, setBusy] = useState(false)
  const [pub, setPub] = useState(false)
  /// 单场提醒（PRD F3）。★初值 null = 跟随个人默认★，不是「不提醒」——
  /// 大多数人不会动这一项，默认必须是「照我平时的习惯办」。
  const [remind, setRemind] = useState<number | null>(null)
  /// ★这场活动的时区★（PRD E1）。默认取 `myTz()` —— liaoruili 2026-08-12 拍板
  /// 「没设过时区的人跟随浏览器」：E0 已经定了「不设默认北京」，这里再默认北京就自相矛盾。
  /// ⚠ 它不是「谁建的会他在哪」，是★这个时间按哪儿的钟说的★：
  ///   「我在纽约给北京的组会排 15:00」——指的是北京时间 15:00。
  const [tz, setTz] = useState<string>(() => myTz())
  const [projOpen, setProjOpen] = useState(false)
  /// ★参会人与时间提到组件级★:右栏的 chips 与忙闲图都要用它们,
  /// 留在 Form 内部的话右栏读不到(原型就是左表单/右面板并排)。
  const [people, setPeople] = useState<string[]>([])
  const [range, setRange] = useState<[string, string] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /// 当前输入的关键词。★候选只覆盖登录过汇流的人★(/api/users 查本地 app_user),
  /// 而后端能拉任何平台用户 —— 所以搜不到时要允许直接用输入的用户名。
  /// ⚠★2026-08-15 起 /api/users 更窄了★:陌生人**只认完整用户名**(精确等值),
  ///   只有与我共过项目的人才能按前缀/姓名搜(liaoruili 拍板,防目录枚举)。
  ///   ⇒ 「搜不到也能直接输入」这条从**便利**升级成了**必需**:约一个没共过项目的人,
  ///     除非你正好输全了他的账号,否则下拉里一条候选都不会有。别把这条兜底去掉。
  const [typed, setTyped] = useState('')

  useEffect(() => {
    // ★只列我能建会的项目★:后端要求每个关联项目 ≥editor,前端先过滤掉 viewer 的,
    // 免得选了才被拒(选项里放一个必然失败的选择 = 引导人犯错)。
    // ★「我的活动材料」不进这个下拉★(PRD §J1):它是个人存档区不是协作项目。
    // 后端也拒(材料区在 require_role 上全只读,关联项目要 ≥editor),这里只是别引导人去点。
    api<Project[]>('/api/projects')
      .then((ps) => {
        const 可选 = ps.filter((p) => !isMaterials(p) && (p.my_role === 'editor' || p.my_role === 'admin'))
        setProjects(可选)
        // ★预填要连 label 一起给★(2026-08-16,真浏览器里看出来的,详见下面 Select 的注释):
        //   只塞 id 的话,chip 上画出来的是**「1 ×」**这个裸数字 —— 见过一眼就忘不了。
        // ★预填的项目必须真在「我能建会的项目」里★ —— 万一它不在(角色刚被降成 viewer、
        //   或项目刚归档),预填就是**给人一个必然被后端拒的初值**,而人多半不会去看那一栏。
        //   宁可留空让必填校验拦住他。
        const 预填 = prefillProjectId != null ? 可选.find((p) => p.id === prefillProjectId) : undefined
        if (预填) form.setFieldValue('project_ids', [{ value: 预填.id, label: 预填.name }])
      })
      .catch(() => setProjects([]))
  }, [prefillProjectId, form])

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
    // ★显示名等于用户名时会拼重★(2026-08-15 巡检截图看出来的):原来是
    //   `push(me.username, me.name ? `${me.name}· 我` : '我')` —— 于是 name === username 的人
    //   (liaoruili 就是)得到 n = 「liaoruili· 我」,而 `n !== u` 成立,
    //   最终拼成 ★「liaoruili· 我（liaoruili）」★,用户名出现两遍。
    //   本意是「张三· 我（zhangsan）」;所以判据该看 **name 和 username 一不一样**,而不是 name 有没有。
    if (me?.username) {
      const 别名 = me.name && me.name !== me.username ? me.name : null
      out.push({ value: me.username, label: 别名 ? `${别名}· 我（${me.username}）` : `${me.username}· 我` })
      seen.add(me.username)
    }
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
  /// ⚠★这一栏是 `labelInValue`,表单里存的是 `{value,label}` 不是裸 id★(2026-08-16,理由见 Select 的注释)。
  ///   所以凡是要拿 id 的地方都得 `.value` —— 下面三处(projKey / 提交 / options 过滤)都改过了。
  const projSel: { value: number; label?: React.ReactNode }[] = Form.useWatch('project_ids', form) ?? []
  const projIds: number[] = projSel.map((x) => x.value)
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
      seen.add(u); out.push({ value: u, label: showUserWithAccount(u, n) })
    }
    if (me?.username) push(me.username, me.name)
    for (const u of pool) push(u.username, u.name)
    return out
  }, [me, pool])

  const cap = types.find((t) => t.id === typeId)
  // ⚠ 类型还没拉回来时**按最严的算**（两样都要）——先松后紧会让人填到一半突然多出必填项。
  const needRecorder = cap?.has_minutes ?? true
  const needProject = cap?.needs_project ?? true
  /// ★能不能补录,跟着类型走★(F0/F1)。缺省 false = 按最严的「会议」算 ——
  /// 类型还没加载出来时不该先把闸放开(后端也会再判一次)。
  const allowPast = cap?.allow_past ?? false

  const submit = async (v: {
    title: string; agenda?: string; recorder: string
    range: [{ toISOString(): string }, { toISOString(): string }]
    // ★labelInValue★:表单里是 `{value,label}`,发给后端前要摘出 id(见下面 Select 的注释)
    project_ids: { value: number }[]; participants?: string[]
    location?: string; online_url?: string
  }) => {
    // ★补录超过 7 天要确认一次★(PRD F1,liaoruili 定的阈值)。
    // 想补多久以前的都行 —— 这是自己的记录不是报销;但**输错月份**比输错年份常见得多
    // (8 月 8 日打成次年 3 月 1 日),而一周之内的补录才是常态,跨过一周就值得停下来看一眼日期。
    const start = pickedToUtc(new Date(v.range[0].toISOString()), tz)
    if (allowPast && start.getTime() < Date.now() - 7 * 864e5) {
      const ok = await new Promise<boolean>((res) => modal.confirm({
        title: '确认这个日期吗？',
        content: `这条活动排在 ${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日，已经过去 ${Math.floor((Date.now() - start.getTime()) / 864e5)} 天了。`,
        okText: '就是这天', cancelText: '我改一下',
        onOk: () => res(true), onCancel: () => res(false),
      }))
      if (!ok) return
    }
    setBusy(true)
    try {
      const r = await api<{ id: number }>('/api/activities', {
        method: 'POST',
        body: JSON.stringify({
          type_id: typeId,
          title: v.title,
          agenda: v.agenda ?? '',
          recorder: needRecorder ? v.recorder : '',
          // ★不是 .toISOString()★:那是按**浏览器**解释墙上时间(见 tz.ts::pickedToUtc 头注)
          starts_at: pickedToUtc(new Date(v.range[0].toISOString()), tz).toISOString(),
          ends_at: pickedToUtc(new Date(v.range[1].toISOString()), tz).toISOString(),
          timezone: tz,
          // ★摘 id★:labelInValue 让表单里存的是 {value,label},后端要的是裸 id 数组
          project_ids: needProject ? (v.project_ids ?? []).map((x) => x.value) : [],
          participants: people,
          location: v.location ?? '',
          online_url: v.online_url ?? '',
          visibility: pub ? 'public' : 'private',
          remind_minutes: remind,
        }),
      })
      message.success('活动已创建')
      onCreated(r.id)
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
    {/* ⚠★这里曾经还有一个 `extra={<Button>取消</Button>}`★(2026-08-12 删):
        整页同时有两个「取消」——页头一个、表单底一个,点下去做的是同一件事。
        留底下那个:它和「创建活动」成对,是表单的通用摆法;而页头这个还容易被读成
        「取消这场活动」(详情页真有这么个按钮,见 activity-detail.tsx),语义撞车。
        误伤检查过:发起活动是**整页视图不是弹窗**,离开的路不止这一条 ——
        顶部导航(日程/项目/活动)一直在,不会把人关在表单里出不去。 */}
    <Card title="发起活动" style={{ flex: 1, minWidth: 0 }}>
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
              {/* ★第四条能力位原来漏在这儿★(2026-08-15 巡检截图看出来的):
                  「我的活动类型」页给会议标着 `只能排未来`,而这排徽标只有三个。
                  这排徽标存在的理由就是让人**一眼看见这个类型的规矩**(见上面那段注释),
                  漏掉它的后果是:下面的日期选择器把过去**禁灰了**(`noPast={!allowPast}`),
                  ★而屏幕上没有任何一处说明为什么★ —— 又一个「禁用但不给理由」。
                  ⚠ 这条不是「点了会报错」:后端确有闸,但界面早就挡住了;
                    坏的是**人不知道自己撞到了什么规矩**。 */}
              {!cap.allow_past && <Tag color="orange">只能排未来</Tag>}
            </Space>
          )}
        </Form.Item>
        <Form.Item name="title" label="活动标题" rules={[{ required: true, message: '写个标题' }]}>
          <Input placeholder="如：8 月第二次组会" />
        </Form.Item>

        <Form.Item label="时间" required>
          <Form.Item name="range" noStyle rules={[{ required: true, message: '选时间' }]}>
            {/* ★能不能选过去,跟着类型的 allow_past 走★(F0/F1,2026-08-09 liaoruili:
                「会议类型的活动只能发起未来的会议,其他类型可以后面补录」)。
                在此之前这里写死 `noPast` —— 于是「昨天下午改论文改了 3 小时」这种正当的补录
                在界面上根本选不了日期。后端有真闸(activity_types.rs 的 check_past,带 5 分钟容差)。
                粒度、扁平时间列、持续时长快捷都在 time-range.tsx 里,三处共用。 */}
            <TimeRangePicker noPast={!allowPast} roundStart={!!cap?.busy_default}
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

              ══ ★2026-08-16:这套设计有个只对「人手点」成立的隐含前提★ ══
              这里原来的注释写着「已选项从 options 里摘掉后,中文名靠 rc-select 的 label 缓存显示;
              缓存是它专为『options 变了但已选项还要显示』做的,**不是我们在碰运气**」。
              这句话当时是对的 —— 但它成立的条件是**值是被人点进来的**。

              加了项目页「发起活动」的预填(`form.setFieldValue`)之后,第一次在真浏览器里
              看截图,chip 上画的是★「1 ×」★—— 项目 id 的裸数字。
              读 `@rc-component/select` 的 `useCache` 源码才明白:
                · 缓存只对**当前已选中**的值刷新,而 label 来自「此刻能在 options 里查到它」;
                · 而这个 filter 保证了★一旦选中就从 options 里消失★
                  ⇒ 不存在「既选中、又在 options 里」的那一帧,缓存**永远收不到**这一条;
                · 人手点选之所以有名字,是因为 onChange 直接带着被点那个 option 的 label,
                  跟 options 里还有没有它无关。
              ⇒ 结构上,**任何程序化赋值**都拿不到名字。这不是时机问题 ——
                我一开始以为是,还把预填挪到「项目列表加载完之后」并在注释里写下这个理由,
                ★那条注释是错的,而且它错得很安静★(界面照常渲染,只是画了个数字)。

              ⇒ 改成 `labelInValue`:★让 label 跟着值一起走,彻底不依赖那个缓存★。
              代价是表单里存的变成 `{value,label}`,取 id 的三处都要 `.value`(已改)。
              ⚠ 别为了「少改两行」退回去只塞 id —— 那等于把这个坑原样留给下一个预填场景。 */}
          <Select mode="multiple" labelInValue placeholder="选一个或多个项目" optionFilterProp="label"
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
            onSearch={search} filterOption={false} notFoundContent="同项目的人可搜姓名；其他人请输完整用户名" />
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
            <Input placeholder="腾讯会议 / Zoom 链接" />
          </Form.Item>
        </Space>

        {/* ⚠★这里原来有两句说明,2026-08-09 用户点名删掉★:「全平台可见并旁听（仅活动信息）」
            与开关打开后那句「公开的只是活动信息;材料仍然只有关联项目的成员能看」。
            后一句当年是 PRD 专门为「公开」这个词的歧义加的 —— 现在按用户要求去掉,
            **这条歧义的兜底只剩后端**(材料权限一律走项目成员身份,与 visibility 无关)。
            记在这儿,免得下一个人以为是漏写的又给加回来。 */}
        {/* ★紧跟「时间」★:它是时间的**修饰**,不是独立的一件事 ——
            隔开放会让人填完时间就走,回头才发现时区不对。 */}
        <Form.Item label="时区">
          <Select size="middle" style={{ width: 260 }} value={tz} onChange={setTz}
            showSearch optionFilterProp="label" options={TZ_OPTIONS} />
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            上面填的时间按这里的钟算
          </Typography.Text>
        </Form.Item>

        {/* ★放在「公开活动」之前★：提醒是发起每一场都会瞄一眼的东西，
            而公开与否偶尔才改。表单顺序应当按**看它的频率**排，不是按实现顺序。 */}
        <Form.Item label="提醒我">
          <RemindSelect value={remind} onChange={setRemind} size="middle" style={{ width: 200 }} />
        </Form.Item>

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
