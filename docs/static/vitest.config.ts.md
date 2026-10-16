# `vitest.config.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

测试运行器的单个配置文件：把测试文件限定在 `test/**/*.test.ts`、运行环境固定为 Node，并指定报告器；它是 `npm test` / `npm run test:watch` 的唯一配置来源。

## 结构说明

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
```

| 层级 | 键 | 值 | 含义 |
| --- | --- | --- | --- |
| 顶层 | — | `defineConfig`（来自 `vitest/config`） | 只用于类型推断的恒等函数；导入路径必须是 `vitest/config` 而不是 `vite`，否则 `test` 字段无类型 |
| `test` | `include` | `['test/**/*.test.ts']` | 唯一的测试发现规则 |
| `test` | `environment` | `'node'` | 不注入 jsdom/happy-dom，测试直接跑在 Node 里（后端测试需要真实 `node:fs`/`node:http` 语义） |
| `test` | `reporters` | `['default']` | 使用默认报告器；等价于不写，写出来是为了显式锁死（CI 日志格式稳定） |

### 没有配置的东西（同样重要）

| 未出现的键 | 后果 / 原因 |
| --- | --- |
| `test.exclude` | 走 Vitest 默认排除（`node_modules`、`dist` 等）。因为 `include` 已经是绝对受限的 `test/**`，再补 `exclude` 是冗余的 |
| `test.root` | 默认为配置文件所在目录（项目根）。**不需要设**，因为 `include` 用根相对路径书写 |
| `test.globals` | 未开启，所以测试文件必须显式 `import { describe, it, expect } from 'vitest'` |
| `plugins` / `resolve` | 后端测试不需要 JSX 转换或路径别名，保持最小配置 |
| `coverage` | 未配置覆盖率，`npm test` 不产生覆盖率报告 |

## 关键选项与坑

### `include: ['test/**/*.test.ts']` 为什么必须写死

- 若删掉 `include`，Vitest 默认会扫描整个项目，命中 `web/src/**`（如 `web/src/api.test.ts` 之类）与 `node_modules` 邻域模式，把**前端**测试一起算进来。前端测试需要 DOM/JSX 环境，而这里 `environment: 'node'`，结果是「配置正确但报错一堆」，很容易被误判成后端回归。
- 当前的 `test/**` 限定同时保证了 `test/fakes.ts`（测试替身，非 `*.test.ts`）不会被当成测试文件收集。
- `include` 的路径是**相对项目根**（`vitest.config.ts` 所在目录）解析的，与 `vitest` 命令的 `cwd` 无关；这也是不需要设 `test.root` 的原因。
- **改了会坏的典型情形**：把 `include` 放宽成 `['**/*.test.ts']` 或 `['test/**/*.ts']`。前者会把 `web/` 下的测试拉进来（环境不匹配），后者会把 `fakes.ts` 当测试文件收集（通常得到「无测试的测试文件」错误）。

### `environment: 'node'` 为什么不能换成 `jsdom`

测试对象是 Fastify 应用、Docker/Tailscale 客户端与纯函数（`route-path`、`reconcile`、`serve-config`），断言依赖真实的 Node 原生模块与 `127.0.0.1` 回环 HTTP。换成浏览器模拟环境既无收益，还会让 `node:fs`、`node:http`、Unix socket 相关行为失真。

### `reporters: ['default']` 的意义

值等于默认值，属于「显式固定」。它不改变行为，但让配置文件完整表达了「CI 上要看到什么格式」，避免以后有人无意中把默认值改掉导致 CI 日志解析失效。

### 与 `tsconfig.json` 的关系

`vitest.config.ts` 自身被 `tsconfig.json` 的 `include` 覆盖（也在 `npm run lint` 的检查范围内）；反过来 Vitest **不读** `tsconfig.json` 的 `include`/`exclude`——测试范围完全由本文件的 `include` 决定。两处不要试图互相同步。

## 引用方

- `npm test`（`vitest run`）与 `npm run test:watch`（`vitest`）自动加载项目根的 `vitest.config.ts`。
- `.github/workflows/docker-publish.yml` 的 `verify` job 经 `npm test` 间接使用。
- `tsconfig.json` 把本文件纳入类型检查（`include` 的最后一项）。
