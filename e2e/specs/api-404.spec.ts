// ★不存在的 /api 路径必须 404,不能回 SPA 首页★（2026-09-05）。
//
// 撞上的经过：我猜了一个不存在的 `GET /api/activities/{id}/minutes.pdf`（真实入口是
// 「POST 生成 item → 按 item 下载」两步），curl 回的是 **HTTP 200 + text/html** ——
// 差点当成「接口在、只是内容不对」去查生成逻辑。
//
// 根因是 axum 的 `nest`：`/api` 这一层没匹配上的路径会一路掉到**外层 fallback**，
// 而外层兜底是给前端路由用的 `index.html`。
//
// ★为什么这值得一条用例守着★：它把「错误」表达成了「成功」——
//   · 前端 `res.ok` 为真却拿到一坨 HTML，`res.json()` 抛的是 JSON 解析错，
//     人会去查解析而不是查「这个接口根本不存在」；
//   · 接口被删掉或改名时不报 404 反而「成功」，★任何按 404 率做的监控都看不见它★。
// 这和本仓 2026-08-13 那次「响应体从数组改成对象、八道门禁一道没红」是同一族：
// 判据被抹平之后，所有守卫一起失明。
import { expect, test } from '@playwright/test'

test.skip(!process.env.IAH_E2E_KEY, '没配 IAH_E2E_KEY,跳过(见 README)')

// ⚠★别只测一条★:只测一条的话,「/api 这一层被兜住了」和「恰好这一条被显式注册成 404」
//   分不开。取三种形状:顶层不存在、已有前缀下不存在、带后缀像文件名的。
const 不存在的路径 = [
  '/api/完全不存在的接口',
  '/api/me/xxx',
  '/api/activities/1/nope',
  '/api/activities/1/minutes.pdf',   // ★就是这一条把我骗了★
]

test('不存在的 /api 路径回 404 且是 JSON,不是 SPA 首页', async ({ request }) => {
  for (const p of 不存在的路径) {
    const r = await request.get(p)
    expect(r.status(), `${p} 应当 404`).toBe(404)
    // ★光看状态码不够★:要的是「它走了 API 的错误通道」,而不是别处凑巧也返回了 404。
    // 判据取 content-type + 响应体形状 —— 与其余所有 404 完全一致的 `{"error":"not found"}`。
    expect(r.headers()['content-type'] ?? '', `${p} 不该是 HTML`).toContain('application/json')
    expect(await r.json(), `${p} 的响应体形状要和别的 404 一致`).toHaveProperty('error')
  }
})

// ★反向断言★:真实存在的接口必须照常 200 —— 否则一个「把 /api 全判 404」的
// 实现也能让上面那条全绿,而那是把功能整个关掉。
test('真实存在的接口不受影响', async ({ request }) => {
  const r = await request.get('/api/me')
  expect(r.status()).toBe(200)
  expect(await r.json()).toHaveProperty('username')
})
