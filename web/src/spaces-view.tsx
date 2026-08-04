// 空间视图:左列空间列表,右侧选中空间的文件树 + 内容面板。
// 前端只做显隐(my_role),真判权在后端(perm.rs)——按钮藏了 API 也会 403,别当安全边界。
import {
  Alert, App as AntdApp, AutoComplete, Breadcrumb, Button, Card, Drawer, Dropdown, Empty, Input, List, Modal, Popconfirm,
  Progress, Segmented, Select, Space as AntSpace, Switch, Table, Tag, Tooltip, TreeSelect, Typography, Upload,
} from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, LinkOutlined, SwapOutlined } from '@ant-design/icons'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkdownView, FilePreview, ItemIcon, fmtSize } from './preview'
import { VideoPlayer, openViewer } from './video-player'
import {
  CANCELED, DIRECT_THRESHOLD, cancelUpload, directUpload, newCtl, probeDirect, xhrUpload, type UploadCtl,
} from './upload'

/// ★同时最多传几个★(2026-08-03 用户反馈:一次拖 50 个文件不能 50 并发)。
/// 取 3:再多也吃不到带宽(单文件内部已按 8MiB 分片顺序发满管道),反而会 ①把浏览器每域 6 连接
/// 全占死,连列表刷新都排不上队;②预签直传时 50 份 begin 同时打 registry/Garage。
/// 其余排队,队列里的任务用户也能取消(点取消直接出队,不占位)。
const UPLOAD_CONCURRENCY = 3

/// 「上一层」伪行的 id。用一个很大的负数,和上传伪行(-1、-2…)拉开距离,互不打架。
const PARENT_ROW_ID = -1_000_000

/// 上传任务(表格里以「伪行」呈现,id 取负数与真实 item 区分)。
type UpTask = { key: string; file: File; percent: number; running: boolean; ctl: UploadCtl }
import { api, type Diagnose, type Grant, type Item, type Me, type Role, type Space, type UserOpt, type Version } from './api'

