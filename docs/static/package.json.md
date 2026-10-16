# `package.json`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

本项目唯一的 Node 包清单：声明包身份、ESM 模块类型、Node 版本下限、全部 npm 脚本入口，以及后端运行时依赖与前端/测试开发依赖。

## 结构说明

### 顶层字段

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `name` | `tscontroller` | 包名（与容器镜像名 `tscontroller:local` 一致，但两者无强制耦合） |
| `version` | `0.1.0` | 包版本；镜像的 `semver` 标签来自 git tag，不读这里 |
| `private` | `true` | 禁止 `npm publish`；本包只用于本地运行、构建与测试 |
| `description` | `本机 tailnet ↔ Docker 端口路由控制器（tailscale serve 控制面）` | 一句话定位 |
| `type` | `module` | **全仓库 ESM**。所有 `.ts`/`.js` 均按 ESM 解析，因此源码内必须写 `import ... from './x.ts'`；改成 `commonjs` 会让 `src/**` 的裸 `import` 与 `node src/main.ts` 直接崩 |
| `engines.node` | `>=22.18.0` | 硬性下限，见下节 |

### `engines.node` 为什么是硬要求

`start`/`dev`/`verify:*` 都是直接用 `node` 跑 `.ts` 源文件，**没有编译步骤**：

- `start: node src/main.ts`
- `dev: node --watch src/main.ts`
- `verify:live` / `verify:security` / `clean:verify`: `node scripts/*.ts`

这依赖 Node 22.18+ 的**原生 TypeScript 类型擦除**（直接执行 `.ts`）。低于该版本时 Node 不认识 `.ts`，脚本会立即失败。`tsconfig.json` 的 `erasableSyntaxOnly: true` 是与这条运行时约束配套的编译期护栏（禁止 `enum`、参数属性等不可擦除语法）。

因此这个值**不能为了兼容旧环境而下调**，否则“零构建运行后端”的整个设计前提就失效；`deploy/Dockerfile` 里还有一段等价的启动期自检（`node -e` 校验主次版本 ≥ 22.18）。

### `scripts`

| 脚本 | 命令 | 实际做了什么 | 什么时候跑 |
| --- | --- | --- | --- |
| `start` | `node src/main.ts` | 直接以 Node 原生类型擦除启动后端控制面 | 生产/日常运行（构建产物 `web/dist` 需已存在，否则管理界面无静态资源） |
| `dev` | `node --watch src/main.ts` | 同上，但 `--watch` 监听源码变化自动重启进程 | 改后端时用；**进程重启会重跑启动收敛**，不适合在真实环境频繁触发 |
| `lint` | `tsc -p tsconfig.json --noEmit && tsc -p web/tsconfig.json --noEmit` | 依次对**后端配置**与**前端配置**各做一次纯类型检查，都不产出文件；前者失败则后者不执行 | 提交前、CI 的 `verify` job。注意它是 `&&`，不是并行 |
| `test` | `vitest run` | 以 `vitest.config.ts` 为准跑一遍全部单测/API 测试后退出 | 提交前、CI 的 `verify` job |
| `test:watch` | `vitest` | 同上，进入 watch 交互模式 | 本地改测试或改被测代码时 |
| `web:dev` | `vite --config web/vite.config.ts` | 启动前端 dev server（端口 5273，`strictPort`），`/api` 代理到 `127.0.0.1:8787` | 改前端界面时；需要后端 `start` 同时在跑 |
| `web:build` | `vite build --config web/vite.config.ts` | 构建前端到 `web/dist`（先清空旧产物） | 前端改动后、部署前；`Dockerfile` 的 `web` 阶段与 CI 都依赖它 |
| `build` | `npm run web:build` | 只是 `web:build` 的别名（后端无需构建） | 习惯性敲 `npm run build` 时 |
| `verify:live` | `node scripts/verify-live.ts` | 对**真实运行中的**服务做端到端探活验证 | 部署后人工验证；会读写真实映射，别在无关环境乱跑 |
| `verify:security` | `node scripts/verify-security.ts` | 验证安全约束（回环绑定、Host 白名单、暴露判定等） | 安全相关改动后、上线前 |
| `verify:docs` | `node scripts/verify-docs.ts` | 静态文档的四重校验（数量 / 结构 / 覆盖 / 格式） | 改了源码或文档后；不通过时退出码 1 |
| `docs:stats` | `node scripts/verify-docs.ts --stats` | 同上，并把统计表写回 `docs/static/README.md` 的 STATS 标记区 | 文档批量更新后刷新索引统计 |
| `clean:verify` | `node scripts/clean-verify.ts` | 清理验证过程留下的残留（镜像/容器/预约等） | 验证脚本跑完后收尾 |

