#!/usr/bin/env node
// ★补 shots-all.mjs 漏掉的页面★ —— 漏的原因各不相同,都值得记下来:
//   · 用户菜单那四页藏在**用户名下拉**里,不是主导航 —— 我按「点文字」找了半天当然找不到。
//   · 「材料」「录制」两个 tab 的**标签带计数**(「材料 1」),`exact:true` 匹配不上。
//   · 项目的「回收站」「设置」同理。
// ★「点不到」和「不存在」必须分开报★ —— 静默跳过会让漏截看起来像没问题。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { pwWs } from './pw-endpoint.mjs'
const BASE = 'https://congrove-dev.sub.ruciah.com'
const DIR = `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${process.env.SHOT_VER ?? 'latest'}`
mkdirSync(DIR, { recursive: true })
const b = await chromium.connect(pwWs(), { timeout: 12000 })
  .catch(() => chromium.launch({ headless: true }))
const ctx = await b.newContext({ viewport: { width: 1520, height: 1000 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY, 'X-IAH-E2E-User': 'liaoruili' } })
const p = await ctx.newPage()
const errs = []; p.on('console', m => m.type() === 'error' && errs.push(m.text().slice(0, 100)))
const shot = async (n) => { await p.screenshot({ path: `${DIR}/${n}.png`, fullPage: true }); console.log('  ✓ ' + n) }
const home = async () => { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500) }

console.log('── 用户菜单四页 ──')
for (const [label, name] of [['个人面板','20-我的-个人面板'],['我的分享','21-我的-分享'],
  ['我的活动类型','22-我的-活动类型'],['开发者','23-我的-开发者']]) {
  await home()
  // ⚠ 下拉的触发器是**头像**;按 `header button` + 用户名文字找过,点不开(按钮结构套了几层)
  await p.locator('.ant-avatar').first().click({ timeout: 6000 }).catch(() => {})
  await p.waitForTimeout(700)
  const it = p.locator('.ant-dropdown-menu-item', { hasText: new RegExp('^' + label + '$') }).first()
  if (!(await it.count())) { console.log(`  ⚠ 菜单里没有「${label}」`); continue }
  await it.click(); await p.waitForTimeout(1800); await shot(name)
}

console.log('── 活动详情的材料/录制(标签带计数) ──')
await home()
await p.getByText('活动', { exact: true }).first().click().catch(() => {}); await p.waitForTimeout(1500)
await p.locator('.ant-segmented-item', { hasText: /^已结束$/ }).first().click().catch(() => {}); await p.waitForTimeout(1500)
await p.getByText('八月第二次组会', { exact: false }).first().click().catch(() => {}); await p.waitForTimeout(2000)
for (const [re, n] of [[/^材料/, '08-详情-材料'], [/^录制/, '09-详情-录制']]) {
  const t = p.locator('.ant-tabs-tab', { hasText: re }).first()
  if (!(await t.count())) { console.log(`  ⚠ 找不到 tab ${re}`); continue }
  await t.click(); await p.waitForTimeout(1600); await shot(n)
}

console.log('── 项目的回收站/设置 ──')
await home()
await p.getByText('项目', { exact: true }).first().click().catch(() => {}); await p.waitForTimeout(1500)
await p.getByText('课题组·计量经济学', { exact: false }).first().click().catch(() => {}); await p.waitForTimeout(1800)
// ⚠★「回收站」是**抽屉**不是 tab★ —— 我按 tab 找了两轮都报「找不到」,
//   差点当成「这个功能没做」。项目详情只有四个 tab:文档/成员/活动/设置。
const t = p.locator('.ant-tabs-tab', { hasText: /^设置/ }).first()
if (await t.count()) { await t.click(); await p.waitForTimeout(1600); await shot('17b-项目-设置') }
const trash = p.getByRole('button', { name: /^回收站$/ }).first()
if (!(await trash.count())) console.log('  ⚠ 找不到「回收站」按钮')
else { await trash.click(); await p.waitForTimeout(1800); await shot('17-项目-回收站(抽屉)') }

// ★量准折叠条★:VL 说它「文字与展开按钮重叠、还遮住日期」。
// 目测靠不住,量 bounding box —— 相邻子元素右边界 > 下一个左边界才叫重叠。
console.log('── 折叠条实测 ──')
await home()
console.log(JSON.stringify(await p.evaluate(() => {
  const bar = [...document.querySelectorAll('div,span')]
    .filter(x => (x.innerText || '').includes('凌晨这一段有活动被折叠'))
    .sort((a, b) => a.innerText.length - b.innerText.length)[0]
  if (!bar) return { 找到: false }
  const r = bar.getBoundingClientRect()
  const kids = [...bar.querySelectorAll('*')].filter(c => c.children.length === 0 && c.innerText?.trim())
    .map(c => { const k = c.getBoundingClientRect(); return { 文字: c.innerText.trim().slice(0, 16), 左: Math.round(k.left), 右: Math.round(k.right), 上: Math.round(k.top), 下: Math.round(k.bottom) } })
  let 重叠 = []
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const a = kids[i], c = kids[j]
    if (a.左 < c.右 && c.左 < a.右 && a.上 < c.下 && c.上 < a.下) 重叠.push([a.文字, c.文字])
  }
  return { 条: { 左: Math.round(r.left), 右: Math.round(r.right), 高: Math.round(r.height) }, 子元素: kids, 重叠 }
}), null, 1))
console.log('\n控制台报错:', errs.length ? errs.slice(0, 5) : '无 ✓')
await ctx.close(); await b.close()
