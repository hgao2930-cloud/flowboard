import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = new URL(env.VITE_WS_URL || 'ws://127.0.0.1:3000')
  backend.protocol = backend.protocol === 'wss:' ? 'https:' : 'http:'
  return {
    base: mode === 'production' ? '/flowboard/' : '/',
    plugins: [vue(), vueDevTools()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: { '/api': { target: backend.origin, changeOrigin: true } },
    },
  }
})
