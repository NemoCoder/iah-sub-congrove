// 公开分享的**访客页**(/s/{token})——对标百度网盘的分享落地页。
// ★它不需要登录★:App 在最外层就把这条路由劫走,不会去打 /api/me,也就不会被 401 跳登录。
// 访客能做的只有:输提取码 → 看内容 → (分享方允许时)下载。
// 服务端每一步都 fail-closed:过期/超次数/撤销/令牌不存在一律 404,前端只负责把话说清楚。
import { Alert, Button, Card, Empty, Input, Result, Space, Spin, Table, Typography } from 'antd'
import { DownloadOutlined, LockOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'
import { ItemIcon, fmtSize, MarkdownView } from './preview'
import { IahHeader } from './iah-header'
import type { Item } from './api'

type Brief = { id: number; kind: Item['kind']; name: string; size: number | null; mime: string | null; created_at: string }

async function pub<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = ((await r.json()) as { error?: string }).error || msg } catch { /* 非 JSON */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

export function SharePage({ token }: { token: string }) {
  const [phase, setPhase] = useState<'loading' | 'code' | 'open' | 'gone'>('loading')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ticket, setTicket] = useState('')
  const [item, setItem] = useState<Brief | null>(null)
  const [allowDownload, setAllowDownload] = useState(true)
  const [rows, setRows] = useState<Brief[]>([])
  const [cwd, setCwd] = useState<number | null>(null)
  const [doc, setDoc] = useState<string | null>(null)
  const [multi, setMulti] = useState(false)
  const [count, setCount] = useState(1)

  useEffect(() => {
    pub<{ needs_code: boolean }>(`/pub/share/${token}`)
      .then((m) => setPhase(m.needs_code ? 'code' : 'open'))
      .catch(() => setPhase('gone'))
  }, [token])

  // 无提取码的分享:拿到 meta 就直接开
  const open = useCallback(async (c?: string) => {
    setBusy(true); setErr(null)
    try {
      const r = await pub<{ ticket: string; item: Brief; allow_download: boolean; multi?: boolean; count?: number }>(
        `/pub/share/${token}/open`, { method: 'POST', body: JSON.stringify({ code: c ?? null }) })
      setTicket(r.ticket); setItem(r.item); setAllowDownload(r.allow_download); setPhase('open')
      setMulti(!!r.multi); setCount(r.count ?? 1)
      // 多选分享:列表就是那 N 项(不带 parent 时服务端返回全部根);单个文件夹则进它自己。
      if (r.multi) setCwd(null)
      else if (r.item.kind === 'folder') setCwd(r.item.id)
    } catch (e) {
      const m = (e as Error).message
      // 提取码错是可重试的;其它(404)一律当「链接已失效」——服务端刻意不区分原因。
      if (m.includes('提取码')) setErr('提取码不对,再试一次')
      else setPhase('gone')
    } finally { setBusy(false) }
  }, [token])

  useEffect(() => { if (phase === 'open' && !item) void open() }, [phase, item, open])

  // 文件夹分享:逛子树
  useEffect(() => {
    if (!ticket) return
    if (cwd == null && !multi) return
    const q = cwd == null ? '' : `&parent=${cwd}`
    pub<Brief[]>(`/pub/share/${token}/list?k=${encodeURIComponent(ticket)}${q}`)
      .then(setRows).catch(() => setRows([]))
  }, [ticket, cwd, token, multi])

  // 文档正文:公开面没有 content 接口,直接按文件取(text/markdown 会走 inline)
  useEffect(() => {
    if (!ticket || !item || item.kind !== 'doc') { setDoc(null); return }
    fetch(`/pub/share/${token}/file/${item.id}?k=${encodeURIComponent(ticket)}&inline=1`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setDoc).catch(() => setDoc(null))
  }, [ticket, item, token])

  const fileUrl = (it: Brief, inline = false) =>
    `/pub/share/${token}/file/${it.id}?k=${encodeURIComponent(ticket)}${inline ? '&inline=1' : ''}`

  const shell = (body: React.ReactNode) => (
    <div style={{ minHeight: '100vh', background: '#f4f4f7' }}>
      <IahHeader />
      <div style={{ maxWidth: 1000, margin: '24px auto', padding: '0 22px' }}>{body}</div>
    </div>
  )

  if (phase === 'loading') return shell(<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>)

  if (phase === 'gone')
    return shell(
      <Result status="404" title="链接已失效"
        subTitle="它可能已过期、超出访问次数,或者被分享者撤销了。找分享给你的人要一条新的。" />)

  if (phase === 'code')
    return shell(
      <Card style={{ maxWidth: 420, margin: '40px auto' }}>
        <Typography.Title level={5} style={{ marginTop: 0 }}><LockOutlined /> 请输入提取码</Typography.Title>
        <Space.Compact style={{ width: '100%' }}>
          <Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="提取码"
            onPressEnter={() => code.trim() && open(code.trim())} />
          <Button type="primary" loading={busy} disabled={!code.trim()} onClick={() => open(code.trim())}>打开</Button>
        </Space.Compact>
        {err && <Alert type="error" showIcon style={{ marginTop: 10 }} message={err} />}
      </Card>)

  if (!item) return shell(<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>)

  // 单个文件/文档/视频(多选分享一律走下面的列表)
  if (!multi && item.kind !== 'folder')
    return shell(
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <ItemIcon it={item} />
          <Typography.Text strong style={{ fontSize: 16 }}>{item.name}</Typography.Text>
          <Typography.Text type="secondary">{fmtSize(item.size)}</Typography.Text>
          {allowDownload
            ? <Button type="primary" size="small" icon={<DownloadOutlined />} href={fileUrl(item)}>下载</Button>
            : <Typography.Text type="secondary">(分享者未开放下载)</Typography.Text>}
        </Space>
        {item.kind === 'doc' && doc != null && <MarkdownView text={doc} />}
        {item.kind === 'video' && (
          <video controls preload="metadata" src={fileUrl(item, true)}
            style={{ width: '100%', maxHeight: '72vh', background: '#000', borderRadius: 6 }} />
        )}
        {item.kind === 'file' && <PubFile it={item} url={fileUrl(item, true)} />}
      </Card>)

  // 文件夹:列内容,可进子目录
  return shell(
    <Card>
      <Space style={{ marginBottom: 10 }}>
        <ItemIcon it={item} />
        <Typography.Text strong style={{ fontSize: 16 }}>
          {multi ? `分享了 ${count} 项` : item.name}
        </Typography.Text>
        {((multi && cwd != null) || (!multi && cwd !== item.id)) && (
          <Button size="small" onClick={() => setCwd(multi ? null : item.id)}>回到分享根目录</Button>
        )}
      </Space>
      <Table size="small" rowKey="id" dataSource={rows} pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个文件夹是空的" /> }}
        columns={[
          { title: '名称', dataIndex: 'name',
            render: (_, it) => (it.kind === 'folder'
              ? <a onClick={() => setCwd(it.id)}><ItemIcon it={it} />{it.name}</a>
              : <span><ItemIcon it={it} />{it.name}</span>) },
          { title: '大小', dataIndex: 'size', width: 110, render: (v, it) => (it.kind === 'folder' ? '—' : fmtSize(v)) },
          { title: '操作', width: 90, render: (_, it) => (it.kind === 'folder' ? null : allowDownload
              ? <a href={fileUrl(it)}><DownloadOutlined /> 下载</a>
              : <Typography.Text type="secondary" style={{ fontSize: 12 }}>不可下载</Typography.Text>) },
        ]} />
    </Card>)
}

/// 公开面的文件预览:PDF/图片内嵌,其余给一句说明(不给 iframe 跑未知类型)。
function PubFile({ it, url }: { it: Brief; url: string }) {
  const m = it.mime || ''
  if (m === 'application/pdf')
    return <embed src={url} type="application/pdf" style={{ width: '100%', height: 'calc(100vh - 240px)', border: '1px solid #f0f0f0', borderRadius: 6 }} />
  if (m.startsWith('image/') && m !== 'image/svg+xml')
    return <img src={url} alt={it.name} style={{ maxWidth: '100%', maxHeight: '72vh', borderRadius: 6 }} />
  return <Typography.Text type="secondary">这个类型不支持在线预览,下载后查看。</Typography.Text>
}
