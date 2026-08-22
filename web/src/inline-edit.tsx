// 就地编辑 —— ★全站唯一的编辑交互★(2026-08-07 用户定):
// 「任何一个可以编辑的地方,双击即可编辑,不要弹出框」。
//
// 为什么值得抽成公共组件:此前纪要页是双击就地改、活动详情页却是「编辑」按钮 + 弹窗,
// 同一个动作两套交互 —— 用户在一个页面学会的操作,到另一个页面不管用,这比丑更糟。
//
// 三条行为是刻意的:
//   · **默认长得像读稿**(没有边框、没有输入框感)——不双击就看不出这里能改,页面才安静;
//   · ★**显式点「保存」才生效**★(见下面那段改动记录);值没变则**不发请求**;
//   · **Esc 放弃**——误双击的退路。
//
// ⚠★2026-08-09 推翻了「失焦即保存」,改成点按钮确认★(liaoruili:「鼠标移出来就自动确认了。。
//   不要这样,还是弄成点击确认」)。原来那条是 2026-08-07 定的,当时的理由是「少一次点击」。
//   ★但这些字段是**纪要正文**——鼠标随手划过去就把一段没写完的东西存进去,
//   而且没有任何提示、也没有撤销。★「少一次点击」换来的是「说不清自己什么时候存的」。
//   记在这儿:下一个人看到这里有保存按钮,别当成「忘了做失焦保存」又给改回去。
import { Button, Input, Space, Spin, Typography } from 'antd'
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

  /// ★存成功了才退出编辑态★:原来是先 setEditing(false) 再发请求 ——
  /// 请求失败时编辑框已经关了、草稿也没了,屏幕上还是旧值,**看起来像什么都没发生**。
  /// 现在失败就留在编辑态,人还能重试或先把内容复制走。
  const commit = async () => {
    if (draft === value) { setEditing(false); return }   // 没改就不发请求
    setBusy(true)
    try { await onSave(draft); setEditing(false) } finally { setBusy(false) }
  }

  const cancel = () => { setDraft(value); setEditing(false) }

  if (editing) {
    const common = {
      autoFocus: true,
      value: draft,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      // ★这里**没有** onBlur★ —— 是刻意的,见文件头那段改动记录。
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { cancel(); return }
        // 单行:回车即保存(多行的回车要留给换行,改用 Ctrl/⌘+Enter)
        if (!multiline && e.key === 'Enter') { void commit() }
        if (multiline && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { void commit() }
      },
    }
    return (
      <div>
        {multiline
          // ★框子跟着内容长★(2026-08-09 用户:「这个框太矮了」):原来固定 rows,
          // 而只读态的高度是按**实际内容**撑开的 —— 双击之后框比刚才那段文字还矮,
          // 得在一个小窗口里滚动着改一篇纪要。autoSize 让它至少和只读时一样高。
          ? <Input.TextArea autoSize={{ minRows: Math.max(rows, 4), maxRows: 30 }} {...common} />
          : <Input {...common} />}
        <Space size={6} style={{ marginTop: 6 }}>
          <Button size="small" type="primary" loading={busy} onClick={() => void commit()}>保存</Button>
          <Button size="small" onClick={cancel}>取消</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {multiline ? 'Ctrl+Enter 保存 · Esc 取消' : 'Enter 保存 · Esc 取消'}
          </Typography.Text>
        </Space>
      </div>
    )
  }

  // ★多行只读态用 <div> 不用 <span>★(2026-08-22):`renderView` 可以返回**块级**内容
  // (纪要/议程现在渲染 Markdown,`MarkdownView` 就是个 <div>),而 <span> 是行内元素、
  // 按 HTML 规范不能包块级 —— 浏览器会**自己把 DOM 拆开**,布局当场错乱,
  // 而 React 只在开发模式下警告一句 validateDOMNesting。★它本来就 display:block,换成 div 视觉不变。★
  // 单行仍旧是 span:那里的 renderView 渲染的是 <a> 这类行内内容,包进 div 会把行给断开。
  const 壳属性 = {
    onDoubleClick: () => canEdit && setEditing(true),
    title: canEdit ? '双击编辑' : undefined,
    style: {
      display: multiline ? 'block' : ('inline-block' as const),
      minHeight: multiline ? rows * 22 : undefined,
      // ★有 renderView 就别 pre-wrap★:Markdown 自己管换行,再叠一层 pre-wrap
      // 会把源码里的缩进和空行原样顶出来(列表前多一大截空白)。
      whiteSpace: multiline && !renderView ? ('pre-wrap' as const) : undefined,
      cursor: canEdit ? ('text' as const) : ('default' as const),
      borderRadius: 4,
      padding: multiline ? '4px 6px' : '0 4px',
      // 空值时给一点底色,让「这里可以填」看得出来;有值时完全透明,像普通文本
      background: value ? 'transparent' : canEdit ? '#fafafa' : 'transparent',
      ...style,
    },
  }
  const 内容 = (
    <>
      {busy && <Spin size="small" style={{ marginRight: 6 }} />}
      {value
        ? (renderView ? renderView(value) : value)
        : <Typography.Text type="secondary">{canEdit ? placeholder : '未填'}</Typography.Text>}
    </>
  )
  return multiline ? <div {...壳属性}>{内容}</div> : <span {...壳属性}>{内容}</span>
}
