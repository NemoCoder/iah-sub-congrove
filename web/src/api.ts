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
  /// 待答复的主持人转让（后端一直在详情里给，前端此前**一直没用**）。
  /// ★发起方靠它才看得到「我发出去的那笔还挂着」，也才有地方撤回★ ——
  /// 转让确认框里那句「你随时可以撤回」原本是**空头承诺**：后端有 `DELETE .../transfer`，
  /// 界面上却没有任何入口（2026-08-15 逐张看巡检截图看出来的）。
  pending_transfer?: { id: number; from: string; to: string; created_at: string } | null
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
  /// 上传者姓名(app_user.name)。★2026-09-07 补★:「上传者」列此前一律印账号,
  /// 而同一屏的记录员/参会人早就印姓名 —— 同一个人在一个界面里两种叫法。
  /// null = 平台没给名字,`showUser` 退回账号。
  created_by_name?: string | null
  /// ★属于某场活动的材料★(D10 的只读区):非空时**不画**改名/移动/删除 ——
  /// 后端也拒(items.rs 的 update/remove 里有判断),这里不画是为了不引导人去犯错。
  activity_id?: number | null
  /// ★客户端申报的哈希与服务端算出的真值不符★(A2/D3):很可能传输中损坏了。
  /// 不阻止使用,但要在界面上说出来 —— 此前这个信号被后端直接改写成了「已核验」。
  sha_declared_mismatch?: boolean
  /// ★你,现在,下不下得了这一项★——后端算好的**唯一判据**(items.rs::ItemRow)。
  /// 项目级 `no_download` 只拦 viewer,活动级对所有角色生效,两者是 OR。
  /// ⚠ 别在前端自己拼这个判断:2026-08-15 之前这里拼的是
  /// `cur.my_role === 'viewer' && cur.no_download`,**只有项目级那一半** ——
  /// 于是禁下载活动的材料照样画着下载按钮,点下去才 400。
  no_download?: boolean
  created_at: string
  updated_at: string
}
/// 项目成员。★只有人,没有组★——权限只到具体的人。
/// 项目成员。★只有人,没有组★——权限只到具体的人。
/// name = 真实姓名(app_user.name);★拉进来但还没登录过的人为空★,只显示用户名即可。
export type Member = { username: string; name?: string | null; role: Role; added_by: string; added_at: string }
/// 「用户名（姓名）」的统一显示。姓名为空时只给用户名 —— 别显示成「zhangsan（）」。
/// 陈述事实时怎么称呼一个人 —— ★只显示姓名★(2026-08-19 liaoruili:「都使用中文,不要用账号」)。
///
/// 「谁参会了」「谁是记录员」「谁传的这份材料」这些地方,读的人要的是**人**,
/// 而 `liaoruili` 这种账号名对读者没有信息量。姓名缺失(没登录过 / 平台没填)才退回账号。
///
/// ⚠★别拿它去做「选人」和「管理操作」★——那两类场景账号名是**操作凭据**不是称呼:
///   搜人是按账号搜的,授撤超管/改配额也要能唯一定位到账号(重名时姓名不唯一)。
///   那些地方用下面的 `showUserWithAccount`。
export const showUser = (username: string, name?: string | null) =>
  name && name !== username ? name : username

/// 选人 / 管理操作时怎么称呼 —— ★姓名在前、账号在括号里★。
/// 姓名让人认得出是谁,账号保证唯一定位。姓名缺失就只剩账号。
export const showUserWithAccount = (username: string, name?: string | null) =>
  name && name !== username ? `${name}（${username}）` : username
export type MemberList = { owner: string | null; members: Member[] }
export type Version = { id: number; size: number | null; label: string | null; created_by: string
  /// 上传者姓名。null = 平台没给,`showUser` 退回账号。见 Item.created_by_name。
  created_by_name?: string | null; created_at: string }

