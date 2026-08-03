// 空间视图:左列空间列表,右侧选中空间的文件树 + 内容面板。
// 前端只做显隐(my_role),真判权在后端(perm.rs)——按钮藏了 API 也会 403,别当安全边界。
import {
  App as AntdApp, AutoComplete, Breadcrumb, Button, Card, Drawer, Dropdown, Empty, Input, List, Modal, Popconfirm,
  Progress, Segmented, Select, Space as AntSpace, Switch, Table, Tag, Tooltip, TreeSelect, Typography, Upload,
} from 'antd'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type Diagnose, type Grant, type Item, type Me, type Role, type Space, type UserOpt, type Version } from './api'

/// markdown 渲染:react-markdown **默认不渲染原始 HTML**(不开 rehype-raw),
/// 所以团队成员写的文档里就算塞 <script> 也只会当文本显示——同源存储型 XSS 从源头堵死。
/// remark-gfm 补表格/任务列表/删除线(会议记录高频)。
function MarkdownView({ text }: { text: string }) {
  return (
    <div className="cg-md" style={{ lineHeight: 1.75, wordBreak: 'break-word' }}>
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}

/// 文件预览:PDF 内嵌、图片直显;其余给下载。
/// 走同源 /download?inline=1(带会话 cookie),后端按 mime 白名单决定 inline/attachment
/// ——HTML/SVG 一律 attachment,避免同源渲染上传内容造成存储型 XSS。
function FilePreview({ item }: { item: Item }) {
  const src = `/api/items/${item.id}/download?inline=1`
  const mime = item.mime || ''
  if (mime === 'application/pdf') {
    return <embed src={src} type="application/pdf" style={{ width: '100%', height: 620, border: '1px solid #f0f0f0', borderRadius: 6 }} />
  }
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    return <img src={src} alt={item.name} style={{ maxWidth: '100%', maxHeight: 620, borderRadius: 6 }} />
  }
  return null
}

/// P2 预签名直传:>100MB 或视频走浏览器→Garage 直传(字节不过 pod)。
/// begin 拿全部 part URL → File.slice 逐片 PUT(收集 ETag,跨源可读靠桶 CORS 的 ExposeHeaders)
/// → complete 交回服务端。返回 false = 后端说预签名未启用(501),调用方回退后端流式上传。
const DIRECT_THRESHOLD = 100 * 1024 * 1024

/// 开局探测:本设备能不能直连 s3api(证书信不信得过)。
/// no-cors 的 HEAD:证书不受信 → fetch 直接 reject;受信则即使 403 也算 resolve(opaque)。
/// 结果缓存在 sessionStorage,每标签页只探一次;探不通就静默走同源分片,不再撞墙报警告。
async function probeDirect(endpoint: string | null): Promise<boolean> {
  if (!endpoint) return false
  const cached = sessionStorage.getItem('cg_direct_ok')
  if (cached !== null) return cached === '1'
  let ok = false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 6000)
    await fetch(endpoint, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctl.signal })
    clearTimeout(timer)
    ok = true
  } catch {
    ok = false // 证书不受信 / 该网络到不了 → 走分片
  }
  sessionStorage.setItem('cg_direct_ok', ok ? '1' : '0')
  return ok
}

