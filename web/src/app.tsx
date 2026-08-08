// 根组件:登录态(/api/me)+ 顶部页眉 + 顶层视图切换。
// 身份纪律:SPA 永远不碰 token——会话是 HttpOnly cookie,401 就整页跳 /auth/login(api.ts 统一处理)。
import { Avatar, Button, Dropdown, Result, Segmented, Spin, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Me } from './api'

type View = 'schedule' | 'projects' | 'activities' | 'shares' | 'apis' | 'atypes' | 'me'
import { IahHeader } from './iah-header'
import { ViewerPage } from './viewer-page'
import { ProjectsView } from './projects-view'
import { SharePage } from './share-page'
import { SharesView } from './shares-view'
import { ApiDocView } from './apidoc-view'
import { ScheduleView } from './schedule-view'
import { ActivityDetailView } from './activity-detail'
import { ActivityNewView } from './activity-new'
import { ActivityMinutesView } from './activity-minutes'
import { ActivitiesListView } from './activities-list'
import { MeView } from './me-view'
import ActivityTypesView from './activity-types-view'

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


/// 站内信里的「?activity=<id>」—— ★通知必须点得进去★:
/// 只说「有事发生」而落地在首页,人还得自己去找是哪场会,那通知就只完成了一半。
/// 不引路由库(app.tsx 头注的既有约定),查询参数够用:读一次就把人放到那场会上。
function deepLinkActivityId(): number | null {
  const v = new URLSearchParams(window.location.search).get('activity')
  return v && /^\d+$/.test(v) ? Number(v) : null
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
  // ★默认落在日程★:产品从「文档存储」转向「项目+活动协同」之后,
  // 打开先看到的应该是「我今天要做什么」,而不是文件柜。
  // 带 ?activity= 进来的直接落在活动页(否则日程页的日历要先滚到那一周才看得见那场会)
  const [view, setView] = useState<View>(() => (deepLinkActivityId() != null ? 'activities' : 'schedule'))
  // 活动子视图:null=日历 / 数字=看某场会 / 'new'=发起活动。
  // ★不引路由库★:与 /viewer/{id} 一样,这层用状态足够(app.tsx 头注的既有约定)。
  const [activityId, setActivityId] = useState<number | 'new' | null>(deepLinkActivityId)
  // 纪要是活动的子页:非空时盖在详情之上(返回回到详情,不是回日历)
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
        nav={
          <Segmented
            value={view}
            onChange={(v) => { setView(v as View); setActivityId(null); setMinutesOf(null) }}
            options={[
              { value: 'schedule', label: '日程' },
              { value: 'projects', label: '项目' },
              { value: 'activities', label: '活动' },
            ]}
          />
        }
        extra={
          <Dropdown menu={{
            items: [
              { key: 'me', label: '个人面板' },
              { key: 'shares', label: '我的分享' },
              // ★活动类型是低频设置,收进用户菜单★(与「我的分享」同档);主导航只放三个天天用的
              { key: 'atypes', label: '我的活动类型' },
              // 开发者页面只给超管:清单来自 /api/_dev/apis,与路由表由后端测试逐条比对,不会漂移
              ...(me?.is_super ? [{ key: 'apis', label: '开发者' }] : []),
              { type: 'divider' as const },
              { key: 'logout', label: <a href="/auth/logout">退出登录</a> },
            ],
            onClick: ({ key }) => { if (key === 'me' || key === 'shares' || key === 'apis' || key === 'atypes') { setView(key as View); setActivityId(null); setMinutesOf(null) } },
          }}>
            <Button type="text" style={{ height: 'auto', padding: '4px 8px' }}>
              <Avatar size="small" style={{ background: '#0d9488', marginRight: 8 }}>{display.slice(0, 1).toUpperCase()}</Avatar>
              {display}
              {me?.is_super && <Tag color="purple" style={{ marginLeft: 8 }}>超管</Tag>}
            </Button>
          </Dropdown>
        }
      />
      <div style={{ maxWidth: 1200, margin: '20px auto', padding: '0 22px' }}>
        {view === 'schedule' ? (
          minutesOf != null ? (
            <ActivityMinutesView activityId={minutesOf} onBack={() => setMinutesOf(null)} />
          ) : activityId === 'new' ? (
            <ActivityNewView me={me} onCreated={(id) => setActivityId(id)} onCancel={() => setActivityId(null)} />
          ) : activityId != null ? (
            <ActivityDetailView id={activityId} onBack={() => setActivityId(null)} onOpenMinutes={setMinutesOf}
              backLabel="返回日程" />
          ) : (
            <ScheduleView onOpenActivity={setActivityId} onNewActivity={() => setActivityId('new')} />
          )
        ) : view === 'activities' ? (
          minutesOf != null ? (
            <ActivityMinutesView activityId={minutesOf} onBack={() => setMinutesOf(null)} />
          ) : activityId === 'new' ? (
            <ActivityNewView me={me} onCreated={(id) => setActivityId(id)} onCancel={() => setActivityId(null)} />
          ) : activityId != null ? (
            <ActivityDetailView id={activityId} onBack={() => setActivityId(null)} onOpenMinutes={setMinutesOf}
              backLabel="返回活动" />
          ) : (
            <ActivitiesListView me={me} onOpen={setActivityId} onNew={() => setActivityId('new')} />
          )
        ) : view === 'projects' ? <ProjectsView me={me} />
          : view === 'me' ? <MeView me={me} onOpenShares={() => setView('shares')} />
          : view === 'apis' ? <ApiDocView />
          : view === 'atypes' ? <ActivityTypesView me={me?.username ?? ''} /> : <SharesView />}
      </div>
    </div>
  )
}
