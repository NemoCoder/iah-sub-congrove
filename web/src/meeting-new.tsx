// 发起会议 —— 对应 docs/prototype-m1.html 的 `new` 视图。
//
// ★两个必填项都不是形式★,表单上要把「为什么」说出来,别让人以为是啰嗦的字段:
//   · **关联项目(至少一个)**:材料权限来自项目成员身份(D3),没有项目就没人管得了这场会的材料;
//   · **记录员**:正式纪要由他按固定模板整理,AI 转写只是给他的原材料(D14)。
//
// 参会人用 chips-combobox(输入即过滤、选中清空、★空输入时 Backspace 删最后一个 chip★),
// 与项目成员管理那套一致 —— 同一个交互在两处长得不一样,比丑更糟。
import { App as AntdApp, Button, Card, DatePicker, Form, Input, Select, Space, Switch, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { api, type Me, type Project, type UserOpt } from './api'

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
          participants: v.participants ?? [],
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
    <Card title="发起会议" extra={<Button size="small" onClick={onCancel}>取消</Button>}>
      <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 720 }}
        initialValues={{ recorder: me?.username }}>
        <Form.Item name="title" label="会议标题" rules={[{ required: true, message: '写个标题' }]}>
          <Input placeholder="如：8 月第二次组会" />
        </Form.Item>

        <Form.Item name="range" label="时间" rules={[{ required: true, message: '选时间' }]}>
          {/* ★不让选过去的时间★(2026-08-07 用户):日期粒度禁掉今天以前,
              时间粒度在「今天」这一天里禁掉已过去的小时/分钟。后端另有 5 分钟容差的真闸。 */}
          <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }}
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

        <Form.Item name="participants" label="参会人" extra="之后还能再加">
          <Select mode="tags" showSearch placeholder="输入用户名（没搜到也能直接输入）" options={userOpts}
            onSearch={search} filterOption={false} notFoundContent={null} />
        </Form.Item>

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
  )
}
