// 小组视图:我的组列表 + 建组 + 成员管理(manager 可拉人/改角色/移出)。
import { App as AntdApp, Button, Card, Empty, Input, List, Popconfirm, Select, Space as AntSpace, Table, Tag } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type Group, type Member } from './api'

export function GroupsView() {
  const { message, modal } = AntdApp.useApp()
  const [groups, setGroups] = useState<Group[]>([])
  const [cur, setCur] = useState<Group | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState('member')

  const load = useCallback(async () => {
    const g = await api<Group[]>('/api/groups')
    setGroups(g)
    setCur((c) => (c ? g.find((x) => x.id === c.id) || null : null))
  }, [])
  const loadMembers = useCallback(async (gid: number) => {
    setMembers(await api<Member[]>(`/api/groups/${gid}/members`))
  }, [])
  useEffect(() => {
    load().catch((e) => message.error(e.message))
  }, [load, message])
  useEffect(() => {
    if (cur) loadMembers(cur.id).catch((e) => message.error(e.message))
  }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const isMgr = cur?.my_role === 'manager'

  const newGroup = () => {
    let name = ''
    modal.confirm({
      title: '新建小组',
      content: <Input placeholder="组名,如「XX 研究组」" onChange={(e) => (name = e.target.value)} />,
      onOk: async () => {
        await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) })
        await load()
      },
    })
  }
  const addMember = async () => {
    if (!addName.trim()) return message.warning('填用户名')
    await api(`/api/groups/${cur!.id}/members`, { method: 'POST', body: JSON.stringify({ username: addName.trim(), role: addRole }) })
    setAddName('')
    await loadMembers(cur!.id)
    await load()
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <Card size="small" title="我的小组" extra={<Button size="small" type="primary" onClick={newGroup}>新建</Button>} style={{ width: 260, flex: '0 0 auto' }}>
        <List
          size="small"
          dataSource={groups}
          locale={{ emptyText: <Empty description="还没加入任何组" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(g) => (
            <List.Item
              onClick={() => setCur(g)}
              style={{ cursor: 'pointer', background: cur?.id === g.id ? '#e6fffb' : undefined, borderRadius: 6, padding: '6px 8px' }}
            >
              <span style={{ flex: 1 }}>{g.name}</span>
              <Tag>{g.member_count} 人</Tag>
              {g.my_role === 'manager' && <Tag color="cyan">manager</Tag>}
            </List.Item>
          )}
        />
      </Card>

      {cur ? (
        <Card
          size="small"
          style={{ flex: 1 }}
          title={cur.name}
          extra={
            isMgr && (
              <Popconfirm title="解散小组?(该组的全部空间授权一并撤销)" onConfirm={async () => {
                await api(`/api/groups/${cur.id}`, { method: 'DELETE' })
                setCur(null)
                await load()
              }}>
                <Button size="small" danger>解散</Button>
              </Popconfirm>
            )
          }
        >
          {isMgr && (
            <AntSpace style={{ marginBottom: 12 }}>
              <Input placeholder="用户名(平台账号,可先于其登录拉入)" value={addName} onChange={(e) => setAddName(e.target.value)} style={{ width: 260 }} onPressEnter={addMember} />
              <Select value={addRole} onChange={setAddRole} style={{ width: 120 }}
                options={[{ value: 'member', label: 'member' }, { value: 'manager', label: 'manager' }]} />
              <Button type="primary" onClick={addMember}>拉入</Button>
            </AntSpace>
          )}
          <Table
            size="small" rowKey="username" dataSource={members} pagination={false}
            columns={[
              { title: '用户', render: (_, m) => `${m.username}${m.name ? `(${m.name})` : '(未登录过)'}` },
              { title: '角色', dataIndex: 'role', render: (r) => (r === 'manager' ? <Tag color="cyan">manager</Tag> : <Tag>member</Tag>) },
              {
                title: '', render: (_, m) => isMgr && (
                  <Popconfirm title={`移出 ${m.username}?`} onConfirm={async () => {
                    await api(`/api/groups/${cur.id}/members/${encodeURIComponent(m.username)}`, { method: 'DELETE' })
                    await loadMembers(cur.id)
                    await load()
                  }}><a>移出</a></Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      ) : (
        <Card style={{ flex: 1 }}>
          <Empty description="选择或新建一个小组" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
    </div>
  )
}
