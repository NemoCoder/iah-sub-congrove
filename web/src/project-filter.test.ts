import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { effectiveScope, effectiveTab, showScopeSwitch, shownProjects, type Scope } from './project-filter.ts'

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

/// ★这条是「切到材料区右边一片空白」的复现测试★(2026-08-09):
/// 材料区只有「文档」一个 tab,而 activeKey 还停在上一个项目的「设置」上。
test('可选 tab 少了时,选中值要回落而不是指着不存在的 key', () => {
  const stale = 'settings'                                   // 上一个项目里选的
  assert.equal(effectiveTab(stale, ['items']), 'items', 'tab 没了却还选着它 = 右边整块空白')
  // 回到有全部 tab 的项目,原来的选择照常保留
  assert.equal(effectiveTab(stale, ['items', 'members', 'activities', 'settings']), 'settings')
})

/// ★「已归档里为啥有我的活动材料」的复现测试★（2026-08-13 liaoruili 截图）。
/// 材料区永不归档,却因为「永远显示」被无条件置顶进了归档档 ——
/// 于是它被那一格的语义标成了归档,而计数(只数真项目)说「已归档 1」、底下却有两行。
test('材料区不进「已归档」那一档', () => {
  type P = { name: string; kind: string; archived_at: string | null }
  const all: P[] = [
    { name: '我的活动材料', kind: 'materials', archived_at: null },
    { name: '在做的项目', kind: 'team', archived_at: null },
    { name: '2025 结题项目', kind: 'team', archived_at: '2026-08-01T00:00:00Z' },
  ]
  const isMat = (p: P) => p.kind === 'materials'

  const 归档档 = shownProjects(all, isMat, 'archived', '')
  assert.deepEqual(归档档.map((p) => p.name), ['2025 结题项目'],
    '★材料区永不归档,不该出现在「已归档」里★（计数与行数对不上就是这个 bug）')

  const 进行中 = shownProjects(all, isMat, 'active', '')
  assert.deepEqual(进行中.map((p) => p.name), ['在做的项目'],
    '★材料区一行都不进这个列表★(2026-08-13 拍板:拎到筛选器上面单独一格) —— 否则「进行中 2」底下会有 3 行')
})

/// ★但搜索仍然豁免它★:搜索是「在同一份列表里找」,被关键词筛掉一次人就以为它没了。
/// 这两条判据分开,是这次修复的要点 —— 原来它们被写成了同一条。
test('材料区已不在列表里,搜索自然也碰不到它', () => {
  type P = { name: string; kind: string; archived_at: string | null }
  const all: P[] = [
    { name: '我的活动材料', kind: 'materials', archived_at: null },
    { name: '在做的项目', kind: 'team', archived_at: null },
  ]
  const out = shownProjects(all, (p: P) => p.kind === 'materials', 'active', '不存在的词')
  assert.deepEqual(out.map((p) => p.name), [],
    '★搜索筛的是项目列表,而材料区已经不在这个列表里了★——它那一格在筛选器之上,搜索天然碰不到它')
})
