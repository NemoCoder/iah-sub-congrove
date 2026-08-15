// 时区：全前端渲染时间的**唯一推导**（PRD E0/E1/E2，设计 docs/TECH-DESIGN-M3-timezone.md）。
//
// ══════ 这个文件为什么存在 ══════
// 盘点时发现前端有 **57 处** 裸 `new Date(...)`，散在 8 个文件里，全部走浏览器本地时区；
// 而 `fmtDay` / `fmtHM` / `pad` 这三个函数在 **4 个文件里各抄了一份**（不是引用，是复制）。
// ★同一个判据散在几十个地方，改漏一处不会报错，只会有一个视图默默显示错的时间。★
// 所以先把它们收敛到这里（行为完全不变），再谈时区换算 —— 否则换算逻辑一落地就是 57 个坑。
//
// ══════ 三个概念别混 ══════
//   · **活动时区** `activities.timezone`：「这个时间是按哪儿的钟说的」——输入时的解释；
//   · **我的时区** `user_prefs.timezone`：「我希望按哪儿的钟看」；没设则跟随浏览器；
//   · **设备时区**：浏览器报的。
// 存储一律 UTC，三者都只影响**解释与呈现**。
//
// ⚠★不引第三方时区库★（设计 §6）：`Intl` 够用。luxon / date-fns-tz 是几十 KB 的依赖，
//   换来的只是语法糖；而夏令时、历史时区变更这些真正难的部分，`Intl` 本来就替我们做了。
//   ★绝不自己算偏移★ —— 那是重新实现一遍 tzdata，必错。

/// 用户显式设过的时区（`user_prefs.timezone`）。null = 没设过，跟随浏览器。
///
/// ⚠★模块级可变状态，是有意的★：它是**每个浏览器会话唯一**的一个值，
/// 而消费它的是 8 个文件里几十处渲染点。走 React context 的话，
/// 每个纯函数格式化器都得变成 hook，`schedule-layout.ts` 这种非组件的模块还用不了。
/// 代价是它必须在应用启动读完 `/api/me/prefs` 之后**尽早**调用一次 `setMyTz`。
let _myTz: string | null = null

export function setMyTz(tz: string | null): void { _myTz = tz || null }

/// 浏览器报的时区。
export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
}

/// ★我此刻按哪个时区看★：设置优先，没设过就跟随浏览器。
/// 没设过的人因此与今天的行为**完全一致** —— 这正是步骤 1 敢说「行为不变」的依据。
export function myTz(): string { return _myTz || browserTz() }

/// 用户显式设过时区吗（E0 的提示条只在设过的人身上才有意义）。
export function hasExplicitTz(): boolean { return _myTz !== null }

/// IANA 名 → 中文名（liaoruili 2026-08-12 拍板：用中文）。
///
/// ⚠★只收常见的十来个，映射不到就原样显示 IANA 名★：这句话存在的**全部意义**
/// 就是让人一眼懂「（北京 15:00）」；而给 400 多个 IANA 名逐个起中文名既维护不动，
/// 也会造出「Asia/Urumqi 叫什么」这类没人答得了的问题。★宁可露出英文，不可猜错地名。★
const ZH: Record<string, string> = {
  'Asia/Shanghai': '北京', 'Asia/Chongqing': '北京', 'Asia/Hong_Kong': '香港',
  'Asia/Taipei': '台北', 'Asia/Tokyo': '东京', 'Asia/Seoul': '首尔',
  'Asia/Singapore': '新加坡', 'Asia/Bangkok': '曼谷', 'Asia/Dubai': '迪拜',
  'Asia/Kolkata': '新德里', 'Europe/London': '伦敦', 'Europe/Paris': '巴黎',
  'Europe/Berlin': '柏林', 'Europe/Moscow': '莫斯科',
  'America/New_York': '纽约', 'America/Chicago': '芝加哥', 'America/Denver': '丹佛',
  'America/Los_Angeles': '洛杉矶', 'America/Toronto': '多伦多',
  'Australia/Sydney': '悉尼', 'Pacific/Auckland': '奥克兰', 'UTC': 'UTC',
}
export function tzLabel(tz: string): string { return ZH[tz] || tz }

/// 供「活动时区」下拉用的候选（中文名 + IANA 值）。
export const TZ_OPTIONS = Object.keys(ZH).map((v) => ({ value: v, label: `${ZH[v]}（${v}）` }))

const D = (t: string | Date) => (t instanceof Date ? t : new Date(t))

/// 某个瞬时在某时区里的**墙上时间**各部分。
/// 用 `formatToParts` 而不是 `toLocaleString` 再解析字符串 —— 后者的格式随 locale 变，
/// 解析它等于把 UI 语言当成了数据格式。
export function partsIn(t: string | Date, tz: string): {
  y: number; m: number; d: number; h: number; min: number; wd: number
} {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  })
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(D(t))) p[x.type] = x.value
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>
  return {
    y: +p.year, m: +p.month, d: +p.day,
    // ⚠ `hour12:false` 在部分实现里会把午夜给成 24，归一成 0
    h: +p.hour % 24, min: +p.minute, wd: WD[p.weekday] ?? 0,
  }
}

const WD_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (n: number) => String(n).padStart(2, '0')

