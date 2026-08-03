// 内容渲染件(主窗抽屉与独立查看窗共用)。
import type { Item } from './api'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/// markdown 渲染:react-markdown **默认不渲染原始 HTML**(不开 rehype-raw),
/// 所以团队成员写的文档里就算塞 <script> 也只会当文本显示——同源存储型 XSS 从源头堵死。
/// remark-gfm 补表格/任务列表/删除线(会议记录高频)。
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="cg-md" style={{ lineHeight: 1.75, wordBreak: 'break-word' }}>
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}

/// 文件预览:PDF 内嵌、图片直显;其余给下载。
/// 走同源 /download?inline=1(带会话 cookie),后端按 mime 白名单决定 inline/attachment
/// ——HTML/SVG 一律 attachment,避免同源渲染上传内容造成存储型 XSS。
export function FilePreview({ item, tall = false }: { item: Item; tall?: boolean }) {
  const src = `/api/items/${item.id}/download?inline=1`
  const mime = item.mime || ''
  if (mime === 'application/pdf') {
    return <embed src={src} type="application/pdf" style={{ width: '100%', height: tall ? '82vh' : 620, border: '1px solid #f0f0f0', borderRadius: 6 }} />
  }
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    return <img src={src} alt={item.name} style={{ maxWidth: '100%', maxHeight: tall ? '82vh' : 620, borderRadius: 6 }} />
  }
  return null
}

export const KIND_ICON: Record<Item['kind'], string> = { folder: '📁', doc: '📄', file: '📎', video: '🎬' }

export function fmtSize(n: number | null) {
  if (n == null) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}

