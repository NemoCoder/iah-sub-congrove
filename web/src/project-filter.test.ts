import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { effectiveScope, showScopeSwitch, type Scope } from './project-filter.ts'

test('有归档项目时,切换控件显示且按选择筛选', () => {
  assert.equal(showScopeSwitch(2), true)
  assert.equal(effectiveScope('archived', 2), 'archived')
  assert.equal(effectiveScope('active', 2), 'active')
})

/// ★这条是那个「界面卡死」bug 的复现测试★:
/// 停在「已归档」时把最后一个归档项目恢复 → 控件消失,取值必须跟着回落,
/// 否则列表永远空、而用户没有任何办法切回来。
test('恢复最后一个归档项目后不能卡在「已归档」', () => {
  const stale: Scope = 'archived'          // 用户上一步选的
  assert.equal(showScopeSwitch(0), false, '一个归档项目都没有了,控件不该还在')
  assert.equal(effectiveScope(stale, 0), 'active', '控件没了却还筛「已归档」= 列表永远空且切不回来')
})

test('没有归档项目时,控件不显示、恒为 active', () => {
  assert.equal(showScopeSwitch(0), false)
  assert.equal(effectiveScope('active', 0), 'active')
})
