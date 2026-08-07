// 探查页面上的真实控件 —— ★别拿记忆当事实★:上一版 spec 就是照着我以为的文案写的,
// 结果「新建项目」实际叫「新建」。
import { chromium } from '@playwright/test'
const BASE = 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const b = await chromium.launch()
const ctx = await b.newContext({ extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY }, viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const dump = async (label) => {
  await page.waitForTimeout(1200)
  const btns = await page.getByRole('button').allInnerTexts()
  const ph = await page.locator('input[placeholder],textarea[placeholder]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('placeholder')))
  const tabs = await page.getByRole('tab').allInnerTexts()
  console.log(`\n== ${label} ==`)
  console.log('按钮:', JSON.stringify(btns.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)))
  console.log('输入框:', JSON.stringify(ph))
  if (tabs.length) console.log('tab:', JSON.stringify(tabs))
}
await page.goto(BASE + '/'); await dump('日程页')
await page.getByText('项目', { exact: true }).first().click(); await dump('项目页')
await page.getByRole('button', { name: /新\s*建/ }).first().click(); await dump('新建项目弹窗')
await page.keyboard.press('Escape')
await page.getByText('日程', { exact: true }).first().click(); await page.waitForTimeout(600)
await page.getByRole('button', { name: /发起会议/ }).click(); await dump('发起会议页')
await b.close()
