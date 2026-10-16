# `web/vite.config.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

前端开发服务器与生产构建的 Vite 配置：显式固定 `root` 为 `web/`、接入 React 插件、设定开发端口与 `/api` 代理、并开启构建前清空输出目录。

## 结构说明

```ts
/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: { emptyOutDir: true },
});
```

| 层级 | 键 | 值 | 说明 |
| --- | --- | --- | --- |
| 顶部 | `/// <reference types="node" />` | — | 让编辑器在无 tsconfig 上下文时也能识别 `node:url` |
| 顶部 | `webRoot` | `fileURLToPath(new URL('.', import.meta.url))` | 由本文件 URL 推出的 `web/` **绝对路径**，末尾带分隔符 |
| 顶层 | `root` | `webRoot` | 项目根目录（Vite 解析 `index.html` 与静态资源的基准） |
| 顶层 | `plugins` | `[react()]` | `@vitejs/plugin-react`：JSX 转换 + 开发期 Fast Refresh |
| `server` | `port` | `5273` | 开发服务器端口 |
| `server` | `strictPort` | `true` | 端口被占用时**直接失败**，不自动换端口 |
| `server.proxy` | `'/api'` | `target: 'http://127.0.0.1:8787'` | 开发期把 `/api*` 转发到本机后端 |
| `server.proxy` | `'/api'` | `changeOrigin: false` | **保持原始 `Host` 头**（见下节） |
| `build` | `emptyOutDir` | `true` | 构建前清空输出目录 |

### 没有配置的键

| 未出现的键 | 实际行为 |
| --- | --- |
| `build.outDir` | 保持默认 `dist`，因为 `root` 已是 `web/`，最终产物落在 **`web/dist`** |
| `server.host` | 默认只监听 localhost，符合「管理面只在本机可达」的取向 |
| `base` | 默认 `'/'`，与后端 `@fastify/static` 的 `prefix: '/'` 对齐 |
| `resolve.alias` | 未设别名，导入一律用相对路径 |

## 关键选项与坑

### `root` 为什么必须显式指定

启动命令是**项目根目录**下的 `vite --config web/vite.config.ts`（见 `package.json` 的 `web:dev` / `web:build`）。Vite 对「配置文件所在目录」的处理是取**其父级**作为默认 root —— 也就是会得到项目根目录，而不是 `web/`。后果：

- 入口解析错位：会去项目根找 `index.html`（不存在），dev server 与 build 都无法正确建立入口；
- 资源 URL 基准错位：`/src/main.tsx` 会被解析到 `<repo>/src/main.tsx`（那是**后端**目录）；
- `outDir` 错位：默认 `dist` 会相对错误的 root 解析成 `<repo>/dist`，而不是后端期望的 `web/dist`（`src/config.ts` 的 `webRoot` 默认值就是 `<PROJECT_ROOT>/web/dist`）。

用 `fileURLToPath(new URL('.', import.meta.url))` 而非 `path.resolve(__dirname)` 是因为本文件在 ESM 下运行（根 `package.json` 为 `type: module`），没有 `__dirname`。

### `outDir` 如何落到 `web/dist`

**本文件不写 `build.outDir`**，靠的是 `root: webRoot` + Vite 默认 `dist` 的组合：`outDir` 相对 `root` 解析 → `web/dist`。

因此 `root` 与 `build.outDir` 是**耦合的**：如果哪天把 `outDir` 显式写成 `'dist'` 却同时去掉了 `root`（或把 root 改成项目根），产物就会落到 `<repo>/dist`，而后端默认仍去读 `web/dist`——界面 404，且 `npm run lint` 不会提醒（`web/tsconfig.json` 与产物路径无关）。Docker 构建里 `COPY --from=web /app/web/dist ./web/dist` 同样会随之失效。

### `changeOrigin: false` 为什么不能改成 `true`

后端 `src/app.ts` 有 **Host 头白名单**：只接受回环主机名，非回环 Host 会被拒绝并记录告警。`changeOrigin: true` 会把 `Host` 改写成代理目标的主机——虽然目标本身就是 `127.0.0.1`，两者在这一具体取值下通常等价，但把 `true` 当作“随手开的兼容选项”会在改动 `target` 时立刻触发后端拒绝。当前配置的取向是：**代理不修改任何请求头**，保证开发期行为与直连一致。

### `strictPort: true`

端口被占用时 Vite 直接退出，而不是静默换到 5274。这是刻意的：文档与操作习惯里 5273 是固定值，静默漂移会让人对着错误的地址排查。代价是并行起多个 dev server 需要先解决占用。

### `emptyOutDir: true` 与 `web/index.html` 里注释的关系

源码注释写的是「outDir 保持默认（web/dist），构建前清空避免残留旧 chunk」。Vite 在 outDir 位于 root 内时本就会清空，显式写出是为了把这条行为固化——否则一旦将来把 outDir 指到 root 之外，Vite 会改为**拒绝清空并警告**，残留旧 chunk 会被后端一起静态托管。

### 与 `vitest.config.ts` 的边界

本文件只服务前端构建/开发；`npm test` 用的是根目录 `vitest.config.ts`，其 `include` 限定 `test/**`，**不会**因为本文件的 `root` 而把 `web/src` 卷进测试。两者互不读取。

## 引用方

- `npm run web:dev`（`vite --config web/vite.config.ts`）与 `npm run web:build`（同前缀 + `build`）。
- `npm run build`（`web:build` 的别名）。
- `deploy/Dockerfile` 的 `web` 阶段：`COPY web ./web` 后执行 `npm run web:build`，产物 `web/dist` 再拷进运行时阶段。
- `web/tsconfig.json` 的 `include` 把本文件纳入类型检查（不参与构建）。
