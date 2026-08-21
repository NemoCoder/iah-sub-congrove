// 超管后台（2026-08-16，docs/PRD-admin-console.md + docs/TECH-DESIGN-admin-console.md）。
//
// ══ 这一页存在的理由:后端早就有了,一直没有界面 ══
// 用户列表 / 授撤超管 / 调配额 / 全局审计 —— 四个带 require_super 的接口活了很久,
// curl 调得通、审计也记,★却没有任何界面★。也就是说这些权力一直存在,
// 但没有人能在界面上看见自己有它们,「谁是超管」「谁的配额被谁改成了多少」只能进库查。
//
// ⚠★「后台」与「开发者」是两件事★(liaoruili 2026-08-16 选的 Q1):
//   后台 = 改系统,开发者 = 看文档。AI 模型卡片原先住在「开发者」页 ——
//   一个会改全站行为的开关混在 API 文档里,既不好找,也让那个入口名不副实。现在搬过来了。
import {
  Alert, App as AntdApp, AutoComplete, Button, Card, Empty, Input, InputNumber,
  Select, Space, Table, Tabs, Tag, Tooltip, Typography,
} from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, showUserWithAccount, type Me } from './api'
import { fmtSize } from './preview'
import { fmtHM, fmtDay } from './tz'

const GiB = 1024 ** 3

type UserRow = {
  username: string; name: string | null; email: string | null
  is_super: boolean; created_at: string; last_login: string | null
  quota_bytes: number
  /// ★true = 没有 user_quota 行,跟着全站默认走★。
  /// 只看 quota_bytes 的话,「50 GiB 是他自己的还是全站默认正好 50 GiB」分不出来 ——
  /// 而这恰恰决定了改全站默认会不会影响他。
  quota_is_default: boolean
}
type AuditRow = { id: number; ts: string; actor: string; action: string; target: string; detail: string }
type 设置项<T> = { value: T; source: 'db' | 'env' | 'default' }
type Settings = {
  project_creators: 设置项<string[]>
  default_quota_bytes: 设置项<number>
  default_remind_minutes: 设置项<number>
}
type Impact = { following_default: number; would_exceed: number; exceeding: { username: string; used_bytes: number }[] }

/// 「这个值是从哪来的」。★不是调试信息★:超管看到「10 GiB」得知道它是
/// 「有人设成了 10」还是「没人设过,恰好默认是 10」—— 这两种状态在他改 env
/// 或升级版本时表现完全不同。
function 来源标(s: 设置项<unknown>['source']) {
  if (s === 'db') return <Tag color="blue">已设置</Tag>
  if (s === 'env') return <Tooltip title="来自部署时注入的环境变量。在这里改一次,就改成「已设置」、以后不再看环境变量。">
    <Tag color="orange">来自环境变量</Tag></Tooltip>
  return <Tooltip title="没人设过,用的是代码里的默认值"><Tag>默认值</Tag></Tooltip>
}

function 时刻(t: string | null) {
  if (!t) return <Typography.Text type="secondary">—</Typography.Text>
  return <span>{fmtDay(t)} {fmtHM(t)}</span>
}

// ══════════════════════ 用户 ══════════════════════