async function directUpload(
  sid: number, file: File, parentId: number | null, onProgress: (p: number) => void,
  mode: 'presigned' | 'proxy',
): Promise<boolean> {
  const begin = await fetch(`/api/spaces/${sid}/media/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || 'application/octet-stream', parent_id: parentId }),
  })
  if (begin.status === 501) return false
  if (begin.status === 401) {
    window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`
    throw new Error('未登录')
  }
  if (!begin.ok) throw new Error(((await begin.json()) as { error?: string }).error || `${begin.status}`)
  const { item_id, upload_id, part_size, part_urls } = (await begin.json()) as {
    item_id: number; upload_id: string; part_size: number; part_urls: string[]
  }
  try {
    const parts: { part_number: number; etag: string }[] = []
    let sent = 0
    for (let i = 0; i < part_urls.length; i++) {
      const blob = file.slice(i * part_size, Math.min(file.size, (i + 1) * part_size))
      const report = (loaded: number) => onProgress(Math.round(((sent + loaded) / file.size) * 100))
      // presigned:浏览器直发 Garage(最快,要过 s3api 证书关);
      // proxy:同源发给我们再转推 S3(绕开证书关,也绕开入口层对大请求的限——每片只有 32MiB)。
      // 每片重试 3 次(1s/2s 退避):公网入口层偶发掐断时不必整个文件重来。
      let etag = ''
      for (let attempt = 1; ; attempt++) {
        try {
          etag = mode === 'presigned'
            ? await putPart(part_urls[i], blob, report)
            : await putPart(`/api/items/${item_id}/media/part?upload_id=${encodeURIComponent(upload_id)}&part_number=${i + 1}`, blob, report, true)
          break
        } catch (pe) {
          if (attempt >= 3) throw new Error(`第 ${i + 1}/${part_urls.length} 片失败(已重试 3 次):${(pe as Error).message}`)
          await new Promise((r) => setTimeout(r, attempt * 1000))
          report(0)
        }
      }
      sent += blob.size
      parts.push({ part_number: i + 1, etag })
    }
    await api(`/api/items/${item_id}/media/complete`, { method: 'POST', body: JSON.stringify({ upload_id, parts }) })
    return true
  } catch (e) {
    // 失败必 abort:半截 multipart 不清理会永久占存储(后端另有 24h 兜底清扫)。
    await api(`/api/items/${item_id}/media/abort`, { method: 'POST', body: JSON.stringify({ upload_id }) }).catch(() => {})
    throw e
  }
}

function putPart(url: string, blob: Blob, onLoaded: (loaded: number) => void, viaProxy = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded) }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `${xhr.status}`
        try { detail = JSON.parse(xhr.responseText).error || detail } catch { /* 非 JSON */ }
        return reject(new Error(`分片上传失败:${detail}`))
      }
      // 代理模式 ETag 在 JSON 体里;直传模式在响应头(跨源可读靠桶 CORS ExposeHeaders:[ETag])。
      const etag = viaProxy ? (JSON.parse(xhr.responseText).etag as string) : xhr.getResponseHeader('ETag')
      if (etag) resolve(etag.replaceAll('"', ''))
      else reject(new Error(viaProxy ? '分片响应缺 etag' : 'part 直传缺 ETag(桶 CORS?)'))
    }
    xhr.onerror = () => reject(new Error(viaProxy ? '分片上传网络错误' : 'part 直传网络错误(证书/CORS?)'))
    xhr.send(blob)
  })
}

