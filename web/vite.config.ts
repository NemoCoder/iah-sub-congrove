// vite dev :5180(strictPort,和别的子系统错开),/api /auth /healthz 代理到后端 :8030。
// 生产不走这:后端 ServeDir 同源托管 web/dist(单镜像单端口契约)。
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// ★可以把后端指到 dev 环境★(2026-08-12):改前端样式时本地起不了后端
// (要 PG/S3/OIDC 一整套注入 env),于是只能改完部署才看得见 —— 一轮十几分钟。
// 指到 dev 后 `pnpm dev` 就能立刻看真数据。E2E 头由下面的 configure 补,
// ⚠★钥匙从环境变量读,不写进仓库★。
const backend = process.env.CONGROVE_BACKEND ?? 'http://localhost:8030'
const e2eKey = process.env.IAH_E2E_KEY
const proxyOpts = {
  target: backend,
  changeOrigin: true,
  secure: false,                                  // 内网自签 CA
  configure: e2eKey ? (proxy: { on: (e: string, cb: (p: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
    proxy.on('proxyReq', (p) => {
      p.setHeader('X-IAH-E2E-Key', e2eKey)
      p.setHeader('X-IAH-E2E-User', process.env.IAH_E2E_USER ?? 'liaoruili')
    })
  } : undefined,
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/api': proxyOpts,
      '/auth': proxyOpts,
      '/healthz': proxyOpts,
      '/readyz': proxyOpts,
    },
  },
})
