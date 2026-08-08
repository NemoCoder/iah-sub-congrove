// 内容渲染件(主窗抽屉与独立查看窗共用)。
import type { Item } from './api'
import {
  AudioOutlined, FileExcelOutlined, FileImageOutlined, FileMarkdownOutlined, FileOutlined, FilePdfOutlined,
  FilePptOutlined, FileTextOutlined, FileWordOutlined, FileZipOutlined, FolderFilled, Html5Outlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/// markdown 渲染:react-markdown **默认不渲染原始 HTML**(不开 rehype-raw),
/// 所以团队成员写的文档里就算塞 <script> 也只会当文本显示——同源存储型 XSS 从源头堵死。
/// remark-gfm 补表格/任务列表/删除线(活动记录高频)。
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
  // ★吃满可用高度★(2026-08-05 反馈「PDF 预览窗口太小」):原来抽屉里写死 620px,
  // 下面空一大片。改成按视口算——抽屉里减掉页眉/标题/工具条那约 170px,独立窗给 82vh。
  const h = tall ? '82vh' : 'calc(100vh - 170px)'
  if (mime === 'application/pdf') {
    return <embed src={src} type="application/pdf" style={{ width: '100%', height: h, border: '1px solid #f0f0f0', borderRadius: 6 }} />
  }
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    return <img src={src} alt={item.name} style={{ maxWidth: '100%', maxHeight: h, borderRadius: 6 }} />
  }
  return null
}

/// 文件图标:用 antd 的 File* 系列(**不是 emoji**)。
/// 2026-08-05 用户反馈「PDF 怎么是本合着的书」——emoji 的 📕 在各家字体里长相差异极大,
/// 而 pdf/word/excel/ppt 这些格式本来就有通用图标,专业图标一眼可辨、颜色也统一。
/// 颜色沿用各格式的通行色(PDF 红、Word 蓝、Excel 绿、PPT 橙…),文件夹用暖黄。
export function ItemIcon({ it }: { it: { kind: Item['kind']; mime?: string | null } }) {
  const st = (color: string) => ({ color, fontSize: 15, marginRight: 6 })
  if (it.kind === 'folder') return <FolderFilled style={st('#f0b429')} />
  if (it.kind === 'doc') return <FileMarkdownOutlined style={st('#0d9488')} />
  if (it.kind === 'video') return <VideoCameraOutlined style={st('#7c3aed')} />
  const m = it.mime || ''
  if (m === 'application/pdf') return <FilePdfOutlined style={st('#d93025')} />
  if (m.startsWith('image/')) return <FileImageOutlined style={st('#16a34a')} />
  if (m.startsWith('audio/')) return <AudioOutlined style={st('#db2777')} />
  if (m.includes('html')) return <Html5Outlined style={st('#e34c26')} />
  if (m.includes('zip') || m.includes('tar') || m.includes('compressed') || m.includes('rar'))
    return <FileZipOutlined style={st('#a16207')} />
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv')) return <FileExcelOutlined style={st('#107c41')} />
  if (m.includes('word') || m.includes('officedocument.wordprocessing')) return <FileWordOutlined style={st('#2b579a')} />
  if (m.includes('presentation') || m.includes('powerpoint')) return <FilePptOutlined style={st('#d24726')} />
  if (m.startsWith('text/') || m.includes('json') || m.includes('xml')) return <FileTextOutlined style={st('#6b7280')} />
  return <FileOutlined style={st('#6b7280')} />
}

export function fmtSize(n: number | null) {
  if (n == null) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}