function 用户表({ me, onChanged }: { me: Me | null; onChanged: () => void }) {
  const { message, modal } = AntdApp.useApp()
  const [rows, setRows] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [kw, setKw] = useState('')
  const load = useCallback(() => {
    setLoading(true)
    api<UserRow[]>('/api/admin/users').then(setRows).catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false))
  }, [message])
  useEffect(load, [load])

  const 超管数 = rows.filter((r) => r.is_super).length

  const 改超管 = (r: UserRow) => {
    const 收回 = r.is_super
    modal.confirm({
      title: 收回 ? `撤掉 ${showUserWithAccount(r.username, r.name)} 的超管?` : `把 ${showUserWithAccount(r.username, r.name)} 设为超管?`,
      // ★两条边界必须**动手之前**说清楚★(PRD §5.1):否则人会以为系统坏了。
      content: 收回 ? (
        <div style={{ fontSize: 13 }}>
          <p>超管能看到所有人的项目与活动、能改别人的配额。</p>
          {/* 这一条最容易被当成 bug:撤销成功、刷新也确实撤了,人走开,第二天他又是超管。 */}
          <p style={{ color: '#d46b08' }}>
            ⚠ 如果他在部署时的<b>超管白名单</b>（环境变量）里，
            <b>撤掉之后他下次登录会自动变回超管</b> —— 那份名单是「种子」，每次登录都会重新播一遍。
            要真正撤掉，得先把他从那份名单里去掉再部署。
          </p>
        </div>
      ) : <p style={{ fontSize: 13 }}>他将能看到<b>所有人</b>的项目与活动，并能改别人的配额。</p>,
      okText: 收回 ? '撤掉' : '设为超管', okButtonProps: { danger: 收回 }, cancelText: '算了',
      onOk: async () => {
        try {
          await api(`/api/admin/users/${encodeURIComponent(r.username)}/super`,
            { method: 'PUT', body: JSON.stringify({ is_super: !收回 }) })
          message.success('已改'); load(); onChanged()
        } catch (e) { message.error((e as Error).message) }
      },
    })
  }

  const 改配额 = (r: UserRow) => {
    let 值 = Math.round((r.quota_bytes / GiB) * 100) / 100
    modal.confirm({
      title: `${showUserWithAccount(r.username, r.name)} 的配额`,
      content: (
        <div style={{ fontSize: 13 }}>
          <p>
            现在：<b>{fmtSize(r.quota_bytes)}</b>
            {r.quota_is_default && <Tag style={{ marginLeft: 6 }}>跟随全站默认</Tag>}
          </p>
          <Space>
            <InputNumber min={0.1} max={1024 * 1024} step={1} defaultValue={值} style={{ width: 160 }}
              onChange={(v) => { 值 = Number(v) || 值 }} addonAfter="GiB" />
          </Space>
          {r.quota_is_default && (
            <p style={{ color: '#8c8c8c', marginTop: 8 }}>
              ⚠ 单独设了之后，他就<b>不再跟随全站默认</b> —— 以后调高全站默认，他不会跟着涨。
              想让他跟回去，用这一行的「恢复为默认」。
            </p>
          )}
        </div>
      ),
      okText: '保存', cancelText: '算了',
      onOk: async () => {
        try {
          await api(`/api/admin/users/${encodeURIComponent(r.username)}/quota`,
            { method: 'PUT', body: JSON.stringify({ quota_bytes: Math.round(值 * GiB) }) })
          message.success('已改'); load()
        } catch (e) { message.error((e as Error).message) }
      },
    })
  }

  const 恢复默认 = (r: UserRow) => modal.confirm({
    title: `让 ${showUserWithAccount(r.username, r.name)} 跟回全站默认?`,
    content: <p style={{ fontSize: 13 }}>他现在单独设着 <b>{fmtSize(r.quota_bytes)}</b>。
      恢复之后，他的额度就跟着「治理 → 全站默认配额」走，那里改他也跟着变。</p>,
    okText: '恢复为默认', cancelText: '算了',
    onOk: async () => {
      try {
        await api(`/api/admin/users/${encodeURIComponent(r.username)}/quota`, { method: 'DELETE' })
        message.success('已恢复'); load()
      } catch (e) { message.error((e as Error).message) }
    },
  })

  const 过滤后 = useMemo(() => {
    const q = kw.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.username.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q)
      || (r.email ?? '').toLowerCase().includes(q))
  }, [rows, kw])

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        {/* ★只在**已加载的**行里过滤,不打接口★(PRD 非目标):
            这一页列的是全体登录过的用户,超管看得见是应当的;但别把它做成一个
            能被复用的用户搜索接口 —— 前缀搜索 = 目录枚举(2026-08-07 平台侧拍过板)。 */}
        <Input.Search allowClear placeholder="在这一页里找…" style={{ width: 280 }}
          value={kw} onChange={(e) => setKw(e.target.value)} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {rows.length} 人，其中超管 {超管数} 人
        </Typography.Text>
      </Space>
      <Table<UserRow> size="small" rowKey="username" dataSource={过滤后} loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的用户" /> }}
        columns={[
          { title: '用户', dataIndex: 'username', width: 220,
            render: (_: unknown, r) => (
              <Space size={6}>
                <span>{showUserWithAccount(r.username, r.name)}</span>
                {r.username === me?.username && <Tag color="cyan">我</Tag>}
                {r.is_super && <Tag color="purple">超管</Tag>}
              </Space>
            ) },
          { title: '邮箱', dataIndex: 'email', ellipsis: true,
            render: (v: string | null) => v || <Typography.Text type="secondary">—</Typography.Text> },
          { title: '配额', width: 170,
            render: (_: unknown, r) => (
              <Space size={4}>
                <span>{fmtSize(r.quota_bytes)}</span>
                {/* ★「（默认）」这三个字是这一列的重点★:没有它,「改全站默认会影响谁」
                    这个问题在界面上根本无法回答。 */}
                {r.quota_is_default && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（默认）</Typography.Text>}
              </Space>
            ) },
          { title: '最近登录', width: 150, render: (_: unknown, r) => 时刻(r.last_login) },
          { title: '操作', width: 230, render: (_: unknown, r) => (
            <Space size={4} wrap>
              <Button size="small" onClick={() => 改配额(r)}>改配额</Button>
              {/* 单独设过才给「恢复为默认」——本来就跟随默认的人,这个按钮没有意义 */}
              {!r.quota_is_default && <Button size="small" onClick={() => 恢复默认(r)}>恢复为默认</Button>}
              {/* ★「不能撤掉最后一个超管」要在**按下之前**说★,别让人撞了 400 才知道 */}
              <Tooltip title={r.is_super && 超管数 <= 1 ? '这是最后一个超管，撤了就没人能进后台了' : ''}>
                <Button size="small" danger={r.is_super} disabled={r.is_super && 超管数 <= 1}
                  onClick={() => 改超管(r)}>{r.is_super ? '撤超管' : '设超管'}</Button>
              </Tooltip>
            </Space>
          ) },
        ]} />
    </>
  )
}

