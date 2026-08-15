// tz.ts 的单测 —— 对应设计 docs/TECH-DESIGN-M3-timezone.md §5 的用例 1–9。
//
// ★这些是全前端时间渲染的地基★：57 处渲染点最后都落到这几个函数上，
// 所以这里错一个字，整站的时间就一起错 —— 而那种错**不会报错**。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { annotate, fmtDay, fmtHM, isTodayCell, myTz, partsIn, pickedToUtc, sameDayIn, setMyTz, shiftToTz, tzLabel, utcToPicked, wallToUtc } from './tz.ts'

const SH = 'Asia/Shanghai', NY = 'America/New_York'

test('① 同一瞬时在不同时区显示成不同的钟点', () => {
  const t = '2026-08-12T07:00:00Z'
  assert.equal(fmtHM(t, SH), '15:00')
  assert.equal(fmtHM(t, NY), '03:00')          // 夏令时内 UTC-4
})

test('② ★跨日★:UTC 深夜在东八区已经是次日', () => {
  const t = '2026-08-12T23:00:00Z'
  assert.equal(fmtHM(t, SH), '07:00')
  assert.equal(fmtDay(t, SH), '8/13 周四')      // ★日期也要跟着跳,不只是钟点★
  assert.equal(fmtDay(t, NY), '8/12 周三')      // 同一瞬时,纽约还在前一天
})

test('③ ★夏令时★：同一时区在夏天和冬天的偏移不一样', () => {
  // 7 月:纽约 UTC-4;1 月:UTC-5。★这条钉死「没有把偏移写死」★
  assert.equal(fmtHM('2026-07-15T16:00:00Z', NY), '12:00')
  assert.equal(fmtHM('2026-01-15T16:00:00Z', NY), '11:00')
})

test('④ 墙上时间 → UTC：按**指定时区**解释，不是按运行环境', () => {
  // 「北京时间 2026-08-12 15:00」= 07:00Z
  assert.equal(wallToUtc(2026, 8, 12, 15, 0, SH).toISOString(), '2026-08-12T07:00:00.000Z')
  // 「纽约时间 2026-08-12 15:00」= 19:00Z(夏令时 UTC-4)
  assert.equal(wallToUtc(2026, 8, 12, 15, 0, NY).toISOString(), '2026-08-12T19:00:00.000Z')
  // 冬天的纽约是 UTC-5
  assert.equal(wallToUtc(2026, 1, 12, 15, 0, NY).toISOString(), '2026-01-12T20:00:00.000Z')
})

test('★⑤ 夏令时切换后的第一个小时★ —— 单次迭代会算错整整一小时', () => {
  // 2026-03-08 纽约 02:00 跳到 03:00。★03:30 是一个完全正常、用户真会选的时间★,
  // 它不是边角料 —— 而如果 wallToUtc 只迭代一次,这里会得出 08:30Z(整整差一小时),
  // ★不报错、不越界,只是那场会排错了时间★。
  //
  // ⚠ 这条用例是**变异测试逼出来的**(2026-08-12):把迭代次数从 2 改成 1 之后,
  //   全部 46 个测试照样绿 —— 说明当时的测试根本没覆盖到这个注释所声称的理由。
  //   ★「测试全绿」不等于「测试测到了」。★
  assert.equal(wallToUtc(2026, 3, 8, 3, 30, NY).toISOString(), '2026-03-08T07:30:00.000Z')
  // 切换前一天的同一钟点仍是 EST(UTC-5)
  assert.equal(wallToUtc(2026, 3, 7, 3, 30, NY).toISOString(), '2026-03-07T08:30:00.000Z')
  // 南半球:悉尼 2026-10-04 也有一次跳变,切换后的 03:30 同样要对
  assert.equal(wallToUtc(2026, 10, 4, 3, 30, 'Australia/Sydney').toISOString(), '2026-10-03T16:30:00.000Z')
})

test('⑥ wallToUtc 与 partsIn 互为逆运算(往返不丢)', () => {
  for (const tz of [SH, NY, 'Europe/London', 'Australia/Sydney']) {
    for (const [y, m, d, h, mi] of [[2026, 3, 8, 2, 30], [2026, 11, 1, 1, 30], [2026, 8, 12, 15, 0]]) {
      const inst = wallToUtc(y, m, d, h, mi, tz)
      const p = partsIn(inst, tz)
      // ⚠★这里故意只判到「日」★:上面两个日期正是 DST 的**空洞**(02:30 那天根本不存在)
      //   和**重叠**(01:30 出现两次)——那种墙上时间没有唯一答案,任何结果都是一种约定,
      //   钉死小时等于把一个约定当成正确性。★真正该钉死小时的是上一条用例★(切换后的合法时刻)。
      assert.equal(p.y, y, `${tz} ${y}-${m}-${d} ${h}:${mi} 年份漂了`)
      assert.equal(p.m, m, `${tz} 月份漂了`)
      assert.equal(p.d, d, `${tz} 日期漂了`)
    }
  }
})

