// 发起会议 —— 对应 docs/prototype-m1.html 的 `new` 视图。
//
// ★两个必填项都不是形式★,表单上要把「为什么」说出来,别让人以为是啰嗦的字段:
//   · **关联项目(至少一个)**:材料权限来自项目成员身份(D3),没有项目就没人管得了这场会的材料;
//   · **记录员**:正式纪要由他按固定模板整理,AI 转写只是给他的原材料(D14)。
//
// 参会人用 chips-combobox(输入即过滤、选中清空、★空输入时 Backspace 删最后一个 chip★),
// 与项目成员管理那套一致 —— 同一个交互在两处长得不一样,比丑更糟。
import { App as AntdApp, Button, Card, DatePicker, Form, Input, Select, Space, Spin, Switch, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { api, type FreeBusy, type Me, type Project, type UserOpt } from './api'
import { DAY_END_H, DAY_START_H, ticks, toBar } from './freebusy-layout'

export function MeetingNewView({ me, onCreated, onCancel }: {
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
    api<Project[]>('/api/projects')
      .then((ps) => setProjects(ps.filter((p) => p.my_role === 'editor' || p.my_role === 'admin')))
      .catch(() => setProjects([]))
  }, [])

  /// ★/api/users 是「输入即搜」的接口:不带 q 时返回空数组★(admin.rs user_options)。
  /// 2026-08-07 这里原本不带 q 调一次就把结果当全部候选,于是下拉框永远「暂无数据」——
  /// 而记录员是**必填**,等于根本建不了会议。是用户在真实界面上点出来的。
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

  const submit = async (v: {
    title: string; agenda?: string; recorder: string
    range: [{ toISOString(): string }, { toISOString(): string }]
    project_ids: number[]; participants?: string[]
    location?: string; online_url?: string
  }) => {
    setBusy(true)
    try {
      const r = await api<{ id: number }>('/api/meetings', {
        method: 'POST',
        body: JSON.stringify({
          title: v.title,
          agenda: v.agenda ?? '',
          recorder: v.recorder,
          starts_at: v.range[0].toISOString(),
          ends_at: v.range[1].toISOString(),
          project_ids: v.project_ids,
          participants: people,
          location: v.location ?? '',
          online_url: v.online_url ?? '',
          visibility: pub ? 'public' : 'private',
        }),
      })
      message.success('会议已创建')
      onCreated(r.id)
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
    <Card title="发起会议" style={{ flex: 1, minWidth: 0 }}
      extra={<Button size="small" onClick={onCancel}>取消</Button>}>
      <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 720 }}
        initialValues={{ recorder: me?.username }}>
        <Form.Item name="title" label="会议标题" rules={[{ required: true, message: '写个标题' }]}>
          <Input placeholder="如：8 月第二次组会" />
        </Form.Item>

        <Form.Item name="range" label="时间" rules={[{ required: true, message: '选时间' }]}>
          {/* ★不让选过去的时间★(2026-08-07 用户):日期粒度禁掉今天以前,
              时间粒度在「今天」这一天里禁掉已过去的小时/分钟。后端另有 5 分钟容差的真闸。 */}
          <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }}
            onChange={(v) => setRange(v && v[0] && v[1] ? [v[0].toISOString(), v[1].toISOString()] : null)}
            disabledDate={(d) => !!d && d.isBefore(dayjs().startOf('day'))}
            disabledTime={(d) => {
              if (!d || !d.isSame(dayjs(), 'day')) return {}
              const now = dayjs()
              return {
                disabledHours: () => Array.from({ length: now.hour() }, (_, i) => i),
                disabledMinutes: (h: number) => h === now.hour()
                  ? Array.from({ length: now.minute() }, (_, i) => i) : [],
              }
            }} />
        </Form.Item>

        <Form.Item
          name="project_ids" label="关联项目"
          rules={[{ required: true, message: '至少关联一个项目' }]}
          extra="只列出你有编辑权的项目"
        >
          <Select mode="multiple" placeholder="选一个或多个项目" optionFilterProp="label"
            options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>

        <Form.Item
          name="recorder" label="记录员"
          rules={[{ required: true, message: '必须指定记录员' }]}
          extra="纪要由他按模板整理"
        >
          <Select showSearch placeholder="谁来整理纪要（默认是你自己）" options={userOpts}
            onSearch={search} filterOption={false} notFoundContent="输入用户名或姓名搜索" />
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

        <Form.Item label="公开会议">
          <Space align="start">
            <Switch checked={pub} onChange={setPub} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              全平台可见并旁听（仅会议信息）
            </Typography.Text>
          </Space>
        </Form.Item>
        {pub && (
          // ★这句不能删★:PRD 专门为「公开」这个词的歧义加过一条要求(有人以为资料也跟着公开了)。
          // 但降成一行小字,不用 Alert 那么重。
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
            公开的只是会议信息；<b>材料仍然只有关联项目的成员能看</b>。
          </Typography.Text>
        )}

        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>创建会议</Button>
          <Button onClick={onCancel}>取消</Button>
        </Space>
      </Form>
    </Card>

    {/* ★右栏:参会人 + 忙闲★(原型 new 视图)。两者必须并排 ——
        选人和看他们忙不忙是**同一个决策**,分开就得来回切。 */}
    <div style={{ width: 420, flexShrink: 0 }}>
      <Card size="small" title={`参会人（${people.length}）`} style={{ marginBottom: 12 }}>
        {/* ★id 是给测试用的★:这个 Select 不在 Form 里,拿不到 Form 自动生成的 id,
            而 AntD 的 placeholder 是个被交互层盖住的 <span>、类名又跟着版本变 ——
            E2E 里唯一稳的锚就是我们自己写的 id。**可测性是产品的一部分**,不是测试的私事。 */}
        <Select id="participants-picker" mode="tags" value={people} onChange={setPeople} onSearch={search}
          filterOption={false} style={{ width: '100%' }} notFoundContent={null}
          placeholder="输入用户名（没搜到也能直接输入）" options={userOpts} />
        <Space style={{ marginTop: 8 }} wrap>
          <ImportFromProject projects={projects} onPick={(us) =>
            setPeople((cur) => [...new Set([...cur, ...us])])} />
        </Space>
      </Card>
      <FreeBusyPanel users={people} range={range} />
    </div>
    </div>
  )
}

