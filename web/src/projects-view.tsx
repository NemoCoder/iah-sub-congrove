// 项目视图:左列项目列表,右侧选中项目的文件树 + 内容面板。
// 前端只做显隐(my_role),真判权在后端(perm.rs)——按钮藏了 API 也会 403,别当安全边界。
import {
  Alert, App as AntdApp, Breadcrumb, Button, Card, Drawer, Dropdown, Empty, Input, List, Modal, Popconfirm,
  Pagination, Progress, Segmented, Select, Space as AntSpace, Table, Tabs, Tag, Tooltip, TreeSelect, Typography, Upload,
} from 'antd'
import {
  DeleteOutlined, DownloadOutlined, EditOutlined, FileAddOutlined, FolderAddOutlined,
  CopyOutlined, ShareAltOutlined, SwapOutlined, UploadOutlined, InboxOutlined, LockOutlined,
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
import { effectiveScope, effectiveTab, showScopeSwitch, shownProjects } from './project-filter'
import type { Activity } from './api'
import { ShareModal } from './share-modal'
import { fmtStamp } from './tz'
import { api, isMaterials, showUser, type Diagnose, type Item, type Me, type Role, type Project, type UserOpt, type Version, type Member, type MemberList } from './api'

/// ★角色只有四个词(2026-08-03 用户定):管理员 / 可编辑 / 只读 / 无权限。★
/// 「无权限」是**没有任何授权**的第四态,库里不存它——`effective = null` 即是。
/// 库里存的仍是 viewer/editor/admin:迁移只增不改,换值要重写 space_grants 全表并同步 perm.rs,
/// 收益只是换个字面。所以只在这里做**唯一一处**「存储值 → 用词」映射,别在别处再写第二套。
const ROLE_LABEL: Record<Role, string> = { admin: '管理员', editor: '可编辑', viewer: '只读' }
/// ⚠ `marginInlineEnd: 0`:AntD 的 Tag 自带右外边距,放进「固定宽度的槽」里会把右边缘顶歪 ——
/// 对齐做了一半反而更显乱(标签排齐了、右边缘没排齐)。
const ROLE_TAG: Record<Role, ReactNode> = {
  admin: <Tag color="purple" style={{ marginInlineEnd: 0 }}>{ROLE_LABEL.admin}</Tag>,
  editor: <Tag color="green" style={{ marginInlineEnd: 0 }}>{ROLE_LABEL.editor}</Tag>,
  viewer: <Tag style={{ marginInlineEnd: 0 }}>{ROLE_LABEL.viewer}</Tag>,
}

// ⚠ 原来这里抄了第 2 份 fmtTime(2026-08-12 收敛进 tz.ts)。
const fmtTime = fmtStamp

/// 网盘式项目视图(2026-08-03 重做)。**两套操作严格分开**:
/// - 项目所有者的事(授权管理 / 安全设置 / 重命名项目 / 删除项目)→ 只在左栏项目行的
///   「⋯」菜单里,且仅 space admin 可见;
/// - 项目里的内容操作(上传 / 新建 / 下载 / 重命名 / 移动 / 删除)→ 右侧工具栏与每行操作列,
///   editor 及以上可用。
/// 导航是「进文件夹 + 面包屑」而非一棵永远展开的树(内容多了树没法看)。
export function ProjectsView({ me, onOpenActivity, initialProjectId }: {
  me: Me | null
  /// 跳到某条活动的详情页。★由 app.tsx 注入而不是在这里改 URL★:
  /// 本应用整层不引路由库(app.tsx 头注的既有约定),视图切换是状态,不是地址。
  /// 第二个参数是**离开时选中的项目**,给「返回」用(见 initialProjectId)。
  onOpenActivity?: (activityId: number, fromProjectId?: number | null) => void
  /// 进来时先选中哪个项目。★这是「从活动详情返回」用的★（2026-08-13 liaoruili:
  /// 「我从项目点击去活动，返回却到了活动tab」）—— 切走时本视图整个被卸载,
  /// 选中的项目、右侧的 tab 全丢了;光把根 tab 切回「项目」,人落回的还是列表根,
  /// ★而他明明是从「我的活动材料」里点出去的★。返回要回到**他离开的地方**,不是这一层的门口。
  initialProjectId?: number | null
}) {
  const { message, modal } = AntdApp.useApp()
  const [projects, setProjects] = useState<Project[]>([])
  /// 左栏搜索关键词(只过滤已加载的列表,不打接口)
  const [kw, setKw] = useState('')
  /// 归档筛选(D17):默认只看进行中 —— 列表是「我手头的活」,结题的不该抢视线
  const [scope, setScope] = useState<'active' | 'archived'>('active')
  /// 项目页右侧的四个 tab(原型 proj 视图)
  const [ptab, setPtab] = useState('items')
  const [cur, setCur] = useState<Project | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [cwd, setCwd] = useState<number | null>(null) // 当前所在文件夹(null = 项目根)
  const [checked, setChecked] = useState<number[]>([]) // 批量选中
  const [preview, setPreview] = useState<Item | null>(null)
  const [grantsOpen, setGrantsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  /// 拖放进出的净深度(见拖放区注释):子元素冒泡制造的成对 leave/enter 靠它抵消,否则边框狂闪
  const dragDepth = useRef(0)
  const [uploads, setUploads] = useState<UpTask[]>([])
  const [moving, setMoving] = useState<Item[] | null>(null) // 待移动的项(单个或批量)
  const [moveDest, setMoveDest] = useState<number | null>(null) // 移动目标文件夹(null = 根)
  const [shareFor, setShareFor] = useState<Item[] | null>(null) // 正在设置公开分享的那些项(可多选)
  const [trashOpen, setTrashOpen] = useState(false)             // 回收站抽屉(项目**内**的条目)
  const [copying, setCopying] = useState<Item | null>(null)     // 正在复制到别的项目的那一项(J2)
  const [copyTo, setCopyTo] = useState<number | null>(null)
  /// 项目级回收站(整个项目被软删)。★与上面那个是两件事★:一个装文件,一个装项目。
  const [projTrash, setProjTrash] = useState<{ id: number; name: string; deleted_at: string; days_left: number }[]>([])
  const [projTrashOpen, setProjTrashOpen] = useState(false)

  const loadProjects = useCallback(async () => {
    const s = await api<Project[]>('/api/projects')
    setProjects(s)
    // ★没选中时用 initialProjectId 兜★:那是「从活动详情返回」带回来的落点。
    // 用 `||` 而不是覆盖已有选择 —— 列表刷新(重命名/归档)不该把人正看着的项目换掉。
    setCur((c) => (c ? s.find((x: Project) => x.id === c.id) || null
                     : (initialProjectId ? s.find((x: Project) => x.id === initialProjectId) || null : null)))
    // 回收站空是常态,拉失败也不该影响主列表 —— 静默兜底
    try { setProjTrash(await api('/api/projects/trash')) } catch { setProjTrash([]) }
  }, [initialProjectId])
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
  ///
  /// ★「我的活动材料」也走同一个只读判据★(2026-08-09 liaoruili:「只读的」):
  /// 它是系统给每人建的存档区(PRD §J),材料的增删都回到那条活动里做。
  /// 真闸在后端 —— `require_role` 里 need ≥ Editor 那一段对 kind='materials' 一律 Forbidden,
  /// 与归档那道闸并排(见 perm.rs)。这里只是别把按钮亮着骗人点。
  const isMat = isMaterials(cur)
  const readOnly = !!cur?.archived_at || isMat
  const canEdit = (cur?.my_role === 'editor' || cur?.my_role === 'admin') && !readOnly
  /// 只读时仍然显示的工具栏(回收站是**读**,归档项目照样该能查看已删内容)
  /// ⚠ 材料区连回收站都不给:J1b-2 的「材料区回收站」是 M1 的活,后端现在会拒 ——
  ///   ★亮一个必然 403 的按钮比没有按钮更糟★。
  /// ⚠★原来这里带 `&& !isMat`,于是材料区**整条工具栏**都不渲染★ ——
  /// 连带把「回收站」也藏了,而 PRD J1b-2 明写着「材料区★自带回收站,删了能还原★」
  /// (2026-08-08 liaoruili 拍板)。2026-08-12 实地点了一遍才发现:
  /// 普通项目有回收站按钮,材料区没有。
  ///
  /// ★后端本来就允许★:`perm.rs::effective_role` 的单点否决只对 `owner <> 我` 生效,
  /// 材料区的**主人**照常有角色 —— 那段注释里甚至明写了
  /// 「要放行的『回收站还原』与要拦的『上传/删除』在 need 上完全一样」。
  /// 所以这是纯前端的连坐,一个条件的事。
  ///
  /// 工具栏里每个**写**动作(上传/新建文件夹/新建文档/批量操作)各自都有 `!readOnly` 闸,
  /// 而材料区 readOnly=true —— 所以去掉 `!isMat` 之后,材料区只会露出「回收站」这一个。
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
  // ★文件列表分页★(2026-08-13 liaoruili:「这几个回收站、分享、文件夹,都要做分页」)。
  //
  // ⚠★这一处和回收站/我的分享**不是同一类问题**,所以修法也不同★:
  //   `GET /api/projects/{id}/items` **没有任何 LIMIT**,它一次返回整个项目的条目,
  //   前端再按 `parent_id === cwd` 自己分层显示 —— ★一条数据都没丢★,长只是显示问题。
  //   那两处是后端写死 LIMIT 把数据吃掉了,必须改后端;这里改前端就够,
  //   ★而且必须改前端★:一旦改成服务端按页取,前端的 `byId` / 面包屑 / 「..」上一层
  //   全都依赖「整棵树在手」,会一起坏掉。
  //   (真到几万条要改服务端时,得连带把树导航一起重做 —— 那是另一件事,不是这次。)
  const [文页, set文页] = useState(1)
  const 文每页 = 20
  const 文总页 = Math.max(1, Math.ceil(rows.length / 文每页))
  const 文有效页 = Math.min(文页, 文总页)   // 进了个只有 3 条的子目录还停在第 5 页 = 空白
  const 本页行 = rows.slice((文有效页 - 1) * 文每页, 文有效页 * 文每页)
  // 换目录/换项目/改排序都回第一页
  useEffect(() => { set文页(1) }, [cwd, cur?.id, sortKey, sortAsc])
  // 面包屑:顺 parent 链上溯。
  const trail = useMemo(() => {
    const out: Item[] = []
    let p = cwd
    while (p != null) { const it = byId.get(p); if (!it) break; out.unshift(it); p = it.parent_id }
    return out
  }, [cwd, byId])

  // 上传:先整批入队(立刻在表里出现带进度的伪行),再由 UPLOAD_CONCURRENCY 个 worker 取着做。
  // 上传中的任务在表里占「伪行」:id 取负,靠 Map 反查回任务(rowKey 仍是 id,不用改 Table)。
  const upRows: Item[] = useMemo(
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
        message.info(`${f.name}：从断点继续，已跳过 ${parts} 片(${fmtSize(bytes)})`)
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
      // 与「新建项目」同一条理由:新建不是警告(见 newSpace 那段注释)。
      // ★只改一处会更糟★:那样「新建项目」中性、「新建文件夹」警告,同一个动作两种脸。
      icon: kind === 'folder' ? <FolderAddOutlined style={{ color: '#1677ff' }} />
        : <FileAddOutlined style={{ color: '#1677ff' }} />,
      content: <Input placeholder={kind === 'folder' ? '文件夹名' : '文档名'}
        onChange={(e) => (name = e.target.value)} />,
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
      icon: <EditOutlined style={{ color: '#1677ff' }} />,   // 改名随时能改回来,不是警告
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
      title: `删除 ${targets.length} 项？`,
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
  /// ★归档被挡时的对话框★:把挡路的活动全列出来,一键取消并归档。
  /// ⚠★无权取消的必须单独标出来★:取消是「发起人 / 记录员」的权限(activities::remove),
  ///   批量里最坏的事就是**默不作声地跳过几条** —— 人以为都处理完了,回头再点归档还是被拒,
  ///   而且他不知道是哪几场、为什么。所以这些行标灰 + 一句「你不是发起人/记录员」,
  ///   并且主按钮的文案会如实说「取消其中 N 场」而不是「全部取消」。
  const 归档拦截弹窗 = (s: Project,
    挡: { total: number; items: { id: number; title: string; starts_at: string; can_cancel: boolean }[] }) => {
    const 可取消 = 挡.items.filter((x) => x.can_cancel)
    modal.confirm({
      title: `还有 ${挡.total} 场没开始的活动，归不了档`,
      width: 560,
      icon: null,
      content: (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            归档 = 变成只读存档。这些活动还没开始,先处理掉再归档。
          </Typography.Paragraph>
          <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }}>
            {挡.items.map((x) => (
              <div key={x.id} style={{ padding: '8px 10px', borderBottom: '1px solid #fafafa',
                                       opacity: x.can_cancel ? 1 : 0.55 }}>
                <div style={{ fontWeight: 600 }}>{x.title}</div>
                <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                  {fmtTime(x.starts_at)}
                  {!x.can_cancel && <span style={{ color: '#d46b08' }}>　·　你不是发起人/记录员,取消不了这场</span>}
                </div>
              </div>
            ))}
          </div>
          {可取消.length < 挡.total && (
            <Typography.Paragraph type="warning" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              其中 <b>{挡.total - 可取消.length}</b> 场你取消不了 —— 请找发起人处理,或把本项目从它的关联里去掉。
            </Typography.Paragraph>
          )}
        </div>
      ),
      okText: 可取消.length ? `取消这 ${可取消.length} 场并归档` : '知道了',
      okButtonProps: { danger: true, disabled: !可取消.length },
      cancelText: '先不归档',
      onOk: async () => {
        // ★逐条取消,失败的如实报★ —— 不能「大致成功」就当成功
        const 失败: string[] = []
        for (const x of 可取消) {
          try { await api(`/api/activities/${x.id}`, { method: 'DELETE' }) }
          catch (e) { 失败.push(`${x.title}(${(e as Error).message})`) }
        }
        if (失败.length) {
          message.error(`有 ${失败.length} 场没取消成功：${失败.join('、')}`)
          throw new Error('部分取消失败')   // 抛出去让弹窗留着,别让人以为成了
        }
        if (可取消.length < 挡.total) {
          message.warning(`已取消 ${可取消.length} 场；还有 ${挡.total - 可取消.length} 场你取消不了，项目仍未归档`)
          throw new Error('还有挡路的')
        }
        try { await api(`/api/projects/${s.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: true }) }) }
        catch (e) { message.error((e as Error).message); throw e }
        message.success(`已取消 ${可取消.length} 场并归档`)
        await loadProjects()
      },
    })
  }

  const spaceMenu = (s: Project) => ({
    items: [
      // ★菜单里每一项都要有图标★(2026-08-09 用户):只有这一项没有,
      // 于是它的文字比别人往左顶,整列对不齐 —— 一眼看去像是加载没完。
      { key: 'members', label: '👥 成员与设置' },
      { key: 'rename', label: '✏️ 重命名项目', disabled: !!s.archived_at },
      { type: 'divider' as const },
      // ★归档与删除是两件事,菜单里也要分开★:归档=做完了留着查,删除=不要了。
      // 放在分隔线之后、删除之前,让「结题」有个比「删掉」轻的出口。
      { key: 'archive', label: s.archived_at ? '↩ 恢复为进行中' : '📦 归档项目' },
      { key: 'delete', label: <span style={{ color: '#ff4d4f' }}>🗑 删除项目</span> },
    ],
    onClick: async ({ key }: { key: string }) => {
      setCur(s)
      if (key === 'members') setGrantsOpen(true)
      if (key === 'rename') {
        let name = s.name
        modal.confirm({
          title: '重命名项目',
          icon: <EditOutlined style={{ color: '#1677ff' }} />,   // 同上:改名不是警告
          content: <Input defaultValue={s.name} onChange={(e) => (name = e.target.value)} />,
          onOk: async () => {
            await api(`/api/projects/${s.id}`, { method: 'PUT', body: JSON.stringify({ name, description: s.description }) })
            await loadProjects()
          },
        })
      }
      if (key === 'archive') {
        const on = !s.archived_at
        // ★挡路的活动:先问清楚,直接摆出来 + 一键取消★
        // （2026-08-14 liaoruili:「你这个错误有问题,你要直接弹出来要取消的项目列表,
        //   然后一键取消之类的功能;而且确认和红字同时显示 啥意思呢」）。
        //
        // ⚠★上一版的毛病有两层★:
        //   ① 只把「不行」说出来,没解决**人接下来要干什么** —— 红字里列 5 场,
        //      人还得自己一场场去找、一场场取消;
        //   ② ★确认框和红字同时挂在屏幕上★ —— 等于同时问「确定吗」又答「不行」,
        //      两个对话框语义打架,人不知道该看哪个。
        // 所以现在是:**先查**,有挡路的就换一个对话框(屏幕上永远只有一个),
        //   把它们全列出来,一键取消并归档;没有挡路的才走原来那个确认框。
        if (on) {
          let 挡: { total: number; items: { id: number; title: string; starts_at: string; can_cancel: boolean }[] }
          try { 挡 = await api(`/api/projects/${s.id}/archive-blockers`) }
          catch (e) { message.error((e as Error).message); return }
          if (挡.total > 0) { 归档拦截弹窗(s, 挡); return }
        }
        modal.confirm({
          // ★把项目名写进标题★(2026-08-15 逐张看巡检截图看出来的):原来是「归档这个项目?」——
          //   **哪个项目它不说**。而这个动作的入口之一是列表行尾的「…」菜单,
          //   那个下拉是**渲染在触发行下方**的,视觉上正好压住并且看起来像挂在**下一行**上
          //   (截图 0042/0112 里,「AI 模型评测」的菜单压在「联合项目·因果推断 15908」身上)。
          //   ★于是「归档」成了唯一一个不告诉你目标是谁的确认框★ —— 而删除、移出、转主持人
          //   都是写名字的。补齐它,让确认框自己承担「你选对了吗」这一问。
          title: on ? `归档项目「${s.name}」？` : `把「${s.name}」恢复为进行中？`,
          // ★确认框的说明不能删★:它是决策点,删了就是让人盲选。但压到两行 ——
          // 「变成什么」和「不是什么」,其余(配额/日历/忙闲)在文档里,不在这个弹窗里。
          content: on
            ? <span>变成<b>只读存档</b>：内容全部保留、可查可下载，但不能再上传或建活动。随时可恢复。<br />
                <b>这不是删除</b>——要清理空间请用「删除项目」。</span>
            : '恢复后就能继续往里加东西了。',
          okText: on ? '归档' : '恢复',
          onOk: async () => {
            // ★被拒时必须把后端那句话显示出来★（2026-08-14 把 M2 验收用例改成走界面才发现）:
            //   原来这里**没有 try/catch** —— 后端因「还有没开始的活动」回 400 时,
            //   `api()` 抛异常 → antd 保持弹窗开着、`message.success` 不执行,
            //   ★而错误被整个吞掉:人点了归档,什么都没发生,也不知道为什么★。
            //   M2 的判据原文是「归档被拒**并且说清是哪几场**」—— 那半句此前**只在接口里成立**,
            //   界面上一个字都没有。而那条验收用例只验了接口,于是它绿了好几天。
            //   ⚠ 抛出去(而不是吞掉)才能让 antd 把弹窗留着 —— 人改完再点一次就好。
            try {
              await api(`/api/projects/${s.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: on }) })
            } catch (e) {
              message.error((e as Error).message)
              throw e
            }
            message.success(on ? '已归档' : '已恢复为进行中')
            await loadProjects()
          },
        })
      }
      if (key === 'delete') {
        modal.confirm({
          title: `删除项目「${s.name}」？`,
          // ⚠★文案跟着行为改★(2026-08-09 审计 A5):原来写的是「不可撤销」——
          // 那时后端确实是硬删除;现在是软删除进回收站 30 天。
          // ★说明文案和实现不一致时,人会按文案决策★:说「不可撤销」会让人不敢删该删的东西,
          // 反过来说「可撤销」而实际删干净了,那就是骗人。
          content: <span>进<b>回收站保留 30 天</b>，期间可在「回收站」里还原，文件一个字节都不会删。<br />
            ⚠ <b>已经发出去的公开链接会立即失效</b>，还原也不会恢复它们。</span>,
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
      // ★新建是个无风险动作,别套警告图标★(2026-08-15 逐张看巡检截图看出来的):
      //   `modal.confirm` 默认给橙色感叹号,于是「新建项目」和「归档这个项目?」「删除项目「X」?」
      //   顶着**一模一样的警告标记**。★什么都是警告,就等于没有警告★ —— 真到删除那一下,
      //   那个图标已经不再让人停顿了。这里换成中性的编辑图标,把橙色留给真会造成损失的动作。
      icon: <EditOutlined style={{ color: '#1677ff' }} />,
      content: <Input placeholder="项目名，如「组会记录」「论文库」" onChange={(e) => (name = e.target.value)} />,
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
  /// ★计数只数真项目★:材料区不是项目(PRD §J1),把它算进「进行中 3」里会对不上眼睛看到的。
  const teamProjects = projects.filter((p) => !isMaterials(p))
  const archivedCount = teamProjects.filter((p) => p.archived_at).length
  /// ★没有归档项目时强制回到「进行中」★(2026-08-07 用户撞到):
  /// 切换控件是 `archivedCount > 0` 才渲染的 —— 恢复掉最后一个归档项目后,
  /// 控件消失、而 scope 状态还停在 'archived' → 列表永远筛不出东西,
  /// 且用户**连切回去的按钮都没有了**。
  /// 修法是**派生**而不是同步状态:控件的可见性与筛选值来自同一个事实,不会各说各话。
  /// 两者都抽到 project-filter.ts 并有单测(含这个 bug 的复现用例)。
  const effScope = effectiveScope(scope, archivedCount)
  /// ★「我的活动材料」置顶、且不被搜索筛掉★(2026-08-09 liaoruili:「永远置顶」);
  /// ★但它不进「已归档」那一档★(2026-08-13 liaoruili:「已归档里面为啥有我的活动材料」)。
  /// 两条判据为什么分开,见 project-filter.ts 的头注(那里有复现单测)。
  /// 材料区那一行 —— ★不进下面的列表★,它单独渲染在筛选器之上(见那里的注释)。
  const materialsRow = projects.find(isMaterials) ?? null
  const shown = shownProjects(projects, isMaterials, effScope, kw)

  return (
    <>
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 左栏:项目列表。项目级操作(授权/重命名/删除)只在这里的 ⋯ 菜单,且仅 admin 可见。 */}
      <Card
        // ★320 而不是 260★(2026-08-07 用户反馈「项目名称被挡住」):
        // 260 减去角色标签(~56px)与 ⋯ 按钮(~30px),留给名称的只剩 ~150px,
        // 「课题组·计量经济学」这种正常长度的名字就已经被截断了。
        size="small" title="项目" style={{ width: 320, flex: '0 0 auto' }}
        extra={<AntSpace size={6}>
          {/* ★回收站入口必须有★(2026-08-09 审计 A5):删项目改成软删除之后,
              没有这一页的话「软删除」就只是「永久看不见」——与 §J1b-2 给材料区回收站的
              理由同源:★只能删不能还原的回收站不是回收站★。
              只在**真的删过东西**时出现:平时不占位置,有东西时才提醒你它在倒计时。 */}
          {projTrash.length > 0 && (
            <Button size="small" onClick={() => setProjTrashOpen(true)}>回收站 {projTrash.length}</Button>
          )}
          <Button size="small" type="primary" onClick={newSpace}>新建</Button>
        </AntSpace>}
      >
        {/* ★材料区拎到筛选器**上面**,单独一格★（2026-08-13 liaoruili 拍板）。
            ⚠ 起因是标签写「进行中 2」、底下却有 3 行 —— 计数只数**真项目**(材料区不是项目,PRD §J1),
              而它又置顶显示在同一个列表里,于是数字和行数天生对不上。
              同一天刚修过它的另一半(它不该出现在「已归档」那一档)——★两处是同一个根因★:
              ★把一个「不属于任何一档」的东西塞进按档筛选的列表里,它就会被那个列表的语义染色。★
              解法不是继续给筛选器打补丁,而是**把它挪出这个列表**:
              它本来就不是项目,不参与「进行中/已归档」,也不参与搜索。 */}
        {materialsRow && (
          <div style={{ marginBottom: 10 }}>
            {/* ⚠★用 div 自己排,不要 List.Item★:List.Item 的横向布局来自 List 的 context,
                单独拿出来用时 `flex:1` 推不动右边的标签(2026-08-13 我挪这一格时就这么错了一版)。
                ★挪一个组件时,它依赖的上下文不会跟着走。★

                ★2026-08-13 二改:liaoruili「感觉太分裂了」★。上一版是「名字 + 金色大标签 + 一条实线」,
                三处都在把它往外推:
                  ① ★金色标签是全卡最重的颜色★ —— 下面项目行的角色标签是淡紫/淡绿,
                     它一亮就成了整张卡的视觉重心,而它其实是最不需要被强调的一行(它天天在,不用找);
                  ② 一条实线分隔 = 宣布「这是另一个区」,可它明明还是「我的东西」里的一件;
                  ③ 没有图标,一行光秃秃的文字浮在筛选器上面,读起来像个走失的标题。
                改法照通用做法(Notion/Drive 的固定入口):**图标 + 与下面同一套行高**,
                把「只读」降成一个安静的小锁,分隔线换成极浅的一条 + 呼吸空间。
                ★它要显得「在同一份清单里、只是被钉住了」,而不是「另外一个东西」。★ */}
            {/* ★白底 + 左侧一条青竖条★（liaoruili:「感觉太分裂了，美化一下」）。
                这一格改了四版,每版都渲染出来拿 qwen3.8-max 并排看 —— ★颜色和层级这类事,
                看代码判断不了,必须看图★。四版各自被否掉的理由都记在这里,免得以后有人绕回去:
                · ①浅青底 →「分不开,『我的活动材料』看着也像被选中」:
                  ★青色是这张卡的「选中」语言★(项目行选中就是 #e6fffb),平时就穿它 = 长期像被选中;
                · ②中性灰底 →「和下方『进行中/已归档』的灰底太接近,两条灰 bar 相邻,层级含糊」:
                  ★Segmented 的轨道本来就是灰的★,再放一条灰 bar 在它正上方,糊成一片;
                · ③白底 + 一圈淡边 →「更像下面那个搜索输入框,而不像同级的可选项」:
                  ★带框的盒子在这一列里已经有主人了(搜索框)★,再来一个就是两个东西抢同一种形状;
                · ④白底 + 左侧 3px 青竖条 + 青图标 + 灰锁 → 过。
                  它和项目行是同一套「行」的语言(都是白底一行),而竖条与图标把「被钉住」说清楚 ——
                  ★用位置和一个记号表达特殊,而不是用另一种形状。★ */}
            <div
              onClick={() => setCur(materialsRow)}
              onMouseEnter={(e) => { if (cur?.id !== materialsRow.id) e.currentTarget.style.background = '#fafafa' }}
              onMouseLeave={(e) => { if (cur?.id !== materialsRow.id) e.currentTarget.style.background = '#fff' }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                       background: cur?.id === materialsRow.id ? '#e6fffb' : '#fff',
                       borderLeft: '3px solid #0d9488', borderRadius: '0 6px 6px 0',
                       padding: '7px 8px', transition: 'background .15s' }}
            >
              <InboxOutlined style={{ color: '#0d9488', fontSize: 15, flexShrink: 0 }} />
              {/* ★锁贴在名字后面,不摆到最右★:最右那一列在别的行上是「⋯」菜单,
                  一个孤零零的小锁摆在那儿会被读成「坏掉的菜单按钮」(第一版就是这样)。
                  它是**属性**不是**身份**,不该和下面那排角色标签抢同一档视觉重量;
                  文字留在 tooltip 里 —— 要解释的人 hover 就有,不要的人不必每次都读一遍。 */}
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 0 }}>
                <Typography.Text strong={cur?.id === materialsRow.id} ellipsis
                  title={materialsRow.name}>{materialsRow.name}</Typography.Text>
                <Tooltip title="系统给你的存档区：只读。加材料、删材料都回到那条活动里做">
                  {/* ★颜色加深一档★:第一版 #bfbfbf/11px 在浅底上「几乎要仔细看才注意到」(qwen3.8-max)。
                      「不抢眼」的方向对,但看不见就等于没有。 */}
                  <LockOutlined style={{ color: '#8c8c8c', fontSize: 12, flexShrink: 0 }} />
                </Tooltip>
              </span>
            </div>
          </div>
        )}
        {/* ★项目一多就必须能搜★:参与十几个项目是常态,靠肉眼在列表里找不现实。
            只过滤本地已加载的列表(项目列表本来就是一次拉全),不打接口。 */}
        {/* ★有归档项目才显示切换★:一个都没有时,多一个开关只是噪音 */}
        {showScopeSwitch(archivedCount) && (
          <Segmented
            size="small" block value={effScope} onChange={(v) => { setScope(v as 'active' | 'archived'); setCur(null) }}
            options={[
              { value: 'active', label: `进行中 ${teamProjects.length - archivedCount}` },
              { value: 'archived', label: `已归档 ${archivedCount}` },
            ]}
            style={{ marginBottom: 8 }}
          />
        )}
        {teamProjects.length > 6 && (
          <Input
            size="small" allowClear placeholder={`在 ${teamProjects.length} 个项目里找…`}
            value={kw} onChange={(e) => setKw(e.target.value)}
            style={{ marginBottom: 8 }}
          />
        )}
        <List
          size="small" dataSource={shown}
          locale={{ emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={kw ? '没有匹配的项目'
                : effScope === 'archived' ? '没有已归档的项目'
                : '还没有可见的项目'} />
          ) }}
          renderItem={(s) => (
            <List.Item
              onClick={() => setCur(s)}
              style={{ cursor: 'pointer', background: cur?.id === s.id ? '#e6fffb' : undefined, borderRadius: 6, padding: '6px 8px' }}
            >
              {/* title:名字再长也能悬停看全 —— 截断是布局的妥协,不该让信息真的丢掉 */}
              <Typography.Text strong={cur?.id === s.id} ellipsis style={{ flex: 1 }} title={s.name}>{s.name}</Typography.Text>
              {/* ★角色标签与「⋯」各占一个**固定宽度的槽**★（2026-08-13 liaoruili:「管理员 可编辑 没有对齐，感觉有点乱」）。
                  两处原因叠在一起,行与行才对不齐:
                   ① ★「⋯」只有管理员那行才渲染★ —— 有它的行标签被往左顶,没它的贴到最右,
                      于是标签的右边缘在两个位置之间来回跳;
                   ② 标签自身宽度还不一样(管理员/可编辑 3 字、只读 2 字),左边缘也参差。
                  ★靠「刚好排在一起」是排不齐的,必须给它们各自一个不随内容变的槽。★
                  槽宽 76/24 是量出来的:76 装得下最长的「管理员」还留一点余量。
                  ⚠ 材料区那一行已经不在这个列表里(它在筛选器上面单独一格),
                    所以这里不再判 isMaterials —— ★留着一个永远命中不了的分支会让人以为它还有用。★ */}
              <span style={{ display: 'inline-flex', justifyContent: 'flex-end', width: 76, flexShrink: 0 }}>
                {s.my_role && ROLE_TAG[s.my_role]}
              </span>
              <span style={{ display: 'inline-flex', justifyContent: 'center', width: 24, flexShrink: 0 }}>
                {s.my_role === 'admin' && (
                  <Dropdown menu={spaceMenu(s)} trigger={['click']}>
                    <Button type="text" size="small" onClick={(e) => e.stopPropagation()}>⋯</Button>
                  </Dropdown>
                )}
              </span>
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
              {isMat && <Tag color="gold">系统 · 只读</Tag>}
            </AntSpace>
          }
          extra={
            /* ★配额条去掉了★（ADR-0004）：额度不再挂在项目上，挂在**人**身上。
               这里只显示「这个项目占了多少」—— 一个项目的占用除以**别人的**总额度
               画出来的进度条，是在误导人。总额度看「个人面板」的 /api/me/quota。 */
            <Tooltip title="这个项目占用的空间；总额度按人算，见个人面板">
              <span style={{ color: '#888', fontSize: 12 }}>占用 {fmtSize(cur.used_bytes)}</span>
            </Tooltip>
          }
        >
          {/* ★四个 tab★(原型 proj 视图):成员 / 内容 / 活动 / 设置。
              此前只有「内容」,成员藏在弹窗里、★项目的活动根本没有入口★ ——
              而 D7 明说材料有两个入口(项目 与 时间线),活动同理。 */}
          {/* ★activeKey 必须**派生**,不能直接用 ptab★(2026-08-09 liaoruili 撞到:
              停在别的项目的「设置」tab 上,切到「我的活动材料」→ 右边整块空白)。
              材料区只有「文档」一个 tab,而选中值还指着一个**已经不存在的 key** ——
              AntD 于是什么都不渲染,只剩一条悬空的下划线。
              ★这和 effectiveScope 是同一个坑★(可选项没了、选中值还指着它),修法也一样:
              不同步两份状态,**让取值从可选项派生**。判据在 project-filter.ts,带复现测试。
              ⚠ key 列表从 `tabItems` 现算,不另写一份 —— 手写一份的话,以后加了 tab
              却忘了加进列表,那个 tab 会**点不动**(被 effectiveTab 挡回 items),很难查。 */}
          {(() => {
          const tabItems = [
            {
              // ★叫「文档」不叫「内容」★(2026-08-09 liaoruili):这一栏装的就是文件与文档,
              // 而「内容」这个词在同一页里还指别的东西(活动、成员也都是这个项目的内容)。
              key: 'items', label: '文档',
              children: (<>
          {/* 归档状态由标题旁的「已归档 · 只读」标签表达,写入按钮同时隐藏 ——
              状态清楚、入口没了,不必再写一段话解释(2026-08-07 用户:这种啰嗦的说明删掉)。 */}
          {/* 内容操作工具栏(editor+):只有「在项目里干活」的动作,没有项目管理项。
              ★归档时只留「回收站」★——它是读操作,存档项目照样该能查看已删内容。 */}
          {/* ★材料区要说清「为什么没有上传按钮」★:一个只读的文件页如果不解释,
              人只会以为是坏了。一句话给出去处(回那条活动),不写成一整段说明。 */}
          {isMat && (
            <Alert type="info" showIcon style={{ marginBottom: 10 }}
              message="不关联项目的个人活动，材料落在这里。这里是只读的——加材料、删材料都回到那条活动里做。" />
          )}
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
              {/* ★「我的活动材料」不给回收站入口★（2026-08-15 liaoruili:「不合理,没有增删改查权力」）:
                  这个区标着「系统 · 只读」,横幅也明说「加材料、删材料都回到那条活动里做」——
                  ★既然在这里删不了东西,这里就不该有「装被删东西的地方」★。
                  它此前一直在,点开永远是「回收站是空的」(删除动作发生在活动那边,
                  软删的行也归属那条活动)—— 于是这个按钮**只会让人以为自己漏看了什么**。
                  ⚠ 判据用 `isMaterials()`(唯一推导),不用 `readOnly` ——
                    归档项目也是只读,但它**确实有**自己的回收站,那个入口要留着。 */}
              {!isMaterials(cur) && (
                <Button size="small" icon={<DeleteOutlined />} onClick={() => setTrashOpen(true)}>回收站</Button>
              )}
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
            // 同 activity-upload.tsx:子元素冒泡会制造成对的 leave/enter,直接开关会狂闪。
            // ★判据是「进出的净次数」★,归零才算真的离开。
            onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; if (canEdit) setDragging(true) }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
            onDrop={(e) => {
              e.preventDefault(); dragDepth.current = 0; setDragging(false)
              if (canEdit) uploadFiles(Array.from(e.dataTransfer.files).filter((f) => f.size > 0))
            }}
            style={{
              borderRadius: 8, transition: 'all .15s', minHeight: 200,
              outline: dragging ? '2px dashed #0d9488' : 'none',
              background: dragging ? '#e6fffb' : undefined, padding: dragging ? 6 : 0,
            }}
          >
            <Table
              // ★「..」和「上传中」两种伪行永远留在每一页顶上,不参与分页★:
              //   把「返回上一层」翻到第 3 页去,人在第 3 页就出不来了。
              // ⚠★翻页器**不能**交给 Table 自己管★(2026-08-13 差点写错):
              //   antd 的 Table 在 `dataSource.length > pageSize` 时会**再自己切一刀**,
              //   而这里的 dataSource 已经是切好的一页 + 两种伪行 —— 于是第 2 页会被
              //   二次切成只剩一行。分页器单独放在表格下面(和「公开活动」那处同一做法)。
              size="small" rowKey="id" dataSource={[...parentRow, ...upRows, ...本页行]} pagination={false}
              // 受控排序:伪行(..、上传中)不能被卷进排序,所以自己算 dataSource,
              // 这里只把表头的箭头状态同步过去。
              onChange={(_p, _f, so) => {
                const s2 = Array.isArray(so) ? so[0] : so
                const k = (s2?.field as typeof sortKey) || 'name'
                setSortKey(k)
                setSortAsc(s2?.order !== 'descend')
              }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={canEdit ? '这里还是空的——上传文件，或把文件拖进来' : '这里还是空的'} /> }}
              rowSelection={canEdit ? {
                selectedRowKeys: checked, onChange: (k) => setChecked((k as number[]).filter((x) => x > 0)),
                // ★活动材料不给勾选★:勾上之后「移动 / 删除」两个批量动作会整批失败,
                // 而批量失败的报错最难读(不知道是哪一条挡住的)。不给选就不会走到那一步。
                getCheckboxProps: (it) => ({ disabled: !!up(it) || it.id === PARENT_ROW_ID || !!it.activity_id }),
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
                      <>
                        <a onClick={() => (it.kind === 'folder' ? (setCwd(it.id), setChecked([])) : setPreview(it))}>
                          <ItemIcon it={it} />{it.name}
                        </a>
                        {/* ★只读要看得见★:D10 说活动材料在项目树里不可改,可在此之前
                            界面上唯一的痕迹是「操作列少了三个图标」—— 那是**没有**,不是**说明**。
                            标只打在文件夹上:一场活动的材料整块归它,逐个文件再标一遍纯是噪音。
                            ⚠★2026-08-13 liaoruili:「你只读加个锁就行,这样 活动·只读 太罗嗦,
                              占空间 还被分成了两行」★—— 名字长一点的文件夹会把这个 Tag 挤到第二行,
                              于是**一行数据占两行高**,整张表都跟着松散。换成一把安静的小锁:
                              ★说明搬进 tooltip,视觉上只留一个记号★(同一条思路在 496 行那个
                              「我的活动材料」的锁上已经用过一次)。 */}
                        {it.activity_id && it.kind === 'folder' && (
                          <Tooltip title="活动材料：在项目里只读。改名、增删都回到那条活动里做">
                            <LockOutlined style={{ marginLeft: 6, color: '#d48806' }} />
                          </Tooltip>
                        )}
                        {/* ★传输校验对不上就说出来★(A2/D3):预签名分片上没有 checksum,
                            complete 只对字节数,所以保长度的损坏能整条过闸。不拦你用,
                            但别让人以为一切正常 —— 此前后端把这个信号改写成了「已核验」。 */}
                        {it.sha_declared_mismatch && (
                          <Tooltip title="上传时服务端算出的哈希与你本地算的不一致，很可能传输中损坏了。内容能打开，但建议重传一次核对。">
                            <Tag color="orange" style={{ marginLeft: 8 }}>校验不符</Tag>
                          </Tooltip>
                        )}
                      </>
                    )),
                },
                { title: '大小', dataIndex: 'size', width: 100,
                  sorter: true, sortOrder: sortKey === 'size' ? (sortAsc ? 'ascend' : 'descend') : null, render: (v, it) => (it.kind === 'folder' ? '—' : fmtSize(v)) },
                // ★展示上传时间而不是修改时间★(2026-08-05 反馈):移动/重命名都会刷新 updated_at,
                // 「挪个位置修改时间就变了」很反直觉;created_at 才是用户心里的「什么时候传的」。
                { title: '上传时间', dataIndex: 'created_at', width: 150,
                  sorter: true, sortOrder: sortKey === 'created_at' ? (sortAsc ? 'ascend' : 'descend') : null, render: (v, it) => (up(it) || it.id === PARENT_ROW_ID ? '—' : fmtTime(v)) },
                { title: '上传者', dataIndex: 'created_by', width: 110, ellipsis: true,
                  sorter: true, sortOrder: sortKey === 'created_by' ? (sortAsc ? 'ascend' : 'descend') : null,
                  // ★同一行里别出现两种「空」★(2026-08-15 巡检截图看出来的):
                  //   「..」这行的大小、上传时间都渲染成「—」,唯独上传者是**纯空白** ——
                  //   读的人会以为「这条数据缺了上传者」,而它根本不是一条数据。
                  render: (v, it) => (it.id === PARENT_ROW_ID ? '—' : v) },
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
                      {/* ★活动材料在项目树里是只读的★（D10;2026-08-09 liaoruili:「项目文件夹中的
                          会议内容是不可修改的」「要去会议里面删除」）：名字与位置由活动决定,
                          删除要回活动页。**后端已经拒了**(items.rs 的 update/remove),
                          这里不画按钮是为了不引导人去点一个必然失败的东西。
                          分享与下载照旧 —— 那是读操作,只读区不该连读都受限。 */}
                      {canEdit && !it.activity_id && <Tooltip title="重命名"><a onClick={() => rename(it)}><EditOutlined /></a></Tooltip>}
                      {/* 移动用 SwapOutlined(双向箭头),2026-08-04 用户看过 16 个候选的真实渲染后定的。
                          试过 FolderOpenOutlined(撞「打开文件夹」)、ExportOutlined(像「导出/新窗口」)、
                          SendOutlined(纸飞机,用户嫌丑)。hover 的「移动到…」补足语义。 */}
                      {canEdit && !it.activity_id && <Tooltip title="移动到…"><a onClick={() => setMoving([it])}><SwapOutlined /></a></Tooltip>}
                      {/* ★跨项目复制★(PRD J2)。⚠ 与「移动」的可见条件**不同**,是有意的:
                          移动要求 `!it.activity_id`(活动材料在项目树里是只读的,名字与位置由活动决定),
                          而复制★恰恰要在活动材料上可用★ —— PRD J2 的原话就是
                          「把那个 PDF **复制**进课题组的项目」,方向正是从材料区往外。
                          复制不动源,所以「源只读」不构成障碍。
                          ⚠ 文件夹不给(后端也拒):递归复制是另一件事,画个按钮再报错等于引导人犯错。 */}
                      {it.kind !== 'folder' && (
                        <Tooltip title="复制到其他项目…"><a onClick={() => setCopying(it)}><CopyOutlined /></a></Tooltip>
                      )}
                      {canEdit && !it.activity_id && (
                        <Tooltip title="删除">
                          <a style={{ color: '#ff4d4f' }} onClick={() => del([it])}><DeleteOutlined /></a>
                        </Tooltip>
                      )}
                      {/* ★点得进去★(2026-08-09 liaoruili:「操作那一栏,点击可以直接连接到
                          活动的详情页」)。原来这里是一个**灰色的、不能点的**「活动」二字 ——
                          它说的是「去活动页改」,却没告诉人活动页在哪,等于把人推到路口不给指路牌。
                          ⚠ 这一条对**所有**项目都成立(用户:「其他的项目也有一个只读的文件夹,
                          同理处理」):判据是 `it.activity_id`,与项目是不是材料区无关。 */}
                      {it.activity_id && (
                        <Tooltip title="这是活动材料：名称与位置由活动决定，增删都在活动页里做。点这里去那条活动">
                          <a onClick={() => onOpenActivity?.(it.activity_id!, cur?.id ?? null)}>去活动 ›</a>
                        </Tooltip>
                      )}
                    </AntSpace>
                  )),
                },
              ]}
            />
            {/* ★空文件夹也要说话★(2026-08-15 逐张看巡检截图看出来的):
                进到空的活动文件夹里,画面上只有一行「..」,底下一片空白 —— 而**项目根目录**为空时
                是有「这里还是空的——上传文件,或把文件拖进来」的。同一个「这里没东西」两种表现。
                ★根因是表格的 `locale.emptyText` 压根不会触发★:dataSource 里还有 `parentRow` 那一行,
                `length !== 0`,AntD 认为表格非空。所以补在表格外面,而不是去改 emptyText。 */}
            {cwd != null && 本页行.length === 0 && upRows.length === 0 && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '4px 0 12px' }}
                description={canEdit ? '这个文件夹是空的——上传文件，或把文件拖进来' : '这个文件夹是空的'} />
            )}
            {/* ★只有真需要翻页时才出现★:三五个文件的项目底下挂一个「1」的翻页器纯是噪音。 */}
            {rows.length > 文每页 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 4px 2px' }}>
                <Pagination size="small" current={文有效页} pageSize={文每页} total={rows.length}
                  showSizeChanger={false} onChange={set文页} showTotal={(t: number) => `共 ${t} 项`} />
              </div>
            )}
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
          <MembersModal key={cur.id} space={cur} me={me} open={grantsOpen} onClose={() => setGrantsOpen(false)} onChanged={loadProjects} />
          {shareFor && <ShareModal key={shareFor.map((i) => i.id).join('-')} items={shareFor} onClose={() => setShareFor(null)} />}
          <TrashDrawer space={cur} open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={refresh} />
              </>),
            },
            // ★材料区只有「文档」一个 tab★:成员(只有我一个)、活动(它不关联活动,
            // 是活动的材料落到它这儿)、设置(改名/归档/删除后端全拒)——三个都是空话。
            ...(isMat ? [] : [
            {
              key: 'members', label: '成员',
              children: <MembersModal key={`m${cur.id}`} space={cur} me={me} open onClose={() => {}}
                onChanged={loadProjects} inline />,
            },
            {
              key: 'activities', label: '活动',
              children: <ProjectActivities projectId={cur.id} />,
            },
            {
              key: 'settings', label: '设置',
              children: <ProjectSettings space={cur} onChanged={loadProjects} menu={spaceMenu(cur)} />,
            }]),
          ]
          return <Tabs size="small" activeKey={effectiveTab(ptab, tabItems.map((t) => t.key))}
                       onChange={setPtab} items={tabItems} />
          })()}
        </Card>
      ) : (
        <Card style={{ flex: 1 }}>
          <Empty description="选择或新建一个项目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
      {/* 项目级回收站。★挂在最外层★:它与「当前选中哪个项目」无关 ——
          删掉的项目本来就不在列表里,选不中。 */}
      <Drawer title="项目回收站" open={projTrashOpen} onClose={() => setProjTrashOpen(false)} width={460}>
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="删掉的项目在这里保留 30 天"
          description="期间文件一个字节都没删，还原后内容原样回来。⚠ 已发出去的公开链接在删除那一刻就失效了，还原不会恢复它们。" />
        {/* ★这是**第二个**回收站,别和项目内那个混★(2026-08-14 实拍才发现漏了它):
            上面那个 TrashDrawer 列的是**项目里删掉的文件**(走服务端分页,后端原来写死 LIMIT 500);
            这一个列的是**删掉的项目本身**(`GET /api/projects/trash`)。
            ★我上一轮只做了前者,而实拍时这里已经堆了 37 条滚不完★ —— 用户说「回收站要分页」时
            指的是他看得见的那个,而"回收站"在界面上有两个入口。
            这条接口**没有 LIMIT**,一条不丢,所以前端分页就够(判据同项目文件列表)。 */}
        <List size="small" dataSource={projTrash}
          pagination={projTrash.length > 10
            ? { pageSize: 10, size: 'small', align: 'center', showSizeChanger: false,
                showTotal: (n) => `共 ${n} 个` }
            : false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站是空的" /> }}
          renderItem={(t) => (
            <List.Item actions={[
              <Popconfirm key="r" title={`还原「${t.name}」？`} okText="还原" cancelText="取消"
                onConfirm={async () => {
                  try {
                    await api(`/api/projects/${t.id}/undelete`, { method: 'POST' })
                    message.success('已还原'); await loadProjects()
                  } catch (e) { message.error((e as Error).message) }
                }}><a>还原</a></Popconfirm>,
            ]}>
              <List.Item.Meta title={t.name}
                description={`${fmtTime(t.deleted_at)} 删除 · ${t.days_left > 0 ? `还剩 ${t.days_left} 天` : '即将彻底删除'}`} />
            </List.Item>
          )} />
      </Drawer>
    </div>
      {/* ★复制到其他项目★(PRD J2)。目标只列**我有编辑权、且不是材料区**的项目 ——
          后端两条都会拒,前端不画必然失败的选项(与「关联项目」下拉同一条原则)。 */}
      <Modal open={!!copying} title={`复制「${copying?.name ?? ''}」到其他项目`}
        okText="复制" cancelText="取消" okButtonProps={{ disabled: !copyTo }}
        onCancel={() => { setCopying(null); setCopyTo(null) }}
        onOk={async () => {
          if (!copying || !copyTo) return
          try {
            await api(`/api/items/${copying.id}/copy`, {
              method: 'POST', body: JSON.stringify({ project_id: copyTo }),
            })
            message.success('已复制')
            setCopying(null); setCopyTo(null)
          } catch (e) { message.error((e as Error).message) }
        }}>
        <Select style={{ width: '100%' }} placeholder="选一个项目" value={copyTo ?? undefined}
          onChange={setCopyTo} showSearch optionFilterProp="label"
          options={projects.filter((p) => !isMaterials(p) && p.id !== cur?.id
              && (p.my_role === 'editor' || p.my_role === 'admin') && !p.archived_at)
            .map((p) => ({ value: p.id, label: p.name }))} />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          {/* ★把「几乎免费」讲给用户听★:不解释的话,人会以为复制一份 1GB 的文件要占两份额度,
              于是不敢用 —— 而这正是 J2 存在的意义(内容寻址下盘上本来就只有一份)。 */}
          副本是**独立**的：改名或删除都不影响原件。
          复制到<b>你自己主持的项目</b>不额外占用配额（同一份内容只算一次）。
        </Typography.Paragraph>
      </Modal>
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
              <Popconfirm key="r" title="恢复到此版本？(当前版会自动存为快照)" onConfirm={async () => {
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
/// 成员与设置。★两种形态一份实现★:项目页的「成员」tab 用 inline 内嵌,
/// 别处仍可当弹窗用 —— 免得同一份逻辑维护两遍(2026-08-07 按原型加四 tab 时)。
function MembersModal({ space, open, onClose, onChanged, inline = false, me }:
  { space: Project; open: boolean; onClose: () => void; onChanged: () => void; inline?: boolean; me?: Me | null }) {
  const { message } = AntdApp.useApp()
  const [owner, setOwner] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [role, setRole] = useState<Role>('editor')
  const [users, setUsers] = useState<UserOpt[]>([])
  const [diagName, setDiagName] = useState('')
  const [diag, setDiag] = useState<Diagnose | null>(null)
  const [hot, setHot] = useState(space.hotwords ?? '')
  /// ★这一屏的写操作只有管理员能做★（2026-08-13 沙箱全点巡检抓到）:
  /// 巡检以一个**只是「可编辑」**的身份点了术语表的「保存」→ `PUT /api/projects/{id}` 403。
  /// 后端拒得对(改项目设置要 admin),★错在前端把这个按钮画了出来★ ——
  /// 仓库里为材料区回收站写过同一句话:**亮一个必然 403 的按钮比没有按钮更糟**。
  /// ⚠ 名单本身**照旧给非管理员看**:知道「谁在这个项目里」是协作的基本信息,
  ///   要拦的是「改」,不是「看」。所以是把写控件收起来,不是把整个 tab 藏掉。
  const 可管理 = space.my_role === 'admin'

  const load = useCallback(async () => {
    const r = await api<MemberList>(`/api/projects/${space.id}/members`)
    setOwner(r.owner); setMembers(r.members)
  }, [space.id])
  useEffect(() => { if (open) load().catch((e) => message.error(e.message)) }, [open, load, message])

  // 名单不整表下发(审计收紧):输前缀才查。
  // ⚠ ★这个接口查的是**本地 app_user**,只有登录过汇流的人才在里面★(admin.rs user_options)。
  // 平台目前只有 users/exists(校验单个用户名),没有用户搜索接口 —— 已在群里提。
  // 所以候选搜不到 ≠ 这个人不存在:后端加人走 ensure_platform_user → 平台 users/exists,
  // **能拉从没登录过汇流的同事**。前端因此必须允许**手输用户名**,否则等于把后端支持的路堵死。
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

  const body = (
    <>
      {/* ★把「你随时可以撤回」这句空头承诺兑现掉★（2026-08-15 逐张看巡检截图看出来的）:
          转让确认框里明明写着「他会收到一条站内信；**你随时可以撤回**」,
          后端也确实有 `DELETE /api/projects/{id}/transfer` —— 可**界面上没有任何入口**,
          发起方甚至看不到「我发出去的那笔还挂着」(`/api/me/transfers` 是给**接收方**的)。
          ★这句话恰恰是在一个有后果的动作前用来让人放心的★ —— 在最需要它的时候它是假的。
          数据一直都在(详情接口的 `pending_transfer`),只是前端从没用过。 */}
      {space.pending_transfer && space.pending_transfer.from === me?.username && (
        <Alert type="warning" showIcon style={{ marginBottom: 10 }}
          message={<span>主持人正在转给 <b>{space.pending_transfer.to}</b>，等他接受</span>}
          description="在他答复之前，主持人还是你。"
          action={<Popconfirm title="撤回这次转让？" description="撤回后他那条站内信里的按钮就失效了。"
            onConfirm={async () => {
              try {
                await api(`/api/projects/${space.id}/transfer`, { method: 'DELETE' })
                message.success('已撤回'); await load(); onChanged()
              } catch (e) { message.error((e as Error).message) }
            }}><Button size="small">撤回</Button></Popconfirm>} />
      )}
      <Typography.Text strong>成员（{members.length}）</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 10px' }}>
        进了项目就能看到<b>本项目全部资料</b>，包括他加入之前的历史；移出即失去全部。
      </Typography.Paragraph>

      {可管理 && <AntSpace.Compact style={{ width: '100%', marginBottom: 10 }}>
        {/* ★mode="tags" 而不是 "multiple"★:允许把没搜到的用户名直接敲进去 ——
            候选只覆盖登录过汇流的人,而后端能拉任何平台用户(见 searchUsers 上面的注释)。
            用 multiple 的话,新同事永远加不进来。真伪由后端 ensure_platform_user 判,加错了会被拒。 */}
        <Select mode="tags" value={picked} onChange={setPicked} onSearch={searchUsers}
          filterOption={false} placeholder="输入用户名，可多选（没搜到也能直接输入）" style={{ flex: 1 }}
          notFoundContent={null}
          options={users.map((u) => ({ value: u.username, label: u.name ? `${u.username}（${u.name}）` : u.username }))} />
        <Select value={role} onChange={setRole} style={{ width: 120 }}
          options={[
            { value: 'viewer', label: '只读成员' },
            { value: 'editor', label: '成员' },
            { value: 'admin', label: '管理员' },
          ]} />
        <Button type="primary" onClick={addBatch}>批量添加</Button>
      </AntSpace.Compact>}

      <Table size="small" rowKey="username" dataSource={members} pagination={false}
        columns={[
          {
            // ★显示「用户名（姓名）」★:光有用户名认不出人是谁(2026-08-07 用户提)。
            // 姓名来自 app_user.name(登录时由 OIDC claims 落库);拉进来还没登录过的人为空,
            // showUser 会只显示用户名 —— 不会出现「zhangsan（）」这种空括号。
            title: '成员',
            render: (_, m) => (
              <span>{showUser(m.username, m.name)}
                {m.username === owner && <Tag color="cyan" style={{ marginLeft: 6 }}>主持人</Tag>}</span>),
          },
          {
            title: '角色', width: 140,
            render: (_, m) => (
              <Select size="small" value={m.role} style={{ width: 118 }}
                disabled={m.username === owner || !可管理}
                onChange={(r) => changeRole(m, r as Role)}
                // ★用唯一真相源 ROLE_LABEL,别在这儿另写一套词★(2026-08-15 巡检截图看出来的):
                //   本文件开头就写着「★角色只有四个词(2026-08-03 用户定):管理员 / 可编辑 / 只读 / 无权限★」
                //   并给了 `ROLE_LABEL` —— 可这个下拉自己写了「只读成员 / 成员 / 管理员」。
                //   后果是**同一个人、同一个项目、同一屏**:左边列表徽章写「可编辑」,
                //   右边成员表下拉写「成员」。★读的人会以为那是两种不同的身份。★
                //   ⚠ 这正是本仓最核心的那条纪律的反例:每样东西只有一个真相源。
                options={(['viewer', 'editor', 'admin'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />),
          },
          { title: '加入', dataIndex: 'added_at', width: 110, render: (t: string) => t?.slice(0, 10) },
          {
            title: '', width: 130,
            render: (_, m) => (m.username === owner ? null : (
              <AntSpace size={10}>
              {/* ★转主持人是「发起」不是「转」★(PRD ⑨.5):对方点了接受才生效,
                  待接受期间我仍是主持人。文案必须说清,否则点完以为已经卸任了。 */}
              {me?.username === owner && (
                <Popconfirm
                  title={`把主持人转给 ${m.username}？`}
                  description={<div style={{ maxWidth: 320, fontSize: 12 }}>
                    · <b>要他接受才生效</b>；在他答复之前，主持人还是你<br />
                    · 他会收到一条站内信；你随时可以撤回<br />
                    · 生效后你保留<b>管理员</b>身份，不会被移出项目
                  </div>}
                  onConfirm={async () => {
                    try {
                      await api(`/api/projects/${space.id}/transfer`, {
                        method: 'POST', body: JSON.stringify({ to: m.username }),
                      })
                      message.success('已发出，等他接受')
                      await load(); onChanged()
                    } catch (e) { message.error((e as Error).message) }
                  }}>
                  <a>转主持人</a>
                </Popconfirm>
              )}
              {/* ★把自己移出时要说「你」,不是「他」★(2026-08-15 逐张看巡检截图看出来的):
                  非管理员在成员页看到的那个红色「移出」**只出现在自己这一行**(自己退出项目),
                  可弹窗照旧写「把 liaoruili 移出项目?**他**将立刻看不到…」——
                  ★用第三人称描述一件正在对自己做的、不可逆的事,人容易读成「在处理别人」而顺手确认★,
                  而这一下之后他就进不来这个项目了(要再进得找主持人)。
                  三条后果一个字不改,只把人称和标题按「是不是我自己」切换。 */}
              <Popconfirm
                title={me?.username === m.username ? '退出这个项目？' : `把 ${m.username} 移出项目？`}
                description={me?.username === m.username ? (
                  <div style={{ maxWidth: 320, fontSize: 12 }}>
                    · <b>你</b>将立刻看不到本项目全部资料，包括你自己参与过的活动<br />
                    · 你上传的材料<b>全部留下</b>，署名保留<br />
                    · <b>你创建的、指向本项目的公开链接会被一并撤销</b><br />
                    · 要再进来，得请<b>主持人</b>重新拉你
                  </div>
                ) : (<div style={{ maxWidth: 320, fontSize: 12 }}>
                  · 他将立刻看不到本项目全部资料，包括他自己参与过的活动<br />
                  · 他上传的材料<b>全部留下</b>，署名保留<br />
                  · <b>他创建的、指向本项目的公开链接会被一并撤销</b>
                </div>)}
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
                {/* 链接文字也跟着换:自己那一行叫「退出」——「移出」听起来是在处理别人。 */}
                <a style={{ color: '#ff4d4f' }}>{me?.username === m.username ? '退出' : '移出'}</a>
              </Popconfirm>
              </AntSpace>)),
          },
        ]} />

      <Typography.Text strong style={{ display: 'block', marginTop: 18 }}>权限诊断</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        判定链只有两段：是不是超管、成员表里是什么角色。
      </Typography.Paragraph>
      <AntSpace.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Input value={diagName} onChange={(e) => setDiagName(e.target.value)} placeholder="用户名" />
        {/* ★别留一个「点了什么都不做」的按钮★(2026-08-15 逐张看巡检截图看出来的,六个项目全一样):
            原来是 `onClick` 里 `if (!diagName.trim()) return` —— 静默 return,而按钮**可点**。
            点下去页面毫无反应,人分不清是「查了但没这个人」「我没权限查」还是「页面坏了」,
            ★而这三种情况下一步该做的事完全不同★。
            ⚠ 巡检报告永远抓不到这一格:它只认「点不动 / 前端报错 / HTTP≥400」,
              而这里点得动、不报错、连请求都没发。
            ★为什么是弹提示而不是禁用按钮★:**同一张卡片上**另外两个按钮的做法已经定了调 ——
              「批量添加」空着点会弹「先选人」、「保存」空着点会弹「已保存」(清空词表是合法操作)。
              三个按钮里只有这一个是哑的。做成禁用虽然也讲得通,却是**第三种**行为,
              ★卡片内部一致比我个人偏好哪种更重要★ —— 人看的是这一片区域,不是单个控件。 */}
        <Button onClick={async () => {
          if (!diagName.trim()) { message.warning('先填用户名'); return }
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

      {可管理 && <><Typography.Text strong style={{ display: 'block', marginTop: 18 }}>转写术语表</Typography.Text>
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
      </AntSpace.Compact></>}
      {!可管理 && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
          只有项目管理员能加人、改角色和维护转写术语表。
        </Typography.Paragraph>
      )}
    </>
  )
  // inline:直接吐内容(项目页的「成员」tab);否则仍是弹窗
  return inline ? body : (
    <Modal title={`成员与设置 — ${space.name}`} open={open} onCancel={onClose} footer={null} width={680}>
      {body}
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
  // ★服务端分页★(2026-08-13):后端原来写死 `LIMIT 500` 且不给总数 —— 第 501 条起
  //   **在界面上凭空消失**,而它还在库里、还占着配额。这不是「列表太长」,是数据不见了。
  //   所以这里的翻页必须是**真去服务端要下一页**,不是把已经拿到的数组切一刀。
  const [页, set页] = useState(1)
  const [总数, set总数] = useState(0)
  const 每页 = 20
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api<{ items: TrashRow[]; total: number }>(
        `/api/projects/${space.id}/trash?page=${页}&size=${每页}`)
      setRows(r.items); set总数(r.total)
    } catch { setRows([]); set总数(0) } finally { setLoading(false) }
  }, [space.id, 页])
  useEffect(() => { if (open) void load() }, [open, load])
  // 换项目/重开抽屉都回到第一页 —— 停在上一个项目的第 7 页上只会看到空列表
  useEffect(() => { set页(1) }, [space.id, open])
  // ★还原/彻底删之后当前页可能空了★:删光最后一页的内容,停在那一页会显示「回收站是空的」,
  //   而其实前面还有 100 条 —— 又一次「界面替数据撒谎」。所以往前退一页。
  useEffect(() => { if (!loading && rows.length === 0 && 页 > 1) set页((n) => n - 1) }, [loading, rows.length, 页])

  // ★标题要带作用域★(2026-08-15 巡检截图看出来的):侧栏那个叫「项目回收站」(删掉的**项目**),
  //   这个只叫「回收站」(项目里删掉的**文件**)。而左上角按钮写着「回收站 4」——
  //   那个 4 是**项目**回收站的数,同屏打开这个却说「回收站是空的」,
  //   ★读起来像「我那 4 样东西不见了」★。加上项目名和「文件」两个字就分得开。
  // ⚠★JSX 注释别放进 `return (` 的根元素旁边★ —— 那是两个根节点,tsc 直接报
  //   `Declaration or statement expected`。今天第二次踩(第一次在 activity-detail 那边),
  //   所以这条注释就放在这儿:**函数体里,return 之前**。
  // ★宽度 640 → 760★(2026-08-15 逐张看巡检截图看出来的):后面四列是写死的
  //   92 + 148 + 100 + 130 = 470,「名称」只分得到约 130px,于是文件名被截成「博士论文一…」——
  //   而回收站里恰恰**只剩名字可认**(内容已经看不到了),名字截掉就等于让人猜该还原哪一个。
  return (
    <Drawer title={`🗑 ${space.name} · 文件回收站`} open={open} onClose={onClose} width={760}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {/* ★「项目配额」这个东西已经不存在了★(2026-08-15 逐张看巡检截图看出来的):
            ADR-0004 起配额**按人算**(`user_quota`),库里根本没有项目级配额;
            个人面板那句写的是「算的是你名下所有项目之和;同一份内容放进多个项目只算一次」。
            ⚠ 这不是措辞问题:说成「项目配额」会让人以为**把文件挪到别的项目就能腾空间** ——
            而实际按人算、同内容还去重,挪了等于没挪,人会白折腾一圈还以为是系统没生效。 */}
        删除的内容在这里保留 <b>30 天</b>,之后自动清除。回收站里的内容<b>仍计入你的配额</b>（按人算,不按项目）。
      </Typography.Paragraph>
      <Table size="small" rowKey="id" dataSource={rows} loading={loading}
        // ★把 total 交给 AntD 自己算页数★:它显示的「共 N 条」直接来自服务端,
        //   人一眼能看出回收站里到底有多少 —— 这正是写死 LIMIT 时缺的那句话。
        pagination={{ current: 页, pageSize: 每页, total: 总数, onChange: set页,
                      size: 'small', showSizeChanger: false, hideOnSinglePage: true,
                      showTotal: (t) => `共 ${t} 条` }}
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
                  title: '彻底删除？', okButtonProps: { danger: true },
                  content: '这一步不可撤销：内容会从对象存储里真正抹掉(若没有别处引用同一份内容)。',
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
/// 项目的活动(原型 proj 视图的「活动」tab)。
/// ★D7 说材料有两个入口:项目 与 时间线★——活动同理:在项目里就该看得到「这个项目开过哪些会」,
/// 而不是只能去日程/活动页按项目筛。后端 `/api/activities?project_id=` 早就支持,只是没有入口。
type ProjStats = {
  range: string; activities: number; hours: number
  hours_by_source: { recording: number; manual: number; scheduled: number }
  invited: number; accepted: number; accept_rate: number
  avg_hours_per_person: number | null; minutes_done: number
}

function ProjectActivities({ projectId }: { projectId: number }) {
  const [rows, setRows] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<ProjStats | null>(null)
  const [range, setRange] = useState('quarter')
  useEffect(() => {
    api<ProjStats>(`/api/projects/${projectId}/stats?range=${range}`)
      .then(setStats).catch(() => setStats(null))
  }, [projectId, range])
  useEffect(() => {
    setLoading(true)
    // 前后各半年:项目页看的是「这个项目开过/要开哪些会」,不是当周日程
    const from = new Date(Date.now() - 183 * 864e5).toISOString()
    const to = new Date(Date.now() + 183 * 864e5).toISOString()
    api<Activity[]>(`/api/activities?project_id=${projectId}&from=${from}&to=${to}`)
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false))
  }, [projectId])

  const now = Date.now()
  return (
    <>
    {/* ★项目统计★(PRD 6.5.2):「作为组负责人,我想知道 AI 组这季度开了多少会」。
        放在活动 tab 顶上而不是单开一页 —— 看统计的人下一步多半就是想看是哪些会。 */}
    {stats && (
      <div style={{ background: '#fafafa', borderRadius: 6, padding: '10px 14px', marginBottom: 12 }}>
        <AntSpace size={16} wrap align="center">
          <Segmented size="small" value={range} onChange={(v) => setRange(v as string)}
            options={[{ value: 'month', label: '本月' }, { value: 'quarter', label: '本季度' }, { value: 'year', label: '本年' }]} />
          <span><b style={{ fontSize: 18, color: '#0d9488' }}>{stats.activities}</b> 次活动</span>
          <span><b style={{ fontSize: 18, color: '#0d9488' }}>{stats.hours}</b> 小时</span>
          {/* ★没人可邀请时别报「0%」★(2026-08-15 逐张看巡检截图看出来的):
              空项目上原来渲染成「参会率 **0%**(0/0)」—— 读起来是**「叫了人但没人来」**,
              而事实是「压根没有可度量的东西」。★0/0 不是 0,把它算成 0 就是在编一个坏消息★。
              判据照抄旁边的「人均」:那一项**早就**有 `!= null` 守卫,
              说明这套代码本来就知道「没意义的数字要藏起来」,只是参会率漏了。
              下面的空态已经写着「这个项目还没有活动」,不必再补一句解释。 */}
          {stats.invited > 0 && (
            <span>参会率 <b>{Math.round(stats.accept_rate * 100)}%</b>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{stats.accepted}/{stats.invited}）</Typography.Text></span>
          )}
          {/* ★「人均」这个词把这个数说错了★(2026-08-15 逐张看巡检截图看出来的)。
              后端算的是 `SUM(每场时长 × 该场接受人数) / SUM(接受人数)` —— ★分母是**人次**,不是人数★
              (`activities.rs` 那段注释自己写着「分母是人次」,变量却叫 `per_person`)。
              实拍反例:课题组·计量经济学 3 场、共 4 小时、每场只有 liaoruili 一个人 →
              显示「人均 1.3 h」,而**那个人实际坐了 4 小时** —— ★少报了 3 倍★。
              数没算错,是名字把它说成了另一件事;而「人均」正是最容易被当成「每人花了多久」的说法。
              改叫「每人次」:它字面就是分母,读的人不会再往「每个人」上想。 */}
          {stats.avg_hours_per_person != null && <span>每人次 <b>{stats.avg_hours_per_person}</b> h</span>}
          {/* ★同一条指标带里三个数,不能两个藏一个不藏★(2026-08-15):
              「参会率」在没人被邀请时藏了、「每人次」本来就有守卫,唯独这个还渲染成 `0/0`。
              ⚠ 这是我自己修「参会率 0%」时**只修了一半**留下的 —— 判据是同一个:
                没有可度量的对象时,分数不是 0,是**没有**。 */}
          {stats.activities > 0 && <span>纪要完成 <b>{stats.minutes_done}</b>/{stats.activities}</span>}
        </AntSpace>
        {stats.hours > 0 && (
          <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 6 }}>
            {/* D5:口径来源要透明,「按排程估算」的那部分最不可信,标出来 */}
            时长来源：
            {stats.hours_by_source.recording > 0 && `${stats.hours_by_source.recording} h 录制　`}
            {stats.hours_by_source.manual > 0 && `${stats.hours_by_source.manual} h 手工　`}
            {stats.hours_by_source.scheduled > 0 && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>{stats.hours_by_source.scheduled} h 按排程估算</Typography.Text>
            )}
            {/* ★D6★:不说这句,有人会把几个项目的数字相加当总数 */}
            <span style={{ marginLeft: 12 }}>· 一场活动可关联多个项目，跨项目求总数需按活动去重</span>
          </div>
        )}
      </div>
    )}
    <Table<Activity> size="small" rowKey="id" dataSource={rows} loading={loading}
      pagination={{ pageSize: 15, hideOnSinglePage: true }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个项目还没有活动" /> }}
      columns={[
        {
          title: '时间', width: 150,
          render: (_, m) => {
            const d = new Date(m.starts_at)
            const p = (n: number) => String(n).padStart(2, '0')
            return <span style={{ fontSize: 12 }}>
              {d.getMonth() + 1}/{d.getDate()} {p(d.getHours())}:{p(d.getMinutes())}
            </span>
          },
        },
        { title: '标题', dataIndex: 'title', ellipsis: true },
        { title: '记录员', dataIndex: 'recorder', width: 100, ellipsis: true },
        {
          title: '', width: 96,
          render: (_, m) => new Date(m.ends_at).getTime() < now
            ? (m.minutes_status === 'done' ? <Tag color="green">纪要已完成</Tag> : <Tag color="orange">纪要待整理</Tag>)
            : <Tag color="blue">未开始</Tag>,
        },
      ]} />
    </>
  )
}

/// 项目设置(原型 proj 视图的「设置」tab)。
/// ★把散在 ⋯ 菜单里的项目级动作集中到一处★:此前重命名/归档/删除只在左栏那个三点菜单里,
/// 用户找不到(2026-08-07 反馈「把这三个点点的功能放到同一个界面」)。
function ProjectSettings({ space, menu }: {
  space: Project; onChanged: () => void
  menu: { items: unknown[]; onClick: (e: { key: string }) => void }
}) {
  const act = (key: string) => menu.onClick({ key })
  return (
    <AntSpace direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>项目</Typography.Text>
        <div style={{ marginTop: 6 }}>
          {/* ★这三件事都要**主持人**★(后端一律 `require_owner`) —— 不是主持人就别把入口摆出来。
              ⚠ 2026-08-14 逐按钮巡检抓到的:这里此前**完全没判角色**,于是「可编辑」的成员
                照样看得到三个按钮,点「归档项目」→ 红条 `forbidden: 权限不足`。
                ★后端拦对了,所以这不是安全问题 —— 但摆一个点了必然被拒的入口是在骗人★,
                而且那句报错前面还原样透出了英文错误码,人既不知道为什么、也不知道该找谁。
              ⚠ 前端隐藏按钮**不是**安全边界(后端照旧判权),这里做的只是「别给做不到的事留入口」。 */}
          {space.my_role === 'admin' ? (
            <AntSpace wrap>
              <Button size="small" disabled={!!space.archived_at} onClick={() => act('rename')}>重命名</Button>
              {/* 归档 ≠ 删除:归档=做完了留着查,删除=不要了。两个动作在这里也分开摆 */}
              <Button size="small" onClick={() => act('archive')}>
                {space.archived_at ? '恢复为进行中' : '归档项目'}
              </Button>
              <Button size="small" danger onClick={() => act('delete')}>删除项目</Button>
            </AntSpace>
          ) : (
            /// ★说清楚「为什么没有」比什么都不显示好★:空白会让人以为页面坏了或还没加载完。
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              重命名、归档、删除只有<b>主持人</b>能做。你在这个项目里是「{
                space.my_role === 'editor' ? '可编辑' : '只读'
              }」—— 要动这些,请找主持人（{space.created_by}）。
            </Typography.Text>
          )}
        </div>
        {space.archived_at && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            已归档于 {new Date(space.archived_at).toLocaleDateString('zh-CN')}，内容只读。
          </Typography.Text>
        )}
      </div>
      {/* ★这句话原来写的是「成员、可见性、禁下载、转写术语表在「成员」标签页里」——
          四样里**有两样指向不存在的地方**(2026-08-15 逐张看巡检截图 + grep 代码核实):
            · 可见性:项目级的 `visibility` 在 M0-1 就删了(见 `api.ts` 那段头注:★没有 visibility★),
              它原本兼着「内容给谁看」和「占不占忙闲」两件正交的事,后者已挪到活动自己的 `busy`;
            · 禁下载:字段还在,但开关长在**活动的材料区**(`activity-detail.tsx` 的 policy 那块),
              成员 tab 里根本没有;本文件只是**读** `no_download` 来对 viewer 隐掉下载按钮。
          管理员项目的成员页实拍只有「成员 / 权限诊断 / 转写术语表」三块。
          ★指错路的提示比没有提示更坏★:人会照着去翻,翻不到就以为是自己权限不够或者页面坏了。 */}
      {/* ★这句也要跟着角色裁剪★(2026-08-15 巡检截图看出来的):上面三个按钮我已经按
          「是不是主持人」收了口,却把这句原样留着 —— 又一次**只修了一半**。
          「转写术语表」只有**项目管理员**能维护(成员页自己就写着这句),
          对「可编辑」角色来说,照这句去成员页是**找不到**那一块的。 */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {space.my_role === 'admin'
          ? '成员、转写术语表在「成员」标签页里；禁止下载是每场活动材料区自己的开关。'
          : '成员名单在「成员」标签页里（加人、改角色、转写术语表只有管理员能动）；禁止下载是每场活动材料区自己的开关。'}
      </Typography.Text>
    </AntSpace>
  )
}
