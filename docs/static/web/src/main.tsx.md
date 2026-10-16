# `web/src/main.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

前端入口：取 `#root` 容器、交给 `createRoot(...).render(<StrictMode><App /></StrictMode>)` 挂载。本文件不含任何业务逻辑，**唯一职责是把 `<App />` 放进 StrictMode**——StrictMode 正是 `App.tsx` 必须处理「挂载两次」的直接原因。

## 依赖 / 引用

- 外部模块：`react` 的 `StrictMode`；`react-dom/client` 的 `createRoot`。
- 同项目文件：`./App` 的 `App` 组件（样式与全部子组件都由 `App.tsx` 间接引入）。
- 被引用：`web/index.html` 第 11 行 `<script type="module" src="/src/main.tsx"></script>`；`index.html` 提供 `<div id="root"></div>` 与 `<html lang="zh-CN">`。

## 函数清单

本文件**没有任何函数 / 组件定义**（源文件函数数 = 0）：只有 `container` 常量、一个 `if` 守卫和一次 `createRoot(...).render(...)` 顶层调用。下面「函数详情」只登记这段顶层挂载语句，用于说明它的边界行为。

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| （无） | — | — | 本文件不含函数或组件定义 | 全部逻辑由 3 条顶层语句承担 |

## 函数详情

### 顶层挂载语句（本文件无函数定义）

- **签名**：不适用（模块级副作用，脚本一旦被加载即执行一次）。
- **入参**：无（`#root` 来自 `index.html` 的 DOM，不是参数）。
- **出参**：不适用；`createRoot(...).render(...)` 的返回值为 `void`（React 19 的 `render` 不再返回组件实例）。
- **功能**：三步——
  1. `const container = document.getElementById('root')`；
  2. 守卫：`container === null` 时 `throw new Error('页面缺少 #root 容器，无法挂载 TsController 管理界面')`；
  3. `createRoot(container).render(<StrictMode><App /></StrictMode>)`。
- **边缘条件**：
  - `#root` 缺失（例如后端静态服务返回了被改写的 HTML）→ **模块加载期直接抛错**，页面停在白屏并在控制台留下可检索的中文错误，不会静默失败；正因为有这个守卫，`container` 的类型才能收窄为 `HTMLElement` 交给 `createRoot`；
  - `StrictMode` 在开发构建下会「挂载 → 卸载 → 再挂载」子树，`App.tsx` 因此必须遵守「每次挂载新建 `AbortController` 并写入 ref」的约定（详见 `web/src/App.tsx.md`）；生产构建不双挂载，该约定依然成立；
  - 本文件**不引入任何样式表**：`./styles.css` 由 `App.tsx` 第 38 行副作用式引入，Vite 负责注入；
  - 只有一次 `render` 调用，不做 `hydrate`、不做热更新钩子；模块被重复加载（例如被另一个入口再次 `import`）时不会重复挂载，因为它是副作用模块而非可复用的导出——当前项目只有 `index.html` 一个消费方。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `container` | `HTMLElement` | `#root` DOM 节点 | 由 `document.getElementById` 取得；为 `null` 时在上一行抛错，因此后续代码中它恒非空 |
| （无 props） | — | `App` 不接收任何属性 | `<App />` 是唯一用法 |

## 待办与隐患

- [ ] 无 TODO 标记。已知取舍：挂载前不做任何能力探测（例如 `window.__DSH_BOOT__` 之类的外部引导数据），所有运行时信息都通过 `/api/*` 同源相对路径获取；也**没有错误边界**——`App` 子树渲染期抛错会冒泡到根，页面白屏（唯一的防线是 `App.tsx` 中大量的可选链与 `??` 兜底）。
