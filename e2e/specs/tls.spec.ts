// ★证书链单独验一次★ —— 补上 `ignoreHTTPSErrors: true` 吞掉的那部分。
//
// 全套 Playwright 跑在 .14 的有头浏览器上（liaoruili 2026-08-13 定），而那台机器的浏览器
// 没装内网 CA、我也没有它的 SSH 权限，只能在浏览器侧忽略证书错误。
// ⚠★但「忽略」不等于「不验」★：ui.spec 的头注写得很清楚 ——
//   `ignoreHTTPSErrors` 会把「证书**真的**错了」和「证书是内网 CA 签的」一起吞掉。
//   所以那部分挪到这里，用 **Node 侧的严格 TLS** 验：
//   `NODE_EXTRA_CA_CERTS` 只加了内网 CA，其余校验（有效期 / 域名 / 链完整）一条不放。
//   ★证书哪天真过期或换错，这条会红，而浏览器那边照旧安静。★
import { expect, request as pwRequest, test } from '@playwright/test'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'

test('★证书链在严格校验下也过得去★（补 ignoreHTTPSErrors 吞掉的那一半）', async () => {
  // ★不带 ignoreHTTPSErrors 新开一个 context★：默认就是严格校验。
  // 它走 Node 的 TLS 栈，吃 NODE_EXTRA_CA_CERTS —— 内网 CA 认，别的一律不认。
  const 严格 = await pwRequest.newContext({ baseURL: BASE })
  try {
    const r = await 严格.get('/healthz', { headers: process.env.IAH_E2E_KEY
      ? { 'X-IAH-E2E-Key': process.env.IAH_E2E_KEY } : {} })
    // 200 或 302(未带 key 时网关跳登录)都算「TLS 这一层没问题」——
    // ★这条验的是证书,不是鉴权★，别把两件事混在一个断言里。
    expect([200, 302, 401, 403], `★严格 TLS 下拿不到响应 = 证书链有问题：${r.status()}★`)
      .toContain(r.status())
  } finally { await 严格.dispose() }
})