test('⑦ myTz：设置优先，没设过跟随浏览器', () => {
  setMyTz(null)
  assert.equal(myTz(), Intl.DateTimeFormat().resolvedOptions().timeZone)
  setMyTz(NY)
  assert.equal(myTz(), NY)
  setMyTz(null)                                 // ★复位,别污染后面的用例★
})

test('⑧ E2 判据：一致不标、不一致才标', () => {
  setMyTz(SH)
  const t = '2026-08-12T07:00:00Z'
  assert.equal(annotate(t, SH), '')              // 我和活动都在北京 → 一个字都不加
  assert.equal(annotate(t, null), '')            // 活动没记时区(历史数据)→ 不猜,不标
  assert.equal(annotate(t, ''), '')
  setMyTz(NY)
  // 纽约的人看北京的会:自己看到 03:00,后面补一句原始时区的墙上时间
  assert.equal(fmtHM(t), '03:00')
  assert.equal(annotate(t, SH), '（北京 15:00）')
  setMyTz(null)
})

test('⑨ 时区中文名：收录的给中文，没收录的原样露出 IANA 名', () => {
  assert.equal(tzLabel(SH), '北京')
  assert.equal(tzLabel(NY), '纽约')
  // ★宁可露出英文,不可猜错地名★
  assert.equal(tzLabel('Africa/Nairobi'), 'Africa/Nairobi')
})

test('⑩ shiftToTz：给布局用的平移 Date，本地取值器读出来是目标时区的墙上时间', () => {
  const t = '2026-08-12T23:00:00Z'              // 北京时间 8/13 07:00
  const s = shiftToTz(t, SH)
  assert.equal(s.getDate(), 13)                  // ★布局要据此把它摆进 13 号那一列★
  assert.equal(s.getHours(), 7)
  assert.equal(s.getMinutes(), 0)
})

test('★⑪ 日历格「今天」不能拿 sameDayIn 判★ —— 实测撞到过，整体错一天', () => {
  // 现场:此刻 2026-08-12T08:53Z(北京 16:53、纽约 04:53)—— ★两边都是 8/12★。
  const now = new Date('2026-08-12T08:53:00Z')
  // 日历里 8/12 那一格,是用「浏览器本地那天零点」的 Date 表示的(浏览器=北京时 → 08-11T16:00Z)。
  // ★它不是一个瞬时,是一个格子的名字。★
  const 格8月12 = new Date(2026, 7, 12)
  const 格8月13 = new Date(2026, 7, 13)

  // 正确判据:格子的 Y/M/D 对上「此刻在我的时区里是几号」
  assert.equal(isTodayCell(格8月12, 'America/New_York', now), true)
  assert.equal(isTodayCell(格8月13, 'America/New_York', now), false)
  assert.equal(isTodayCell(格8月12, 'Asia/Shanghai', now), true)

  // ⚠ 用 sameDayIn 会怎样:它把格子当瞬时再投影 → 8/12 那格在纽约变成 8/11,于是判否;
  //   而 8/13 那格反倒判真 —— ★「今天」的高亮整体后移一格,且不报任何错。★
  assert.equal(sameDayIn(格8月12, now, 'America/New_York'), false)   // 错在这
  assert.equal(sameDayIn(格8月13, now, 'America/New_York'), true)    // 也错在这
})

test('★⑫ E1：选择器里那串数字按**活动时区**解释，不是按浏览器★', () => {
  // 场景:人在浏览器本地时区(测试机是北京),给「北京」的会排 8/12 15:00
  const 选中 = new Date(2026, 7, 12, 15, 0)          // 选择器给出的就是这组数字
  assert.equal(pickedToUtc(选中, 'Asia/Shanghai').toISOString(), '2026-08-12T07:00:00.000Z')
  // ★同样一串数字,说它是纽约时间,得到的是完全不同的瞬时★——差 12 小时
  assert.equal(pickedToUtc(选中, 'America/New_York').toISOString(), '2026-08-12T19:00:00.000Z')
  // 伦敦(夏令时 UTC+1)
  assert.equal(pickedToUtc(选中, 'Europe/London').toISOString(), '2026-08-12T14:00:00.000Z')
})

test('⑬ E1 往返：存下去再打开「改时间」，数字必须一模一样', () => {
  // ★不做逆变换的话,一打开编辑框就把时间挪走了,而人只是想改个标题★
  for (const tz of ['Asia/Shanghai', 'America/New_York', 'Europe/London', 'Australia/Sydney']) {
    const 选中 = new Date(2026, 7, 12, 15, 30)
    const 存 = pickedToUtc(选中, tz)
    const 回 = utcToPicked(存, tz)
    assert.equal(回.getHours(), 15, `${tz} 小时漂了`)
    assert.equal(回.getMinutes(), 30, `${tz} 分钟漂了`)
    assert.equal(回.getDate(), 12, `${tz} 日期漂了`)
  }
})
