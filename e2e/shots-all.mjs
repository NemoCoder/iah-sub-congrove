#!/usr/bin/env node
// ★把全部页面走一遍并截图★ —— 给 VL 模型看用（配 see.mjs）。
//
// 默认走 .14 上的**有头**浏览器（liaoruili 能看着我操作）；
// 连不上时自动退回本机 headless —— ★截图这件事本来就不依赖有头★，
// 有头只是为了让人看见。别把「工具坏了」和「这件事做不了」混为一谈。
//
// ⚠ 换网后那台测试机的地址变过一次 —— ★所以端点不写在仓库里★(见 pw-endpoint.mjs)。端点路径已钉死为
//   /congrove（不钉的话 Playwright 每次启动随机生成 token，服务一重启客户端就失效）。
//
// 用法：IAH_E2E_KEY=$(cat ~/.config/iah/congrove-e2e-key) node e2e/shots-all.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { pwWs } from './pw-endpoint.mjs'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
if (!KEY) { console.error('缺 IAH_E2E_KEY'); process.exit(2) }
const VER = process.env.SHOT_VER ?? 'latest'
const DIR = `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${VER}`
mkdirSync(DIR, { recursive: true })

const WS = pwWs()
const b = await chromium.connect(WS, { timeout: 12000 }).catch(async (e) => {
  console.log(`（连不上有头浏览器：${e.message.split('\n')[0].slice(0, 60)} → 退回本机 headless）`)
  return chromium.launch({ headless: true })
})
const ctx = await b.newContext({
  viewport: { width: 1520, height: 1000 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': 'liaoruili' },
})
const p = await ctx.newPage()
const errs = []
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)) })
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 120)))

const shots = []
/// 截一张。★整页截（fullPage）★：视口截只能看见第一屏，
/// 而「下面还堆着几百条历史」这种问题恰恰在第一屏之外。
async function shot(name, note = '') {
  const file = `${DIR}/${name}.png`
  await p.screenshot({ path: file, fullPage: true })
  const txt = (await p.locator('body').innerText()).replace(/\n+/g, ' | ')
  shots.push({ name, note, chars: txt.length })
  console.log(`  ✓ ${name}${note ? '  (' + note + ')' : ''}`)
}
/// 点一个可见文字并等它稳定。找不到就**说出来**，别静默跳过 ——
/// 静默跳过会让「这一页没截到」看起来像「这一页没问题」。
async function click(text, exact = true) {
  const el = p.getByText(text, { exact }).first()
  if (!(await el.count())) { console.log(`  ⚠ 点不到「${text}」——跳过它后面的截图`); return false }
  await el.click({ timeout: 6000 }).catch(() => {})
  await p.waitForTimeout(1600)
  return true
}

await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(3000)

console.log('── 日程 ──')
await shot('01-日程-周视图')
if (await p.locator('.ant-segmented-item', { hasText: /^月$/ }).first().click({ timeout: 5000 }).then(() => true, () => false)) {
  await p.waitForTimeout(1800); await shot('02-日程-月视图')
}
if (await p.locator('.ant-segmented-item', { hasText: /^列表$/ }).first().click({ timeout: 5000 }).then(() => true, () => false)) {
  await p.waitForTimeout(1800); await shot('03-日程-列表')
}
await p.locator('.ant-segmented-item', { hasText: /^周$/ }).first().click({ timeout: 5000 }).catch(() => {})
await p.waitForTimeout(1200)

console.log('── 活动 ──')
if (await click('活动')) {
  await shot('04-活动-我参与的')
  for (const [tab, n] of [['我发起的', '05-活动-我发起的'], ['已结束', '06-活动-已结束']]) {
    if (await p.locator('.ant-segmented-item', { hasText: new RegExp(`^${tab}$`) }).first()
      .click({ timeout: 5000 }).then(() => true, () => false)) { await p.waitForTimeout(1600); await shot(n) }
  }
  // 进一条活动的详情 + 它的几个 tab。
  // ⚠★从「已结束」tab 进★：种子里那几场有材料/纪要的会都开完了，
  //   而「我参与的」现在只列即将进行的（2026-08-11 改的），从那里点不到 ——
  //   ★脚本第一次跑就撞上了我自己刚改的行为，这反倒证明它生效了。★
  await p.locator('.ant-segmented-item', { hasText: /^已结束$/ }).first().click().catch(() => {})
  await p.waitForTimeout(1500)
  if (await click('八月第二次组会', false)) {
    await shot('07-活动详情')
    for (const [t, n] of [['材料', '08-详情-材料'], ['录制', '09-详情-录制'], ['纪要', '10-详情-纪要']]) {
      if (await click(t)) await shot(n)
    }
  }
}

console.log('── 发起活动表单 ──')
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2000)
if (await p.getByRole('button', { name: /发起活动/ }).first().click({ timeout: 6000 }).then(() => true, () => false)) {
  await p.waitForTimeout(2000); await shot('11-发起活动')
}

console.log('── 项目 ──')
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2000)
if (await click('项目')) {
  await shot('12-项目-未选')
  if (await click('我的活动材料')) await shot('13-项目-我的活动材料只读')
  if (await click('课题组·计量经济学')) {
    await shot('14-项目-文档')
    for (const [t, n] of [['成员', '15-项目-成员'], ['活动', '16-项目-活动'],
      ['回收站', '17-项目-回收站'], ['设置', '17b-项目-设置']]) {
      if (await click(t)) await shot(n)
    }
  }
}

console.log('── 我的 ──')
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2000)
for (const entry of ['liaoruili', '我的']) {
  if (await click(entry, false)) { await shot('18-我的'); break }
}

console.log(`\n★共 ${shots.length} 张 → ${DIR}★`)
console.log('控制台报错:', errs.length ? errs.slice(0, 6) : '无 ✓')
await ctx.close(); await b.close()