// ══════════════════════ 审计 ══════════════════════

function 审计表() {
  const { message } = AntdApp.useApp()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [limit, setLimit] = useState(200)
  const [kw, setKw] = useState('')
  useEffect(() => {
    setLoading(true)
    api<AuditRow[]>(`/api/admin/audit?limit=${limit}`).then(setRows)
      .catch((e) => message.error((e as Error).message)).finally(() => setLoading(false))
  }, [limit, message])
  const 过滤后 = useMemo(() => {
    const q = kw.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.actor, r.action, r.target, r.detail].some((s) => (s ?? '').toLowerCase().includes(q)))
  }, [rows, kw])
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        {/* ★这个搜索框只过滤已经拉回来的这 N 条,不打接口★(Q5:这轮不做后端筛选)。
            所以文案必须说清「在最近 N 条里找」,否则搜不到的人会以为是系统没记 ——
            那是把「我没查那么远」误报成「没有这件事」。 */}
        <Input.Search allowClear placeholder={`在最近 ${limit} 条里找…`} style={{ width: 280 }}
          value={kw} onChange={(e) => setKw(e.target.value)} />
        {/* ★用 Select 不用 AutoComplete★(2026-08-16 看截图看出来的):
            AutoComplete 画在框里的是 **value**,于是这里显示的是光秃秃的「200」——
            一个没有单位、没有说明的数字。★这和 chip 画成裸 id 是同一类问题★:
            控件把内部表示直接端给人看。候选是固定四档、不需要手输 ⇒ 本来就该是 Select。 */}
        <Select value={limit} style={{ width: 140 }}
          options={[200, 500, 1000, 2000].map((n) => ({ value: n, label: `最近 ${n} 条` }))}
          onChange={(v) => setLimit(v)} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          显示 {过滤后.length} / 已拉取 {rows.length} 条
        </Typography.Text>
      </Space>
      <Table<AuditRow> size="small" rowKey="id" dataSource={过滤后} loading={loading}
        pagination={{ pageSize: 25, hideOnSinglePage: true, showSizeChanger: false }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的记录" /> }}
        columns={[
          { title: '时间', width: 160, render: (_: unknown, r) => 时刻(r.ts) },
          { title: '操作人', dataIndex: 'actor', width: 140 },
          { title: '动作', dataIndex: 'action', width: 180, render: (v: string) => <code>{v}</code> },
          { title: '对象', dataIndex: 'target', width: 180, ellipsis: true },
          { title: '详情', dataIndex: 'detail', ellipsis: true },
        ]} />
    </>
  )
}

