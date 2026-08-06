// 项目视图:左列项目列表,右侧选中项目的文件树 + 内容面板。
// 前端只做显隐(my_role),真判权在后端(perm.rs)——按钮藏了 API 也会 403,别当安全边界。
import {
  Alert, App as AntdApp, Breadcrumb, Button, Card, Drawer, Dropdown, Empty, Input, List, Modal, Popconfirm,
  Progress, Segmented, Select, Space as AntSpace, Switch, Table, Tag, Tooltip, TreeSelect, Typography, Upload,
} from 'antd'
import {
  DeleteOutlined, DownloadOutlined, EditOutlined, FileAddOutlined, FolderAddOutlined,
  ShareAltOutlined, SwapOutlined, UploadOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownView, FilePreview, ItemIcon, fmtSize } from './preview'
import { VideoPlayer, openViewer } from './video-player'
import { Analysis } from './analysis'
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
type UpTask = { key: string; file: File; percent: number; running: boolean; ctl: UploadCtl; hashing?: boolean }
import { fileSha256 } from './sha256'
import { api, type Diagnose, type Item, type Me, type Role, type Project, type UserOpt, type Version, type Member, type MemberList } from './api'

/// ★角色只有四个词(2026-08-03 用户定):管理员 / 可编辑 / 只读 / 无权限。★
/// 「无权限」是**没有任何授权**的第四态,库里不存它——`effective = null` 即是。
/// 库里存的仍是 viewer/editor/admin:迁移只增不改,换值要重写 space_grants 全表并同步 perm.rs,
/// 收益只是换个字面。所以只在这里做**唯一一处**「存储值 → 用词」映射,别在别处再写第二套。
const ROLE_LABEL: Record<Role, string> = { admin: '管理员', editor: '可编辑', viewer: '只读' }
const ROLE_TAG: Record<Role, ReactNode> = {
  admin: <Tag color="purple">{ROLE_LABEL.admin}</Tag>,
  editor: <Tag color="green">{ROLE_LABEL.editor}</Tag>,
  viewer: <Tag>{ROLE_LABEL.viewer}</Tag>,
}

