import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // maplibre-gl 的 Web Worker 依赖 import.meta.url 解析同目录文件，
    // 预打包会丢失该相对路径；排除后由浏览器原生 ESM 加载。
    exclude: ['maplibre-gl'],
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
