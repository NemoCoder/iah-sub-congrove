// 根组件:登录态(/api/me)+ 顶部页眉 + 「空间 / 小组」两个视图切换。
// 身份纪律:SPA 永远不碰 token——会话是 HttpOnly cookie,401 就整页跳 /auth/login(api.ts 统一处理)。
import { Avatar, Button, Dropdown, Result, Segmented, Spin, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Me } from './api'
import { IahHeader } from './iah-header'
import { GroupsView } from './groups-view'
import { SpacesView } from './spaces-view'

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [view, setView] = useState<'spaces' | 'groups'>('spaces')

  useEffect(() => {
    api<Me>('/api/me')
      .then((m) => { setMe(m); setStatus('ok') })
      .catch((e) => { if (e.message !== '未登录') setStatus('error') }) // 401 已由 api.ts 整页跳登录
  }, [])

  if (status === 'loading')
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}><Spin size="large" /></div>
  if (status === 'error')
    return <Result status="500" title="服务暂不可用" subTitle="后端未就绪,稍后刷新重试。" />

  const display = me?.name || me?.username || '未知用户'
  return (
    <div style={{ minHeight: '100vh', background: '#f4f4f7' }}>
      <IahHeader
        extra={
          <Dropdown menu={{ items: [{ key: 'logout', label: <a href="/auth/logout">退出登录</a> }] }}>
            <Button type="text" style={{ height: 'auto', padding: '4px 8px' }}>
              <Avatar size="small" style={{ background: '#0d9488', marginRight: 8 }}>{display.slice(0, 1).toUpperCase()}</Avatar>
              {display}
              {me?.is_super && <Tag color="purple" style={{ marginLeft: 8 }}>超管</Tag>}
            </Button>
          </Dropdown>
        }
      />
      <div style={{ maxWidth: 1200, margin: '20px auto', padding: '0 22px' }}>
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'spaces' | 'groups')}
          options={[{ value: 'spaces', label: '🌳 空间' }, { value: 'groups', label: '👥 小组' }]}
          style={{ marginBottom: 16 }}
        />
        {view === 'spaces' ? <SpacesView /> : <GroupsView />}
      </div>
    </div>
  )
}
