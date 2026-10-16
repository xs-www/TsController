# `tsconfig.json`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

后端（`src/`、`test/`、`scripts/`）与项目级 TS 配置的编译选项：只做类型检查、不产出任何构建产物，选项集围绕「Node 原生类型擦除」这一运行时前提配齐。

## 结构说明

### `compilerOptions`

| 选项 | 值 | 说明 |
| --- | --- | --- |
| `target` | `ES2023` | 输出/语法目标；因为没有 emit，实际作用是限定可用的新语法与内置库 |
| `lib` | `["ES2023"]` | **故意不含 DOM**：后端若误用 `fetch` 之外的浏览器全局（`window`/`document`）应编译失败 |
| `module` | `NodeNext` | Node 的 ESM/CJS 解析规则 |
| `moduleResolution` | `NodeNext` | 与 `module` 配套；决定了必须写显式扩展名 |
| `types` | `["node"]` | 只加载 `@types/node`，不自动囊括 `node_modules/@types` 下的其他全局类型 |
| `strict` | `true` | 严格模式总开关 |
| `noUncheckedIndexedAccess` | `true` | `arr[i]`、`obj[k]` 结果类型带 `undefined`；索引访问必须先判空 |
| `noImplicitOverride` | `true` | 子类覆盖基类成员必须写 `override` |
| `exactOptionalPropertyTypes` | `false` | **有意关闭**：可选属性允许显式传 `undefined`，否则与现有 `?:` 调用点、Fastify/Zod 类型摩擦 |
| `verbatimModuleSyntax` | `true` | 类型导入必须写成 `import type`，保证擦除时导入语句可被整条删除 |
| `isolatedModules` | `true` | 每个文件必须能被独立转译（单文件擦除的前提） |
| `erasableSyntaxOnly` | `true` | **禁止不可擦除语法**：`enum`、`namespace` 运行时变体、构造函数参数属性等。这条直接对应 `node src/main.ts` 的可行性 |
| `allowImportingTsExtensions` | `true` | 允许 `import './x.ts'`；配合 `noEmit` 使用（Node 原生运行要求写真实扩展名） |
| `noEmit` | `true` | 类型检查器绝不写文件；`lint` 脚本仍显式加 `--noEmit` 兜底 |
| `skipLibCheck` | `true` | 跳过 `node_modules` 内 `.d.ts` 的相互检查，换取检查速度 |
| `forceConsistentCasingInFileNames` | `true` | 大小写敏感校验；跨 Windows/Linux（Docker 是 Linux）时避免 `Foo.ts` / `foo.ts` 类失误 |
| `resolveJsonModule` | `true` | 允许 `import x from './x.json'` |

### `include`

```json
["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"]
```

| 条目 | 为什么在这里 |
| --- | --- |
| `src/**/*.ts` | 后端全部源码 |
| `test/**/*.ts` | 测试与 `fakes.ts` 也参与类型检查，避免测试代码静默腐烂 |
| `scripts/**/*.ts` | 三个验证脚本（`verify-live` / `verify-security` / `clean-verify`） |
| `vitest.config.ts` | 根级配置本身也在检查范围内；`vitest.config.ts` 与 `web/` 无关，故不进 `web/tsconfig.json` |

**注意**：`web/**` 完全不在本配置范围内，前端由 `web/tsconfig.json` 单独检查（`lint` 脚本依次跑两遍）。

### 看起来能改但改了会坏的值

| 值 | 改动的后果 |
| --- | --- |
| `erasableSyntaxOnly: true` | 关掉后可以写 `enum`/参数属性，但 `node src/main.ts` 会在运行时直接抛错——编译期护栏消失，问题推迟到启动 |
| `allowImportingTsExtensions` + `moduleResolution: NodeNext` | 去掉前者则源码里的 `./x.ts` 导入全部报错；改成 `bundler` 会让 Node 实际运行时的解析与类型检查结果不一致 |
| `verbatimModuleSyntax` / `isolatedModules` | 关闭会允许“值导入与类型导入混写”，擦除后残留的导入可能指向不存在的运行时导出 |
| `lib` 加入 `"DOM"` | 后端可误用浏览器 API 而编译通过，等价于放弃一层防线 |
| `noUncheckedIndexedAccess` | 关闭后索引访问不再带 `undefined`，`src/domain`、`src/mappings` 中大量显式判空会被视为多余并可能被删掉 |
| 把 `web/**` 加进 `include` | 前端是 `jsx: react-jsx` + DOM lib，与本配置冲突，会产生大量无关报错 |

## 引用方

- `npm run lint` → `tsc -p tsconfig.json --noEmit`（`package.json`）。
- `npm test` → Vitest 运行时并不读 tsconfig 的 `include`，但根的 `vitest.config.ts` 被本配置纳入检查。
- 编辑器 / TS 语言服务：`src/**`、`test/**`、`scripts/**` 下文件按本配置做实时诊断。
- CI（`.github/workflows/docker-publish.yml` 的 `verify` job）经 `npm run lint` 间接依赖。
- `deploy/Dockerfile` 的 `web` 阶段 `COPY tsconfig.json ./`：前端构建时 Vite 不读它，但保持构建上下文与本地一致。