// ══════════════════════ 治理 ══════════════════════

function 治理({ users }: { users: UserRow[] }) {
  const { message, modal } = AntdApp.useApp()
  const [s, setS] = useState<Settings | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const load = useCallback(() => {
    api<Settings>('/api/admin/settings').then(setS).catch((e) => message.error((e as Error).message))
  }, [message])
  useEffect(load, [load])

  const 存 = async (key: string, value: string) => {
    setSaving(key)
    try { await api(`/api/admin/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) })
      message.success('已保存'); load()
    } catch (e) { message.error((e as Error).message) } finally { setSaving(null) }
  }

  // ── 建项目白名单 ──
  const [名单, set名单] = useState<string[]>([])
  useEffect(() => { if (s) set名单(s.project_creators.value) }, [s])

  // ── 全站默认配额 ──
  const [配额GiB, set配额] = useState<number>(10)
  useEffect(() => { if (s) set配额(Math.round((s.default_quota_bytes.value / GiB) * 100) / 100) }, [s])

  /// ★改全站默认配额之前,先把影响面算出来给人看★。
  /// 这不是礼貌提示:没有它,这个输入框就是一个**无法预估后果**的按钮 ——
  /// 保存之后有人立刻传不了东西,而按下去的人完全不知道自己做了这件事。
  const 保存配额 = async () => {
    const bytes = Math.round(配额GiB * GiB)
    let imp: Impact | null = null
    try { imp = await api<Impact>(`/api/admin/settings/default-quota/impact?bytes=${bytes}`) }
    catch { /* 算不出来就不拦着改,但下面会如实说「算不出影响面」 */ }
    modal.confirm({
      title: '改全站默认配额',
      width: 520,
      content: (
        <div style={{ fontSize: 13 }}>
          <p><b>{fmtSize(s?.default_quota_bytes.value ?? 0)}</b> → <b>{fmtSize(bytes)}</b></p>
          {imp ? (
            <>
              <p>当前 <b>{imp.following_default}</b> 人没单独设过配额，
                改完他们的额度<b>立刻</b>变成 {fmtSize(bytes)}。</p>
              {imp.would_exceed > 0 && (
                <Alert type="error" showIcon style={{ marginTop: 8 }}
                  message={`其中 ${imp.would_exceed} 人已用超过这个数`}
                  description={<div>
                    保存后他们<b>立刻超额、传不了东西</b>，而且不会收到任何通知。
                    <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 12 }}>
                      {imp.exceeding.slice(0, 8).map((x) => (
                        <div key={x.username}>{x.username} —— 已用 {fmtSize(x.used_bytes)}</div>
                      ))}
                      {imp.would_exceed > 8 && <div>…… 还有 {imp.would_exceed - 8} 人</div>}
                    </div>
                  </div>} />
              )}
            </>
          ) : <Alert type="warning" showIcon message="算不出影响面（接口没回）——不知道会影响多少人，谨慎保存。" />}
          <p style={{ color: '#8c8c8c', marginTop: 8 }}>
            单独设过配额的人<b>不受这次改动影响</b>。要让某个人不跟随，去「用户」tab 单独给他配一个。
          </p>
        </div>
      ),
      okText: imp && imp.would_exceed > 0 ? '我知道，仍然保存' : '保存',
      okButtonProps: { danger: !!imp && imp.would_exceed > 0 },
      cancelText: '算了',
      onOk: () => 存('default_quota_bytes', String(bytes)),
    })
  }

  // ── 全站默认提醒提前量 ──
  const [提前量, set提前量] = useState<number>(15)
  useEffect(() => { if (s) set提前量(s.default_remind_minutes.value) }, [s])

  if (!s) return <Card loading />

  const 名单变了 = 名单.join(',') !== s.project_creators.value.join(',')

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" title={<Space>谁能建项目 {来源标(s.project_creators.source)}</Space>}>
        {/* ★从用户列表里勾,不给自由文本★(liaoruili 2026-08-16 的 Q2):
            手输用户名会打错,而打错的后果是「这个人从此建不了项目」,并且
            ★没有任何地方会报错★ —— 白名单是字符串比对,名字对不上就是不在名单里。
            安静地错,还要等那个人某天想建项目才暴露。 */}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {名单.length === 0
            ? <>现在是 <b>【人人可建】</b>。勾上任何一个人，就变成<b>只有名单内的人 + 超管</b>能建项目。</>
            : <>现在<b>只有名单内的 {名单.length} 人 + 超管</b>能建项目。全部取消勾选 = 改回<b>人人可建</b>。</>}
        </Typography.Paragraph>
        <Table<UserRow> size="small" rowKey="username" dataSource={users} pagination={{ pageSize: 8, showSizeChanger: false }}
          rowSelection={{ selectedRowKeys: 名单, onChange: (k) => set名单(k as string[]), preserveSelectedRowKeys: true }}
          columns={[
            { title: '用户', render: (_: unknown, r) => (
              <Space size={6}>{showUserWithAccount(r.username, r.name)}{r.is_super && <Tag color="purple">超管</Tag>}</Space>) },
          ]} />
        <Space style={{ marginTop: 8 }}>
          <Button type="primary" disabled={!名单变了} loading={saving === 'project_creators'}
            onClick={() => 存('project_creators', 名单.join(','))}>保存</Button>
          {名单变了 && <Button size="small" onClick={() => set名单(s.project_creators.value)}>撤销改动</Button>}
        </Space>
      </Card>

      <Card size="small" title={<Space>全站默认配额 {来源标(s.default_quota_bytes.source)}</Space>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {/* ★这句是 2026-08-16 那次答错的更正★:它不是「新用户默认」。 */}
          没有单独设过配额的人，用的就是这个数。<b>改它会立刻改变他们所有人</b>（不只是以后的新用户）。
        </Typography.Paragraph>
        <Space wrap>
          <InputNumber min={0.1} max={1024 * 1024} step={1} value={配额GiB} onChange={(v) => set配额(Number(v) || 0)}
            style={{ width: 160 }} addonAfter="GiB" />
          <Button type="primary" loading={saving === 'default_quota_bytes'}
            disabled={Math.round(配额GiB * GiB) === s.default_quota_bytes.value}
            onClick={保存配额}>保存…</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前 <b>{fmtSize(s.default_quota_bytes.value)}</b>
            {' · '}{users.filter((u) => u.quota_is_default).length} / {users.length} 人跟随它
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title={<Space>全站默认提醒提前量 {来源标(s.default_remind_minutes.source)}</Space>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          活动开始前多久发提醒。<b>个人设置和单场活动都可以覆盖它</b> —— 这只是都没设时的兜底。
        </Typography.Paragraph>
        <Space wrap>
          <InputNumber min={1} max={10080} step={5} value={提前量} onChange={(v) => set提前量(Number(v) || 0)}
            style={{ width: 150 }} addonAfter="分钟" />
          <Button type="primary" loading={saving === 'default_remind_minutes'}
            disabled={提前量 === s.default_remind_minutes.value}
            onClick={() => 存('default_remind_minutes', String(提前量))}>保存</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前 <b>{s.default_remind_minutes.value}</b> 分钟</Typography.Text>
        </Space>
      </Card>
    </Space>
  )
}

// ══════════════════════ AI 模型（从「开发者」页搬来） ══════════════════════

/// ★AI 模型:超管在这里选★(2026-08-16 热修加的,同日从「开发者」页搬到后台)。
///
/// 起因是 prod 上的真实故障:平台换了模型,congrove 还在调 `Qwen3.6-35B-A3B`,
/// 于是 `LLM 返回 403:无权调用模型` —— ★纪要功能整个哑掉,而这边没有任何自助恢复的办法★,
/// 只能等人去改平台的环境变量再重启。配置项该由超管在界面上选。
///
/// ⚠★用 AutoComplete 而不是 Select★:网关的 `/v1/models` **只列常驻模型**,
///   按需(scale-to-zero)的模型不在列表里、但**能调**。只给下拉等于把按需模型全挡了 ——
///   所以列表只是**建议**,手输的名字一律接受。
function AI模型() {
  const { message } = AntdApp.useApp()
  const [cur, setCur] = useState('')
  const [val, setVal] = useState('')
  const [opts, setOpts] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    api<{ current: string; models: string[]; error?: string }>('/api/admin/llm/models')
      .then((d) => { setCur(d.current); setVal(d.current); setOpts(d.models || []); setErr(d.error ?? null) })
      .catch((e) => setErr((e as Error).message))
  }, [])
  useEffect(load, [load])
  return (
    <Card size="small" title="生成纪要 / 摘要用的模型">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        <b>平台换过模型之后，这里改一下即可</b>，不用改环境变量、也不用重启。
        {/* 这句不是废话:它解释了为什么列表可能不全,免得有人以为列表坏了 */}
        <br />下拉里是网关<b>当前常驻</b>的模型；<b>按需模型不在列表里但可以直接输入</b>。
      </Typography.Paragraph>
      {err && <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message={`列不出可用模型:${err}`} description="不影响保存 —— 你仍然可以直接输入模型名。" />}
      <Space wrap>
        <AutoComplete style={{ width: 340 }} value={val} onChange={setVal}
          options={opts.map((m) => ({ value: m }))} placeholder="模型名，如 Qwen3.6-35B-A3B"
          filterOption={(i, o) => String(o?.value ?? '').toLowerCase().includes(i.toLowerCase())} />
        <Button type="primary" loading={saving} disabled={!val.trim() || val.trim() === cur}
          onClick={async () => {
            setSaving(true)
            try {
              await api('/api/admin/llm/model', { method: 'PUT', body: JSON.stringify({ model: val.trim() }) })
              message.success('已保存，下一次生成纪要就用它'); load()
            } catch (e) { message.error((e as Error).message) } finally { setSaving(false) }
          }}>保存</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前：<b>{cur || '（未设置，用默认）'}</b></Typography.Text>
      </Space>
    </Card>
  )
}

// ══════════════════════ 页面 ══════════════════════

export function AdminView({ me }: { me: Me | null }) {
  const { message } = AntdApp.useApp()
  /// 403 = 我有超管资格但**超管模式没开**(docs/TECH-DESIGN-admin-mode.md)。
  /// ★入口留着、点了给提示★是 2026-08-09 liaoruili 定的:
  /// 直接把菜单项藏掉会让人以为超管被撤了,而一个空白页更难懂。
  const [denied, setDenied] = useState(false)
  const [users, setUsers] = useState<UserRow[]>([])
  const [tab, setTab] = useState('users')
  const 拉用户 = useCallback(() => {
    api<UserRow[]>('/api/admin/users')
      .then((r) => { setUsers(r); setDenied(false) })
      .catch((e) => {
        const m = (e as Error).message
        if (m.includes('forbidden') || m.includes('403')) setDenied(true)
      })
  }, [])
  useEffect(拉用户, [拉用户])

  if (denied) return (
    <Card>
      <Alert type="warning" showIcon
        message="这一页要超管权限，而你的超管模式没开着"
        description="超管模式平时是关的——那样你在系统里就是个普通用户，看不到别人的项目与活动。开一下就能进，2 小时后自动关。"
        action={<Button type="primary" size="small" onClick={async () => {
          try { await api('/api/me/admin-mode', { method: 'POST', body: JSON.stringify({ on: true }) }); window.location.reload() }
          catch (e) { message.error((e as Error).message) }
        }}>进入超管模式</Button>} />
    </Card>
  )

  return (
    <Card title={<Space><span>后台</span><Tag color="purple">超管</Tag></Space>}
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
        改动都会记进审计日志
      </Typography.Text>}>
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'users', label: '用户', children: <用户表 me={me} onChanged={拉用户} /> },
        { key: 'audit', label: '审计日志', children: <审计表 /> },
        { key: 'gov', label: '治理', children: <治理 users={users} /> },
        { key: 'llm', label: 'AI 模型', children: <AI模型 /> },
      ]} />
    </Card>
  )
}
