# `src/runtime.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

依赖装配。把「读环境变量 → 构造真实实现」集中在这里；测试与验证脚本则各自注入替身（`RuntimeOverrides`），因此**端到端验证脚本与单测共用同一套装配逻辑**。

本文件是「哪些实现是可替换的」这份清单的唯一出处。

## 依赖 / 引用

- `node:fs/promises`（建数据目录）。
- `./config.ts`、`./logger.ts`、`./docker/docker-client.ts`（`DockerEngineClient`、`DockerTransport`）、`./docker/docker-service.ts`（`DockerContainerService`、`ContainerSource`）、`./tailscale/tailscale-cli.ts`（`ExecFileRunner`、`TailscaleCli`、`CommandRunner`）、`./tailscale/tailscale-service.ts`（`TailscaleServeGateway`、`ServeGateway`）、`./mappings/store.ts`（`FileMappingStore`、`FileAuditLog`、`AuditLog`、`MappingStore`）、`./mappings/mapping-service.ts`（`MappingService`）、`./snapshot.ts`（`FileSnapshotWriter`、`SnapshotWriter`）、`./app.ts`（`buildApp`）。
- `fastify` 的 `FastifyInstance` 类型。
- 被 `src/main.ts` 与 `scripts/verify-*.ts` 调用；`test/**` 不直接用（它们自行拼装 `MappingService`）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `createRuntime` | `(overrides?: RuntimeOverrides) => Promise<Runtime>` | `Promise<Runtime>` | 装配完整运行时（含 Fastify 实例，**尚未 listen**） | 每个依赖都可被 `overrides` 替换；会 `mkdir -p` 数据目录 |

## 函数详情

### `createRuntime(overrides?)`

- **签名**：`(overrides: RuntimeOverrides = {}) => Promise<Runtime>`
- **入参**：`RuntimeOverrides`（全部可选）：

  | 键 | 类型 | 用途 |
  | --- | --- | --- |
  | `config` | `Partial<AppConfig>` | 覆盖配置（优先级高于环境变量） |
  | `store` | `MappingStore` | 替换映射库 |
  | `audit` | `AuditLog` | 替换审计 |
  | `containers` | `ContainerSource` | 替换容器清单 |
  | `gateway` | `ServeGateway` | 替换 Tailscale 网关（**假实现走这条**） |
  | `snapshot` | `SnapshotWriter` | 替换快照写出器 |
  | `dockerTransport` | `DockerTransport` | 只换传输层（保留 `DockerContainerService` 的归一化） |
  | `commandRunner` | `CommandRunner` | 只换 CLI 执行器（保留 `TailscaleCli` 的参数拼装） |
  | `logger` | `Logger` | 替换 logger |

- **出参**：`Runtime`：`{config, logger, store, audit, containers, gateway, mappings, app, snapshot}`。
- **功能**：按依赖方向自底向上装配——`config` → `logger` → `Docker` → `Tailscale` → `store`/`audit`/`snapshot` → `MappingService` → `buildApp`。所有 logger 都用 `logger.child(scope)` 派生子作用域（`docker` / `tailscale` / `store` / `audit` / `mappings`）。
- **边缘条件与关键约定**：
  - `await fs.mkdir(config.dataDir, {recursive: true})` 在装配早期执行，后续所有落盘（映射库、审计、快照）都假定目录已存在；
  - `MappingService` 注入的是 `config.port`（`adminPort`）、`config.servePort`（默认对外端口）与 `config.autoUnexpose`；
  - **`TailscaleServeGateway` 会收到 logger**：`get-config` 读失败时要记警告（降级而不致命）；
  - 未注入 `gateway` 时才会**真的**调用本机 `tailscale` 可执行文件——因此「不想碰真实系统」的测试必须注入 `gateway` 或 `commandRunner`；
  - `app` 只是构造，**监听由 `main.ts` 负责**（这样 `app.inject()` 可以在不监听的情况下测全部路由）。

## 接口与类型

| 名称 | 形状 | 用途 |
| --- | --- | --- |
| `Runtime` | 见上文出参 | 组合根，`main.ts` 消费 |
| `RuntimeOverrides` | 见上文入参表 | 注入点清单 |

## 全局常量 / 变量

- 无。全部状态都在返回的 `Runtime` 对象里。

## 待办与隐患

- [ ] 无 TODO 标记。**扩展提醒**：新增可替换依赖时要同时加到 `Runtime` 与 `RuntimeOverrides` 两处，否则验证脚本无法注入替身。
- [ ] 已知取舍：`createRuntime` 不做任何网络/进程探测（Docker 连接与 tailscale 调用都是惰性的）。因此启动日志里「Docker 端点」需要 `main.ts` 额外预热一次才有真实值。
