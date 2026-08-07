// 就地编辑 —— ★全站唯一的编辑交互★(2026-08-07 用户定):
// 「任何一个可以编辑的地方,双击即可编辑,不要弹出框」。
//
// 为什么值得抽成公共组件:此前纪要页是双击就地改、会议详情页却是「编辑」按钮 + 弹窗,
// 同一个动作两套交互 —— 用户在一个页面学会的操作,到另一个页面不管用,这比丑更糟。
//
// 三条行为是刻意的:
//   · **默认长得像读稿**(没有边框、没有输入框感)——不双击就看不出这里能改,页面才安静;
//   · **失焦即保存**,不要求再点一次「保存」;值没变则**不发请求**;
//   · **Esc 放弃**——误双击的退路。
import { Input, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'

export function InlineEdit({
  value, onSave, canEdit, multiline = false, rows = 3, placeholder = '（双击填写）',
  style, renderView,
}: {
  value: string
  onSave: (v: string) => Promise<void>
  canEdit: boolean
  multiline?: boolean
  rows?: number
  placeholder?: string
  style?: React.CSSProperties
  /// 只读态的自定义渲染(如把链接渲染成 <a>)。不给则按纯文本显示。
  renderView?: (v: string) => React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  // 外部值变了(别人改了 / 重新加载)要跟上,否则下次进编辑态拿到的是旧值
  useEffect(() => { setDraft(value) }, [value])

  const commit = async () => {
    setEditing(false)
    if (draft === value) return                 // 没改就不发请求
    setBusy(true)
    try { await onSave(draft) } finally { setBusy(false) }
  }

  if (editing) {
    const common = {
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        // 单行:回车即保存(多行要留给换行)
        if (!multiline && e.key === 'Enter') { void commit() }
      },
    }
    return multiline ? <Input.TextArea rows={rows} {...common} /> : <Input {...common} />
  }

  return (
    <span
      onDoubleClick={() => canEdit && setEditing(true)}
      title={canEdit ? '双击编辑' : undefined}
      style={{
        display: multiline ? 'block' : 'inline-block',
        minHeight: multiline ? rows * 22 : undefined,
        whiteSpace: multiline ? 'pre-wrap' : undefined,
        cursor: canEdit ? 'text' : 'default',
        borderRadius: 4,
        padding: multiline ? '4px 6px' : '0 4px',
        // 空值时给一点底色,让「这里可以填」看得出来;有值时完全透明,像普通文本
        background: value ? 'transparent' : canEdit ? '#fafafa' : 'transparent',
        ...style,
      }}
    >
      {busy && <Spin size="small" style={{ marginRight: 6 }} />}
      {value
        ? (renderView ? renderView(value) : value)
        : <Typography.Text type="secondary">{canEdit ? placeholder : '未填'}</Typography.Text>}
    </span>
  )
}