/// XHR 上传(fetch 至今无标准上传进度,对抗核查 §7.4b-5):onProgress 喂给 antd Upload 画进度条。
function xhrUpload(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      if (xhr.status === 401) { window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`; return }
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else {
        // 后端 JSON 错误取 error 字段;axum 框架层的纯文本错误(如 query 解析失败)取原文,别只剩裸状态码。
        let msg = `${xhr.status}`
        try { msg = JSON.parse(xhr.responseText).error || msg } catch { if (xhr.responseText) msg = `${xhr.status}:${xhr.responseText.slice(0, 120)}` }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

const KIND_ICON: Record<Item['kind'], string> = { folder: '📁', doc: '📄', file: '📎', video: '🎬' }
const ROLE_TAG: Record<Role, ReactNode> = {
  admin: <Tag color="purple">admin</Tag>,
  editor: <Tag color="green">editor</Tag>,
  viewer: <Tag>viewer</Tag>,
}

function fmtSize(n: number | null) {
  if (n == null) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}

function fmtTime(s: string) {
  const d = new Date(s)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/// 网盘式空间视图(2026-08-03 重做)。**两套操作严格分开**:
/// - 空间所有者的事(授权管理 / 安全设置 / 重命名空间 / 删除空间)→ 只在左栏空间行的
///   「⋯」菜单里,且仅 space admin 可见;
/// - 空间里的内容操作(上传 / 新建 / 下载 / 重命名 / 移动 / 删除)→ 右侧工具栏与每行操作列,
///   editor 及以上可用。
/// 导航是「进文件夹 + 面包屑」而非一棵永远展开的树(内容多了树没法看)。
export function SpacesView({ me }: { me: Me | null }) {
  const { message, modal } = AntdApp.useApp()
  const [spaces, setSpaces] = useState<Space[]>([])
  const [cur, setCur] = useState<Space | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [cwd, setCwd] = useState<number | null>(null) // 当前所在文件夹(null = 空间根)
  const [checked, setChecked] = useState<number[]>([]) // 批量选中
  const [preview, setPreview] = useState<Item | null>(null)
  const [grantsOpen, setGrantsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads] = useState<{ key: string; name: string; percent: number }[]>([])
  const [moving, setMoving] = useState<Item[] | null>(null) // 待移动的项(单个或批量)
  const [moveDest, setMoveDest] = useState<number | null>(null) // 移动目标文件夹(null = 根)

  const loadSpaces = useCallback(async () => {
    const s = await api<Space[]>('/api/spaces')
    setSpaces(s)
    setCur((c) => (c ? s.find((x) => x.id === c.id) || null : null))
  }, [])
  const loadItems = useCallback(async (sid: number) => {
    setItems(await api<Item[]>(`/api/spaces/${sid}/items`))
  }, [])
  useEffect(() => {
    loadSpaces().catch((e) => message.error(e.message))
  }, [loadSpaces, message])
  useEffect(() => {
    setCwd(null); setChecked([]); setPreview(null)
    if (cur) loadItems(cur.id).catch((e) => message.error(e.message))
  }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = cur?.my_role === 'editor' || cur?.my_role === 'admin'
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  // 当前目录内容:文件夹在前,同类按名称。
  const rows = useMemo(
    () => items.filter((i) => i.parent_id === cwd)
      .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh')),
    [items, cwd],
  )
  // 面包屑:顺 parent 链上溯。
  const trail = useMemo(() => {
    const out: Item[] = []
    let p = cwd
    while (p != null) { const it = byId.get(p); if (!it) break; out.unshift(it); p = it.parent_id }
    return out
  }, [cwd, byId])

  const uploadFiles = async (files: File[]) => {
    if (!cur || !canEdit || !files.length) return
    for (const f of files) {
      const key = `${f.name}-${Date.now()}-${Math.random()}`
      setUploads((u) => [...u, { key, name: f.name, percent: 0 }])
      const report = (percent: number) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, percent } : x)))
      try {
        // 选路:大文件/视频走分片(片发给谁由开局探测定),小文件整文件 POST。
        let done = false
        const big = f.size > DIRECT_THRESHOLD || f.type.startsWith('video/')
        if (big) {
          const direct = await probeDirect(me?.direct_upload_endpoint ?? null)
          try {
            done = await directUpload(cur.id, f, cwd, report, direct ? 'presigned' : 'proxy')
          } catch (de) {
            if (!direct) throw de
            sessionStorage.setItem('cg_direct_ok', '0')
            report(0)
            done = await directUpload(cur.id, f, cwd, report, 'proxy')
          }
        }
        if (!done) await xhrUpload(`/api/spaces/${cur.id}/upload${cwd != null ? `?parent_id=${cwd}` : ''}`, f, report)
        message.success(`${f.name} 上传完成`)
      } catch (e) {
        message.error(`${f.name}:${(e as Error).message}`)
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key))
      }
    }
    await Promise.all([loadItems(cur.id), loadSpaces()])
  }

  const refresh = async () => {
    if (!cur) return
    setChecked([])
    await Promise.all([loadItems(cur.id), loadSpaces()])
  }

  // ── 内容操作(editor+)────────────────────────────────────────────────────
  const newItem = (kind: 'folder' | 'doc') => {
    let name = ''
    modal.confirm({
      title: kind === 'folder' ? '新建文件夹' : '新建文档',
      content: <Input placeholder="名称" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        try {
          await api(`/api/spaces/${cur!.id}/items`, { method: 'POST', body: JSON.stringify({ kind, name, parent_id: cwd }) })
          await refresh()
        } catch (e) { message.error((e as Error).message); throw e }
      },
    })
  }
  const rename = (it: Item) => {
    let name = it.name
    modal.confirm({
      title: `重命名「${it.name}」`,
      content: <Input defaultValue={it.name} onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        try {
          await api(`/api/items/${it.id}`, { method: 'PUT', body: JSON.stringify({ name }) })
          await refresh()
        } catch (e) { message.error((e as Error).message); throw e }
      },
    })
  }
  const del = (targets: Item[]) => {
    const names = targets.map((t) => t.name).join('、')
    modal.confirm({
      title: `删除 ${targets.length} 项?`,
      content: <span>{names.slice(0, 120)}{names.length > 120 ? '…' : ''}<br />文件夹会连同其中全部内容一起删除,不可撤销。</span>,
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const t of targets) {
          try { await api(`/api/items/${t.id}`, { method: 'DELETE' }) } catch (e) { message.error(`${t.name}:${(e as Error).message}`) }
        }
        setPreview((p) => (p && targets.some((t) => t.id === p.id) ? null : p))
        await refresh()
      },
    })
  }
  const doMove = async (dest: number | null) => {
    setMoveDest(null)
    for (const t of moving!) {
      try { await api(`/api/items/${t.id}`, { method: 'PUT', body: JSON.stringify({ parent_id: dest }) }) }
      catch (e) { message.error(`${t.name}:${(e as Error).message}`) }
    }
    setMoving(null)
    await refresh()
  }

  // ── 空间所有者操作(admin;只在左栏空间「⋯」里)────────────────────────────
  const spaceMenu = (s: Space) => ({
    items: [
      { key: 'grants', label: '🔑 授权与安全设置' },
      { key: 'rename', label: '✏️ 重命名空间' },
      { type: 'divider' as const },
      { key: 'delete', label: <span style={{ color: '#ff4d4f' }}>🗑 删除空间</span> },
    ],
    onClick: ({ key }: { key: string }) => {
      setCur(s)
      if (key === 'grants') setGrantsOpen(true)
      if (key === 'rename') {
        let name = s.name
        modal.confirm({
          title: '重命名空间',
          content: <Input defaultValue={s.name} onChange={(e) => (name = e.target.value)} />,
          onOk: async () => {
            await api(`/api/spaces/${s.id}`, { method: 'PUT', body: JSON.stringify({ name, description: s.description }) })
            await loadSpaces()
          },
        })
      }
      if (key === 'delete') {
        modal.confirm({
          title: `删除空间「${s.name}」?`,
          content: '空间内全部内容与文件将一并删除,不可撤销。',
          okButtonProps: { danger: true },
          onOk: async () => {
            try {
              await api(`/api/spaces/${s.id}`, { method: 'DELETE' })
              setCur(null); await loadSpaces()
            } catch (e) { message.error((e as Error).message); throw e }
          },
        })
      }
    },
  })

  const newSpace = () => {
    let name = ''
    modal.confirm({
      title: '新建空间',
      content: <Input placeholder="空间名,如「组会记录」「论文库」" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        try {
          await api('/api/spaces', { method: 'POST', body: JSON.stringify({ name }) })
          await loadSpaces()
        } catch (e) { message.error((e as Error).message); throw e }
      },
    })
  }

  const checkedItems = rows.filter((r) => checked.includes(r.id))

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 左栏:空间列表。空间级操作(授权/重命名/删除)只在这里的 ⋯ 菜单,且仅 admin 可见。 */}
      <Card
        size="small" title="空间" style={{ width: 260, flex: '0 0 auto' }}
        extra={<Button size="small" type="primary" onClick={newSpace}>新建</Button>}
      >
        <List
          size="small" dataSource={spaces}
          locale={{ emptyText: <Empty description="还没有可见的空间" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(s) => (
            <List.Item
              onClick={() => setCur(s)}
              style={{ cursor: 'pointer', background: cur?.id === s.id ? '#e6fffb' : undefined, borderRadius: 6, padding: '6px 8px' }}
            >
              <Typography.Text strong={cur?.id === s.id} ellipsis style={{ flex: 1 }}>{s.name}</Typography.Text>
              {s.my_role && ROLE_TAG[s.my_role]}
              {s.my_role === 'admin' && (
                <Dropdown menu={spaceMenu(s)} trigger={['click']}>
                  <Button type="text" size="small" onClick={(e) => e.stopPropagation()} style={{ marginLeft: 2 }}>⋯</Button>
                </Dropdown>
              )}
            </List.Item>
          )}
        />
      </Card>

      {cur ? (
        <Card
          size="small" style={{ flex: 1, minWidth: 0 }}
          styles={{ body: { paddingTop: 8 } }}
          title={
            <Breadcrumb
              items={[
                { title: <a onClick={() => setCwd(null)}>{cur.name}</a> },
                ...trail.map((t) => ({ title: <a onClick={() => setCwd(t.id)}>{t.name}</a> })),
              ]}
            />
          }
          extra={
            <Tooltip title={`已用 ${fmtSize(cur.used_bytes)} / 配额 ${fmtSize(cur.quota_bytes)}`}>
              <span style={{ width: 130, display: 'inline-block' }}>
                <Progress
                  percent={Math.min(100, Math.round((cur.used_bytes / Math.max(1, cur.quota_bytes)) * 100))}
                  size="small" status={cur.used_bytes >= cur.quota_bytes ? 'exception' : 'normal'}
                />
              </span>
            </Tooltip>
          }
        >
          {/* 内容操作工具栏(editor+):只有「在空间里干活」的动作,没有空间管理项。 */}
          {canEdit && (
            <AntSpace style={{ marginBottom: 10 }} wrap>
              <Upload showUploadList={false} multiple
                customRequest={({ file, onSuccess }) => { uploadFiles([file as File]).then(() => onSuccess?.({})) }}>
                <Button type="primary" size="small">⬆ 上传文件</Button>
              </Upload>
              <Button size="small" onClick={() => newItem('folder')}>📁 新建文件夹</Button>
              <Button size="small" onClick={() => newItem('doc')}>📝 新建文档</Button>
              {checkedItems.length > 0 && (
                <>
                  <span style={{ color: '#8c8c8c', fontSize: 12 }}>已选 {checkedItems.length} 项</span>
                  <Button size="small" onClick={() => setMoving(checkedItems)}>移动</Button>
                  <Button size="small" danger onClick={() => del(checkedItems)}>删除</Button>
                </>
              )}
            </AntSpace>
          )}

          {/* 拖拽落区:整张表都能接文件 */}
          <div
            onDragOver={(e) => { e.preventDefault(); if (canEdit) setDragging(true) }}
            onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
            onDrop={(e) => {
              e.preventDefault(); setDragging(false)
              if (canEdit) uploadFiles(Array.from(e.dataTransfer.files).filter((f) => f.size > 0))
            }}
            style={{
              borderRadius: 8, transition: 'all .15s', minHeight: 200,
              outline: dragging ? '2px dashed #0d9488' : 'none',
              background: dragging ? '#e6fffb' : undefined, padding: dragging ? 6 : 0,
            }}
          >
            {uploads.map((u) => (
              <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Typography.Text ellipsis style={{ maxWidth: 300, fontSize: 13 }}>⬆ {u.name}</Typography.Text>
                <Progress percent={u.percent} size="small" style={{ flex: 1, maxWidth: 340 }} />
              </div>
            ))}
            <Table
              size="small" rowKey="id" dataSource={rows} pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={canEdit ? '这里还是空的——上传文件,或把文件拖进来' : '这里还是空的'} /> }}
              rowSelection={canEdit ? { selectedRowKeys: checked, onChange: (k) => setChecked(k as number[]) } : undefined}
              columns={[
                {
                  title: '名称', dataIndex: 'name', ellipsis: true,
                  render: (_, it) => (
                    <a onClick={() => (it.kind === 'folder' ? (setCwd(it.id), setChecked([])) : setPreview(it))}>
                      {KIND_ICON[it.kind]} {it.name}
                    </a>
                  ),
                },
                { title: '大小', dataIndex: 'size', width: 100, render: (v, it) => (it.kind === 'folder' ? '—' : fmtSize(v)) },
                { title: '修改时间', dataIndex: 'updated_at', width: 150, render: (v) => fmtTime(v) },
                { title: '上传者', dataIndex: 'created_by', width: 110, ellipsis: true },
                {
                  title: '操作', width: 190,
                  render: (_, it) => (
                    <AntSpace size={4}>
                      {it.kind !== 'folder' && <a onClick={() => setPreview(it)}>打开</a>}
                      {it.kind !== 'folder' && !(cur.my_role === 'viewer' && cur.viewer_no_download) && (
                        <a href={`/api/items/${it.id}/download`}>下载</a>
                      )}
                      {canEdit && <a onClick={() => rename(it)}>重命名</a>}
                      {canEdit && <a onClick={() => setMoving([it])}>移动</a>}
                      {canEdit && <a style={{ color: '#ff4d4f' }} onClick={() => del([it])}>删除</a>}
                    </AntSpace>
                  ),
                },
              ]}
            />
          </div>

          {/* 预览抽屉:文档编辑器 / 视频播放 / PDF·图片预览 / 版本历史 */}
          <Drawer
            open={!!preview} onClose={() => setPreview(null)} width="62%" destroyOnHidden
            title={preview ? `${KIND_ICON[preview.kind]} ${preview.name}` : ''}
          >
            {preview && (
              <ItemPanel
                key={preview.id} item={preview} canEdit={canEdit}
                noDownload={cur.my_role === 'viewer' && cur.viewer_no_download}
                onChanged={refresh}
              />
            )}
          </Drawer>

          {/* 移动目标选择:只列本空间的文件夹 */}
          <Modal
            open={!!moving} title={`移动 ${moving?.length ?? 0} 项到…`} okText="移动"
            onCancel={() => setMoving(null)}
            onOk={() => doMove(moveDest ?? null)}
          >
            <TreeSelect
              style={{ width: '100%' }} value={moveDest} onChange={setMoveDest} placeholder="选择目标文件夹"
              treeDefaultExpandAll
              treeData={[{
                value: null as unknown as number, title: `📚 ${cur.name}(根目录)`,
                children: folderTree(items, null, moving?.map((m) => m.id) ?? []),
              }]}
            />
          </Modal>
          <GrantsModal space={cur} open={grantsOpen} onClose={() => setGrantsOpen(false)} onChanged={loadSpaces} />
        </Card>
      ) : (
        <Card style={{ flex: 1 }}>
          <Empty description="选择或新建一个空间" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
    </div>
  )
}

/// 移动目标树:只要文件夹,且**排除被移动项自身及其子树**(否则移进自己 = 整棵树消失,
/// 后端也有递归 CTE 防环兜底,这里先在 UI 上不给选)。
type FolderNode = { value: number; title: string; children: FolderNode[] }
function folderTree(items: Item[], parent: number | null, exclude: number[]): FolderNode[] {
  const blocked = new Set(exclude)
  const isBlocked = (it: Item): boolean => {
    let p: number | null = it.id
    while (p != null) {
      if (blocked.has(p)) return true
      p = items.find((x) => x.id === p)?.parent_id ?? null
    }
    return false
  }
  return items
    .filter((i) => i.kind === 'folder' && i.parent_id === parent && !isBlocked(i))
    .map((i) => ({ value: i.id, title: `📁 ${i.name}`, children: folderTree(items, i.id, exclude) }))
}

/// 内容面板(抽屉里):文档编辑/预览 + 版本;视频播放;PDF/图片预览。
function ItemPanel({ item, canEdit, noDownload, onChanged }: {
  item: Item; canEdit: boolean; noDownload: boolean; onChanged: () => void
}) {
  const { message } = AntdApp.useApp()
  const [text, setText] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [docView, setDocView] = useState<'edit' | 'split' | 'preview'>(canEdit ? 'split' : 'preview')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<Version[]>([])

  useEffect(() => {
    if (item.kind === 'doc') {
      api<string>(`/api/items/${item.id}/content`).then(setText).catch((e) => message.error(e.message))
    }
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (label?: string) => {
    await api(`/api/items/${item.id}/content`, { method: 'PUT', body: JSON.stringify({ text, label }) })
    setDirty(false)
    message.success('已保存')
    onChanged()
  }

  return (
    <>
      <AntSpace style={{ marginBottom: 12 }} wrap>
        {item.kind === 'doc' && canEdit && <Button type="primary" size="small" disabled={!dirty} onClick={() => save()}>保存</Button>}
        {item.kind === 'doc' && (
          <Button size="small" onClick={async () => { setVersions(await api<Version[]>(`/api/items/${item.id}/versions`)); setVersionsOpen(true) }}>
            版本历史
          </Button>
        )}
        {item.kind !== 'doc' && (noDownload
          ? <Tag>本空间 viewer 禁下载</Tag>
          : <Button size="small" type="primary" href={`/api/items/${item.id}/download`}>下载 {fmtSize(item.size)}</Button>)}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {item.mime} · {fmtSize(item.size)} · 由 {item.created_by} 上传
        </Typography.Text>
      </AntSpace>

      {item.kind === 'doc' ? (
        text === null ? '加载中…' : (
          <>
            {canEdit && (
              <Segmented
                size="small" value={docView} onChange={(v) => setDocView(v as typeof docView)}
                options={[{ value: 'edit', label: '✏️ 编辑' }, { value: 'split', label: '⇄ 分屏' }, { value: 'preview', label: '👁 预览' }]}
                style={{ marginBottom: 10 }}
              />
            )}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {canEdit && docView !== 'preview' && (
                <Input.TextArea
                  value={text} autoSize={{ minRows: 18, maxRows: 40 }}
                  style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 13 }}
                  placeholder={'# 标题\n\n支持 markdown:**粗体**、列表、表格、`代码`、> 引用…'}
                  onChange={(e) => { setText(e.target.value); setDirty(true) }}
                />
              )}
              {docView !== 'edit' && (
                <div style={{ flex: 1, minWidth: 0, padding: docView === 'split' ? '0 4px' : 0,
                              borderLeft: docView === 'split' ? '1px solid #f0f0f0' : undefined }}>
                  <MarkdownView text={text} />
                </div>
              )}
            </div>
          </>
        )
      ) : item.kind === 'video' ? (
        <video controls preload="metadata" style={{ width: '100%', maxHeight: 520, background: '#000' }}
          src={`/api/items/${item.id}/play`} />
      ) : (
        <FilePreview item={item} />
      )}

      <Drawer title="版本历史" open={versionsOpen} onClose={() => setVersionsOpen(false)} width={420}>
        <List
          size="small" dataSource={versions}
          renderItem={(v) => (
            <List.Item actions={canEdit ? [
              <Popconfirm key="r" title="恢复到此版本?(当前版会自动存为快照)" onConfirm={async () => {
                await api(`/api/items/${item.id}/restore/${v.id}`, { method: 'POST' })
                setVersionsOpen(false)
                setText(await api<string>(`/api/items/${item.id}/content`)); setDirty(false); onChanged()
                message.success('已恢复')
              }}><a>恢复</a></Popconfirm>,
            ] : []}>
              <List.Item.Meta
                title={v.label || `版本 #${v.id}`}
                description={`${v.created_by} · ${new Date(v.created_at).toLocaleString()} · ${fmtSize(v.size)}`}
              />
            </List.Item>
          )}
        />
      </Drawer>
    </>
  )
}


