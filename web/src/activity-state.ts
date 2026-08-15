// 「这场活动现在是什么状态」——★纯逻辑,所以放 .ts 不放 .tsx★
// (与 activity-mine.ts / schedule-layout.ts 同一分工:纯的那半能被 `node --test` 直接跑)。
//
// ══════ 这个文件为什么存在 ══════
// 2026-08-15 的对抗检查数出来两处「同一个判据抄了 N 份」:
//
//   · **结束了没**:`new Date(m.ends_at).getTime() < Date.now()` 在 **6 个地方**各写一遍。
//     `schedule-view.tsx` 里其实 `export const isEnded` 过 —— ★而没有任何一个文件 import 它★。
//     导出了却没人用,比没导出更糟:它让人以为这件事已经收敛了。
//   · **答复状态怎么写**:两张表(`activities-list.tsx` 的 `STATUS_TAG`、
//     `activity-detail.tsx` 的 `STATUS_META`),而且**用词不一样** ——
//     同一个 `accepted`,活动页写「已接受」、详情页写「接受」;`counter` 一个写「已提改期」
//     一个写「建议改期」。★两处用词不同,人会以为是两种状态。★
//
// ⚠ 这类重复的共同点是**改漏一处不会报错**:tsc 不管、测试不覆盖,只有某个视图默默显示得不一样。
//   `tz.ts` 的头注写的是同一件事(4 份复制的时间格式化器),这里是它的第二季。
import type { Activity, RespondStatus } from './api'

/// 这场活动结束了没。★判据只有这一处★ —— 别再在组件里写 `new Date(m.ends_at) < …`。
///
/// ⚠ 只看 `ends_at`,不看 `status`:被取消的活动(`status='cancelled'`)在时间上仍然
/// 「过没过点」,是两个正交的问题。要「既没取消又开完了」就自己 `&&` 一下,
/// 别把它糊进这个函数 —— 糊进去之后调用方就分不清自己问的是哪一个了。
export const isEnded = (m: Pick<Activity, 'ends_at'>, now = Date.now()) =>
  new Date(m.ends_at).getTime() < now

/// 答复状态的**展示**用词与颜色。★唯一一份★。
///
/// ⚠★这里是「状态」不是「动作」★:标签写的是 `已接受`(状态),按钮上写的是 `接受`(动作)。
///   详情页那张表原来把状态写成了动作词(标签上就写「接受」「拒绝」),
///   于是同一个状态在两个页面读起来像两回事。按钮的动词各自写在按钮上,别来取这张表。
export const STATUS_LABEL: Record<RespondStatus, { text: string; color: string }> = {
  pending: { text: '待应答', color: 'red' },
  accepted: { text: '已接受', color: 'green' },
  declined: { text: '已拒绝', color: 'default' },
  tentative: { text: '待定', color: 'orange' },
  counter: { text: '已提改期', color: 'purple' },
}
