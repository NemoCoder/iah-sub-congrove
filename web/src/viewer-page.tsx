// 独立查看窗(/viewer/{id}):只渲染一个内容项,可拖到第二块屏、切到别的软件,
// 主窗口继续正常用系统。同源路由 → 会话 cookie 自动带,鉴权无缝;
// 后端对未知路径回落 index.html(ServeDir fallback),所以不需要后端加路由。
import { App as AntdApp, Result, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Item } from './api'
import { CongroveLogo } from './logo'
import { MarkdownView, FilePreview } from './preview'
import { VideoPlayer } from './video-player'

export function ViewerPage({ itemId }: { itemId: number }) {
  const { message } = AntdApp.useApp()
  const [item, setItem] = useState<Item | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<Item>(`/api/items/${itemId}`)
      .then(async (it) => {
        setItem(it)
        document.title = `${it.name} · 汇流`
        if (it.kind === 'doc') setText(await api<string>(`/api/items/${itemId}/content`))
      })
      .catch((e) => { if (e.message !== '未登录') setErr(e.message) })
  }, [itemId, message])

  if (err) return <Result status="warning" title="打不开" subTitle={err} />
  if (!item) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}><Spin size="large" /></div>

  return (
    <div style={{ minHeight: '100vh', background: '#f4f4f7' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: '#fff', borderBottom: '1px solid #ececf1' }}>
        <CongroveLogo size={24} />
        <Typography.Text strong ellipsis style={{ flex: 1 }}>{item.name}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>汇流 · 独立窗口</Typography.Text>
      </div>
      <div style={{ padding: 16 }}>
        {item.kind === 'video' ? (
          <VideoPlayer item={item} standalone />
        ) : item.kind === 'doc' ? (
          text === null ? <Spin /> : (
            <div style={{ background: '#fff', padding: 24, borderRadius: 8, maxWidth: 900, margin: '0 auto' }}>
              <MarkdownView text={text} />
            </div>
          )
        ) : (
          <div style={{ textAlign: 'center' }}><FilePreview item={item} tall /></div>
        )}
      </div>
    </div>
  )
}
