# `web/tsconfig.json`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

前端（`web/src/**`，含 `.tsx`）与 `web/vite.config.ts` 的独立 TypeScript 配置：启用 JSX 与 DOM 类型、按打包器规则解析模块，同样只检查不产出。

## 结构说明

### `compilerOptions`

| 选项 | 值 | 说明 |
| --- | --- | --- |
| `target` | `ES2022` | 前端语法目标（与后端 `ES2023` 不同，浏览器兼容面更宽） |
| `lib` | `["ES2022", "DOM", "DOM.Iterable"]` | **含 DOM**：React 组件需要 `document`、`window`、事件类型；`DOM.Iterable` 让 `NodeList` 等可迭代 |
| `module` | `ESNext` | 交给打包器处理的 ESM，不做 Node 式解析 |
| `moduleResolution` | `bundler` | 打包器解析：允许无扩展名导入、允许 `exports` 映射；**这是与后端 `NodeNext` 的关键差异** |
| `jsx` | `react-jsx` | 新版 JSX 运行时：`.tsx` 无需 `import React`，由 `react/jsx-runtime` 提供 |
| `strict` | `true` | 严格模式总开关 |
| `noUncheckedIndexedAccess` | `true` | 索引访问结果带 `undefined`，与后端保持一致 |
| `noEmit` | `true` | 只做类型检查；真正的产物由 Vite 输出到 `web/dist` |
| `skipLibCheck` | `true` | 跳过依赖 `.d.ts` 互检，缩短检查时间 |
| `isolatedModules` | `true` | 每个文件必须可独立转译，与 Vite/esbuild 的逐文件转换模型一致 |
| `verbatimModuleSyntax` | `true` | 类型导入必须写 `import type`，避免打包出无用导入 |
| `allowImportingTsExtensions` | `true` | 允许 `import './x.ts'`（本项目源码即此风格）；因 `noEmit` 为真而合法 |
| `forceConsistentCasingInFileNames` | `true` | 大小写一致性校验，避免 Windows 本地通过、Linux 构建失败 |
| `types` | `["node"]` | 显式只加载 Node 类型；`web/vite.config.ts` 里用到 `node:url`，需要它 |

### 与 `tsconfig.json`（后端）的差异一览

| 项 | 后端 `tsconfig.json` | 本文件 |
| --- | --- | --- |
| `lib` | `["ES2023"]`（无 DOM） | `["ES2022", "DOM", "DOM.Iterable"]` |
| `module` / `moduleResolution` | `NodeNext` / `NodeNext` | `ESNext` / `bundler` |
| `jsx` | 未设 | `react-jsx` |
| `erasableSyntaxOnly` | `true` | 未设 |
| `resolveJsonModule` | `true` | 未设 |
| `exactOptionalPropertyTypes` / `noImplicitOverride` | 显式设置 | 未设（走默认） |

### `include`

```json
["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
```

**路径是相对本文件所在目录（`web/`）解析的**，所以 `src/**` 指的是 `web/src/**`。`vite.config.ts` 也在这里被检查（后端 `tsconfig.json` 的 `include` 不含它，两边不重叠）。

### 看起来能改但改了会坏的值

| 值 | 改动的后果 |
| --- | --- |
| `jsx: "react-jsx"` | 改成 `react` 则每个 `.tsx` 都要显式 `import React`，现有组件全部报错 |
| `moduleResolution: "bundler"` | 改成 `NodeNext` 后 `@vitejs/plugin-react` 等包的 `exports` 解析方式改变，且相对导入需补扩展名 |
| `include` 的 `vite.config.ts` | 移出后 `web/vite.config.ts` 不再被任何 tsconfig 覆盖，`npm run lint` 会漏检它 |
| `types: ["node"]` | 删掉后 `vite.config.ts` 的 `import { fileURLToPath } from 'node:url'` 失去类型 |
| `lib` 去掉 DOM | React 组件与事件处理器全面报错 |

## 引用方

- `npm run lint` → `tsc -p web/tsconfig.json --noEmit`（`package.json`，`lint` 的第二段）。
- 编辑器/TS 语言服务对 `web/src/**` 与 `web/vite.config.ts` 的诊断。
- `web/vite.config.ts`、`web/src/**` 的构建由 Vite 执行（esbuild 逐文件转换），本文件不参与产物生成，只约束类型。
- CI 的 `verify` job 经 `npm run lint` 间接依赖。
