import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // maplibre-gl 的 Web Worker 依赖 import.meta.url 解析同目录文件，
    // 预打包会丢失该相对路径；排除后由浏览器原生 ESM 加载。
    exclude: ['maplibre-gl'],
  },
  build: {
    // 地图 / 图表 / 后台均为路由级动态 import，保持各自独立 chunk，
    // 不进入首屏；额外 manualChunks 会把动态边界合并进父 chunk，故不启用。
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