// ── 活动与日程(M1)────────────────────────────────────────────────────────
/// 答复状态。★counter=建议改期★:私密项目的日程对发起人完全隐形,他不知道我忙,
/// 所以这是私事冲突**唯一的结构化出口**(D2),不是可有可无的便利功能。
export type RespondStatus = 'pending' | 'accepted' | 'declined' | 'tentative' | 'counter'
export type Activity = {
  id: number; title: string; agenda: string
  organizer: string; recorder: string
  /// 发起人 / 记录员的姓名。★列表行里只有账号,姓名要后端一起带过来★
  /// (2026-09-04:参会名单本来就有 name,所以那一处早就显示中文了,而列表 / 待办卡 /
  ///  日程视图 / 纪要页拿的是这个扁平行 —— 同一个人在两行里叫了两个名字)。
  /// null = 平台没给名字,`showUser` 退回账号。
  organizer_name?: string | null; recorder_name?: string | null
  /// 主讲人,自由文本(多人用顿号分隔)。★不进参会名单、也不判权★——
  /// 「谁来讲」与「谁有权限」是两件事:外请的主讲人未必是平台用户。null = 没填。
  speakers?: string | null
  /// 会议主题:这次要推进什么(一句话)。★不是 title 的别名★——
  /// title 是「这场活动叫什么」。null = 没填,纪要模板里那一行就不画。
  subject?: string | null
  starts_at: string; ends_at: string; timezone: string
  /// 会后补录的实际时长(分钟)。★D5 三级回退的第 2 级★:录制 > **手工** > 排程。
  /// null = 没填过 —— 统计会退到排程时长,而排程常常离谱(排 2 小时、20 分钟散会)。
  actual_minutes?: number | null
  /// 这一场提前多少分钟提醒(PRD F3)。★三态★:null=跟随个人默认 / 0=这场不提醒 / >0=提前这么多。
  /// 值域与下拉选项的唯一真相源在 remind-poll.tsx 的 REMIND_OPTIONS。
  remind_minutes?: number | null
  /// 活动粒度的材料策略(PRD 6.3.2)。★与项目级叠加不是覆盖★:两处任一禁了就禁。
  no_download?: boolean
  no_share?: boolean
  location: string; online_url: string
  visibility: 'private' | 'public'
  /// 活动类型名（ADR-0002）。软删的类型历史照常显示名字（L1）。
  type_name?: string | null
  /// 这个类型有没有纪要这回事（ADR-0002 能力位）。★徽章与「待整理」判据必须带上它★ ——
  /// 漏了的话个人日程也会被催交纪要（2026-08-11 liaoruili 从界面上看出来的）。
  has_minutes?: boolean
  status: 'active' | 'canceled'
  created_at: string
  /// 我的答复;不在名单里则 null
  my_status: RespondStatus | null
  /// ★我在这场活动里是什么身份★(C0–C2):attendee=正式参会人 / observer=旁听 / null=不在名单里。
  /// 「我发起的」「我是记录员」拿 organizer/recorder 与自己比就知道;
  /// ★只有「是不是旁听」是库里的事实、推不出来★,所以后端只补了这一个字段。
  my_kind?: 'attendee' | 'observer' | null
  /// ★活动自己的 `visibility <> 'public'`★——日历据此上色(M0 起)。
  /// ⚠ 这里原来写的是「只关联私密项目 / 只要关联任一公开项目就算公开的会」,
  ///   那是 M0 之前按项目可见性判的老规则,`projects.visibility` 已删(2026-08-15 订正)。
  /// 忙闲是**另一个**开关(活动自己的 `busy`),别再把两者当同一件事。
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
  /// ★提醒是什么时候投出去的★(2026-08-16;null = 还没投)。
  /// ⚠ 它是「投递那一刻」,不是「会开始的时刻」—— 两个都是时间戳,极易看混。
  reminded_at: string | null
}
export type ActivityDetail = {
  activity: Activity
  participants: Participant[]
  /// ★能不能看这场活动的材料/录制★——★由后端算,前端别自己拿「是不是参会人」当替身判据★
  /// (2026-08-17,ADR-0006):那个替身判据正是「卡片在、列表空、上传失败」的成因。
  can_see_items: boolean
  /// 能不能往这场活动传材料(参会人也能传,ADR-0006 决定二推翻了 D8)
  can_upload_items: boolean
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
  mime: string | null; is_recording: boolean; created_by: string
  /// 上传者姓名(app_user.name)。★2026-09-07 补★:「上传者」列此前一律印账号,
  /// 而同一屏的记录员/参会人早就印姓名 —— 同一个人在一个界面里两种叫法。
  /// null = 平台没给名字,`showUser` 退回账号。
  created_by_name?: string | null; created_at: string
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
