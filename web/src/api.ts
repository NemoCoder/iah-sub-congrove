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
