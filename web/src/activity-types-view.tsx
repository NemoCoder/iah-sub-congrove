/// 「我的活动类型」管理页（ADR-0002 / 原型 `4-我的活动类型`）。
///
/// ★这一页的形状直接照原型★：一张表，每行是「类型 / 占忙闲 / 能力 / 操作」，
/// 底部一行内联新建。★不做弹窗★ —— 原型就是内联的，弹窗会让人为了建一个类型离开当前上下文。
import { App as AntdApp, Button, Card, Checkbox, Input, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type ActivityType } from './api'

/// 这一行能改到什么程度。★与后端 `activity_types.rs::scope_of` 必须一致★ ——
/// 前端只管显隐，真判权在后端（前端隐藏按钮不是安全边界）。
function scopeOf(t: ActivityType, me: string): 'full' | 'busy' | 'none' {
  if (t.owner === me) return 'full'
  if (t.owner !== null) return 'none'
  // ★预置行：沾了任一能力位就完全锁死★（O4 的理由：占忙闲 = 影响别人，
  //   而要出纪要 / 要挂项目的活动按定义就是多人的事）。简单型才能调忙闲。
  return t.has_minutes || t.needs_project ? 'none' : 'busy'
}

export default function ActivityTypesView({ me }: { me: string }) {
  const { message } = AntdApp.useApp()
  const [rows, setRows] = useState<ActivityType[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    api<ActivityType[]>('/api/activity-types').then(setRows).catch((e) => message.error((e as Error).message))
  }, [message])
  useEffect(load, [load])

  const patch = async (t: ActivityType, body: Record<string, unknown>) => {
    try {
      // ⚠ 后端的 name 是 COALESCE 更新：不传就保留。改忙闲时**不要**把名字一起送上去，
      //   否则预置行会因为「你在改名」被拒。
      await api(`/api/activity-types/${t.id}`, { method: 'PUT', body: JSON.stringify(body) })
      load()
    } catch (e) { message.error((e as Error).message) }
  }

  return (
    <Card title="我的活动类型" style={{ maxWidth: 920 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        自建类型 = <b>一个名字 + 一个开关</b>。★「占忙闲」是唯一的开关★ ——
        它是<b>唯一真正影响别人</b>的属性：决定别人约你时看不看得到你这段时间是忙的。
        参与人与材料对所有类型统一开放，不由类型决定。
      </Typography.Paragraph>
      <Table<ActivityType>
        rowKey="id" size="small" pagination={false} dataSource={rows}
        columns={[
          {
            title: '类型', dataIndex: 'name',
            render: (v: string, t) => (
              <Space>
                <b>{v}</b>
                {t.owner === null && <Tag>系统</Tag>}
              </Space>
            ),
          },
          {
            title: '占忙闲', width: 110,
            render: (_, t) => {
              const s = scopeOf(t, me)
              // 全能力的预置类型:显示「固定」而不是一个点不动的复选框 —— 灰着的控件
              // 会让人一直想去点它,还以为是自己没权限。
              if (s === 'none' && t.owner === null) return <span>✅ 固定</span>
              return (
                <Checkbox
                  checked={t.busy_default} disabled={s === 'none'}
                  onChange={(e) => patch(t, { busy_default: e.target.checked })}
                >{t.busy_default ? '占' : '不占'}</Checkbox>
              )
            },
          },
          {
            title: '能力', width: 200,
            render: (_, t) => (t.has_minutes || t.needs_project
              ? <Space size={4}>
                  {t.has_minutes && <Tag color="blue">纪要</Tag>}
                  {t.needs_project && <Tag color="blue">须关联项目</Tag>}
                </Space>
              : <span style={{ color: '#999' }}>简单型</span>),
          },
          {
            title: '', align: 'right' as const,
            render: (_, t) => {
              const s = scopeOf(t, me)
              if (s === 'none' && t.owner === null) return <span style={{ color: '#999' }}>不可改</span>
              if (s === 'busy') return <span style={{ color: '#999' }}>不可删</span>
              return (
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => {
                    const n = prompt('新名字', t.name)?.trim()
                    if (n && n !== t.name) patch(t, { name: n })
                  }}>改名</Button>
                  <Button type="link" size="small" danger onClick={async () => {
                    try {
                      await api(`/api/activity-types/${t.id}`, { method: 'DELETE' }); load()
                    } catch (e) { message.error((e as Error).message) }
                  }}>删除</Button>
                </Space>
              )
            },
          },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <Input placeholder="新类型的名字，如「写作」" value={name} maxLength={12}
               onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
        <Checkbox checked={busy} onChange={(e) => setBusy(e.target.checked)}>占忙闲</Checkbox>
        <Button type="primary" loading={saving} disabled={!name.trim()} onClick={async () => {
          setSaving(true)
          try {
            await api('/api/activity-types', {
              method: 'POST', body: JSON.stringify({ name: name.trim(), busy_default: busy }),
            })
            setName(''); load()
          } catch (e) { message.error((e as Error).message) } finally { setSaving(false) }
        }}>新建</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        ★删除一个类型★：用过它的历史活动<b>照常显示这个类型名</b>（统计不断档），
        只是新建时不再出现在下拉里（L1，软删除）。<br />
        ★没有「改类型」这个功能★ —— 改类型相当于删除重建，与其提供一个会悄悄吃掉
        参与人和纪要的按钮，不如诚实地不给（L2）。
      </Typography.Paragraph>
    </Card>
  )
}
