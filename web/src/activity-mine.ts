// 「我在这场活动里是什么身份」——★纯逻辑,所以放 .ts 不放 .tsx★
// (与 schedule-layout.ts / freebusy-layout.ts / time-slots.ts 同一分工:
//  纯的那半能被 `node --test` 直接跑,组件那半跑不了)。
//
// PRD C0–C2:日历块只标三种身份 —— 发起 / 记录员 / 旁听。
// ★普通参与人不标★:默认状态不该占视觉;全标的话满屏都是同一个图标 = 等于没有图标,
// 反而把真正特殊的那几个淹了。
import type { Activity } from './api'

export type Mine = 'organizer' | 'recorder' | 'observer' | null

/// ⚠★判据的顺序是有讲究的★:`create` 时记录员默认填自己,于是**发起人常常同时是记录员**。
/// 这时该显示「我发起的」——「对它负责」比「欠着一份纪要」更主导。
/// 顺序错了在截图上看不出来,只会显示成另一个图标 —— 所以它值得一条单测。
export function mineOf(m: Pick<Activity, 'organizer' | 'recorder' | 'my_kind'>, me: string): Mine {
  if (!me) return null              // 还没拿到当前用户名时宁可不标:★标错比不标更误导★
  if (m.organizer === me) return 'organizer'
  if (m.recorder === me) return 'recorder'
  if (m.my_kind === 'observer') return 'observer'
  return null
}

export const MINE_TEXT: Record<NonNullable<Mine>, string> = {
  organizer: '我发起的', recorder: '我是记录员', observer: '我旁听',
}
