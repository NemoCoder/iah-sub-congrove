// vite dev :5180(strictPort,和别的子系统错开),/api /auth /healthz 代理到后端 :8030。
// 生产不走这:后端 ServeDir 同源托管 web/dist(单镜像单端口契约)。
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = 'http://localhost:8030'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/healthz': backend,
      '/readyz': backend,
    },
  },
})
