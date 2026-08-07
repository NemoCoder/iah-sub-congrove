// 截 v0.5 原型的各视图 —— ★自己画完必须自己看★(记忆:verify-against-design-not-just-code)
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
const OUT = '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/_prototype-v0.5'
mkdirSync(OUT, { recursive: true })
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
await p.goto('file:///iah101/iah_k8s_platform/iah_sub/congrove/docs/prototype-v0.5.html')
const shot = async (id, name) => {
  await p.evaluate((i) => window.go(i, null), id)
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${OUT}/${name}.png` })
  console.log('✓', name)
}
await shot('cal', '1-日程')
await shot('new1', '2-新建活动-会议')
await shot('new2', '3-新建活动-读文献')
await shot('act', '4-我的活动类型')
await shot('mat', '5-我的活动材料')
await shot('proj', '6-设置')
await b.close()
