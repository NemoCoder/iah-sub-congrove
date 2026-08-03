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
export type Space = {
  id: number; name: string; description: string; created_by: string; my_role: Role | null
  quota_bytes: number; used_bytes: number; viewer_no_download: boolean
}
export type Diagnose = {
  username: string; is_super: boolean; direct: Role | null
  via_groups: { group_id: number; group: string; role: Role }[]; effective: Role | null
}
export type UserOpt = { username: string; name: string | null }
export type Item = {
  id: number
  parent_id: number | null
  kind: 'folder' | 'doc' | 'file' | 'video'
  name: string
  size: number | null
  mime: string | null
  created_by: string
  updated_at: string
}
export type Grant = { grantee_type: 'user' | 'group'; grantee_id: string; role: Role; grantee_name: string | null }
export type Group = { id: number; name: string; description: string; member_count: number; my_role: string | null }
export type Member = { username: string; role: string; name: string | null }
export type Version = { id: number; size: number | null; label: string | null; created_by: string; created_at: string }