export function fmtHM(t: string | Date, tz = myTz()): string {
  const p = partsIn(t, tz); return `${pad(p.h)}:${pad(p.min)}`
}
/// 「8/12 周三」——与原来 4 份复制里的格式一致，换过来不改观感。
export function fmtDay(t: string | Date, tz = myTz()): string {
  const p = partsIn(t, tz); return `${p.m}/${p.d} ${WD_ZH[p.wd]}`
}
export function fmtWeek(t: string | Date, tz = myTz()): string {
  return WD_ZH[partsIn(t, tz).wd]
}
export function fmtRange(a: string | Date, b: string | Date, tz = myTz()): string {
  return `${fmtHM(a, tz)}–${fmtHM(b, tz)}`
}
/// 「2026-08-12 15:00」
export function fmtStamp(t: string | Date, tz = myTz()): string {
  const p = partsIn(t, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`
}

/// ★墙上时间 → UTC 瞬时★（E1 的核心，也是最容易写错的一步）。
///
/// 「我在纽约给**北京**的组会排 15:00」——15:00 指的是北京时间，
/// 而浏览器的 `new Date(y,m,d,15,0)` 会按**纽约**解释，差 12–13 小时，★而且不会报错★。
///
/// 做法：先把这组数字当成 UTC 造一个猜测瞬时，看它在目标时区显示成几点，
/// 差多少就反向补多少；再迭代一次收敛 —— ★第二次迭代是为了夏令时切换的那一小时★，
/// 那一小时里「猜测点的偏移」和「答案点的偏移」不是同一个值。
export function wallToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const want = Date.UTC(y, m - 1, d, h, min)
  let t = want
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(t), tz)
    const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
    t -= got - want          // got 比 want 快多少，就把瞬时往回拨多少
  }
  return new Date(t)
}

/// ★E1 的核心：把「用户在选择器里看到并选中的那个墙上时间」按 `tz` 解释成 UTC 瞬时★。
///
/// 时间选择器（`TimeRangePicker` / dayjs）给出的 Date 里，Y/M/D/H/M 这组数字
/// **就是用户看到的那串数字**（选择器显示的是本地时间，他从 15 分钟整槽里挑了一个）。
/// 我们要的是「按**活动所在时区**读这组数字」。
///
/// ⚠★原来是 `v.range[0].toISOString()`★ —— 那是按**浏览器**解释的。
/// 「我在纽约给北京的组会排 15:00」时，两者差 12–13 小时，
/// ★而且不会报错★：请求 200、日历上照常出现一场会，只是时间整个错了半天。
/// 这是整块时区里**最容易写错、也最难发现**的一步（设计 §3 步骤 3）。
export function pickedToUtc(picked: Date, tz: string): Date {
  return wallToUtc(picked.getFullYear(), picked.getMonth() + 1, picked.getDate(),
    picked.getHours(), picked.getMinutes(), tz)
}

/// `pickedToUtc` 的逆：把库里的瞬时还原成「在 `tz` 里看是几点」的本地 Date，
/// 好塞回选择器让人接着改。★不做这一步，一打开「改时间」就会把时间挪走★。
export const utcToPicked = shiftToTz

/// 把一个瞬时按 `tz` 的墙上时间，重新表达成一个「本地时间看起来一样」的 Date。
/// ★只给布局计算用★（`schedule-layout` 要算「这场会落在哪一天的第几行」）：
/// 它内部全靠 `getHours()/getDay()` 这类**本地**取值器，喂给它一个平移过的 Date，
/// 就等于让整套布局按目标时区算，而不必把布局代码全改写一遍。
/// ⚠ 返回的 Date **不是那个真实瞬时**，别拿它去存库或做时长运算。
export function shiftToTz(t: string | Date, tz = myTz()): Date {
  const p = partsIn(t, tz)
  return new Date(p.y, p.m - 1, p.d, p.h, p.min, 0, 0)
}

/// ★一个**日历格**是不是「今天」★。
///
/// ⚠★这和 `sameDayIn` 不是一回事，混用会整体错一天★（2026-08-12 实测撞到）：
/// 日历的 `days[]` 里装的是**日历日期**，用「浏览器本地的那天零点」这个 Date 表示
/// （8/12 那一格 = `2026-08-11T16:00Z`）。它**不是一个瞬时**，是一个格子的名字。
/// 拿 `sameDayIn` 去比，等于把那个零点当瞬时再投影到别的时区 —— 8/12 那格投到纽约变成 8/11，
/// 于是「今天」的高亮整体后移一格。★而且它不报错，只是高亮错了一列。★
///
/// 正确的判据是：**格子的 Y/M/D**（本来就是日历日期，不用换算）对上
/// **此刻在我的时区里是几号**。
export function isTodayCell(cell: Date, tz = myTz(), now: Date = new Date()): boolean {
  const p = partsIn(now, tz)
  return cell.getFullYear() === p.y && cell.getMonth() + 1 === p.m && cell.getDate() === p.d
}

/// 两个**瞬时**在 `tz` 里是不是同一天。⚠ 别拿它比日历格,见 `isTodayCell`。
/// ⚠ 原来 schedule-view 里是 `a.getFullYear()===b.getFullYear() && ...` —— 那是**浏览器本地**的同一天。
/// 「今天」这条高亮、跨天活动的裁剪都靠它,判错的表现是**高亮错一整列**。
export function sameDayIn(a: string | Date, b: string | Date, tz = myTz()): boolean {
  const x = partsIn(a, tz), y = partsIn(b, tz)
  return x.y === y.y && x.m === y.m && x.d === y.d
}

/// E2：活动时区与我的不一致时才标注。
/// 一致 → 返回 ''（国内 99% 的情况看不到任何多余的字）。
export function annotate(t: string | Date, activityTz: string | null | undefined, tz = myTz()): string {
  if (!activityTz || activityTz === tz) return ''
  return `（${tzLabel(activityTz)} ${fmtHM(t, activityTz)}）`
}
