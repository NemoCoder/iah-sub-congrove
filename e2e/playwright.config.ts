// congrove 的 Playwright 配置。★凭证一律走 env,不写进这个文件★(它在仓库容器里)。
//
// 两个环境前提,缺一个就跑不起来:
//   1. ★内网自签 CA★:*.ruciah.com 全是内网 CA 签的,不装 CA 会 TLS 失败。
//      走 NODE_EXTRA_CA_CERTS 指到 CA 文件(见 run.sh),★不要用 ignoreHTTPSErrors 图省事★——
//      那会把「证书错了」和「证书是内网 CA 签的」一起吞掉,真出问题时看不见。
//   2. ★E2E key★:env IAH_E2E_KEY。带上它,dev 网关跳过 SSO 三道(平台 registry v1.3.80)。
//      没有它,所有请求会 302 到 Keycloak —— 下面的 gate.spec 专门验这件事,所以它**不该**依赖 key。
import { defineConfig } from '@playwright/test'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY ?? ''

export default defineConfig({
  testDir: './specs',
  // ★跑完必清测试数据★:不加这个,dev 的项目列表会被历次 E2E 造的项目淹没
  // (2026-08-07 实测堆到 80+ 个,真实项目根本找不到)。
  // teardown 用**前缀扫描**而不是记账 —— 崩溃/超时/中断时记账会漏,而漏的正是失败那轮。
  globalTeardown: './teardown.ts',
  // 内网 + 单机跑,并发开小一点;失败重跑一次(网关偶发抖动不该算 red)
  workers: 2,
  retries: 1,
  // ★产物统一落 unit_tests/congrove/screenshots★(2026-08-07 用户要求):
  // 「截图不要都放到 ~ 以及很多脚本也放到 ~ 家目录,每次我都要清理」——
  // 失败截图/trace 也是截图,同样不该散落在仓库里。
  // ⚠ 与 shot.mjs 的 `<版本号>/` 归档目录**分开放**:那些是**成品**的存档、要留;
  //   这里是**排查**用的即时产物,下一次跑就作废,所以不按版本分、可随时整个删。
  reporter: [['list'], ['html', {
    outputFolder: '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/_e2e-report', open: 'never',
  }]],
  use: {
    baseURL: BASE,
    // ★key 为空时不要注入空 header★:Traefik 的路由规则按 `HeadersRegexp(X-IAH-E2E-Key, .+)` 匹配,
    // 空值匹配不上等于没带,但显式发一个空头容易让人误判「带了却没生效」。
    extraHTTPHeaders: KEY ? { 'X-IAH-E2E-Key': KEY } : {},
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'retain-on-failure',
  },
  outputDir: '/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/_e2e-failures',
})