/// ★角色只有四个词(2026-08-03 用户定):管理员 / 可编辑 / 只读 / 无权限。★
/// 「无权限」是**没有任何授权**的第四态,库里不存它——`effective = null` 即是。
/// 库里存的仍是 viewer/editor/admin:迁移只增不改,换值要重写 space_grants 全表并同步 perm.rs,
/// 收益只是换个字面。所以只在这里做**唯一一处**「存储值 → 用词」映射,别在别处再写第二套。
const ROLE_LABEL: Record<Role, string> = { admin: '管理员', editor: '可编辑', viewer: '只读' }
const NO_ACCESS = '无权限'
const ROLE_TAG: Record<Role, ReactNode> = {
  admin: <Tag color="purple">{ROLE_LABEL.admin}</Tag>,
  editor: <Tag color="green">{ROLE_LABEL.editor}</Tag>,
  viewer: <Tag>{ROLE_LABEL.viewer}</Tag>,
}
const ROLE_OPTIONS = (['viewer', 'editor', 'admin'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))

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
export function SpacesView({ me, shareItemId }: { me: Me | null; shareItemId?: number | null }) {
  const { message, modal } = AntdApp.useApp()
  const [spaces, setSpaces] = useState<Space[]>([])
  const [cur, setCur] = useState<Space | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [cwd, setCwd] = useState<number | null>(null) // 当前所在文件夹(null = 空间根)
  const [checked, setChecked] = useState<number[]>([]) // 批量选中
  const [preview, setPreview] = useState<Item | null>(null)
  const [grantsOpen, setGrantsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads] = useState<UpTask[]>([])
  const [moving, setMoving] = useState<Item[] | null>(null) // 待移动的项(单个或批量)
  const [moveDest, setMoveDest] = useState<number | null>(null) // 移动目标文件夹(null = 根)
  const [shareErr, setShareErr] = useState<string | null>(null)  // 分享链接打不开时的说明

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

  /// 排序(2026-08-04 用户要求)。**文件夹恒在前**,排序只在同类之间比——网盘/资源管理器都是这个惯例,
  /// 按大小排时也不该把文件夹混进文件堆里。
  /// 名称用 localeCompare('zh', {numeric:true}):带数字的文件名(20260723… / 20260730…)按数值排,
  /// 不然 "10" 会排在 "9" 前面。
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'created_at' | 'created_by'>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const rows = useMemo(() => {
    const cmp = (a: Item, b: Item) => {
      switch (sortKey) {
        case 'size': return (a.size ?? 0) - (b.size ?? 0)
        case 'created_at': return a.created_at.localeCompare(b.created_at)
        case 'created_by': return a.created_by.localeCompare(b.created_by, 'zh')
        default: return a.name.localeCompare(b.name, 'zh', { numeric: true })
      }
    }
    return items.filter((i) => i.parent_id === cwd).sort(
      (a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || (sortAsc ? cmp(a, b) : -cmp(a, b)),
    )
  }, [items, cwd, sortKey, sortAsc])
  // 面包屑:顺 parent 链上溯。
  const trail = useMemo(() => {
    const out: Item[] = []
    let p = cwd
    while (p != null) { const it = byId.get(p); if (!it) break; out.unshift(it); p = it.parent_id }
    return out
  }, [cwd, byId])

  // 上传:先整批入队(立刻在表里出现带进度的伪行),再由 UPLOAD_CONCURRENCY 个 worker 取着做。
  // 上传中的任务在表里占「伪行」:id 取负,靠 Map 反查回任务(rowKey 仍是 id,不用改 Table)。
  const upRows = useMemo(
    () => uploads.map((u, i) => ({
      id: -(i + 1), parent_id: cwd, kind: 'file' as const, name: u.file.name,
      size: u.file.size, mime: u.file.type || null, created_by: me?.username ?? '', created_at: '', updated_at: '',
    })),
    [uploads, cwd, me],
  )
  const up = (it: Item): UpTask | null => (it.id < 0 && it.id !== PARENT_ROW_ID ? uploads[-it.id - 1] ?? null : null)
  // 「上一层」行:进了子目录才有。面包屑够用但不好点(2026-08-04 反馈),列表里给一行更顺手。
  const parentRow: Item[] = cwd == null ? [] : [{
    id: PARENT_ROW_ID, parent_id: null, kind: 'folder', name: '..',
    size: null, mime: null, created_by: '', created_at: '', updated_at: '',
  }]
  const goUp = () => { setCwd(cwd == null ? null : byId.get(cwd)?.parent_id ?? null); setChecked([]) }

  const uploadFiles = async (files: File[]) => {
    if (!cur || !canEdit || !files.length) return
    const sid = cur.id, dir = cwd
    const stamp = Date.now()
    const tasks: UpTask[] = files.map((f, i) => ({ key: `${stamp}-${i}-${f.name}`, file: f, percent: 0, running: false, ctl: newCtl() }))
    setUploads((u) => [...u, ...tasks])
    const patch = (key: string, p: Partial<UpTask>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)))

    const runOne = async (t: UpTask) => {
      if (t.ctl.canceled) return // 排队期间就被取消了,连 begin 都不用发
      patch(t.key, { running: true })
      const f = t.file
      const report = (percent: number) => patch(t.key, { percent })
      // 断点续传命中时说一声:否则用户会以为进度条从 60% 起跳是出了错(2026-08-04 P2)。
      const resumed = (parts: number, bytes: number) =>
        message.info(`${f.name}:从断点继续,已跳过 ${parts} 片(${fmtSize(bytes)})`)
      try {
        // 选路:大文件/视频走分片(片发给谁由开局探测定),小文件整文件 POST。
        let done = false
        const big = f.size > DIRECT_THRESHOLD || f.type.startsWith('video/')
        if (big) {
          const direct = await probeDirect(me?.direct_upload_endpoint ?? null)
          try {
            done = await directUpload(sid, f, dir, report, direct ? 'presigned' : 'proxy', t.ctl, resumed)
          } catch (de) {
            if (!direct || t.ctl.canceled) throw de
            sessionStorage.setItem('cg_direct_ok', '0')
            report(0)
            done = await directUpload(sid, f, dir, report, 'proxy', t.ctl, resumed)
          }
        }
        if (!done) await xhrUpload(`/api/spaces/${sid}/upload${dir != null ? `?parent_id=${dir}` : ''}`, f, report, t.ctl)
        message.success(`${f.name} 上传完成`)
      } catch (e) {
        // 取消是用户自己按的,不当错误刷红(directUpload 的 catch 已顺手 abort 掉半截 multipart)。
        if (t.ctl.canceled || (e as Error).message === CANCELED) message.info(`${f.name} 已取消`)
        // 失败时半截上传**保留**着(只有主动取消才清):告诉用户重拖即可续,别让他以为要从头来。
        else message.error(`${f.name}:${(e as Error).message}——把同一个文件再拖进来可从断点继续(24 小时内有效)`)
      } finally {
        setUploads((u) => u.filter((x) => x.key !== t.key))
      }
    }

    const queue = [...tasks]
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, tasks.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) await runOne(t)
    }))
    await Promise.all([loadItems(sid), loadSpaces()])
  }

  /// 取消:中断在传的 xhr(排队中的只置标记,worker 取到时跳过),行立刻消失。
  const cancelOne = (t: UpTask) => { cancelUpload(t.ctl); if (!t.running) setUploads((u) => u.filter((x) => x.key !== t.key)) }

  /// 复制分享链接。**不是公开链接**——链接只是「直达地址」,谁点开都要登录且必须是本空间成员,
  /// 权限仍由后端 require_role 判(前端连隐藏都算不上安全边界)。
  const copyShare = async (it: Item) => {
    const url = `${window.location.origin}/i/${it.id}`
    try {
      await navigator.clipboard.writeText(url)
      message.success({ content: `链接已复制:${it.kind === 'folder' ? '文件夹' : '文件'}「${it.name}」——只有本空间成员打得开`, duration: 4 })
    } catch {
      // 剪贴板 API 要安全上下文/用户授权,失败就把链接摆出来让用户自己复制。
      modal.info({ title: '分享链接(只有本空间成员打得开)', content: <Input readOnly value={url} onFocus={(e) => e.target.select()} /> })
    }
  }

  // 分享链接 /i/{id}:解析一次,定位到空间并打开对应内容。
  // 没权限(403)/已删(404)时给一句人话,而不是让用户对着空列表发呆。
  useEffect(() => {
    if (shareItemId == null || !spaces.length) return
    let done = false
    ;(async () => {
      try {
        const it = await api<Item>(`/api/items/${shareItemId}`)
        const sp = spaces.find((x) => x.id === it.space_id)
        if (!sp) { setShareErr('这条链接指向的空间你没有访问权限——找空间管理员开通'); return }
        if (done) return
        setCur(sp)
        if (it.kind === 'folder') setCwd(it.id)
        else { setCwd(it.parent_id); setPreview(it) }
      } catch (e) {
        const m = (e as Error).message
        setShareErr(m.includes('forbidden') ? '这条链接指向的内容你没有访问权限——找空间管理员开通'
          : m.includes('not found') ? '这条链接指向的内容已被删除' : `打不开这条链接:${m}`)
      }
    })()
    return () => { done = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareItemId, spaces.length])

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
    <>
      {/* 分享链接打不开:给一句人话,而不是让用户对着空列表发呆 */}
      {shareErr && (
        <Alert type="warning" showIcon closable style={{ marginBottom: 12 }}
          message="分享链接打不开" description={shareErr} onClose={() => setShareErr(null)} />
      )}
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
            <Table
              size="small" rowKey="id" dataSource={[...parentRow, ...upRows, ...rows]} pagination={false}
              // 受控排序:伪行(..、上传中)不能被卷进排序,所以自己算 dataSource,
              // 这里只把表头的箭头状态同步过去。
              onChange={(_p, _f, so) => {
                const s2 = Array.isArray(so) ? so[0] : so
                const k = (s2?.field as typeof sortKey) || 'name'
                setSortKey(k)
                setSortAsc(s2?.order !== 'descend')
              }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={canEdit ? '这里还是空的——上传文件,或把文件拖进来' : '这里还是空的'} /> }}
              rowSelection={canEdit ? {
                selectedRowKeys: checked, onChange: (k) => setChecked((k as number[]).filter((x) => x > 0)),
                getCheckboxProps: (it) => ({ disabled: !!up(it) || it.id === PARENT_ROW_ID }),
              } : undefined}
              columns={[
                {
                  // 不设 width、不 ellipsis:名称吃满剩余宽度,长文件名整行显示(2026-08-04 反馈显示不全)。
                  title: '名称', dataIndex: 'name',
                  sorter: true, sortOrder: sortKey === 'name' ? (sortAsc ? 'ascend' : 'descend') : null,
                  render: (_, it) => (it.id === PARENT_ROW_ID
                    ? <a onClick={goUp}><ItemIcon it={it} /><span style={{ fontFamily: 'ui-monospace, monospace' }}>..</span></a>
                    : up(it)
                    ? <Typography.Text type="secondary" ellipsis>⬆ {it.name}</Typography.Text>
                    : (
                      <a onClick={() => (it.kind === 'folder' ? (setCwd(it.id), setChecked([])) : setPreview(it))}>
                        <ItemIcon it={it} />{it.name}
                      </a>
                    )),
                },
                { title: '大小', dataIndex: 'size', width: 100,
                  sorter: true, sortOrder: sortKey === 'size' ? (sortAsc ? 'ascend' : 'descend') : null, render: (v, it) => (it.kind === 'folder' ? '—' : fmtSize(v)) },
                // ★展示上传时间而不是修改时间★(2026-08-05 反馈):移动/重命名都会刷新 updated_at,
                // 「挪个位置修改时间就变了」很反直觉;created_at 才是用户心里的「什么时候传的」。
                { title: '上传时间', dataIndex: 'created_at', width: 150,
                  sorter: true, sortOrder: sortKey === 'created_at' ? (sortAsc ? 'ascend' : 'descend') : null, render: (v, it) => (up(it) || it.id === PARENT_ROW_ID ? '—' : fmtTime(v)) },
                { title: '上传者', dataIndex: 'created_by', width: 110, ellipsis: true,
                  sorter: true, sortOrder: sortKey === 'created_by' ? (sortAsc ? 'ascend' : 'descend') : null },
                {
                  // ★图标化★(2026-08-04 反馈:操作列太宽,把文件名挤没了)。
                  // 「打开」去掉——点名称就是打开,重复给一个按钮只是占地方;
                  // 其余四个动作用图标 + hover 出文字,列宽从 220 收到 132,省下的全给名称列。
                  title: '操作', width: 158,
                  render: (_, it) => (it.id === PARENT_ROW_ID ? null : up(it) ? (
                    // ★上传中的行:进度条 + 取消★(2026-08-03 用户要求)。排队中的显示「排队中」,
                    // 它还没发任何请求,取消 = 直接出队。
                    <AntSpace size={6} style={{ width: '100%' }}>
                      {up(it)!.running
                        ? <Progress percent={up(it)!.percent} size="small" style={{ width: 120 }} />
                        : <Typography.Text type="secondary" style={{ fontSize: 12, width: 120 }}>排队中…</Typography.Text>}
                      <a style={{ color: '#ff4d4f' }} onClick={() => cancelOne(up(it)!)}>取消</a>
                    </AntSpace>
                  ) : (
                    <AntSpace size={10}>
                      {/* 分享:文件与文件夹都能分享;链接不公开,只有本空间成员打得开 */}
                      <Tooltip title="复制分享链接"><a onClick={() => copyShare(it)}><LinkOutlined /></a></Tooltip>
                      {it.kind !== 'folder' && !(cur.my_role === 'viewer' && cur.viewer_no_download) && (
                        <Tooltip title="下载"><a href={`/api/items/${it.id}/download`}><DownloadOutlined /></a></Tooltip>
                      )}
                      {canEdit && <Tooltip title="重命名"><a onClick={() => rename(it)}><EditOutlined /></a></Tooltip>}
                      {/* 移动用 SwapOutlined(双向箭头),2026-08-04 用户看过 16 个候选的真实渲染后定的。
                          试过 FolderOpenOutlined(撞「打开文件夹」)、ExportOutlined(像「导出/新窗口」)、
                          SendOutlined(纸飞机,用户嫌丑)。hover 的「移动到…」补足语义。 */}
                      {canEdit && <Tooltip title="移动到…"><a onClick={() => setMoving([it])}><SwapOutlined /></a></Tooltip>}
                      {canEdit && (
                        <Tooltip title="删除">
                          <a style={{ color: '#ff4d4f' }} onClick={() => del([it])}><DeleteOutlined /></a>
                        </Tooltip>
                      )}
                    </AntSpace>
                  )),
                },
              ]}
            />
          </div>

          {/* 预览抽屉:文档编辑器 / 视频播放 / PDF·图片预览 / 版本历史 */}
          <Drawer
            // PDF/图片给更宽的抽屉(62% 下 A4 排版字太小),文档与视频维持 62%
            open={!!preview} onClose={() => setPreview(null)} destroyOnHidden
            width={preview?.mime === 'application/pdf' || preview?.mime?.startsWith('image/') ? '82%' : '62%'}
            title={preview && <><ItemIcon it={preview} />{preview.name}</>}
            // 打开着也能直接分享当前这份内容(不用退回列表再找那一行)
            extra={preview && <Button size="small" icon={<LinkOutlined />} onClick={() => copyShare(preview)}>复制链接</Button>}
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
          {/* key 按空间:这个面板是常驻挂载的(不是 open 才渲染),不给 key 的话切到别的空间时
              术语表输入框、诊断结果这些内部 state 会留着上一个空间的值——保存就把 A 的词写进 B
              (2026-08-04 审计发现,v0.3.29 引入)。 */}
          <GrantsModal key={cur.id} space={cur} open={grantsOpen} onClose={() => setGrantsOpen(false)} onChanged={loadSpaces} />
        </Card>
      ) : (
        <Card style={{ flex: 1 }}>
          <Empty description="选择或新建一个空间" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
    </div>
    </>
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
        {item.kind !== 'video' && <Button size="small" onClick={() => openViewer(item.id)}>🗗 新窗口打开</Button>}
        {item.kind === 'doc' && (
          <Button size="small" onClick={async () => { setVersions(await api<Version[]>(`/api/items/${item.id}/versions`)); setVersionsOpen(true) }}>
            版本历史
          </Button>
        )}
        {item.kind !== 'doc' && (noDownload
          ? <Tag>本空间「只读」不能下载</Tag>
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
        <VideoPlayer item={item} />
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


/// 授权管理(空间管理员):user/group × 只读/可编辑/管理员。
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
  /// 按输入的前缀查人(后端只回 20 条、且必须带 q)。原来是进页面就把全所名单拉下来,
  /// 任何登录用户都能拿到完整人员表——2026-08-04 审计收紧,前端跟着改成按需查。
  const searchUsers = useCallback(async (q: string) => {
    const t = q.trim()
    if (!t) { setUsers([]); return }
    try { setUsers(await api<UserOpt[]>(`/api/users?q=${encodeURIComponent(t)}`)) } catch { setUsers([]) }
  }, [])
  const [diagName, setDiagName] = useState('')
  const [diag, setDiag] = useState<Diagnose | null>(null)
  const [hot, setHot] = useState(space.hotwords ?? '') // 术语表编辑框(受控;保存后由 onChanged 拉新值)

  const load = useCallback(async () => {
    setGrants(await api<Grant[]>(`/api/spaces/${space.id}/grants`))
    setMyGroups(await api<{ id: number; name: string }[]>('/api/groups'))
    setUsers([]) // 名单不再整表下发(审计收紧):改成输入前缀时才查,见 searchUsers
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
              message.success(v ? '已开启:「只读」成员不能下载原件(阅读/播放不受影响)' : '已关闭下载限制')
              onChanged()
            } catch (e) {
              message.error((e as Error).message)
            }
          }}
        />
        <Typography.Text>「只读」成员禁止下载原件</Typography.Text>
      </AntSpace>

      {/* ★转写术语表★(v0.3.29):落到空间而不是全局——人名/专业词天然按组不同,
          思想史组的「柯老师」和 CS 组的「benchmark」互不相干,也只有空间管理员知道自己组的词。
          填错的代价是真的:平台侧是拼音模糊匹配的确定性替换,词表乱填会把正常的字改坏,
          所以文案里明说「宁少勿滥」。改完只对**之后**的转写生效,老视频要重新生成。 */}
      <Typography.Text strong style={{ fontSize: 13 }}>录屏转写术语表</Typography.Text>
      {/* 长说明按用户要求删了(2026-08-04):「宁少勿滥、拼音匹配会改坏字」这条压进 placeholder,
          完整背景在 docs/PERMISSIONS.md 与 media_ai.rs 的注释里,别再往界面上堆。 */}
      <Input.TextArea
        rows={3} value={hot} onChange={(e) => setHot(e.target.value)} style={{ marginBottom: 6 }}
        placeholder="人名、专业词,空格或换行分隔;宁少勿滥(按拼音匹配,乱填会把正常的字改坏)"
      />
      <AntSpace style={{ marginBottom: 14 }}>
        <Button size="small" type="primary" disabled={hot === (space.hotwords ?? '')} onClick={async () => {
          try {
            await api(`/api/spaces/${space.id}`, {
              method: 'PUT',
              body: JSON.stringify({ name: space.name, description: space.description, hotwords: hot }),
            })
            message.success('术语表已保存(对之后的转写生效)')
            onChanged()
          } catch (e) { message.error((e as Error).message) }
        }}>保存术语表</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hot.trim() ? `${hot.trim().split(/\s+/).length} 个词` : '未设置'}
        </Typography.Text>
      </AntSpace>
      <AntSpace style={{ marginBottom: 12 }} wrap>
        <Select value={gtype} onChange={(v) => { setGtype(v); setGid('') }} options={[{ value: 'user', label: '用户' }, { value: 'group', label: '小组' }]} style={{ width: 90 }} />
        {gtype === 'user' ? (
          // 下拉 = 用过汇流的人;也可直接输平台账号(后端 users/exists 向 Keycloak 校验——AI_Talks 0094)。
          <AutoComplete
            placeholder="用户名(平台账号)" value={gid} onChange={setGid} style={{ width: 200 }}
            onSearch={searchUsers}
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
          options={ROLE_OPTIONS} />
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
                options={ROLE_OPTIONS} />
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
          onSearch={searchUsers}
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
      {/* ★只给结论★(2026-08-03 用户定):原来把「超管→直接授权→组授权→有效角色」整条判定链摊开,
          看的人要自己在脑子里做一次合并。现在直接是「谁 = 什么角色」,来源压成一句灰字小注
          (要的就是「他凭什么」这一句,再多就又变成判定链了)。 */}
      {diag && (
        <div style={{ fontSize: 14, background: '#f6ffed', padding: '10px 12px', borderRadius: 6 }}>
          <b>{diag.username}</b> ：{diag.effective
            ? <Tag color="green">{ROLE_LABEL[diag.effective]}</Tag>
            : <Tag color="red">{NO_ACCESS}</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {diag.is_super ? '（超级管理员）'
              : diag.direct ? '（直接授权）'
              : diag.via_groups.length ? `（来自小组：${diag.via_groups.map((g) => g.group).join('、')}）`
              : '（没有任何授权）'}
          </Typography.Text>
        </div>
      )}
    </Modal>
  )
}
