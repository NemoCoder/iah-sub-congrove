// ★每条界面用例跑完都留一张全页图★（2026-08-14 liaoruili:「目前文件夹里面只有弹窗提醒」）。
//
// ══ 为什么要有这个 ══
// 他早就定过规矩:「截图必须要全部放下来！！！慢没问题,核心是我怕你漏掉」、
// 「★脚本跑完必须人逐张看截图★」—— 理由是**只有眼睛能看出「页面安安静静显示错东西」**:
// 断言只认它被写下来的那几件事,而「安静地显示错东西」不在任何断言里。
//
// 而此前 29 条界面用例里**只有提醒弹窗那一条留了图**,其余 28 条跑完什么也不留 ——
// ★用例绿了,而他看不到界面长什么样★,等于又把人排除在验证之外。
//
// ⚠ 两个刻意的选择:
// ① ★全页 fullPage★:视口截图会把长页面切掉下半截,而「下半截长什么样」正是他上次
//    发现问题的地方(24 条转移请求把页面拉到滚不完)。切掉 = 漏掉。
// ② ★纯接口用例不留空白图★:混着写的 spec 里,afterEach 拿 `page` 会**现建**一个空白页,
//    留下来就是一堆 about:blank 的白图 —— 那不是证据,是噪音,而且会淹掉真正要看的那几张。
import { test } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'

/// ★版本从 `web/src/version.ts` 现读,别写死★(2026-08-14 踩过:硬编码成 v0.4.145,
/// 于是版本一直涨而截图永远堆在 145 下,★而它看起来完全正常——图确实生成了★)。
export function 版本(): string {
  try {
    const src = readFileSync(new URL('../../web/src/version.ts', import.meta.url), 'utf8')
    return /VERSION\s*=\s*'([^']+)'/.exec(src)?.[1] ?? 'unknown'
  } catch { return 'unknown' }
}

export function 截图目录(子: string): string {
  const d = `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${版本()}/${子}`
  mkdirSync(d, { recursive: true })
  return d
}

/// 在 spec 顶层调一次,这个文件里**每条用到浏览器的用例**跑完都会留一张全页图。
export function 每条都留图(子目录: string) {
  test.afterEach(async ({ page }, info) => {
    try {
      if (!page || page.isClosed()) return
      const u = page.url()
      if (!u || u.startsWith('about:')) return          // 纯接口用例:没开过页面
      const 名 = `${info.title}`.replace(/[\/\s]+/g, '_').replace(/[^\w一-龥.-]/g, '').slice(0, 60)
      const 记 = info.status === 'passed' ? '' : `-${info.status}`
      // ⚠★给截图单独设短超时,而且要短★（2026-08-14 它把一条用例弄红了）:
      //   `afterEach` **共用那条用例的时间预算**。提醒弹窗那条本来就要等两轮 60 秒轮询、
      //   耗掉大半个 300 秒,截图再一挤就整条超时 —— 报的是
      //   「Test timeout … while running "afterEach" hook」,★产品和判据都没问题,
      //   是我加的**证据收集**把用例拖红了★。
      //   下面那个 catch 只挡得住**异常**,挡不住**超时**(超时是 Playwright 掐的,不走 catch)。
      // ★证据不该有能力弄红判据★ —— 截不出来就不截,绝不为一张图牺牲一条判据。
      await page.screenshot({ path: `${截图目录(子目录)}/${名}${记}.png`, fullPage: true, timeout: 8000 })
    } catch { /* 截图失败绝不能把用例本身弄红 —— 它是证据,不是判据 */ }
  })
}
