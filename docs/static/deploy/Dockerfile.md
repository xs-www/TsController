# `deploy/Dockerfile`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

TsController 的容器镜像定义：一个**两阶段**构建（`web` 构建前端 → `runtime` 装生产依赖并直接运行 `src/main.ts`），后端不需要编译步骤。

> 源码文件头明确写着：**本文件未在真实 Linux/NAS 上构建验证过，只依据平台行为编写**。

## 结构说明

### 头部约定

| 项 | 值 | 说明 |
| --- | --- | --- |
| `# syntax=docker/dockerfile:1` | Dockerfile 前端语法 | 启用 BuildKit 语法特性 |
| 构建上下文 | **仓库根目录**，不是 `deploy/` | 因此命令为 `docker build -f deploy/Dockerfile .`，compose 里写 `context: ..` |
| 构建参数 | 无 `ARG` / `--build-arg` | 镜像不含任何构建期可变开关，所有差异走运行期环境变量 |

### 阶段一：`web`（构建前端）

| 步骤 | 指令 | 作用 / 为什么这么写 |
| --- | --- | --- |
| 基础镜像 | `FROM node:22-bookworm-slim AS web` | Node 22 满足 `engines.node >= 22.18.0`；bookworm-slim 体积小且是 glibc |
| 工作目录 | `WORKDIR /app` | 后续相对路径的基准 |
| 依赖层 | `COPY package.json package-lock.json ./` | **先只拷清单**，让 `npm ci` 这一层可缓存；源码变动不会导致重装依赖 |
| 安装 | `RUN npm ci` | 装**全部**依赖（含 devDependencies，构建前端需要 vite/react/typescript） |
| 配置 | `COPY tsconfig.json ./` | 与本地检查环境保持一致；Vite 构建本身不读它 |
| 源码 | `COPY web ./web` | 只拷前端目录（后端源码对构建前端无用） |
| 构建 | `RUN npm run web:build` | 等价 `vite build --config web/vite.config.ts`，产物落 `/app/web/dist` |

### 阶段二：`runtime`

| 步骤 | 指令 | 作用 / 为什么这么写 |
| --- | --- | --- |
| 基础镜像 | `FROM node:22-bookworm-slim AS runtime` | 与构建阶段同一镜像。**选 Debian(glibc) 而非 Alpine(musl)**：宿主上的 tailscale 二进制会被 bind-mount 进来，glibc 版本兼容性最好，避免 `cannot execute binary file` |
| 工作目录 | `WORKDIR /app` | 生产容器内的应用根 |
| 环境 | `ENV NODE_ENV=production` | 运行期语义标记 |
| 依赖 | `COPY package.json package-lock.json ./` + `RUN npm ci --omit=dev` | 只装 `dependencies`（fastify / @fastify/static / zod），前端框架不进运行镜像 |
| **版本自检** | `node -e "...process.versions.node..."` | 与 `npm ci` 同一条 `RUN`：若主版本 < 22 或 (22 且次版本 < 18) 则 `console.error` + `process.exit(1)`，即**镜像自身构建失败**。理由与 `engines.node` 完全一致：后端靠 Node 原生 TypeScript 类型擦除直接跑 `.ts` |
| 后端源码 | `COPY src ./src` | 直接运行，**不需要编译产物** |
| 运维脚本 | `COPY scripts ./scripts` | 让容器内可手动执行验证/清理脚本 |
| 前端产物 | `COPY --from=web /app/web/dist ./web/dist` | 只从前一阶段取构建结果，运行镜像里没有 `web/node_modules` |
| 数据卷声明 | `VOLUME ["/data"]` | 声明数据目录。注释强调必须在 compose 里挂卷并把 `TSCONTROLLER_DATA_DIR` 指向它，否则映射库落在容器可写层，**容器一重建就丢** |
| 端口声明 | `EXPOSE 8787` | 仅文档性声明；实际能否被访问取决于 `network_mode: host`（见 `deploy/docker-compose.yml`） |
| 启动命令 | `CMD ["node", "src/main.ts"]` | exec form，PID 1 就是 node，信号可直接送达 |

### 镜像布局摘要

```text
/app/
├── package.json, package-lock.json
├── node_modules/            ← npm ci --omit=dev
├── src/                     ← 后端源码（.ts，直接运行）
├── scripts/                 ← 运维脚本
└── web/dist/                ← 前端构建产物（来自 web 阶段）
/data/                       ← VOLUME，映射库 / 审计日志 / 快照
```

### 关键点：`EXPOSE 8787` 与「只绑回环」

`EXPOSE` 只是元数据，**不代表端口能被 publish**。本应用硬性拒绝绑定非回环地址且没有绕过开关，所以 `ports:` 映射在 `docker-compose.yml` 里是被明确否定的做法（容器内必须 bind `0.0.0.0` 才能被 publish，会被应用拒绝并直接退出）。注释里指向 `deploy/docker-compose.yml` 的 `network_mode: host` 正是为此。

### 看起来能改但改了会坏的值

| 值 | 改动的后果 |
| --- | --- |
| `node:22-bookworm-slim` → `node:22-alpine` | musl 环境下 bind-mount 进来的宿主 glibc tailscale 二进制无法执行（`cannot execute binary file`） |
| `CMD ["node", "src/main.ts"]` | 改成编译后再跑（如 `tsc && node dist/main.js`）与全仓库设计前提冲突：`tsconfig.json` 是 `noEmit`，且源码用 `.ts` 扩展名互相导入 |
| `npm ci --omit=dev` | 去掉 `--omit=dev` 会让前端框架进运行镜像；反向若在 `web` 阶段也加 `--omit=dev`，`vite`/`react` 缺失导致构建失败 |
| 删除版本自检 `node -e` | 基础镜像将来若被换成 < 22.18 的 Node，问题会推迟到容器启动时才暴露，且报错信息更晦涩 |
| `COPY web ./web` 不排除 `web/dist` | 镜像会带上本机构建产物；`.dockerignore` 已排除 `web/dist`，但若去掉该行则上下文膨胀 |
| 构建上下文改成 `deploy/` | 所有 `COPY package.json` / `COPY src` 路径失效——`Dockerfile` 依赖上下文是仓库根 |

## 引用方

- **`deploy/docker-compose.yml`**：`build.context: ..` + `build.dockerfile: deploy/Dockerfile`，镜像名 `tscontroller:local`。
- **`.github/workflows/docker-publish.yml`**：`docker/build-push-action@v6` 使用 `context: .` 与 `file: deploy/Dockerfile`，只构建 `linux/amd64`。
- **`.dockerignore`**：过滤进入本文件构建上下文的内容（排除 `node_modules`、`data`、`docs`、`test`、`web/dist` 等）。
- **`docs/nas-deployment.md`**：部署说明中引用本文件与其中的数据卷注意事项（本文档不重复其内容）。
