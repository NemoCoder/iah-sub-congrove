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
import { RemindPoll } from './remind-poll'
import { TzBanner } from './tz-banner'
import { setMyTz } from './tz'
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

  /// ★把「我的时区」尽早灌进 tz.ts★（PRD E0；tz.ts 的 setMyTz 头注解释了为什么是模块级状态）。
  ///
  /// ⚠★必须在这里、而不是在设置页里灌★：消费它的是 8 个文件里几十处渲染，
  ///   其中大多数视图用户可能一整天都不打开设置页。在设置页里灌 = 只有去过设置的人时间才是对的。
  ///
  /// ⚠★prefs 拉回来之前，页面已经在按浏览器时区渲染了★ —— 这一瞬的闪动是有意接受的：
  ///   替代方案是「拉到 prefs 之前整页转圈」，而那会让**所有人**（包括 99% 时区一致的国内用户）
  ///   每次进站都多等一个请求，为的是消除一个只影响少数人的短暂闪动。不划算。
  ///   `reloadTick` 让灌完之后重渲染一次，把闪动收在一帧里。
  const [tzTick, setTzTick] = useState(0)
  useEffect(() => {
    api<{ timezone: string | null }>('/api/me/prefs')
      .then((p) => { setMyTz(p.timezone); setTzTick((t) => t + 1) })
      .catch(() => { /* 拿不到就跟随浏览器 —— 这正是 myTz() 的兜底,不必报错打断人 */ })
  }, [])

  /// 进 / 出超管模式(docs/TECH-DESIGN-admin-mode.md)。
  ///
  /// ★切完必须整页重载★:超管特权影响的是**数据本身**(项目列表、日历里有哪些活动、
  /// 材料看不看得到),而这些数据散在各个视图各自的 useEffect 里 —— 只更新 `me` 的话,
  /// 用户会看到一个「已进入超管模式」的横幅 + 一屏还是普通视角的旧数据,
  /// 而他没法知道哪些是刷新过的。整页重载是这里**唯一诚实**的做法。
  const toggleAdminMode = async (on: boolean) => {
    try {
      await api('/api/me/admin-mode', { method: 'POST', body: JSON.stringify({ on }) })
      window.location.reload()
    } catch (e) { void e /* 失败保持原状:横幅与菜单都由 me 派生,没切成就什么都不变 */ }
  }

  if (status === 'loading')
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}><Spin size="large" /></div>
  if (status === 'error')
    return <Result status="500" title="服务暂不可用" subTitle="后端未就绪,稍后刷新重试。" />

  const display = me?.name || me?.username || '未知用户'
  return (
    <div style={{ minHeight: '100vh', background: '#f4f4f7' }}>
      {/* ★挂在这里而不是各视图里★：提醒该弹就得弹，跟当前停在哪个页面无关。
          放进某个视图 = 只有停在那一页的人收得到，而人多半停在别处。
          点弹窗直接跳到那场活动 —— 提醒说「快开始了」，下一步一定是「那我去看看」。 */}
      <RemindPoll onOpen={(aid) => { setView('activities'); setActivityId(aid); setMinutesOf(null) }} />
      {/* ★E0 提示条★:挂在最外层而不是某个视图里 —— 「我在按错的时区看时间」这件事
          跟你停在哪一页无关。key 带上 tzTick:prefs 拉回来之后要重算一次 dev vs set。 */}
      <div key={tzTick} style={{ maxWidth: 1400, margin: '0 auto', padding: '10px 16px 0' }}>
        <TzBanner onGoSettings={() => { setView('me'); setActivityId(null); setMinutesOf(null) }} />
      </div>
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
              // ★开发者入口按「资格」显示,不按「特权」★(超管模式):按特权的话,
              // 一关模式入口就消失了,人会以为超管被撤了 —— 2026-08-09 liaoruili 定的三条之一
              // 「入口留着,点了提示开启」。点进去发现 403 比入口凭空消失好解释得多。
              ...(me?.can_super ? [{ key: 'apis', label: '开发者' }] : []),
              // ★超管模式开关★(docs/TECH-DESIGN-admin-mode.md):有资格才画。
              // 平时关着 = 我就是个普通用户,看不到别人的东西;要用特权刻意开一下,2 小时自动关。
              ...(me?.can_super ? [{
                key: 'adminmode',
                label: me?.is_super ? '退出超管模式' : '进入超管模式',
              }] : []),
              { type: 'divider' as const },
              { key: 'logout', label: <a href="/auth/logout">退出登录</a> },
            ],
            onClick: ({ key }) => {
              if (key === 'adminmode') { void toggleAdminMode(!me?.is_super); return }
              if (key === 'me' || key === 'shares' || key === 'apis' || key === 'atypes') { setView(key as View); setActivityId(null); setMinutesOf(null) }
            },
          }}>
            <Button type="text" style={{ height: 'auto', padding: '4px 8px' }}>
              <Avatar size="small" style={{ background: '#0d9488', marginRight: 8 }}>{display.slice(0, 1).toUpperCase()}</Avatar>
              {display}
              {me?.is_super && <Tag color="purple" style={{ marginLeft: 8 }}>超管</Tag>}
            </Button>
          </Dropdown>
        }
      />
      {/* ⚠★用 padding 而不是上下 margin★:这一层是 `min-height:100vh` 那个容器的最后一个子元素,
          而**外边距会从没有 padding/border 的父元素底边「逃出去」**(margin collapsing) ——
          20px 不计进 100vh 的盒子里,却把文档撑到 100vh+20px,又是一条凭空多出来的滚动条。
          padding 不会塌陷,视觉完全一样。(与 index.html 里那条 body reset 是同一个问题的两半。) */}
      {/* ★超管模式常驻横幅,不可关闭★(照 GitLab / PRD §J1c 影子账户那套):
          这一刻我看到的东西比平时多,★这件事必须一直在视野里★ ——
          不然过两小时忘了自己开着,又回到「默认看得见所有人」的老问题上。
          写出到期时间,因为它会自己关,而「怎么突然又看不见了」比看不见更困惑。 */}
      {me?.is_super && (
        <div style={{
          background: '#fff7e6', borderBottom: '1px solid #ffd591', color: '#d46b08',
          padding: '6px 22px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span>超管模式生效中 —— 你现在看得到所有人的项目与活动{me.admin_mode_until
            ? `，${new Date(me.admin_mode_until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动关闭` : ''}</span>
          <span style={{ flex: 1 }} />
          <a onClick={() => void toggleAdminMode(false)}>立即退出</a>
        </div>
      )}
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 22px' }}>
        {view === 'schedule' ? (
          minutesOf != null ? (
            <ActivityMinutesView activityId={minutesOf} onBack={() => setMinutesOf(null)} />
          ) : activityId === 'new' ? (
            <ActivityNewView me={me} onCreated={(id) => setActivityId(id)} onCancel={() => setActivityId(null)} />
          ) : activityId != null ? (
            <ActivityDetailView id={activityId} me={me?.username ?? ''} onBack={() => setActivityId(null)} onOpenMinutes={setMinutesOf}
              backLabel="返回日程" />
          ) : (
            <ScheduleView me={me?.username ?? ''} onOpenActivity={setActivityId} onOpenMinutes={setMinutesOf} onNewActivity={() => setActivityId('new')} />
          )
        ) : view === 'activities' ? (
          minutesOf != null ? (
            <ActivityMinutesView activityId={minutesOf} onBack={() => setMinutesOf(null)} />
          ) : activityId === 'new' ? (
            <ActivityNewView me={me} onCreated={(id) => setActivityId(id)} onCancel={() => setActivityId(null)} />
          ) : activityId != null ? (
            <ActivityDetailView id={activityId} me={me?.username ?? ''} onBack={() => setActivityId(null)} onOpenMinutes={setMinutesOf}
              backLabel="返回活动" />
          ) : (
            <ActivitiesListView me={me} onOpen={setActivityId} onOpenMinutes={setMinutesOf} onNew={() => setActivityId('new')} />
          )
        ) : view === 'projects' ? (
          // 项目页里点「去活动 →」直接切到活动详情(活动材料的文件夹在项目树里是只读的,
          // 要改就得回那条活动 —— 给它一条路,别让人自己去活动列表里找)
          <ProjectsView me={me} onOpenActivity={(aid) => { setView('activities'); setActivityId(aid); setMinutesOf(null) }} />
        )
          : view === 'me' ? <MeView me={me} onOpenShares={() => setView('shares')} />
          : view === 'apis' ? <ApiDocView />
          : view === 'atypes' ? <ActivityTypesView me={me?.username ?? ''} /> : <SharesView />}
      </div>
    </div>
  )
}
