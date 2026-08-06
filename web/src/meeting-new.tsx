// 发起会议 —— 对应 docs/prototype-m1.html 的 `new` 视图。
//
// ★两个必填项都不是形式★,表单上要把「为什么」说出来,别让人以为是啰嗦的字段:
//   · **关联项目(至少一个)**:材料权限来自项目成员身份(D3),没有项目就没人管得了这场会的材料;
//   · **记录员**:正式纪要由他按固定模板整理,AI 转写只是给他的原材料(D14)。
//
// 参会人用 chips-combobox(输入即过滤、选中清空、★空输入时 Backspace 删最后一个 chip★),
// 与项目成员管理那套一致 —— 同一个交互在两处长得不一样,比丑更糟。
import { App as AntdApp, Alert, Button, Card, DatePicker, Form, Input, Select, Space, Switch, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Project, type UserOpt } from './api'

export function MeetingNewView({ onCreated, onCancel }: {
  onCreated: (id: number) => void
  onCancel: () => void
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [projects, setProjects] = useState<Project[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [busy, setBusy] = useState(false)
  const [pub, setPub] = useState(false)

  useEffect(() => {
    // ★只列我能建会的项目★:后端要求每个关联项目 ≥editor,前端先过滤掉 viewer 的,
    // 免得选了才被拒(选项里放一个必然失败的选择 = 引导人犯错)。
    api<Project[]>('/api/projects')
      .then((ps) => setProjects(ps.filter((p) => p.my_role === 'editor' || p.my_role === 'admin')))
      .catch(() => setProjects([]))
    api<UserOpt[]>('/api/users').then(setUsers).catch(() => setUsers([]))
  }, [])

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

  const userOpts = users.map((u) => ({ value: u.username, label: u.name ? `${u.name}（${u.username}）` : u.username }))

  return (
    <Card title="发起会议" extra={<Button size="small" onClick={onCancel}>取消</Button>}>
      <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 720 }}>
        <Form.Item name="title" label="会议标题" rules={[{ required: true, message: '写个标题' }]}>
          <Input placeholder="如：8 月第二次组会" />
        </Form.Item>

        <Form.Item name="range" label="时间" rules={[{ required: true, message: '选时间' }]}>
          <DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          name="project_ids" label="关联项目"
          rules={[{ required: true, message: '至少关联一个项目' }]}
          extra="材料权限来自项目成员身份 —— 没有项目，这场会的材料就没人管得了。只列出你有编辑权的项目。"
        >
          <Select mode="multiple" placeholder="选一个或多个项目" optionFilterProp="label"
            options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>

        <Form.Item
          name="recorder" label="记录员"
          rules={[{ required: true, message: '必须指定记录员' }]}
          extra="正式纪要由记录员按固定模板整理；AI 转写与摘要只是给他的原材料，不是成品。"
        >
          <Select showSearch placeholder="谁来整理纪要" optionFilterProp="label" options={userOpts} />
        </Form.Item>

        <Form.Item name="participants" label="参会人" extra="之后还能再加。临时参会人可以在详情页里单独设。">
          <Select mode="multiple" placeholder="搜用户名或姓名" optionFilterProp="label" options={userOpts} />
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
              打开后，全平台的人都能看到这场会的**标题、议程、时间、地点、链接**并旁听。
            </Typography.Text>
          </Space>
        </Form.Item>
        {pub && (
          // ★「公开」这个词有歧义,必须消歧★:PRD 里专门为此加过一条(有人以为资料也公开了)
          <Alert type="info" showIcon style={{ marginBottom: 16 }}
            message="公开的只是会议信息，不是材料"
            description="旁听的人看得到议程、时间、地点和线上链接，但拿不到任何会议材料 —— 材料始终只有关联项目的成员能看。" />
        )}

        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>创建会议</Button>
          <Button onClick={onCancel}>取消</Button>
        </Space>
      </Form>
    </Card>
  )
}
