// 空间视图:左列空间列表,右侧选中空间的文件树 + 内容面板。
// 前端只做显隐(my_role),真判权在后端(perm.rs)——按钮藏了 API 也会 403,别当安全边界。
import {
  App as AntdApp, AutoComplete, Button, Card, Drawer, Empty, Input, List, Modal, Popconfirm, Progress,
  Select, Space as AntSpace, Table, Tag, Tooltip, Tree, Typography, Upload,
} from 'antd'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Grant, type Item, type Role, type Space, type UserOpt, type Version } from './api'

/// P2 预签名直传:>100MB 或视频走浏览器→Garage 直传(字节不过 pod)。
/// begin 拿全部 part URL → File.slice 逐片 PUT(收集 ETag,跨源可读靠桶 CORS 的 ExposeHeaders)
/// → complete 交回服务端。返回 false = 后端说预签名未启用(501),调用方回退后端流式上传。
const DIRECT_THRESHOLD = 100 * 1024 * 1024

async function directUpload(sid: number, file: File, parentId: number | null, onProgress: (p: number) => void): Promise<boolean> {
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
      const etag = await putPart(part_urls[i], blob, (loaded) => onProgress(Math.round(((sent + loaded) / file.size) * 100)))
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

function putPart(url: string, blob: Blob, onLoaded: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded) }
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag') // 跨源可读靠桶 CORS ExposeHeaders:[ETag](PoC 2c 已验)
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag.replaceAll('"', ''))
      else reject(new Error(`part 直传失败:status=${xhr.status} etag=${etag ? '有' : '无(桶 CORS?)'}`))
    }
    xhr.onerror = () => reject(new Error('part 直传网络错误(证书/CORS?)'))
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
        let msg = `${xhr.status}`
        try { msg = JSON.parse(xhr.responseText).error || msg } catch { /* 非 JSON */ }
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

