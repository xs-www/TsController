/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 前端构建配置。
 *
 * 启动命令是项目根目录下的 `vite --config web/vite.config.ts`，此时 Vite 默认会把
 * root 解析成「配置文件所在目录」的父级（即项目根），前端资源路径与 outDir 都会错位，
 * 所以这里显式把 root 固定为 web/ 的绝对路径。
 */
const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    // 管理面只监听回环地址，开发时的 /api 全部转发给本机后端。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    // outDir 保持默认（web/dist），构建前清空避免残留旧 chunk。
    emptyOutDir: true,
  },
});