### `dependencies`（运行时）

| 依赖 | 版本约束 | 用途 |
| --- | --- | --- |
| `@fastify/static` | `^8.0.4` | 由 `src/app.ts` 注册，把 `config.webRoot`（默认 `<PROJECT_ROOT>/web/dist`）作为管理界面静态资源 |
| `fastify` | `^5.2.1` | HTTP 服务主体；`@fastify/static` 8.x 与之同一大版本线 |
| `zod` | `^3.24.1` | 运行期外部输入校验（持久化文件、CLI JSON 等） |

### `devDependencies`（仅开发/构建/测试）

| 依赖 | 版本约束 | 用途 |
| --- | --- | --- |
| `@types/node` | `^22.10.5` | Node 类型，与 `tsconfig.json` 的 `types: ["node"]` 对应 |
| `@types/react`、`@types/react-dom` | `^19.0.7` / `^19.0.3` | React 19 类型 |
| `@vitejs/plugin-react` | `^4.3.4` | `web/vite.config.ts` 的 JSX/Fast Refresh 插件 |
| `react`、`react-dom` | `^19.0.0` | 前端框架；放在 `devDependencies` 是因为前端只经 Vite 打包进 `web/dist`，Node 运行时不需要它们 |
| `typescript` | `^5.7.3` | `lint` 脚本与编辑器。注意：`tsconfig.json` 用到的 `erasableSyntaxOnly` 是较新版本才有的编译选项，而本文件声明的是 `^5.7.3`；`^` 允许安装更高的小版本，实际解析结果以 `package-lock.json` 为准 |
| `vite` | `^6.0.7` | 前端 dev server 与构建 |
| `vitest` | `^2.1.8` | 测试运行器，读 `vitest.config.ts` |

### 看起来能改但改了会坏的值

| 值 | 改动的后果 |
| --- | --- |
| `type: "module"` | 改回 `commonjs` → 源码里的 ESM `import` 与 `node src/main.ts` 全部失效 |
| `engines.node: ">=22.18.0"` | 下调 → 原生类型擦除不可用，`start`/`dev`/`verify:*` 全部启动失败；`Dockerfile` 的启动自检也会拦下 |
| `@fastify/static` 的 `^8.x` | 降到 7.x 会与 `fastify` 5.x 不兼容，静态资源注册阶段报错 |
| `react`/`react-dom` 挪进 `dependencies` | 镜像 `npm ci --omit=dev` 会多装一份运行期不需要的前端框架，镜像无谓变大 |
| `lint` 里的 `&&` | 改成 `;` 或拆成两条会让「后端类型错但前端仍报绿」的假通过成为可能 |

## 引用方

- **npm / Node**：读取 `type`、`engines`、`scripts`；`npm ci` 依 `dependencies` / `devDependencies`（版本解析以 `package-lock.json` 为准）安装。
- **`deploy/Dockerfile`**：两个阶段都 `COPY package.json package-lock.json` 后执行 `npm ci`；运行时阶段用 `--omit=dev` 只装 `dependencies`，并执行 `npm run web:build`（构建阶段）。
- **`.github/workflows/docker-publish.yml`**：`actions/setup-node` 与 `cache: npm` 依赖本文件与 `package-lock.json`；`verify` job 直接调用 `npm run lint` 与 `npm test`。
- **`tsconfig.json` / `web/tsconfig.json` / `vitest.config.ts`**：不直接读本文件，但 `lint`、`test`、`web:build` 三个脚本是它们实际生效的入口。
