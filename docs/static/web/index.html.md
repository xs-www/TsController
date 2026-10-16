# `web/index.html`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

前端管理界面的 HTML 入口模板：提供挂载点 `<div id="root">` 并引入 `web/src/main.tsx`，同时规定语言、视口、Referrer 策略与页面标题。

## 结构说明

| 行 | 内容 | 作用 |
| --- | --- | --- |
| `<!doctype html>` | — | 标准 HTML5 文档声明 |
| `<html lang="zh-CN">` | `lang="zh-CN"` | 界面文案为中文，影响字体选择与朗读器发音 |
| `<meta charset="UTF-8" />` | 编码 | 无 BOM 的 UTF-8；Vite 构建时原样保留 |
| `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` | 视口 | 移动端/窄窗口下按设备宽度渲染，不缩放 |
| `<meta name="referrer" content="no-referrer" />` | Referrer 策略 | **安全相关**：管理界面自身的路径不会作为 `Referer` 泄漏给任何外部目标；与后端「只在回环可达」的约束同一取向 |
| `<title>TsController · tailnet 端口路由控制台</title>` | 标题 | 浏览器标签页与历史记录中的名称 |
| `<div id="root"></div>` | 挂载点 | React 应用的根节点；`id` 必须与 `web/src/main.tsx` 中的挂载选择器一致 |
| `<script type="module" src="/src/main.tsx"></script>` | 入口脚本 | `type="module"` 是 ESM 必需；`/src/main.tsx` 是**根相对**路径 |

### 入口路径 `/src/main.tsx` 为什么带前导斜杠

`web/vite.config.ts` 把 `root` 显式设为 `web/` 的绝对路径，因此开发期该 URL 解析到 `<repo>/web/src/main.tsx`。构建时 Vite 会把它改写为带哈希的产物引用（从 `web/dist/index.html` 加载），所以这里写的是**源码路径**，不要手改成 `./src/main.tsx` 或 `web/src/main.tsx`。

### 构建后的形态

生产环境由后端读取 `config.webRoot`（默认 `<repo>/web/dist`）经 `@fastify/static` 以 `prefix: '/'` 提供，因此 `web/dist/index.html` 是管理界面的实际首屏。**不要手写 `<script>` 指向 `web/src/**` 的原始路径**——那条路径只在 dev server 下存在。

### 看起来能改但改了会坏的值

| 值 | 改动的后果 |
| --- | --- |
| `id="root"` | 与 `web/src/main.tsx` 的挂载目标不一致时，页面白屏（React 找不到容器） |
| `src="/src/main.tsx"` | 改成相对路径或加 `web/` 前缀 → dev server 404，构建入口也丢失 |
| `referrer: no-referrer` | 去掉后从本页跳转到任何外部链接都会带上管理界面 URL 作为 `Referer` |
| `type="module"` | 去掉会退化为经典脚本，模块化导入与 Vite 的 dev 注入失效 |

## 引用方

- **`web/vite.config.ts`**：其 `root` 指向 `web/`，Vite 以本文件为 HTML 入口（`vite build` 的输出目录为 `web/dist`）。
- **`web/src/main.tsx`**：由本文件以 `<script type="module">` 引入，反过来由它查找 `#root`。
- **后端 `src/app.ts`**：不读本文件，但通过 `@fastify/static` 把构建后的 `web/dist/index.html` 作为 `/` 的静态资源返回。
- **`deploy/Dockerfile`**：`COPY web ./web` 后执行 `npm run web:build`，本文件是构建输入之一。