export function SpacesView() {
  const { message, modal } = AntdApp.useApp()
  const [spaces, setSpaces] = useState<Space[]>([])
  const [cur, setCur] = useState<Space | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState<Item | null>(null)
  const [grantsOpen, setGrantsOpen] = useState(false)

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
    setSelected(null)
    if (cur) loadItems(cur.id).catch((e) => message.error(e.message))
  }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = cur?.my_role === 'editor' || cur?.my_role === 'admin'
  const isAdmin = cur?.my_role === 'admin'

  // 平铺 items → antd Tree 结构。folder 在前后端已排序;children 递归组装。
  const treeData = useMemo(() => {
    const byParent = new Map<number | null, Item[]>()
    items.forEach((it) => {
      const k = it.parent_id
      byParent.set(k, [...(byParent.get(k) || []), it])
    })
    type TreeNode = { key: number; title: string; isLeaf: boolean; children?: TreeNode[] }
    const build = (pid: number | null): TreeNode[] =>
      (byParent.get(pid) || []).map((it) => ({
        key: it.id,
        title: `${KIND_ICON[it.kind]} ${it.name}`,
        isLeaf: it.kind !== 'folder',
        children: it.kind === 'folder' ? build(it.id) : undefined,
      }))
    return build(null)
  }, [items])

  // 新建目标父节点:选中 folder 用它,选中别的用其父,没选中落根。
  const targetParent = selected ? (selected.kind === 'folder' ? selected.id : selected.parent_id) : null

  const newSpace = () => {
    let name = ''
    modal.confirm({
      title: '新建空间',
      content: <Input placeholder="空间名,如「组会记录」「论文库」" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        try {
          await api('/api/spaces', { method: 'POST', body: JSON.stringify({ name }) })
          await loadSpaces()
        } catch (e) {
          message.error((e as Error).message) // 白名单外建空间 403 等,必须可见
          throw e // 保持弹窗不关
        }
      },
    })
  }
  const newItem = (kind: 'folder' | 'doc') => {
    let name = ''
    modal.confirm({
      title: kind === 'folder' ? '新建文件夹' : '新建文档',
      content: <Input placeholder="名称" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        await api(`/api/spaces/${cur!.id}/items`, {
          method: 'POST',
          body: JSON.stringify({ kind, name, parent_id: targetParent }),
        })
        await loadItems(cur!.id)
      },
    })
  }
  const rename = (it: Item) => {
    let name = it.name
    modal.confirm({
      title: '重命名',
      content: <Input defaultValue={it.name} onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        await api(`/api/items/${it.id}`, { method: 'PUT', body: JSON.stringify({ name }) })
        await loadItems(cur!.id)
      },
    })
  }
  const del = async (it: Item) => {
    await api(`/api/items/${it.id}`, { method: 'DELETE' })
    message.success('已删除')
    setSelected(null)
    await loadItems(cur!.id)
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 空间列表 */}
      <Card
        size="small"
        title="空间"
        extra={<Button size="small" type="primary" onClick={newSpace}>新建</Button>}
        style={{ width: 240, flex: '0 0 auto' }}
      >
        <List
          size="small"
          dataSource={spaces}
          locale={{ emptyText: <Empty description="还没有可见的空间" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(s) => (
            <List.Item
              onClick={() => setCur(s)}
              style={{ cursor: 'pointer', background: cur?.id === s.id ? '#e6fffb' : undefined, borderRadius: 6, padding: '6px 8px' }}
            >
              <Typography.Text strong={cur?.id === s.id} ellipsis style={{ flex: 1 }}>{s.name}</Typography.Text>
              {s.my_role && ROLE_TAG[s.my_role]}
            </List.Item>
          )}
        />
      </Card>

      {/* 选中空间 */}
      {cur ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <Card
            size="small"
            title={
              <AntSpace>
                {cur.name}
                {cur.my_role && ROLE_TAG[cur.my_role]}
                <Tooltip title={`已用 ${fmtSize(cur.used_bytes)} / 配额 ${fmtSize(cur.quota_bytes)}(超管可调)`}>
                  <span style={{ width: 120, display: 'inline-block' }}>
                    <Progress
                      percent={Math.min(100, Math.round((cur.used_bytes / Math.max(1, cur.quota_bytes)) * 100))}
                      size="small"
                      status={cur.used_bytes >= cur.quota_bytes ? 'exception' : 'normal'}
                    />
                  </span>
                </Tooltip>
              </AntSpace>
            }
            extra={
              <AntSpace>
                {canEdit && (
                  <>
                    <Button size="small" onClick={() => newItem('folder')}>📁 新建文件夹</Button>
                    <Button size="small" onClick={() => newItem('doc')}>📄 新建文档</Button>
                    <Upload
                      showUploadList={{ showRemoveIcon: false }}
                      maxCount={3}
                      customRequest={async ({ file, onSuccess, onError, onProgress }) => {
                        const f = file as File
                        const report = (percent: number) => onProgress?.({ percent })
                        try {
                          // 大文件/视频优先直传(字节不过 pod);501(预签名未启用)回退后端流式。
                          let done = false
                          if (f.size > DIRECT_THRESHOLD || f.type.startsWith('video/')) {
                            done = await directUpload(cur.id, f, targetParent, report)
                          }
                          if (!done) {
                            await xhrUpload(`/api/spaces/${cur.id}/upload?parent_id=${targetParent ?? ''}`, f, report)
                          }
                          message.success('上传完成')
                          await Promise.all([loadItems(cur.id), loadSpaces()]) // 用量条一起刷
                          onSuccess?.({})
                        } catch (e) {
                          message.error((e as Error).message)
                          onError?.(e as Error)
                        }
                      }}
                    >
                      <Button size="small">📎 上传文件</Button>
                    </Upload>
                  </>
                )}
                {isAdmin && <Button size="small" onClick={() => setGrantsOpen(true)}>🔑 授权管理</Button>}
                {isAdmin && (
                  <Popconfirm
                    title={`删除空间「${cur.name}」及其全部内容?`}
                    onConfirm={async () => {
                      await api(`/api/spaces/${cur.id}`, { method: 'DELETE' })
                      setCur(null)
                      await loadSpaces()
                    }}
                  >
                    <Button size="small" danger>删除空间</Button>
                  </Popconfirm>
                )}
              </AntSpace>
            }
          >
            {treeData.length ? (
              <Tree
                treeData={treeData}
                defaultExpandAll
                selectedKeys={selected ? [selected.id] : []}
                onSelect={(keys) => setSelected(items.find((i) => i.id === keys[0]) || null)}
              />
            ) : (
              <Empty description="空空如也——建个文件夹或文档开始" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>

          {selected && selected.kind !== 'folder' && (
            <ItemPanel key={selected.id} item={selected} canEdit={canEdit} onChanged={() => loadItems(cur.id)} onRename={() => rename(selected)} onDelete={() => del(selected)} />
          )}
          {selected && selected.kind === 'folder' && canEdit && (
            <Card size="small" style={{ marginTop: 12 }}>
              <AntSpace>
                <span>📁 {selected.name}</span>
                <Button size="small" onClick={() => rename(selected)}>重命名</Button>
                <Popconfirm title="删除文件夹及其全部内容?" onConfirm={() => del(selected)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </AntSpace>
            </Card>
          )}
          <GrantsModal space={cur} open={grantsOpen} onClose={() => setGrantsOpen(false)} />
        </div>
      ) : (
        <Card style={{ flex: 1 }}>
          <Empty description="选择或新建一个空间" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
    </div>
  )
}

/// 文档/文件面板:doc = 在线编辑 + 版本;file/video = 下载 + 元信息。
function ItemPanel({ item, canEdit, onChanged, onRename, onDelete }: {
  item: Item; canEdit: boolean; onChanged: () => void; onRename: () => void; onDelete: () => void
}) {
  const { message } = AntdApp.useApp()
  const [text, setText] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
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
  const loadVersions = async () => {
    setVersions(await api<Version[]>(`/api/items/${item.id}/versions`))
    setVersionsOpen(true)
  }

  return (
    <Card
      size="small"
      style={{ marginTop: 12 }}
      title={`${KIND_ICON[item.kind]} ${item.name}`}
      extra={
        <AntSpace>
          {item.kind !== 'doc' && <Button size="small" type="primary" href={`/api/items/${item.id}/download`}>下载 {fmtSize(item.size)}</Button>}
          {item.kind === 'doc' && canEdit && <Button size="small" type="primary" disabled={!dirty} onClick={() => save()}>保存</Button>}
          {item.kind === 'doc' && <Button size="small" onClick={loadVersions}>版本</Button>}
          {canEdit && <Button size="small" onClick={onRename}>重命名</Button>}
          {canEdit && (
            <Popconfirm title="确认删除?" onConfirm={onDelete}>
              <Button size="small" danger>删除</Button>
            </Popconfirm>
          )}
        </AntSpace>
      }
    >
      {item.kind === 'doc' ? (
        text === null ? '加载中…' : canEdit ? (
          <Input.TextArea
            value={text}
            autoSize={{ minRows: 12, maxRows: 32 }}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }}
            placeholder="markdown 正文…(P3 上真编辑器与渲染,先纯文本)"
            onChange={(e) => { setText(e.target.value); setDirty(true) }}
          />
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{text}</pre>
        )
      ) : item.kind === 'video' ? (
        <>
          {/* 播放:同源 /play 判权后 302 到 15min 预签名 GET,Range 拖动由 Garage 206。
              不带 crossorigin 属性 = no-cors 媒体请求,不需要 CORS(对抗核查 §7.4b-6)。 */}
          <video controls preload="metadata" style={{ width: '100%', maxHeight: 480, background: '#000' }}
            src={`/api/items/${item.id}/play`} />
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
            {item.mime} · {fmtSize(item.size)} · 由 {item.created_by} 上传 ·(拖动进度条随点随播;非 mp4/webm 浏览器可能不支持)
          </Typography.Text>
        </>
      ) : (
        <Typography.Text type="secondary">
          {item.mime} · {fmtSize(item.size)} · 由 {item.created_by} 上传
        </Typography.Text>
      )}

      <Drawer title="版本历史" open={versionsOpen} onClose={() => setVersionsOpen(false)} width={420}>
        <List
          size="small"
          dataSource={versions}
          renderItem={(v) => (
            <List.Item
              actions={canEdit ? [
                <Popconfirm key="r" title="恢复到此版本?(当前版会自动存为快照)" onConfirm={async () => {
                  await api(`/api/items/${item.id}/restore/${v.id}`, { method: 'POST' })
                  setVersionsOpen(false)
                  const t = await api<string>(`/api/items/${item.id}/content`)
                  setText(t); setDirty(false); onChanged(); message.success('已恢复')
                }}><a>恢复</a></Popconfirm>,
              ] : []}
            >
              <List.Item.Meta
                title={v.label || `版本 #${v.id}`}
                description={`${v.created_by} · ${new Date(v.created_at).toLocaleString()} · ${fmtSize(v.size)}`}
              />
            </List.Item>
          )}
        />
      </Drawer>
    </Card>
  )
}

/// 授权管理(admin):user/group × viewer/editor/admin。
function GrantsModal({ space, open, onClose }: { space: Space; open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp()
  const [grants, setGrants] = useState<Grant[]>([])
  // 默认选「小组」:调研结论(docs/PERMISSIONS.md),按组授权是主战场——整组人(含未来入组者)
  // 动态获得权限,人员流动只改组;按个人授权是例外通道。
  const [gtype, setGtype] = useState<'user' | 'group'>('group')
  const [gid, setGid] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [myGroups, setMyGroups] = useState<{ id: number; name: string }[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])

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
    </Modal>
  )
}
