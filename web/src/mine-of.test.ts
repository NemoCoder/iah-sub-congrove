// 「我在这场活动里是什么身份」的判定（PRD C0–C2）。★抽出来单测★：
// 判据的**顺序**是有讲究的，而顺序错了在截图上看不出来 —— 只会显示成另一个图标。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mineOf } from './activity-mine.ts'
import type { Activity } from './api.ts'

const mk = (p: Partial<Activity>): Activity => ({
  id: 1, title: 't', agenda: '', organizer: 'bob', recorder: 'bob',
  starts_at: '', ends_at: '', timezone: 'Asia/Shanghai', location: '', online_url: '',
  visibility: 'private', status: 'active', created_at: '', my_status: null, is_private: true,
  ...p,
} as Activity)

test('发起人优先于记录员', () => {
  // ★create 时记录员默认填自己★，于是发起人常常同时是记录员。
  // 这时该显示「我发起的」——**对它负责**比「欠着一份纪要」更主导。
  assert.equal(mineOf(mk({ organizer: 'alice', recorder: 'alice' }), 'alice'), 'organizer')
  assert.equal(mineOf(mk({ organizer: 'bob', recorder: 'alice' }), 'alice'), 'recorder')
})

test('旁听要看 my_kind，推不出来', () => {
  assert.equal(mineOf(mk({ my_kind: 'observer' }), 'alice'), 'observer')
  // 正式参会人★不标★：默认状态不该占视觉，全标等于没标
  assert.equal(mineOf(mk({ my_kind: 'attendee' }), 'alice'), null)
  assert.equal(mineOf(mk({}), 'alice'), null, '不在名单里（关联项目的成员）也不标')
})

test('拿不到当前用户名时一个都不标', () => {
  // 未登录/还没加载出来时，宁可不标也别标错 —— 标错比不标更误导
  assert.equal(mineOf(mk({ organizer: 'alice' }), ''), null)
})
