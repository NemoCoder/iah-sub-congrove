import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { 拆决议与待办 } from './ai-decisions.ts'

/// ★2026-08-17 liaoruili 截图里那份的形状★（原样简化，标题写法一致）
const 实拍 = `**关键决议**

1. **确定技术路线优先级**：优先执行"词语检索"。
2. **确立数据处理工作流**：漏斗式压缩。

**待办事项**

| 负责人 | 待办内容 | 截止时间/状态 |
| :--- | :--- | :--- |
| **spk0** | 完成 OCR 入库 | 4-5 天内 |`

test('★实拍那份能切开,两栏各拿各的★', () => {
  const r = 拆决议与待办(实拍)
  assert.equal(r.切开了, true)
  assert.ok(r.决议.includes('确定技术路线优先级'))
  assert.ok(!r.决议.includes('负责人'), `★决议里还混着待办表格★:\n${r.决议}`)
  assert.ok(r.待办.includes('负责人'))
  assert.ok(!r.待办.includes('确定技术路线优先级'), `★待办里还混着决议★:\n${r.待办}`)
})

test('★切不出来就整份都给,绝不给一个空栏★', () => {
  // 没有待办标题
  const 只有决议 = '1. 决定优先做词语检索。\n2. 数据入库还需 4-5 天。'
  const a = 拆决议与待办(只有决议)
  assert.equal(a.切开了, false)
  assert.equal(a.决议, 只有决议)
  assert.equal(a.待办, 只有决议, '切不动时两栏都给全文 —— 回到今天的样子')

  // 有标题但下面是空的
  const 空待办 = '**关键决议**\n1. 甲。\n\n**待办事项**\n'
  const b = 拆决议与待办(空待办)
  assert.equal(b.切开了, false, '★一个空的「决议事项」比一个混着待办的糟得多★')
})

test('别把正文里顺带提到的「待办事项」当标题', () => {
  const 文 = '**关键决议**\n1. 会后由 spk2 整理成待办事项并同步群里。\n2. 乙。'
  const r = 拆决议与待办(文)
  assert.equal(r.切开了, false, '「…整理成待办事项并…」不独占一行,不算标题')
})

test('几种标题写法都认', () => {
  for (const [决, 待] of [['## 关键决议', '## 待办事项'], ['决议：', '待办：'],
                           ['一、决议事项', '二、待办事项'], ['**决策事项**', '**行动项**']]) {
    const r = 拆决议与待办(`${决}\n甲决定\n${待}\n乙要做`)
    assert.equal(r.切开了, true, `${决} / ${待} 没认出来`)
    assert.equal(r.决议, '甲决定')
    assert.equal(r.待办, '乙要做')
  }
})

test('没有决议标题、只有待办标题:上半段当决议', () => {
  const r = 拆决议与待办('1. 甲决定。\n2. 乙决定。\n**待办事项**\n- spk0 做丙')
  assert.equal(r.切开了, true)
  assert.equal(r.决议, '1. 甲决定。\n2. 乙决定。')
  assert.equal(r.待办, '- spk0 做丙')
})

test('顺序反了不猜', () => {
  const r = 拆决议与待办('**待办事项**\n- 甲\n**关键决议**\n- 乙')
  assert.equal(r.切开了, false)
})

test('空输入', () => {
  const r = 拆决议与待办(null)
  assert.deepEqual(r, { 决议: '', 待办: '', 切开了: false })
})
