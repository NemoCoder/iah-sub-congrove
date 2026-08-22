// 内容渲染件(主窗抽屉与独立查看窗共用)。
import type { Item } from './api'
import {
  AudioOutlined, FileExcelOutlined, FileImageOutlined, FileMarkdownOutlined, FileOutlined, FilePdfOutlined,
  FilePptOutlined, FileTextOutlined, FileWordOutlined, FileZipOutlined, FolderFilled, Html5Outlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import Markdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { useEffect, useState } from 'react'
import { Alert, Spin } from 'antd'

/// markdown 渲染:react-markdown **默认不渲染原始 HTML**(不开 rehype-raw),
/// 所以团队成员写的文档里就算塞 <script> 也只会当文本显示——同源存储型 XSS 从源头堵死。
/// remark-gfm 补表格/任务列表/删除线(活动记录高频)。
/// ★`breaks` 是给「人手写的短文本」用的★(2026-08-22)。
///
/// Markdown 规范里**单个换行不换行** —— 连续两行会被折成一段。
/// 对文档/AI 产物这是对的(它们本来就按 markdown 写);
/// 但对**纪要正文、议程**这种人随手敲的字段就是错的:
/// 人打了回车却没换行,而他根本不知道自己在写 markdown。
/// (同一件事 2026-08-04 在分段大纲上撞过一次,当时的处置是**整个不给 markdown 渲染**,
///  见 `analysis.tsx` 的 `TimedLines` —— 那是回避,不是解决。)
///
/// ⚠ 默认 **false**,保持既有各处的渲染一字不变;只有明确「这是人手写的」才开。
export function MarkdownView({ text, breaks = false }: { text: string; breaks?: boolean }) {
  return (
    <div className="cg-md" style={{ lineHeight: 1.75, wordBreak: 'break-word' }}>
      <Markdown remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}>{text}</Markdown>
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
  // ★上传的 .md / 纯文本也要能预览★（2026-08-13 liaoruili:「md 格式也可以预览呗」）。
  //
  // 在此之前只有**站内新建的文档**(kind='doc')渲染 markdown,而**传上来的 .md 文件**
  // 走的是这个函数 → 落到 `return null` → 一片空白,只能下载下来看。
  // ★同一种内容,来路不同就一个能看一个不能看 —— 用户不关心它是「建的」还是「传的」。★
  //
  // ⚠★安全性靠的是 MarkdownView 本身,不是靠不渲染★:react-markdown 默认不开 rehype-raw,
  //   原始 HTML 只当文本显示(见它的头注)。所以渲染**别人传上来的** md 与渲染站内文档同样安全。
  //   纯文本一律进 <pre>,天然惰性。★HTML/SVG 仍然不在这里预览★(后端也强制 attachment)。
  if (是文本(item, mime)) return <TextPreview item={item} maxH={h} />
  return null
}

/// 判「这个文件能不能当文本读」。★mime 不可靠★:上传的 .md 常被标成 application/octet-stream
/// (浏览器按扩展名猜,而 markdown 没进大多数系统的 mime 表),所以扩展名是必要的兜底。
function 是文本(item: Item, mime: string): boolean {
  if (mime === 'text/html' || mime === 'image/svg+xml') return false      // 这两个不预览(存储型 XSS)
  if (mime.startsWith('text/') || mime === 'application/json') return true
  return /\.(md|markdown|txt|log|json|ya?ml|csv|tsv|ini|conf|toml)$/i.test(item.name)
}

/// 文本/markdown 预览:取回内容再渲染。
/// ⚠★带上限★:这一步是把整个文件读进内存再交给渲染器,而项目里躺着 GB 级的录屏和数据文件;
///   不设限的话点错一个 2GB 的 .log 就是把浏览器卡死。超限时**说清楚为什么**并让人去下载,
///   ——★「点了没反应」和「明确告诉你太大了」差的是一次求助。★
const 文本上限 = 2 * 1024 * 1024
function TextPreview({ item, maxH }: { item: Item; maxH: string }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if ((item.size ?? 0) > 文本上限) { setErr(`文件超过 ${Math.round(文本上限 / 1024 / 1024)} MB，这里不展开；下载下来看更快。`); return }
    fetch(`/api/items/${item.id}/download?inline=1`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`取内容失败（HTTP ${r.status}）`))))
      .then((t) => { if (alive) setText(t) })
      .catch((e: Error) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [item.id, item.size])
  if (err) return <Alert type="info" showIcon message={err} />
  if (text === null) return <Spin />
  const md = /\.(md|markdown)$/i.test(item.name) || item.mime === 'text/markdown'
  return (
    <div style={{ maxHeight: maxH, overflow: 'auto' }}>
      {md ? <MarkdownView text={text} />
          : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{text}</pre>}
    </div>
  )
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
  // ⚠★原来到 MB 就封顶★(2026-08-12 补 GB):个人配额默认 10 GiB,于是「存储配额」
  // 那一行显示成「已用 94B / 10240.0MB」—— 两个数一个论字节一个论兆,读的人
  // 得自己心算才知道用了多少。配额是**给人看用了多大比例**的,不是给人做除法的。
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`
  return `${(n / 1073741824).toFixed(1)}GB`
}