/// 授权管理(admin):user/group × viewer/editor/admin。
function GrantsModal({ space, open, onClose, onChanged }: { space: Space; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { message } = AntdApp.useApp()
  const [grants, setGrants] = useState<Grant[]>([])
  // 默认选「小组」:调研结论(docs/PERMISSIONS.md),按组授权是主战场——整组人(含未来入组者)
  // 动态获得权限,人员流动只改组;按个人授权是例外通道。
  const [gtype, setGtype] = useState<'user' | 'group'>('group')
  const [gid, setGid] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [myGroups, setMyGroups] = useState<{ id: number; name: string }[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [diagName, setDiagName] = useState('')
  const [diag, setDiag] = useState<Diagnose | null>(null)

  const load = useCallback(async () => {
    setGrants(await api<Grant[]>(`/api/spaces/${space.id}/grants`))
    setMyGroups(await api<{ id: number; name: string }[]>('/api/groups'))
    setUsers(await api<UserOpt[]>('/api/users'))
  }, [space.id])
  useEffect(() => {
    if (open) load().catch((e) => message.error(e.message))
  }, [open, load, message])

  const add = async () => {
    if (!gid.trim()) return message.warning('填用户名或选组')
    try {
      await api(`/api/spaces/${space.id}/grants`, {
        method: 'PUT',
        body: JSON.stringify({ grantee_type: gtype, grantee_id: gid.trim(), role }),
      })
      message.success('已授权')
      setGid('')
      await load()
    } catch (e) {
      message.error((e as Error).message) // 假名/降级最后一个 admin 都要让用户看见
    }
  }
  const changeRole = async (g: Grant, r: Role) => {
    try {
      await api(`/api/spaces/${space.id}/grants`, {
        method: 'PUT',
        body: JSON.stringify({ grantee_type: g.grantee_type, grantee_id: g.grantee_id, role: r }),
      })
      message.success('角色已更新')
      await load()
    } catch (e) {
      message.error((e as Error).message)
      await load()
    }
  }

  return (
    <Modal title={`授权管理 — ${space.name}`} open={open} onCancel={onClose} footer={null} width={640}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 10, fontSize: 13 }}>
        推荐按<b>小组</b>授权:整组人(含以后新入组的)自动获得本空间权限,人员流动只需改组成员;按个人授权留给例外情况。
      </Typography.Paragraph>
      {/* D4 空间安全开关:只拦「下载原件」;在线阅读/播放不拦(能播就能录屏,拦了只会逼 viewer 什么都干不了)。 */}
      <AntSpace style={{ marginBottom: 12 }}>
        <Switch
          size="small"
          checked={space.viewer_no_download}
          onChange={async (v) => {
            try {
              await api(`/api/spaces/${space.id}`, {
                method: 'PUT',
                body: JSON.stringify({ name: space.name, description: space.description, viewer_no_download: v }),
              })
              message.success(v ? '已开启:viewer 不能下载原件(阅读/播放不受影响)' : '已关闭下载限制')
              onChanged()
            } catch (e) {
              message.error((e as Error).message)
            }
          }}
        />
        <Typography.Text>viewer 禁止下载原件</Typography.Text>
      </AntSpace>
      <AntSpace style={{ marginBottom: 12 }} wrap>
        <Select value={gtype} onChange={(v) => { setGtype(v); setGid('') }} options={[{ value: 'user', label: '用户' }, { value: 'group', label: '小组' }]} style={{ width: 90 }} />
        {gtype === 'user' ? (
          // 下拉 = 用过汇流的人;也可直接输平台账号(后端 users/exists 向 Keycloak 校验——AI_Talks 0094)。
          <AutoComplete
            placeholder="用户名(平台账号)" value={gid} onChange={setGid} style={{ width: 200 }}
            options={users.map((u) => ({ value: u.username, label: u.name ? `${u.username}(${u.name})` : u.username }))}
            filterOption={(input, opt) => (opt?.value as string).toLowerCase().includes(input.toLowerCase())}
          />
        ) : (
          <Select
            placeholder="选组" value={gid || undefined} onChange={setGid} style={{ width: 200 }}
            options={myGroups.map((g) => ({ value: String(g.id), label: g.name }))}
          />
        )}
        <Select value={role} onChange={setRole} style={{ width: 110 }}
          options={[{ value: 'viewer', label: 'viewer 读' }, { value: 'editor', label: 'editor 读写' }, { value: 'admin', label: 'admin 管理' }]} />
        <Button type="primary" onClick={add}>授权</Button>
      </AntSpace>
      <Table
        size="small" rowKey={(g) => `${g.grantee_type}:${g.grantee_id}`} dataSource={grants} pagination={false}
        columns={[
          { title: '类型', dataIndex: 'grantee_type', render: (t) => (t === 'group' ? <Tag color="cyan">组</Tag> : <Tag>用户</Tag>) },
          { title: '对象', render: (_, g) => g.grantee_name || g.grantee_id },
          {
            title: '角色', dataIndex: 'role',
            // 就地改角色(后端 upsert;最后一个 admin 降级会被 400 挡回)。
            render: (r: Role, g) => (
              <Select size="small" value={r} style={{ width: 120 }} onChange={(v) => changeRole(g, v as Role)}
                options={[{ value: 'viewer', label: 'viewer 读' }, { value: 'editor', label: 'editor 读写' }, { value: 'admin', label: 'admin 管理' }]} />
            ),
          },
          {
            title: '', render: (_, g) => (
              <Popconfirm title="撤销此授权?" onConfirm={async () => {
                await api(`/api/spaces/${space.id}/grants`, { method: 'DELETE', body: JSON.stringify({ grantee_type: g.grantee_type, grantee_id: g.grantee_id }) })
                await load()
              }}><a>撤销</a></Popconfirm>
            ),
          },
        ]}
      />

      {/* 权限诊断:「为什么他能/不能看」——三家共同痛点,Confluence 的付费卖点,我们白送(docs/PERMISSIONS.md 共识 6)。 */}
      <Typography.Title level={5} style={{ marginTop: 18 }}>权限诊断</Typography.Title>
      <AntSpace style={{ marginBottom: 8 }}>
        <AutoComplete
          placeholder="输用户名,看 ta 为什么能/不能访问本空间" value={diagName} onChange={setDiagName} style={{ width: 280 }}
          options={users.map((u) => ({ value: u.username, label: u.name ? `${u.username}(${u.name})` : u.username }))}
          filterOption={(input, opt) => (opt?.value as string).toLowerCase().includes(input.toLowerCase())}
        />
        <Button onClick={async () => {
          if (!diagName.trim()) return
          try {
            setDiag(await api<Diagnose>(`/api/spaces/${space.id}/diagnose?username=${encodeURIComponent(diagName.trim())}`))
          } catch (e) {
            message.error((e as Error).message)
          }
        }}>诊断</Button>
      </AntSpace>
      {diag && (
        <Typography.Paragraph style={{ fontSize: 13, background: '#f6ffed', padding: 10, borderRadius: 6 }}>
          <b>{diag.username}</b> 的判定链:超管 {diag.is_super ? '✅(直接 admin)' : '否'} →
          直接授权 {diag.direct ? <Tag>{diag.direct}</Tag> : '无'} →
          组授权 {diag.via_groups.length ? diag.via_groups.map((g) => <Tag key={g.group_id} color="cyan">{g.group}:{g.role}</Tag>) : '无'} →
          <b> 有效角色:{diag.effective ? <Tag color="green">{diag.effective}</Tag> : <Tag color="red">无权访问</Tag>}</b>
        </Typography.Paragraph>
      )}
    </Modal>
  )
}
