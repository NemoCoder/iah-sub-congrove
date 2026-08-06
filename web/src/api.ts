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
  username: string | null; name: string | null; email: string | null; is_super: boolean
  /// 预签名直传的外部端点;null = 平台未启用。前端据此探测本设备能否信任其证书。
  direct_upload_endpoint: string | null
}
export type Role = 'viewer' | 'editor' | 'admin'
/// 项目(原「项目」)。visibility ★只影响忙闲★:public 的会议让成员显示「忙」,
/// private 完全不占忙闲(可多人私下组队)。两者的**资料**都只有成员能看。
export type Project = {
  id: number; name: string; description: string; created_by: string; my_role: Role | null
  quota_bytes: number; used_bytes: number; no_download: boolean
  /// 本项目的转写术语表(空格分隔),项目管理员维护
  hotwords: string
  /// 归档时间;非空 = ★只读存档★(D17)。归档 ≠ 删除:材料全保留、可读可下载,
  /// 只是不能再往里加东西;它的会议也不再进日历、不产生忙闲。
  archived_at?: string | null
}
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
  created_at: string
  updated_at: string
}
/// 项目成员。★只有人,没有组★——权限只到具体的人。
export type Member = { username: string; role: Role; added_by: string; added_at: string }
export type MemberList = { owner: string | null; members: Member[] }
export type Version = { id: number; size: number | null; label: string | null; created_by: string; created_at: string }

// ── 会议与日程(M1)────────────────────────────────────────────────────────
/// 答复状态。★counter=建议改期★:私密项目的日程对发起人完全隐形,他不知道我忙,
/// 所以这是私事冲突**唯一的结构化出口**(D2),不是可有可无的便利功能。
export type RespondStatus = 'pending' | 'accepted' | 'declined' | 'tentative' | 'counter'
export type Meeting = {
  id: number; title: string; agenda: string
  organizer: string; recorder: string
  starts_at: string; ends_at: string; timezone: string
  location: string; online_url: string
  visibility: 'private' | 'public'
  status: 'active' | 'canceled'
  created_at: string
  /// 我的答复;不在名单里则 null
  my_status: RespondStatus | null
  /// ★只关联私密项目★——日历据此上色。判据与忙闲分流一致(D1):
  /// 只要关联了任一公开项目就算「公开的会」,它已经会让别人看到你在忙。
  is_private: boolean
}
export type Participant = {
  username: string; kind: 'attendee' | 'guest' | 'observer'; status: RespondStatus
  counter_starts_at: string | null; counter_ends_at: string | null; counter_reason: string | null
  responded_at: string | null
}
export type MeetingDetail = {
  meeting: Meeting
  participants: Participant[]
  projects: { id: number; name: string }[]
  can_edit: boolean
  /// 旁听者拿到的是裁剪版(无名单、无材料入口),后端会带这个标记
  observer?: boolean
}
export type MeetingMessage = {
  id: number; sender: string; channel: 'public' | 'private'
  peer: string | null; body: string; created_at: string
}
/// 忙闲:★只有时间段,没有任何内容★(D1)。私密项目的会完全不在里面。
export type FreeBusy = { busy: Record<string, { start: string; end: string }[]> }

/// 会议纪要(D14):★AI 转写只是原材料,记录员才是作者★。
/// 字段就是「固定模板」本身 —— 到场/列席/缺席是**会后补录的事实**(D11),
/// 与邀请时的答复是两回事(答复了不等于真来了)。
export type Minutes = {
  meeting_id: number
  status: 'draft' | 'done'
  attendees: string; observers: string; absentees: string
  agenda_text: string; content_md: string
  resolutions: string; todos: string
  pdf_item_id: number | null
  completed_at: string | null
  updated_at: string
}