function fmtTime(s: string) {
  const d = new Date(s)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/// 网盘式项目视图(2026-08-03 重做)。**两套操作严格分开**:
/// - 项目所有者的事(授权管理 / 安全设置 / 重命名项目 / 删除项目)→ 只在左栏项目行的
///   「⋯」菜单里,且仅 space admin 可见;
/// - 项目里的内容操作(上传 / 新建 / 下载 / 重命名 / 移动 / 删除)→ 右侧工具栏与每行操作列,
///   editor 及以上可用。
/// 导航是「进文件夹 + 面包屑」而非一棵永远展开的树(内容多了树没法看)。
export function ProjectsView({ me }: { me: Me | null }) {
  const { message, modal } = AntdApp.useApp()
  const [projects, setProjects] = useState<Project[]>([])
  /// 左栏搜索关键词(只过滤已加载的列表,不打接口)
  const [kw, setKw] = useState('')
  /// 归档筛选(D17):默认只看进行中 —— 列表是「我手头的活」,结题的不该抢视线
  const [scope, setScope] = useState<'active' | 'archived'>('active')
  const [cur, setCur] = useState<Project | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [cwd, setCwd] = useState<number | null>(null) // 当前所在文件夹(null = 项目根)
  const [checked, setChecked] = useState<number[]>([]) // 批量选中
  const [preview, setPreview] = useState<Item | null>(null)
  const [grantsOpen, setGrantsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads] = useState<UpTask[]>([])
  const [moving, setMoving] = useState<Item[] | null>(null) // 待移动的项(单个或批量)
  const [moveDest, setMoveDest] = useState<number | null>(null) // 移动目标文件夹(null = 根)
  const [shareFor, setShareFor] = useState<Item[] | null>(null) // 正在设置公开分享的那些项(可多选)
  const [trashOpen, setTrashOpen] = useState(false)             // 回收站抽屉

  const loadProjects = useCallback(async () => {
    const s = await api<Project[]>('/api/projects')
    setProjects(s)
    setCur((c) => (c ? s.find((x: Project) => x.id === c.id) || null : null))
  }, [])
  const loadItems = useCallback(async (pid: number) => {
    setItems(await api<Item[]>(`/api/projects/${pid}/items`))
  }, [])
  useEffect(() => {
    loadProjects().catch((e) => message.error(e.message))
  }, [loadProjects, message])
  useEffect(() => {
    setCwd(null); setChecked([]); setPreview(null)
    if (cur) loadItems(cur.id).catch((e) => message.error(e.message))
  }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /// ★归档项目是只读的(D17)★:后端会 409 拒绝一切写操作,前端就不该把按钮亮着 ——
  /// 横幅写着「不能再上传」、按钮却还能点,等于在骗人点一次才告诉他不行。
  /// ⚠ 这不是安全边界(真闸在后端 require_role),只是别让界面说谎。
  const readOnly = !!cur?.archived_at
  const canEdit = (cur?.my_role === 'editor' || cur?.my_role === 'admin') && !readOnly
  /// 只读时仍然显示的工具栏(回收站是**读**,归档项目照样该能查看已删内容)
  const showToolbar = cur?.my_role === 'editor' || cur?.my_role === 'admin'
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
    const pid = cur.id, dir = cwd
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
        // ★秒传预检★(2026-08-05):先在本地按块算 SHA-256(不吃内存,GB 级也行),
        // 服务端若发现**我本来就能读到**同内容的文件,直接建引用、零字节传输。
        // 读不到的同内容不给秒传——那是百度网盘那个「知道哈希就能认领别人文件」的坑。
        patch(t.key, { hashing: true })
        let sha = ''
        try { sha = await fileSha256(f, (p) => patch(t.key, { percent: Math.round(p * 0.15) })) } catch { /* 算不出就照常传 */ }
        patch(t.key, { hashing: false })
        if (t.ctl.canceled) throw new Error(CANCELED)
        if (sha) {
          try {
            const pre = await api<{ instant: boolean }>(`/api/projects/${pid}/precheck`, {
              method: 'POST',
              body: JSON.stringify({ sha256: sha, size: f.size, name: f.name, mime: f.type || null, parent_id: dir }),
            })
            if (pre.instant) { message.success(`${f.name} 秒传完成(库里已有同样内容)`); return }
          } catch { /* 预检失败不影响正常上传 */ }
        }
        // 选路:大文件/视频走分片(片发给谁由开局探测定),小文件整文件 POST。
        let done = false
        const big = f.size > DIRECT_THRESHOLD || f.type.startsWith('video/')
        if (big) {
          const direct = await probeDirect(me?.direct_upload_endpoint ?? null)
          try {
            done = await directUpload(pid, f, dir, report, direct ? 'presigned' : 'proxy', t.ctl, resumed, sha)
          } catch (de) {
            if (!direct || t.ctl.canceled) throw de
            sessionStorage.setItem('cg_direct_ok', '0')
            report(0)
            done = await directUpload(pid, f, dir, report, 'proxy', t.ctl, resumed, sha)
          }
        }
        if (!done) await xhrUpload(`/api/projects/${pid}/upload${dir != null ? `?parent_id=${dir}` : ''}`, f, report, t.ctl)
        // 录屏/录音传完后端会自动排队生成纪要(v0.3.49),这里说一声,免得用户以为要手动点。
        const auto = f.type.startsWith('video/') || f.type.startsWith('audio/')
        message.success(`${f.name} 上传完成${auto ? '——已自动排队生成纪要' : ''}`)
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
    await Promise.all([loadItems(pid), loadProjects()])
  }

  /// 取消:中断在传的 xhr(排队中的只置标记,worker 取到时跳过),行立刻消失。
  const cancelOne = (t: UpTask) => { cancelUpload(t.ctl); if (!t.running) setUploads((u) => u.filter((x) => x.key !== t.key)) }

  const refresh = async () => {
    if (!cur) return
    setChecked([])
    await Promise.all([loadItems(cur.id), loadProjects()])
  }

  // ── 内容操作(editor+)────────────────────────────────────────────────────
  const newItem = (kind: 'folder' | 'doc') => {
    let name = ''
    modal.confirm({
      title: kind === 'folder' ? '新建文件夹' : '新建文档',
      content: <Input placeholder="名称" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        try {
          await api(`/api/projects/${cur!.id}/items`, { method: 'POST', body: JSON.stringify({ kind, name, parent_id: cwd }) })
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
      // 软删除之后文案要改:不再是「不可撤销」,而是「进回收站、30 天内可还原」(2026-08-05)。
      content: <span>{names.slice(0, 120)}{names.length > 120 ? '…' : ''}<br />
        文件夹会连同其中全部内容一起放进<b>回收站</b>,30 天内可以还原。</span>,
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

  // ── 项目所有者操作(admin;只在左栏项目「⋯」里)────────────────────────────
  const spaceMenu = (s: Project) => ({
    items: [
      { key: 'members', label: '成员与设置' },
      { key: 'rename', label: '✏️ 重命名项目', disabled: !!s.archived_at },
      { type: 'divider' as const },
      // ★归档与删除是两件事,菜单里也要分开★:归档=做完了留着查,删除=不要了。
      // 放在分隔线之后、删除之前,让「结题」有个比「删掉」轻的出口。
      { key: 'archive', label: s.archived_at ? '↩ 恢复为进行中' : '📦 归档项目' },
      { key: 'delete', label: <span style={{ color: '#ff4d4f' }}>🗑 删除项目</span> },
    ],
    onClick: ({ key }: { key: string }) => {
      setCur(s)
      if (key === 'members') setGrantsOpen(true)
      if (key === 'rename') {
        let name = s.name
        modal.confirm({
          title: '重命名项目',
          content: <Input defaultValue={s.name} onChange={(e) => (name = e.target.value)} />,
          onOk: async () => {
            await api(`/api/projects/${s.id}`, { method: 'PUT', body: JSON.stringify({ name, description: s.description }) })
            await loadProjects()
          },
        })
      }
      if (key === 'archive') {
        const on = !s.archived_at
        modal.confirm({
          title: on ? '归档这个项目？' : '恢复为进行中？',
          content: on ? (
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              归档后它变成<b>只读存档</b>：
              <div style={{ color: '#389e0d' }}>· 材料、会议、纪要全部保留，照样能看、能下载、能搜到</div>
              <div style={{ color: '#cf1322' }}>· 不能再上传、建会议、改内容</div>
              <div style={{ color: '#8c8c8c' }}>· 它的会议不再出现在日历上，也不再让成员显示「忙」</div>
              <div style={{ color: '#8c8c8c' }}>· 占用的空间仍然计入配额（东西还在）</div>
              <div style={{ marginTop: 6 }}>随时可以恢复。<b>这不是删除</b>——要清理空间请用「删除项目」。</div>
            </div>
          ) : '恢复后就能继续往里加东西了。',
          okText: on ? '归档' : '恢复',
          onOk: async () => {
            await api(`/api/projects/${s.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: on }) })
            message.success(on ? '已归档' : '已恢复为进行中')
            await loadProjects()
          },
        })
      }
      if (key === 'delete') {
        modal.confirm({
          title: `删除项目「${s.name}」?`,
          content: '项目内全部内容与文件将一并删除,不可撤销。',
          okButtonProps: { danger: true },
          onOk: async () => {
            try {
              await api(`/api/projects/${s.id}`, { method: 'DELETE' })
              setCur(null); await loadProjects()
            } catch (e) { message.error((e as Error).message); throw e }
          },
        })
      }
    },
  })

  const newSpace = () => {
    let name = ''
    modal.confirm({
      title: '新建项目',
      content: <Input placeholder="项目名,如「组会记录」「论文库」" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        try {
          await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) })
          await loadProjects()
        } catch (e) { message.error((e as Error).message); throw e }
      },
    })
  }

  const checkedItems = rows.filter((r) => checked.includes(r.id))

  /// 左栏过滤后的项目。★大小写不敏感★:项目名常混中英文,记不住原始大小写。
  const archivedCount = projects.filter((p) => p.archived_at).length
  const shown = projects
    .filter((p) => (scope === 'archived' ? !!p.archived_at : !p.archived_at))
    .filter((p) => !kw.trim() || p.name.toLowerCase().includes(kw.trim().toLowerCase()))

  return (
    <>
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 左栏:项目列表。项目级操作(授权/重命名/删除)只在这里的 ⋯ 菜单,且仅 admin 可见。 */}
      <Card
        // ★320 而不是 260★(2026-08-07 用户反馈「项目名称被挡住」):
        // 260 减去角色标签(~56px)与 ⋯ 按钮(~30px),留给名称的只剩 ~150px,
        // 「课题组·计量经济学」这种正常长度的名字就已经被截断了。
        size="small" title="项目" style={{ width: 320, flex: '0 0 auto' }}
        extra={<Button size="small" type="primary" onClick={newSpace}>新建</Button>}
      >
        {/* ★项目一多就必须能搜★:参与十几个项目是常态,靠肉眼在列表里找不现实。
            只过滤本地已加载的列表(项目列表本来就是一次拉全),不打接口。 */}
        {/* ★有归档项目才显示切换★:一个都没有时,多一个开关只是噪音 */}
        {archivedCount > 0 && (
          <Segmented
            size="small" block value={scope} onChange={(v) => { setScope(v as 'active' | 'archived'); setCur(null) }}
            options={[
              { value: 'active', label: `进行中 ${projects.length - archivedCount}` },
              { value: 'archived', label: `已归档 ${archivedCount}` },
            ]}
            style={{ marginBottom: 8 }}
          />
        )}
        {projects.length > 6 && (
          <Input
            size="small" allowClear placeholder={`在 ${projects.length} 个项目里找…`}
            value={kw} onChange={(e) => setKw(e.target.value)}
            style={{ marginBottom: 8 }}
          />
        )}
        <List
          size="small" dataSource={shown}
          locale={{ emptyText: <Empty description={kw ? '没有匹配的项目' : '还没有可见的项目'} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(s) => (
            <List.Item
              onClick={() => setCur(s)}
              style={{ cursor: 'pointer', background: cur?.id === s.id ? '#e6fffb' : undefined, borderRadius: 6, padding: '6px 8px' }}
            >
              {/* title:名字再长也能悬停看全 —— 截断是布局的妥协,不该让信息真的丢掉 */}
              <Typography.Text strong={cur?.id === s.id} ellipsis style={{ flex: 1 }} title={s.name}>{s.name}</Typography.Text>
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
            <AntSpace>
              <Breadcrumb
                items={[
                  { title: <a onClick={() => setCwd(null)}>{cur.name}</a> },
                  ...trail.map((t) => ({ title: <a onClick={() => setCwd(t.id)}>{t.name}</a> })),
                ]}
              />
              {cur.archived_at && <Tag color="default">已归档 · 只读</Tag>}
            </AntSpace>
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
          {/* ★只读横幅★:归档项目里所有写入按钮都会失效(后端 409),
              不解释的话人只会以为「坏了」。说清三件事:为什么、还能做什么、怎么解开。 */}
          {cur.archived_at && (
            <Alert type="warning" showIcon style={{ marginBottom: 10 }}
              message={`这个项目已归档（${new Date(cur.archived_at).toLocaleDateString('zh-CN')}），是只读的`}
              description="材料、会议与纪要都保留着，可以查看和下载；但不能再上传、建会议或修改。主持人可在左侧 ⋯ 菜单里恢复为进行中。" />
          )}
          {/* 内容操作工具栏(editor+):只有「在项目里干活」的动作,没有项目管理项。
              ★归档时只留「回收站」★——它是读操作,存档项目照样该能查看已删内容。 */}
          {showToolbar && (
            <AntSpace style={{ marginBottom: 10 }} wrap>
              {!readOnly && (
              <Upload showUploadList={false} multiple
                customRequest={({ file, onSuccess }) => { uploadFiles([file as File]).then(() => onSuccess?.({})) }}>
                <Button type="primary" size="small" icon={<UploadOutlined />}>上传文件</Button>
              </Upload>
              )}
              {/* ★只给图标★(2026-08-05 用户:文字太占地方,参考 VSCode)。
                  FolderAddOutlined / FileAddOutlined 就是 VSCode 资源管理器那两个
                  「新建文件夹 / 新建文件」的形态(容器 + 加号),hover 出文字补足语义。 */}
              {!readOnly && (
                <Tooltip title="新建文件夹">
                  <Button size="small" icon={<FolderAddOutlined />} onClick={() => newItem('folder')} />
                </Tooltip>
              )}
              {!readOnly && (
                <Tooltip title="新建文档">
                  <Button size="small" icon={<FileAddOutlined />} onClick={() => newItem('doc')} />
                </Tooltip>
              )}
              <Button size="small" icon={<DeleteOutlined />} onClick={() => setTrashOpen(true)}>回收站</Button>
              {/* 批量操作三个都是写(建分享链接/移动/删除),归档时整块不出现。
                  ⚠ ★已经发出去的分享链接仍然有效★——归档是「只读」不是「封存」,
                  读得到才是归档的意义;要断链接请用「禁止分享」开关或撤销。 */}
              {!readOnly && checkedItems.length > 0 && (
                <>
                  <span style={{ color: '#8c8c8c', fontSize: 12 }}>已选 {checkedItems.length} 项</span>
                  {/* 多选分享(2026-08-05):一条链接带多份内容,和单项分享同一套闸(提取码/有效期/次数) */}
                  <Button size="small" icon={<ShareAltOutlined />} onClick={() => setShareFor(checkedItems)}>分享</Button>
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
                    // ★别给进度条写死宽度★(v0.3.56):原先 width:120 + 「取消」28 + 间距,
                    // 超过操作列 158 的可用宽度(还要扣单元格 padding),「取消」被挤到第二行。
                    // 改成 flex:进度条吃掉剩余项目(minWidth:0 才允许它被压缩),
                    // 「取消」flexShrink:0 + nowrap 永不换行。列宽以后怎么调都不会再断行。
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {up(it)!.running
                        ? <Progress percent={up(it)!.percent} size="small" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}
                            format={(p) => (up(it)!.hashing ? '校验中' : `${p}%`)} />
                        : <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>排队中…</Typography.Text>}
                      <a style={{ color: '#ff4d4f', flexShrink: 0, whiteSpace: 'nowrap' }}
                         onClick={() => cancelOne(up(it)!)}>取消</a>
                    </div>
                  ) : (
                    <AntSpace size={10}>
                      {/* ★行内分享★:文件与文件夹都能分享(公开链接,可设提取码/有效期/次数)。
                          ⚠ 这一行 v0.3.48 加过,后来清理旧的 copyShare 时被连带删掉了(2026-08-05 用户三次提醒)。 */}
                      {canEdit && <Tooltip title="分享"><a onClick={() => setShareFor([it])}><ShareAltOutlined /></a></Tooltip>}
                      {it.kind !== 'folder' && !(cur.my_role === 'viewer' && cur.no_download) && (
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
            extra={preview && canEdit && <Button size="small" icon={<ShareAltOutlined />} onClick={() => setShareFor([preview])}>分享</Button>}
          >
            {preview && (
              <ItemPanel
                key={preview.id} item={preview} canEdit={canEdit}
                noDownload={cur.my_role === 'viewer' && cur.no_download}
                onChanged={refresh}
              />
            )}
          </Drawer>

          {/* 移动目标选择:只列本项目的文件夹 */}
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
          {/* key 按项目:这个面板是常驻挂载的(不是 open 才渲染),不给 key 的话切到别的项目时
              术语表输入框、诊断结果这些内部 state 会留着上一个项目的值——保存就把 A 的词写进 B
              (2026-08-04 审计发现,v0.3.29 引入)。 */}
          <MembersModal key={cur.id} space={cur} open={grantsOpen} onClose={() => setGrantsOpen(false)} onChanged={loadProjects} />
          {shareFor && <ShareModal key={shareFor.map((i) => i.id).join('-')} items={shareFor} onClose={() => setShareFor(null)} />}
          <TrashDrawer space={cur} open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={refresh} />
        </Card>
      ) : (
        <Card style={{ flex: 1 }}>
          <Empty description="选择或新建一个项目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
          ? <Tag>本项目「只读」不能下载</Tag>
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
      ) : item.mime?.startsWith('audio/') ? (
        // 音频没有单独的 kind(见后端 http::media::analyzable):按 mime 认,
        // 给一个原生播放器 + 同一套 AI 纪要(转写/大纲/决议/逐字稿都适用于录音)。
        <AudioPanel item={item} />
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


/// 成员管理(项目管理员)。★只有人,没有组(D12)★——权限只到具体的人。
///
/// 删组之后「他为什么能看到这个」永远只有一个答案:**他在这张表里**。
/// 代价是加人变成一个个加,所以★批量添加是必做的★:第一次拉 20 人不能让人点 20 次。
function MembersModal({ space, open, onClose, onChanged }:
  { space: Project; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { message } = AntdApp.useApp()
  const [owner, setOwner] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [role, setRole] = useState<Role>('editor')
  const [users, setUsers] = useState<UserOpt[]>([])
  const [diagName, setDiagName] = useState('')
  const [diag, setDiag] = useState<Diagnose | null>(null)
  const [hot, setHot] = useState(space.hotwords ?? '')

  const load = useCallback(async () => {
    const r = await api<MemberList>(`/api/projects/${space.id}/members`)
    setOwner(r.owner); setMembers(r.members)
  }, [space.id])
  useEffect(() => { if (open) load().catch((e) => message.error(e.message)) }, [open, load, message])

  // 名单不整表下发(审计收紧):输前缀才查
  const searchUsers = useCallback(async (t: string) => {
    if (!t) { setUsers([]); return }
    try { setUsers(await api<UserOpt[]>(`/api/users?q=${encodeURIComponent(t)}`)) } catch { setUsers([]) }
  }, [])

  const addBatch = async () => {
    if (!picked.length) return message.warning('先选人')
    try {
      await api(`/api/projects/${space.id}/members`, {
        method: 'PUT',
        body: JSON.stringify({ usernames: picked, role }),
      })
      message.success(`已添加 ${picked.length} 人`)
      setPicked([]); await load(); onChanged()
    } catch (e) { message.error((e as Error).message) }
  }

  const changeRole = async (m: Member, r: Role) => {
    try {
      await api(`/api/projects/${space.id}/members`, {
        method: 'PUT', body: JSON.stringify({ usernames: [m.username], role: r }),
      })
      message.success('角色已更新'); await load(); onChanged()
    } catch (e) { message.error((e as Error).message); await load() }
  }

  return (
    <Modal title={`成员与设置 — ${space.name}`} open={open} onCancel={onClose} footer={null} width={680}>
      <Typography.Text strong>成员（{members.length}）</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 10px' }}>
        进了项目就能看到<b>本项目全部资料</b>，包括他加入之前的历史；移出即失去全部。
      </Typography.Paragraph>

      <AntSpace.Compact style={{ width: '100%', marginBottom: 10 }}>
        <Select mode="multiple" value={picked} onChange={setPicked} onSearch={searchUsers}
          filterOption={false} placeholder="输入用户名搜索，可多选" style={{ flex: 1 }}
          options={users.map((u) => ({ value: u.username, label: u.name ? `${u.username}（${u.name}）` : u.username }))} />
        <Select value={role} onChange={setRole} style={{ width: 120 }}
          options={[
            { value: 'viewer', label: '只读成员' },
            { value: 'editor', label: '成员' },
            { value: 'admin', label: '管理员' },
          ]} />
        <Button type="primary" onClick={addBatch}>批量添加</Button>
      </AntSpace.Compact>

      <Table size="small" rowKey="username" dataSource={members} pagination={false}
        columns={[
          {
            title: '成员', dataIndex: 'username',
            render: (u: string) => (
              <span>{u}{u === owner && <Tag color="cyan" style={{ marginLeft: 6 }}>主持人</Tag>}</span>),
          },
          {
            title: '角色', width: 140,
            render: (_, m) => (
              <Select size="small" value={m.role} style={{ width: 118 }}
                disabled={m.username === owner}
                onChange={(r) => changeRole(m, r as Role)}
                options={[
                  { value: 'viewer', label: '只读成员' },
                  { value: 'editor', label: '成员' },
                  { value: 'admin', label: '管理员' },
                ]} />),
          },
          { title: '加入', dataIndex: 'added_at', width: 110, render: (t: string) => t?.slice(0, 10) },
          {
            title: '', width: 60,
            render: (_, m) => (m.username === owner ? null : (
              <Popconfirm
                title={`把 ${m.username} 移出项目？`}
                description={<div style={{ maxWidth: 320, fontSize: 12 }}>
                  · 他将立刻看不到本项目全部资料，包括他自己参与过的会议<br />
                  · 他上传的材料<b>全部留下</b>，署名保留<br />
                  · <b>他创建的、指向本项目的公开链接会被一并撤销</b>
                </div>}
                onConfirm={async () => {
                  try {
                    const r = await api<{ revoked_links: number }>(
                      `/api/projects/${space.id}/members?username=${encodeURIComponent(m.username)}`,
                      { method: 'DELETE' })
                    message.success(r.revoked_links > 0
                      ? `已移出；连带撤销公开链接 ${r.revoked_links} 条`
                      : '已移出')
                    await load(); onChanged()
                  } catch (e) { message.error((e as Error).message) }
                }}>
                <a style={{ color: '#ff4d4f' }}>移出</a>
              </Popconfirm>)),
          },
        ]} />

      <Typography.Text strong style={{ display: 'block', marginTop: 18 }}>权限诊断</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        判定链只有两段：是不是超管、成员表里是什么角色。
      </Typography.Paragraph>
      <AntSpace.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input value={diagName} onChange={(e) => setDiagName(e.target.value)} placeholder="用户名" />
        <Button onClick={async () => {
          if (!diagName.trim()) return
          try {
            setDiag(await api<Diagnose>(
              `/api/projects/${space.id}/diagnose?username=${encodeURIComponent(diagName.trim())}`))
          } catch (e) { message.error((e as Error).message) }
        }}>查询</Button>
      </AntSpace.Compact>
      {diag && (
        <Alert type={diag.effective ? 'success' : 'warning'} showIcon
          message={<span>
            <b>{diag.username}</b>：{diag.effective ? ROLE_LABEL[diag.effective] : '无权限'}
            {diag.is_super && <Tag color="purple" style={{ marginLeft: 8 }}>超管</Tag>}
            {diag.is_owner && <Tag color="cyan" style={{ marginLeft: 4 }}>主持人</Tag>}
          </span>} />
      )}

      <Typography.Text strong style={{ display: 'block', marginTop: 18 }}>转写术语表</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        空格分隔。人名与专业词按项目不同，只有本项目的人知道自己的词。
      </Typography.Paragraph>
      <AntSpace.Compact style={{ width: '100%' }}>
        <Input value={hot} onChange={(e) => setHot(e.target.value)} placeholder="如：廖睿黎 汇流 向量检索" />
        <Button onClick={async () => {
          try {
            await api(`/api/projects/${space.id}`, {
              method: 'PUT',
              body: JSON.stringify({ name: space.name, description: space.description, hotwords: hot }),
            })
            message.success('已保存'); onChanged()
          } catch (e) { message.error((e as Error).message) }
        }}>保存</Button>
      </AntSpace.Compact>
    </Modal>
  )
}

/// 回收站(2026-08-05 软删除):列被删的东西,可还原;项目 admin 还能彻底删。
/// ★彻底删除才真正动对象★,而且按引用计数——同样内容被别处引用着就只删行不删对象。
function TrashDrawer({ space, open, onClose, onChanged }:
  { space: Project; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { message, modal } = AntdApp.useApp()
  const [rows, setRows] = useState<TrashRow[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api<TrashRow[]>(`/api/projects/${space.id}/trash`)) } catch { setRows([]) } finally { setLoading(false) }
  }, [space.id])
  useEffect(() => { if (open) void load() }, [open, load])

  return (
    <Drawer title="🗑 回收站" open={open} onClose={onClose} width={640}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        删除的内容在这里保留 <b>30 天</b>,之后自动清除。回收站里的内容<b>仍占用项目配额</b>。
      </Typography.Paragraph>
      <Table size="small" rowKey="id" dataSource={rows} loading={loading} pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站是空的" /> }}
        columns={[
          { title: '名称', dataIndex: 'name', ellipsis: true,
            render: (_, r) => <span><ItemIcon it={r} />{r.name}</span> },
          { title: '大小', dataIndex: 'size', width: 92, render: (v, r) => (r.kind === 'folder' ? '—' : fmtSize(v)) },
          { title: '删除时间', dataIndex: 'deleted_at', width: 148, render: (v) => fmtTime(v) },
          { title: '删除者', dataIndex: 'deleted_by', width: 100, ellipsis: true },
          { title: '', width: 130, render: (_, r) => (
            <AntSpace size={8}>
              <a onClick={async () => {
                try { await api(`/api/items/${r.id}/undelete`, { method: 'POST' }); message.success('已还原'); await load(); onChanged() }
                catch (e) { message.error((e as Error).message) }
              }}>还原</a>
              {space.my_role === 'admin' && (
                <a style={{ color: '#ff4d4f' }} onClick={() => modal.confirm({
                  title: '彻底删除?', okButtonProps: { danger: true },
                  content: '这一步不可撤销:内容会从对象存储里真正抹掉(若没有别处引用同一份内容)。',
                  onOk: async () => {
                    try { await api(`/api/items/${r.id}/purge`, { method: 'DELETE' }); message.success('已彻底删除'); await load(); onChanged() }
                    catch (e) { message.error((e as Error).message) }
                  },
                })}>彻底删除</a>
              )}
            </AntSpace>) },
        ]} />
    </Drawer>
  )
}

type TrashRow = { id: number; kind: Item['kind']; name: string; size: number | null; mime: string | null
  deleted_by: string; deleted_at: string }

/// 音频面板:原生 <audio> + AI 纪要。上传后纪要已自动排队(后端 enqueue_analysis),
/// 所以打开时通常直接看到「排队中/转写中」的进度,不用再点一次生成。
function AudioPanel({ item }: { item: Item }) {
  const ref = useRef<HTMLAudioElement>(null)
  return (
    <>
      <audio ref={ref} controls preload="metadata" src={`/api/items/${item.id}/download?inline=1`}
        style={{ width: '100%' }} />
      <Analysis item={item} onSeek={(t) => { if (ref.current) { ref.current.currentTime = t; void ref.current.play() } }} />
    </>
  )
}

/// 公开分享对话框(2026-08-05,对标百度网盘)。
/// ★这是把内容送出墙外的入口,所以文案要把边界说清楚★:链接一旦发出去,拿到的人**不需要**是
/// 本项目成员;提取码/有效期/次数上限是仅有的三道闸,撤销是唯一的后悔药。
function ShareModal({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const item = items[0]  // 主项:标题与「已有链接」列表按它查(多选时其余项登记在 share_items)
  const { message } = AntdApp.useApp()
  const [code, setCode] = useState(randomCode())
  const [useCode, setUseCode] = useState(true)
  const [days, setDays] = useState<number | null>(7)
  const [maxVisits, setMaxVisits] = useState<number | null>(null)
  const [allowDownload, setAllowDownload] = useState(true)
  const [busy, setBusy] = useState(false)
  // 刚生成的这条:提取码**只在此刻拿得到**(库里存的是加盐哈希,事后取不回),
  // 所以留在对话框里让用户能再复制一次。
  const [lastLink, setLastLink] = useState<{ url: string; code: string | null; text: string } | null>(null)


  const create = async () => {
    setBusy(true)
    try {
      const r = await api<{ token: string; code: string | null }>(`/api/items/${item.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({
          code: useCode ? code.trim() : null,
          expires_days: days, max_visits: maxVisits, allow_download: allowDownload,
          items: items.map((i) => i.id),   // 多选分享:一条链接带这些内容
        }),
      })
      // ★复制文案带内容名★(2026-08-05 用户:不然对方不知道分享的是啥;百度网盘也是
      //   「通过网盘分享的文件:xxx」开头)。多项时给第一个名字 + 「等 N 项」。
      const url = `${window.location.origin}/s/${r.token}`
      const what = items.length > 1 ? `${item.name} 等 ${items.length} 项` : item.name
      const life = days ? `${days} 天内有效` : '长期有效'
      const text = [
        `通过汇流分享:${what}`,
        `链接:${url}`,
        ...(r.code ? [`提取码:${r.code}`] : []),
        life,
      ].join('\n')
      setLastLink({ url, code: r.code, text })
      try { await navigator.clipboard.writeText(text); message.success('分享文案已复制' + (r.code ? '(含提取码)' : '')) }
      catch { message.info('链接已生成,见下方') }
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal open onCancel={onClose} footer={null} width={620}
      title={<span><ItemIcon it={item} />
        {items.length > 1 ? `分享 ${items.length} 项(${item.name} 等)` : `分享「${item.name}」`}</span>}>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="这是公开链接:拿到链接的人不需要是本项目成员"
        description="提取码、有效期、访问次数是仅有的三道闸;发出去之后唯一的后悔药是撤销。" />
      <AntSpace direction="vertical" style={{ width: '100%' }} size={10}>
        <AntSpace wrap>
          <Switch size="small" checked={useCode} onChange={setUseCode} />
          <Typography.Text>需要提取码</Typography.Text>
          {useCode && (
            <AntSpace.Compact>
              <Input value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 130 }} maxLength={32} />
              <Button onClick={() => setCode(randomCode())}>换一个</Button>
            </AntSpace.Compact>
          )}
        </AntSpace>
        <AntSpace wrap>
          <Typography.Text>有效期</Typography.Text>
          <Select value={days} onChange={setDays} style={{ width: 130 }}
            options={[{ value: 1, label: '1 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' },
                      { value: null as unknown as number, label: '永久有效' }]} />
          <Typography.Text>访问次数</Typography.Text>
          <Select value={maxVisits} onChange={setMaxVisits} style={{ width: 130 }}
            options={[{ value: null as unknown as number, label: '不限' }, { value: 1, label: '1 次' },
                      { value: 10, label: '10 次' }, { value: 50, label: '50 次' }]} />
        </AntSpace>
        <AntSpace>
          <Switch size="small" checked={allowDownload} onChange={setAllowDownload} />
          <Typography.Text>允许下载原件(关掉则只能在线看)</Typography.Text>
        </AntSpace>
        <Button type="primary" loading={busy} onClick={create}>生成链接并复制</Button>
      </AntSpace>

      {/* 「已有链接」不在这里列了(2026-08-05 用户):生成链接的对话框就该只管生成,
          管理散落在每个文件里没法用。全部分享集中在顶部「🔗 我的分享」页。 */}
      {lastLink && (
        <Alert type="success" showIcon style={{ marginTop: 14 }}
          message="已生成(文案已复制到剪贴板)"
          description={
            <AntSpace direction="vertical" size={6} style={{ width: '100%' }}>
              <Input.TextArea readOnly value={lastLink.text} autoSize style={{ fontSize: 12 }}
                onFocus={(e) => e.target.select()} />
              <AntSpace wrap>
                <Button size="small" onClick={() => { void navigator.clipboard.writeText(lastLink.text); message.success('已复制') }}>
                  复制文案
                </Button>
                {lastLink.code && (
                  // ?pwd= 是百度那套「提取码自动填充」的做法:一步直达,代价是**链接即等于码**。
                  // 两种都给,让用户按场景选:要分开发就用上面的文案,图省事就用这个。
                  <Button size="small" onClick={() => {
                    void navigator.clipboard.writeText(`${lastLink.url}?pwd=${lastLink.code}`)
                    message.success('已复制(链接自带提取码,打开即免输)')
                  }}>复制免输码链接</Button>
                )}
              </AntSpace>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ⚠ 提取码只在这里能看到一次(库里存的是哈希,事后取不回)。
              </Typography.Text>
            </AntSpace>
          } />
      )}
    </Modal>
  )
}


/// 4 位提取码(去掉易混的 0/O/1/l/I)。只是默认值,用户可改。
function randomCode(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
}
