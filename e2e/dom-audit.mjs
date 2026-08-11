#!/usr/bin/env node
// ★结构巡查:能由浏览器精确判定的,一律不要问 VL 模型★(2026-08-12)。
// 起因是拿 VL 满页「找问题」,它把间距审美当缺陷报、还编出三条不存在的
// (月视图标签缺底色/文字截断/元素重叠),逐条对 DOM 一验全假。
// 反过来它**读字很准**(整页 1520px 也能一字不差念出 12px 正文)。
// 所以分工:截断/压盖/出屏/空文本这些量得出来的归这里,VL 只答它独有的那类。
import { chromium } from 'playwright'
const BASE = process.env.CONGROVE_BASE ?? 'http://localhost:5181'
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1520, height: 1000 },
  extraHTTPHeaders: { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY ?? '', 'X-IAH-E2E-User': 'liaoruili' } })
const p = await ctx.newPage()

const AUDIT = () => {
  const vis = (e) => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 }
  const leaves = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() && vis(e))
  const out = { 截断: [], 出屏: [], 压盖: [], 空按钮: [], 文本: [] }
  for (const e of leaves) {
    const s = getComputedStyle(e), r = e.getBoundingClientRect()
    const t = (e.innerText || '').trim()
    out.文本.push(t)
    if (s.overflowX !== 'auto' && s.overflowX !== 'scroll' && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
      out.截断.push({ t: t.slice(0, 30), 可视: e.clientWidth, 内容: e.scrollWidth, 省略号: s.textOverflow === 'ellipsis' })
    if (r.width > 0 && (r.right > innerWidth + 2 || r.left < -2)) out.出屏.push({ t: t.slice(0, 30), 左: Math.round(r.left), 右: Math.round(r.right) })
  }
  // 按钮有没有可点却没标签的(纯图标不算,有 aria-label/title 就算有名字)
  for (const e of document.querySelectorAll('button')) {
    if (!vis(e)) continue
    if (!(e.innerText || '').trim() && !e.getAttribute('aria-label') && !e.getAttribute('title')
        && !e.querySelector('[aria-label],svg,img,.anticon')) out.空按钮.push(e.outerHTML.slice(0, 70))
  }
  // 同层兄弟互相压盖(只看有文字的叶子,同一父节点内两两求交)
  const byParent = new Map()
  for (const e of leaves) { const k = e.parentElement; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(e) }
  for (const [, sib] of byParent) for (let i = 0; i < sib.length; i++) for (let j = i + 1; j < sib.length; j++) {
    const a = sib[i].getBoundingClientRect(), c = sib[j].getBoundingClientRect()
    if (a.width && c.width && a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1)
      out.压盖.push([sib[i].innerText.trim().slice(0, 20), sib[j].innerText.trim().slice(0, 20)])
  }
  return out
}

const 视图 = [
  ['日程-周', async () => {}],
  ['日程-月', async () => { await p.locator('.ant-segmented-item', { hasText: /^月$/ }).first().click(); await p.waitForTimeout(1500) }],
  ['日程-列表', async () => { await p.locator('.ant-segmented-item', { hasText: /^列表$/ }).first().click(); await p.waitForTimeout(1500) }],
  ['活动-我参与的', async () => { await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1600) }],
  ['活动-我发起的', async () => { await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1200); await p.locator('.ant-segmented-item', { hasText: /^我发起的$/ }).first().click(); await p.waitForTimeout(1400) }],
  ['活动-已结束', async () => { await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1200); await p.locator('.ant-segmented-item', { hasText: /^已结束$/ }).first().click(); await p.waitForTimeout(1400) }],
  ['活动详情', async () => { await p.getByText('活动', { exact: true }).first().click(); await p.waitForTimeout(1200); await p.locator('.ant-segmented-item', { hasText: /^已结束$/ }).first().click(); await p.waitForTimeout(1300); await p.getByText('八月第二次组会', { exact: false }).first().click(); await p.waitForTimeout(1800) }],
  ['发起活动', async () => { await p.getByRole('button', { name: /发起活动/ }).first().click(); await p.waitForTimeout(2000) }],
  ['项目-未选', async () => { await p.getByText('项目', { exact: true }).first().click(); await p.waitForTimeout(1600) }],
  ['项目-文档', async () => { await p.getByText('项目', { exact: true }).first().click(); await p.waitForTimeout(1200); await p.getByText('课题组·计量经济学', { exact: false }).first().click(); await p.waitForTimeout(1800) }],
  ['个人面板', async () => { await p.locator('.ant-avatar').first().click(); await p.waitForTimeout(700); await p.locator('.ant-dropdown-menu-item', { hasText: /^个人面板$/ }).first().click(); await p.waitForTimeout(1800) }],
  ['我的活动类型', async () => { await p.locator('.ant-avatar').first().click(); await p.waitForTimeout(700); await p.locator('.ant-dropdown-menu-item', { hasText: /^我的活动类型$/ }).first().click(); await p.waitForTimeout(1800) }],
]
const 全部文本 = {}
for (const [名, go] of 视图) {
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2400)
  try { await go() } catch (e) { console.log(`⚠ ${名}: 走不到 —— ${e.message.split('\n')[0].slice(0, 60)}`); continue }
  const r = await p.evaluate(AUDIT)
  全部文本[名] = r.文本
  const 问题 = ['截断', '出屏', '压盖', '空按钮'].filter(k => r[k].length)
  if (!问题.length) { console.log(`✓ ${名}  (${r.文本.length} 个文本节点,无结构问题)`); continue }
  console.log(`★ ${名}`)
  for (const k of 问题) console.log(`   ${k}(${r[k].length}): ${JSON.stringify(r[k].slice(0, 4))}`)
}
const { writeFileSync } = await import('node:fs')
writeFileSync(process.env.TEXTOUT ?? '/tmp/ui-text.json', JSON.stringify(全部文本, null, 1))
console.log('\n各视图文本已存 ' + (process.env.TEXTOUT ?? '/tmp/ui-text.json'))
await b.close()
