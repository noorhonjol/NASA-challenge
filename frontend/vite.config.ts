import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import type { PluginOption } from 'vite'
import { defineConfig } from 'vitest/config'

// Only /api is proxied to the backend; everything else stays with Vite.
// API_PROXY_TARGET exists so the proxy can point at another port when 8000
// is taken locally; the default matches the documented backend port.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

// vite-plugin-cesium's ESM default export is not seen as callable by TS 7.
const cesiumPlugin = cesium as unknown as () => PluginOption

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cesiumPlugin()],
  server: {
    proxy: {
      '/api': apiTarget,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
