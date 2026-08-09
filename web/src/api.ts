// fetch 封装:401 整页跳登录(SPA 不碰 token,会话是 HttpOnly cookie);
// 报错取后端 JSON 的 error 字段。body 是 FormData 时不设 Content-Type(浏览器自带 boundary)。

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) || {}) }
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  const r = await fetch(path, { ...opts, headers })
  if (r.status === 401) {
    window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`
    throw new Error('未登录')
  }
  if (!r.ok) {
    let msg = `${r.status}`
    try {
      msg = ((await r.json()) as { error?: string }).error || msg
    } catch {
      /* 非 JSON 错误体,用状态码 */
    }
    throw new Error(msg)
  }
  const ct = r.headers.get('content-type') || ''
  return ct.includes('json') ? r.json() : ((await r.text()) as unknown as T)
}

export type Me = {
  username: string | null; name: string | null; email: string | null
  /// ★此刻有没有超管**特权**★ —— 语义没变,「能不能」的判断继续用它。
  /// ⚠ 超管模式关着时它是 **false**,哪怕这个人有超管资格(docs/TECH-DESIGN-admin-mode.md)。
  is_super: boolean
  /// 有没有超管**资格**。★只用来决定「超管模式」那个开关画不画出来★,不是权限判据。
  can_super?: boolean
  /// 超管模式的到期时刻;null = 没开。
  admin_mode_until?: string | null
  /// 预签名直传的外部端点;null = 平台未启用。前端据此探测本设备能否信任其证书。
  direct_upload_endpoint: string | null
}
export type Role = 'viewer' | 'editor' | 'admin'
/// 项目。★没有 visibility★(M0-1 删):它原本兼着「内容给谁看」与「会不会占忙闲」两件正交的事,
/// 后者已挪到**活动自己的** `busy`(PRD A4)。项目的资料可见性由成员身份唯一决定(D3)。
export type Project = {
  id: number; name: string; description: string; created_by: string; my_role: Role | null
  /// ★没有 quota_bytes★（ADR-0004）：额度挂在**人**身上，见 `/api/me/quota`。
  /// `used_bytes` 是「这个项目占了多少」，信息性，不是判据。
  used_bytes: number; no_download: boolean
  /// 本项目的转写术语表(空格分隔),项目管理员维护
  hotwords: string
  /// 归档时间;非空 = ★只读存档★(D17)。归档 ≠ 删除:材料全保留、可读可下载,
  /// 只是不能再往里加东西;它的活动也不再进日历、不产生忙闲。
  archived_at?: string | null
  /// `team` = 普通项目;`materials` = ★「我的活动材料」★(ADR-0005 / PRD §J):
  /// 系统给每人建的一个存档区,不关联项目的个人活动,材料落在这里。
  /// ★它是全只读的★ —— 增删都回到那条活动里做(闸在后端 perm.rs,前端只是别给假按钮)。
  kind?: string
}
/// 「我的活动材料」判据 —— ★只有这一处★。它决定要不要藏掉全部写入口、
/// 要不要从「关联项目」下拉里剔掉(把个人存档区当协作项目用,正是 PRD §J1 要防的)。
export const isMaterials = (p: { kind?: string } | null | undefined) => p?.kind === 'materials'
/// 权限诊断:★判定链只剩两段★(超管? 成员表里什么角色?)。
/// 删掉「组」之后不再有 via_groups —— 这正是删组的好处:从一条推导链变成一次查表。
export type Diagnose = {
  username: string; is_super: boolean; is_owner: boolean
  member_role: Role | null; effective: Role | null
}
export type UserOpt = { username: string; name: string | null }
export type Item = {
  id: number
  /// 只有 GET /api/items/{id} 会带(列表接口不带):分享链接靠它定位项目
  project_id?: number
  parent_id: number | null
  kind: 'folder' | 'doc' | 'file' | 'video'
  name: string
  size: number | null
  mime: string | null
  created_by: string
  /// ★属于某场活动的材料★(D10 的只读区):非空时**不画**改名/移动/删除 ——
  /// 后端也拒(items.rs 的 update/remove 里有判断),这里不画是为了不引导人去犯错。
  activity_id?: number | null
  created_at: string
  updated_at: string
}
/// 项目成员。★只有人,没有组★——权限只到具体的人。
/// 项目成员。★只有人,没有组★——权限只到具体的人。
/// name = 真实姓名(app_user.name);★拉进来但还没登录过的人为空★,只显示用户名即可。
export type Member = { username: string; name?: string | null; role: Role; added_by: string; added_at: string }
/// 「用户名（姓名）」的统一显示。姓名为空时只给用户名 —— 别显示成「zhangsan（）」。
export const showUser = (username: string, name?: string | null) =>
  name && name !== username ? `${username}（${name}）` : username
export type MemberList = { owner: string | null; members: Member[] }
export type Version = { id: number; size: number | null; label: string | null; created_by: string; created_at: string }

// ── 活动与日程(M1)────────────────────────────────────────────────────────
/// 答复状态。★counter=建议改期★:私密项目的日程对发起人完全隐形,他不知道我忙,
/// 所以这是私事冲突**唯一的结构化出口**(D2),不是可有可无的便利功能。
export type RespondStatus = 'pending' | 'accepted' | 'declined' | 'tentative' | 'counter'
export type Activity = {
  id: number; title: string; agenda: string
  organizer: string; recorder: string
  starts_at: string; ends_at: string; timezone: string
  /// 会后补录的实际时长(分钟)。★D5 三级回退的第 2 级★:录制 > **手工** > 排程。
  /// null = 没填过 —— 统计会退到排程时长,而排程常常离谱(排 2 小时、20 分钟散会)。
  actual_minutes?: number | null
  /// 活动粒度的材料策略(PRD 6.3.2)。★与项目级叠加不是覆盖★:两处任一禁了就禁。
  no_download?: boolean
  no_share?: boolean
  location: string; online_url: string
  visibility: 'private' | 'public'
  /// 活动类型名（ADR-0002）。软删的类型历史照常显示名字（L1）。
  type_name?: string | null
  status: 'active' | 'canceled'
  created_at: string
  /// 我的答复;不在名单里则 null
  my_status: RespondStatus | null
  /// ★只关联私密项目★——日历据此上色。判据与忙闲分流一致(D1):
  /// 只要关联了任一公开项目就算「公开的会」,它已经会让别人看到你在忙。
  is_private: boolean
  /// ★关联的项目**全部**已归档★(PRD B1)。日历据此淡化并标「已归档 · 只读」。
  /// 归档项目的活动**照常显示**(B0:日程也是「我做过什么」的记录),但它是只读的 ——
  /// 不标出来的话人会点进去想传材料、改时间,才发现动不了。
  /// 零关联项目的活动恒为 false:「没有项目」不等于「项目都归档了」。
  archived?: boolean
  /// 关联项目(列表页显示标签用),后端在列表 SQL 里一次取全
  projects?: { id: number; name: string }[] | null
  participant_count?: number
  /// null=还没建纪要 / draft=待整理 / done=已完成
  minutes_status?: 'draft' | 'done' | null
}
export type Participant = {
  /// 必参 / 选参 —— ★只有必参人的冲突算「有冲突」★(PRD 6.1.2)
  required?: boolean
  username: string
  /// 真实姓名;拉进来还没登录过的人为空
  name?: string | null
  kind: 'attendee' | 'guest' | 'observer'; status: RespondStatus
  counter_starts_at: string | null; counter_ends_at: string | null; counter_reason: string | null
  responded_at: string | null
}
export type ActivityDetail = {
  activity: Activity
  participants: Participant[]
  projects: { id: number; name: string }[]
  can_edit: boolean
  /// 旁听者拿到的是裁剪版(无名单、无材料入口),后端会带这个标记
  observer?: boolean
}
export type ActivityMessage = {
  id: number; sender: string; channel: 'public' | 'private'
  peer: string | null; body: string; created_at: string
}
/// 忙闲:★只有时间段,没有任何内容★(D1)。私密项目的会完全不在里面。
export type FreeBusy = { busy: Record<string, { start: string; end: string }[]> }

/// 活动纪要(D14):★AI 转写只是原材料,记录员才是作者★。
/// 字段就是「固定模板」本身 —— 到场/列席/缺席是**会后补录的事实**(D11),
/// 与邀请时的答复是两回事(答复了不等于真来了)。
export type Minutes = {
  activity_id: number
  status: 'draft' | 'done'
  attendees: string; observers: string; absentees: string
  agenda_text: string; content_md: string
  resolutions: string; todos: string
  pdf_item_id: number | null
  completed_at: string | null
  updated_at: string
}

/// 活动材料 / 录制。★录制 ≠ 材料★(D5):只有 is_recording 的会被转写、并作为活动时长依据。
export type ActivityItem = {
  id: number; name: string; kind: Item['kind']; size: number | null
  mime: string | null; is_recording: boolean; created_by: string; created_at: string
}
/// 线上活动链接的改动历史
/// 会后补录的实际时长(分钟)。D5 三级回退的第 2 级:录制 > **手工** > 排程。
export type LinkChange = { old_url: string; new_url: string; changed_by: string; changed_at: string }

/// 活动类型（ADR-0002）。三个能力位决定表单显示什么、后端校验什么。
/// `owner === null` = 系统预置（不可改不可删）。
export type ActivityType = {
  id: number; owner: string | null; name: string
  /// 有正式纪要与记录员 → 记录员必填
  has_minutes: boolean
  /// 必须关联项目 → 关联项目必填（材料权限来自项目成员身份）
  needs_project: boolean
  /// 默认占不占忙闲（自建类型时唯一开放的开关）
  busy_default: boolean
  /// ★能不能填过去的时间（补录）★（F0/F1，2026-08-09 liaoruili：
  /// 「会议类型的活动只能发起未来的会议，其他类型可以后面补录」）。
  /// 「会议」= false，其余（含全部自建类型）= true。
  allow_past: boolean
}

/// 我的额度与已用量（ADR-0004）。★用量算我**名下所有项目**之和★，不是我上传的东西。
export type MyQuota = { quota_bytes: number; used_bytes: number }
