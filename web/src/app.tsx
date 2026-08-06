// 根组件:登录态(/api/me)+ 顶部页眉 + 顶层视图切换。
// 身份纪律:SPA 永远不碰 token——会话是 HttpOnly cookie,401 就整页跳 /auth/login(api.ts 统一处理)。
import { Avatar, Button, Dropdown, Result, Segmented, Spin, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Me } from './api'

type View = 'schedule' | 'projects' | 'shares' | 'apis'
import { IahHeader } from './iah-header'
import { ViewerPage } from './viewer-page'
import { ProjectsView } from './projects-view'
import { SharePage } from './share-page'
import { SharesView } from './shares-view'
import { ApiDocView } from './apidoc-view'
import { ScheduleView } from './schedule-view'
import { MeetingDetailView } from './meeting-detail'
import { MeetingNewView } from './meeting-new'
import { MeetingMinutesView } from './meeting-minutes'

/// 独立查看窗路由:/viewer/{id}。没上路由库——只此一条,读 pathname 足够
/// (后端对未知路径回落 index.html,所以直接打开这个地址也能进)。
function viewerItemId(): number | null {
  const m = window.location.pathname.match(/^\/viewer\/(\d+)/)
  return m ? Number(m[1]) : null
}

/// 公开分享落地页:/s/{token} —— **不需要登录**,凭令牌(+提取码)访问。
function sharePageToken(): string | null {
  const m = window.location.pathname.match(/^\/s\/([0-9a-f]{32})$/)
  return m ? m[1] : null
}


export function App() {
  // ★公开分享页最先劫路由★:它不需要登录,所以必须在 /api/me 之前返回——
  // 否则访客会被 401 整页跳去 Keycloak(2026-08-05 公开分享)。
  const st = sharePageToken()
  if (st) return <SharePage token={st} />

  const vid = viewerItemId()
  if (vid != null) return <ViewerPage itemId={vid} />

  const [me, setMe] = useState<Me | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  // ★默认落在日程★:产品从「文档存储」转向「项目+会议协同」之后,
  // 打开先看到的应该是「我今天要做什么」,而不是文件柜。
  const [view, setView] = useState<View>('schedule')
  // 会议子视图:null=日历 / 数字=看某场会 / 'new'=发起会议。
  // ★不引路由库★:与 /viewer/{id} 一样,这层用状态足够(app.tsx 头注的既有约定)。
  const [meetingId, setMeetingId] = useState<number | 'new' | null>(null)
  // 纪要是会议的子页:非空时盖在详情之上(返回回到详情,不是回日历)
  const [minutesOf, setMinutesOf] = useState<number | null>(null)

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
          onChange={(v) => { setView(v as View); setMeetingId(null); setMinutesOf(null) }}
          options={[
            { value: 'schedule', label: '日程' },
            { value: 'projects', label: '项目' },
            { value: 'shares', label: '我的分享' },
            // 开发者页面:只给超管。清单来自 /api/_dev/apis,与路由表由后端测试逐条比对,
            // 所以它永远不会跟实际接口漂移。
            ...(me?.is_super ? [{ value: 'apis', label: '开发者' }] : []),
          ]}
          style={{ marginBottom: 16 }}
        />
        {view === 'schedule' ? (
          minutesOf != null ? (
            <MeetingMinutesView meetingId={minutesOf} onBack={() => setMinutesOf(null)} />
          ) : meetingId === 'new' ? (
            <MeetingNewView onCreated={(id) => setMeetingId(id)} onCancel={() => setMeetingId(null)} />
          ) : meetingId != null ? (
            <MeetingDetailView id={meetingId} onBack={() => setMeetingId(null)} onOpenMinutes={setMinutesOf} />
          ) : (
            <ScheduleView onOpenMeeting={setMeetingId} onNewMeeting={() => setMeetingId('new')} />
          )
        ) : view === 'projects' ? <ProjectsView me={me} /> : view === 'apis' ? <ApiDocView /> : <SharesView />}
      </div>
    </div>
  )
}
