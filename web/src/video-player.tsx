// 视频播放器:续播(位置存后端)+ 画中画 + 独立窗口。
// 位置为什么存后端而非 localStorage:换设备/清缓存/换浏览器都还在,独立播放窗与主窗口天然一致。
import { App as AntdApp, Button, Space as AntSpace, Tag, Tooltip } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { api, type Item } from './api'
import { Analysis } from './analysis'

const SAVE_EVERY_MS = 5000 // 播放中每 5s 记一次;暂停/结束/关窗另外各记一次

function fmtClock(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export function VideoPlayer({ item, standalone = false }: { item: Item; standalone?: boolean }) {
  const { message } = AntdApp.useApp()
  const ref = useRef<HTMLVideoElement>(null)
  const lastSaved = useRef(0)
  const [resumed, setResumed] = useState<number | null>(null) // 提示"已从 x:xx 继续"
  const [pipOk, setPipOk] = useState(false)
  const [hoverTools, setHoverTools] = useState(false) // 悬停画面才把右下角两个按钮点亮

  useEffect(() => {
    setPipOk(typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled)
  }, [])

  // 保存位置。keepalive 让关窗时这一发也能送达(普通 fetch 会被中断)。
  const save = (pos: number, dur?: number, keepalive = false) => {
    if (!Number.isFinite(pos) || pos < 1) return // 刚开头没必要记
    void fetch(`/api/items/${item.id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position_sec: pos, duration_sec: Number.isFinite(dur ?? NaN) ? dur : null }),
      keepalive,
    }).catch(() => {})
  }

  useEffect(() => {
    const v = ref.current
    if (!v) return
    let disposed = false

    // 元数据就绪后再跳位置(此前 currentTime 赋值无效)。
    const onMeta = async () => {
      try {
        const p = await api<{ position_sec: number }>(`/api/items/${item.id}/progress`)
        if (disposed || !p.position_sec || p.position_sec < 5) return
        v.currentTime = p.position_sec
        setResumed(p.position_sec)
      } catch { /* 拿不到就从头播,不打扰用户 */ }
    }
    const onTime = () => {
      const now = Date.now()
      if (now - lastSaved.current >= SAVE_EVERY_MS) { lastSaved.current = now; save(v.currentTime, v.duration) }
    }
    const onStop = () => save(v.currentTime, v.duration)
    const onHide = () => { if (document.visibilityState === 'hidden') save(v.currentTime, v.duration, true) }

    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('pause', onStop)
    v.addEventListener('ended', onStop)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      disposed = true
      save(v.currentTime, v.duration, true) // 组件卸载(关抽屉/切文件)也记一次
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('pause', onStop)
      v.removeEventListener('ended', onStop)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
    }
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {resumed != null && <Tag color="cyan" style={{ marginBottom: 8 }}>已从 {fmtClock(resumed)} 继续</Tag>}
      {/* ★两个按钮浮在画面右下角、只给图标、hover 才出文字★(2026-08-03 用户要求):
          原来横在视频上方占一整行太抢眼。bottom 给 52px 是给原生控制条让位——
          浏览器自带控制条约 40px 高,压上去会挡住全屏/⋮ 按钮(见反馈截图)。
          鼠标不在画面上时按钮压到半透明,不干扰观看(没有 css 文件,全树都是内联样式,就用 state 做)。 */}
      <div
        style={{ position: 'relative', lineHeight: 0 }}
        onMouseEnter={() => setHoverTools(true)} onMouseLeave={() => setHoverTools(false)}
      >
        {/* 不带 crossorigin = no-cors 媒体请求,不需要 CORS;Range 拖动由 Garage 206 提供。 */}
        <video
          ref={ref} controls preload="metadata" src={`/api/items/${item.id}/play`}
          style={{ width: '100%', maxHeight: standalone ? '78vh' : 520, background: '#000', borderRadius: 6 }}
        >
          {/* 实时字幕:转写好了才有内容(没有则轨为空,播放器不显示字幕按钮)。
              同源 vtt,浏览器原生渲染,自带开关与样式——不用自己画字幕层。 */}
          <track kind="subtitles" srcLang="zh" label="转写字幕" default src={`/api/items/${item.id}/subtitles.vtt`} />
        </video>
        {!standalone && (
          <AntSpace size={6} style={{
            position: 'absolute', right: 10, bottom: 52, zIndex: 2,
            opacity: hoverTools ? 1 : 0.45, transition: 'opacity .2s',
          }}>
            <Tooltip title="在新窗口播放" placement="top">
              <Button size="small" shape="circle" onClick={() => {
                // ★开新窗口前先把这边停掉★:否则两个播放器同时出声,用户暂停了这个还听见那个(2026-08-03 反馈)。
                if (ref.current) { ref.current.pause(); ref.current.muted = true }
                openViewer(item.id)
              }}>↗</Button>
            </Tooltip>
            {pipOk && (
              <Tooltip title="画中画" placement="top">
                <Button size="small" shape="circle" onClick={async () => {
                  try {
                    if (document.pictureInPictureElement) await document.exitPictureInPicture()
                    else await ref.current?.requestPictureInPicture()
                  } catch (e) { message.error(`画中画不可用:${(e as Error).message}`) }
                }}>⧉</Button>
              </Tooltip>
            )}
          </AntSpace>
        )}
      </div>
      {/* AI 纪要:点转写可跳到视频对应时刻(同一个 <video> 实例) */}
      <Analysis item={item} onSeek={(t) => { if (ref.current) { ref.current.currentTime = t; void ref.current.play() } }} />
    </>
  )
}

/// 独立窗口:同源 /viewer/{id},会话 cookie 自动带上;可拖到第二块屏,主窗口照常用。
export function openViewer(itemId: number) {
  window.open(`/viewer/${itemId}`, `cg_viewer_${itemId}`, 'width=1100,height=760,menubar=no,toolbar=no')
}