/// 从其它项目导入成员(原型「从其它项目导入成员」)。
/// ★为什么值得有★:一场会的参会人往往就是某个项目的组员 —— 一个个敲名字既慢又容易漏人。
function ImportFromProject({ projects, onPick }: {
  projects: Project[]; onPick: (usernames: string[]) => void
}) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  return (
    <Select size="small" style={{ width: 220 }} placeholder="从其它项目导入成员" value={null}
      loading={busy} options={projects.map((p) => ({ value: p.id, label: p.name }))}
      onChange={async (pid) => {
        setBusy(true)
        try {
          const r = await api<{ members: { username: string }[] }>(`/api/projects/${pid}/members`)
          const us = r.members.map((m) => m.username)
          onPick(us)
          message.success(`已导入 ${us.length} 人`)
        } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
      }} />
  )
}

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
    // 查所选那天的整天忙闲(不只是会议时段)——要看的是「这天他还有什么别的安排」
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
      {/* 时间刻度 */}
      <div style={{ display: 'flex', marginBottom: 4 }}>
        <div style={{ width: 72, flexShrink: 0 }} />
        <div style={{ position: 'relative', flex: 1, height: 14 }}>
          {ticks().map((t) => (
            <span key={t.h} style={{ position: 'absolute', left: t.left, fontSize: 11, color: '#bfbfbf' }}>
              {t.h}:00
            </span>
          ))}
        </div>
      </div>

      {users.map((u) => (
        <div key={u} style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ width: 72, flexShrink: 0, fontSize: 12, textAlign: 'right', paddingRight: 8, overflow: 'hidden' }}>
            {u}
          </div>
          <div style={{ position: 'relative', flex: 1, height: 18, background: '#fafafa', borderRadius: 3 }}>
            {(fb[u] ?? []).map((sp, i) => {
              const b = toBar(sp, day, pick)
              if (!b) return null
              return <div key={i} style={{
                position: 'absolute', top: 2, height: 14, left: b.left, width: b.width, borderRadius: 2,
                // ★冲突用红、普通忙用灰★:一眼看出「这个人这个点不行」
                background: b.clash ? '#ffa39e' : '#d9d9d9',
              }} />
            })}
            {/* 本次会议时段:青色描边,压在最上层 */}
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
      {/* ★这句不能省★:图上空着不代表真空 */}
      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
        只显示{DAY_START_H}–{DAY_END_H} 点。<b>空着不等于一定有空</b>——私密项目的安排不占忙闲。
      </Typography.Text>
    </Card>
  )
}
