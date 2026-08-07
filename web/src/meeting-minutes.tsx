// 会议纪要整理 —— 对应 docs/prototype-m1.html 的 `min` 视图。
//
// ★D14 的核心:AI 是原材料,记录员是作者★。所以这一页刻意**不做**「一键把 AI 稿变成纪要」——
// 那会让「记录员按固定模板整理」这条决策名存实亡。AI 转写/摘要放在旁边供参考,
// 要用哪段自己看着抄。
//
// ★用户在原型上定的两条交互,别改回去★:
//   · **一开始不是可编辑的**——先呈现成读稿的样子,**双击**某一块才进编辑
//     (「这是来自于AI整理吗?一开始不要是这种可编辑的」);
//   · **一次性展示太长,划分为两块**——「会议信息 + 正文」与「决议 + 待办」分开。
import { App as AntdApp, Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type Minutes } from './api'
import { InlineEdit } from './inline-edit'

/// 纪要里的一块:标签 + 就地编辑。★编辑交互走全站统一的 InlineEdit★
/// (此前这里自己实现了一份,和会议详情页的「编辑按钮+弹窗」是两套 —— 2026-08-07 统一)。
function Block({ label, value, hint, rows = 3, canEdit, onSave }: {
  label: string; value: string; hint?: string; rows?: number
  canEdit: boolean; onSave: (v: string) => Promise<void>
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>{label}</Typography.Text>
        {hint && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}
      </div>
      <InlineEdit value={value} canEdit={canEdit} multiline rows={rows} onSave={onSave}
        style={{ fontSize: 13, lineHeight: 1.8 }} />
    </div>
  )
}

export function MeetingMinutesView({ meetingId, onBack }: { meetingId: number; onBack: () => void }) {
  const { message } = AntdApp.useApp()
  const [m, setM] = useState<Minutes | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api<{ minutes: Minutes | null; can_edit: boolean }>(`/api/meetings/${meetingId}/minutes`)
      setM(r.minutes)
      setCanEdit(r.can_edit)
      setErr(null)
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [meetingId])
  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<Minutes>) => {
    try {
      await api(`/api/meetings/${meetingId}/minutes`, { method: 'PUT', body: JSON.stringify(patch) })
      await load()
    } catch (e) { message.error((e as Error).message) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (err) return <Card><Empty description={err === '403' ? '你没有权限查看这份纪要' : err} /></Card>

  // 后端在没有纪要时回 null(不是 404),所以这里用空壳渲染,不必分支
  const v = m ?? {
    status: 'draft' as const, attendees: '', observers: '', absentees: '',
    agenda_text: '', content_md: '', resolutions: '', todos: '',
  }
  const done = v.status === 'done'

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button size="small" onClick={onBack}>‹ 返回会议</Button>
        <Typography.Text strong style={{ fontSize: 16 }}>会议纪要</Typography.Text>
        <Tag color={done ? 'green' : 'orange'}>{done ? '已定稿' : '草稿'}</Tag>
        {m?.completed_at && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            定稿于 {new Date(m.completed_at).toLocaleString('zh-CN')}
          </Typography.Text>
        )}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <Button size="small" type={done ? 'default' : 'primary'}
            onClick={() => save({ status: done ? 'draft' : 'done' })}>
            {done ? '改回草稿' : '定稿'}
          </Button>
        )}
      </Space>


      {/* ★分成两块★:一次性展示太长(原型评审) */}
      <Card size="small" title="会议信息与正文" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Block label="到场" hint="会后补录的事实" value={v.attendees} rows={2} canEdit={canEdit}
              onSave={(x) => save({ attendees: x })} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Block label="列席" value={v.observers} rows={2} canEdit={canEdit}
              onSave={(x) => save({ observers: x })} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Block label="缺席" value={v.absentees} rows={2} canEdit={canEdit}
              onSave={(x) => save({ absentees: x })} />
          </div>
        </div>
        <Block label="议程" value={v.agenda_text} rows={3} canEdit={canEdit}
          onSave={(x) => save({ agenda_text: x })} />
        <Block label="正文" hint="Markdown；出 PDF 时由平台的 LaTeX 服务排版" value={v.content_md}
          rows={12} canEdit={canEdit} onSave={(x) => save({ content_md: x })} />
      </Card>

      <Card size="small" title="决议与待办">
        <Block label="决议" hint="这次会定下来的事" value={v.resolutions} rows={4} canEdit={canEdit}
          onSave={(x) => save({ resolutions: x })} />
        <Block label="待办" hint="谁、做什么、什么时候之前" value={v.todos} rows={4} canEdit={canEdit}
          onSave={(x) => save({ todos: x })} />
      </Card>
    </div>
  )
}
