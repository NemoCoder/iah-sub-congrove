// P0 壳:登录态(/api/me)+ IAH 页眉 + 占位主区。
// 身份纪律:SPA 永远不碰 token——会话是 HttpOnly cookie,401 就整页跳 /auth/login。
import { Avatar, Button, Card, Dropdown, Result, Spin, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { IahHeader } from './iah-header'

type Me = { username: string | null; name: string | null; email: string | null; is_super: boolean }

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'unauthorized' | 'error'>('loading')

  useEffect(() => {
    fetch('/api/me')
      .then(async (r) => {
        if (r.status === 401) return setStatus('unauthorized')
        if (!r.ok) return setStatus('error')
        setMe(await r.json())
        setStatus('ok')
      })
      .catch(() => setStatus('error'))
  }, [])

  if (status === 'loading')
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    )

  if (status === 'unauthorized') {
    // 直接跳登录(服务端 OIDC),回来落在当前路径。
    window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`
    return null
  }

  if (status === 'error')
    return <Result status="500" title="服务暂不可用" subTitle="后端未就绪,稍后刷新重试。" />

  const display = me?.name || me?.username || '未知用户'
  return (
    <div style={{ minHeight: '100vh', background: '#f4f4f7' }}>
      <IahHeader
        extra={
          <Dropdown
            menu={{
              items: [{ key: 'logout', label: <a href="/auth/logout">退出登录</a> }],
            }}
          >
            <Button type="text" style={{ height: 'auto', padding: '4px 8px' }}>
              <Avatar size="small" style={{ background: '#6366f1', marginRight: 8 }}>
                {display.slice(0, 1).toUpperCase()}
              </Avatar>
              {display}
              {me?.is_super && (
                <Tag color="purple" style={{ marginLeft: 8 }}>
                  超管
                </Tag>
              )}
            </Button>
          </Dropdown>
        }
      />
      <div style={{ maxWidth: 880, margin: '44px auto', padding: '0 22px' }}>
        <Card title="汇流 Congrove — P0 骨架">
          <p>登录已打通(服务端 OIDC + HttpOnly 会话)。空间 / 小组 / 内容树在 P1 到来。</p>
          <p style={{ color: '#6b7280' }}>
            当前身份:{me?.username} {me?.email ? `(${me.email})` : ''}
          </p>
        </Card>
      </div>
    </div>
  )
}
