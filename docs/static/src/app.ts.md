# `src/app.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

HTTP 管理面（Fastify）。安全前提由 `config.ts` 强制保证：

1. **只监听回环地址**，因此 tailnet 内其它设备无法直连；
2. 额外校验 `Host` 头，抵御 **DNS rebinding**——否则恶意网页可以让浏览器把 `attacker.com` 解析到 `127.0.0.1` 再调用本 API；
3. 任何指向管理端口的 serve 路由都会被安全闸门摘除（在 `mapping-service.ts`）。

> ⚠️ 第 1、2 层**挡不住同机 Docker 容器**（Docker Desktop 把 `host.docker.internal` 代理到宿主 loopback，且 `Host` 头客户端可控，三种来源的 TCP 对端都是 `127.0.0.1`）。完整实测证据见项目 `README.md` §5.1；**不要**把 `/api/*` 用于项目间集成，读路由请用快照文件。

## 依赖 / 引用

- `node:fs/promises`、`node:path`、`fastify`、`@fastify/static`、`zod`。
- `./config.ts`（`AppConfig`）、`./domain/route-path.ts`（`isLoopbackHost`）、`./logger.ts`、`./docker/docker-service.ts`（`ContainerSource`）、`./tailscale/tailscale-service.ts`（`ServeGateway`）、`./mappings/mapping-service.ts`（`MappingService`、`MappingConflictError`）、`./mappings/store.ts`、`./docker/docker-client.ts`（`DockerApiError`）、`./tailscale/tailscale-cli.ts`（`TailscaleError`）。
- 被 `src/runtime.ts` 调用（`buildApp`）；`test/api.test.ts` 用 `app.inject()` 覆盖全部端点。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `statusFor` | `(err: unknown) => number` | `number` | 领域错误 → HTTP 状态码 | `ZodError`→400、`MappingConflictError`→404/409、`TailscaleError`→502、`DockerApiError`→503、其余 500 |
| `messageOf` | `(err: unknown) => string` | `string` | 规范化错误消息 | `ZodError` 的 `issues` 展平成 `字段: 原因; …`；非 Error 用 `String(err)` |
| `buildApp` | `(deps: AppDeps) => Promise<FastifyInstance>` | `Promise<FastifyInstance>` | 组装 Fastify 实例（尚未 listen） | 见下文各路由与钩子 |

`buildApp` 内部注册的路由/钩子（按代码顺序）：`setErrorHandler`、`onRequest`（Host 白名单）、`GET /api/health`、`GET /api/system`、`GET /api/containers`、`GET /api/mappings`、`POST /api/mappings`、`PATCH /api/mappings/:id`、`DELETE /api/mappings/:id`、`POST /api/mappings/:id/enabled`、`POST /api/mappings/import`、`POST /api/apply`、`GET /api/serve/routes`、`GET /api/audit`、静态资源或 API-only 回落，以及 `setNotFoundHandler`。

## 函数详情

### `statusFor(err)`

- **签名**：`(err: unknown) => number`
- **入参**：任意抛出物。
- **出参**：HTTP 状态码。
- **功能**：把领域错误映射为语义化状态码，避免 Zod 校验失败落到 500（历史缺陷：曾经如此）。
- **边缘条件**：`MappingConflictError` 的 `code === 'not-found'` → 404，其余业务冲突 → 409；未知错误 → 500；Fastify 自带的 `statusCode` 优先（在 `setErrorHandler` 里 `?? statusFor(err)`）。

### `messageOf(err)`

- **签名**：`(err: unknown) => string`
- **出参**：可直接回显给用户的中文消息。
- **功能**：`ZodError` 的 `issues` 展平成 `字段: 原因; 字段2: 原因2`，这样前端拿到的 `error` 字段无需二次加工。
- **边缘条件**：`issues` 为空 → 返回空串；`path` 为空 → 占位 `(body)`。

### `buildApp(deps)`

- **签名**：`(deps: AppDeps) => Promise<FastifyInstance>`
- **入参**：`{config, mappings, containers, gateway, store, audit, logger}`。
- **出参**：未监听的 Fastify 实例（`main.ts` 负责 `listen`）。
- **功能**：注册错误处理器、Host 校验钩子、全部 API 路由与静态资源；`bodyLimit` 为 1MB；`logger: false`（日志走项目自己的 `Logger`）。
- **边缘条件与关键约定**：
  - **Host 校验**：`Host` 缺失 → 400 `bad-host`；主机名不过 `isLoopbackHost()` → 403 `forbidden-host` 并记 warn。IPv6 形式的 `[::1]:8787` 会被正确剥掉方括号。
  - **`GET /api/system`**：返回 `baseUrl`、`dnsName`、`magicDnsSuffix`、`tailnetIps`、`hostname`、`backendState`、`tailscaleVersion`、**`selfTags`**、**`canHostService`**（= `selfTags.length > 0`）、`adminUrl`、`adminPort`、`servePort`、`servePorts`、`serveHost`（**节点级**主机名）、**`services`**、`sources`、`security`、`plan`、`counts`。
  - **暴露判定**：`r.handler.kind === 'proxy' && r.handler.loopback && r.handler.hostPort === config.port`——**只判本机回环目标**（远端主机上的同名端口与本进程无关）。
  - **`POST /api/mappings`**：成功返回 **201** 与 `{mapping, apply}`。
  - **`PATCH /api/mappings/:id`**：先读当前记录（不存在 → 404 `not-found`），再用 `mappingBodySchema.partial()` 解析；**`service`/`remoteHost`/`scheme` 用 `!== undefined` 判断后透传**，省略即「不改动」，显式 `null` 即「切回节点级 / 清除远端」。
  - **`POST /api/mappings/import`**：请求体 `routes?: [{service?, servePort, path}]`，省略即接管全部；`body ?? {}` 容忍空体。
  - **`GET /api/serve/routes`**：返回 `{serveHost, httpsPorts, services, routes}`。
  - **`GET /api/audit?limit=N`**：`limit` 被 clamp 到 **1–500**，非法值回落 50。
  - **静态资源**：仅当 `<webRoot>/index.html` 存在才注册 `@fastify/static`（`wildcard: false`）；否则 `GET /` 返回一段说明 API 已就绪的 HTML。两种情况下 `setNotFoundHandler` 的行为不同：有前端时 `/api/*` 返回 404 JSON、其余回落到 `index.html`（SPA 深链）；无前端时所有未知路径都是 404 JSON。

## 请求体校验（`mappingBodySchema`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | `string`（min 1） | 挂载路径（后端会再做归一化） |
| `hostPort` | `int 1..65535` | 代理目标端口（本机或 `remoteHost` 上） |
| `servePort` | `int 1..65535?` | 对外 HTTPS 端口；省略用配置默认 |
| `targetPath` | `string?` | 追加到目标上的路径 |
| `service` | `string \| null?` | 接受 `dsh` / `svc:dsh`；`null`/`''` = 节点级；**省略 = 不改动** |
| `remoteHost` | `string \| null?` | 代理目标主机；省略 = 本机；只在 Service 级被接受 |
| `scheme` | `'http' \| 'https'?` | 代理协议；省略即 `http` |
| `kind` | `'container' \| 'host'?` | 目标类别（前端回传以避免编辑时降级） |
| `containerId` / `containerName` / `containerPort` | `string` / `string` / `int?` | 容器关联（前端回传，后端在远端目标下会忽略） |
| `note` | `string`（max 500）? | 备注 |
| `enabled` | `boolean?` | 启停 |
| `confirmTakeover` | `boolean?` | 位置被未托管路由占用时的显式确认 |

`enabledSchema`：`POST /api/mappings/:id/enabled` 的体，只有一个 `enabled: boolean`。

## 错误码一览

| code | 来源 | HTTP |
| --- | --- | --- |
| `bad-host` / `forbidden-host` | Host 钩子 | 400 / 403 |
| `invalid-path`、`invalid-target-path`、`invalid-port`、`invalid-serve-port`、`invalid-service`、`invalid-remote-host`、`remote-host-requires-service`、`invalid-scheme` | `#buildMapping` | 409 |
| `exposes-admin`、`serve-port-is-admin`、`duplicate-path`、`takeover-required` | `#buildMapping` | 409 |
| `not-found` | 各处 | 404 |
| `error` | 兜底（含 Zod → 400） | 400/500 |

## 待办与隐患

- [ ] **已知未修的安全缺陷（优先级高）**：同机 Docker 容器可伪造 `Host` 头完整读写管理 API。修法是引入一个只存在于宿主文件系统的令牌（`<DATA_DIR>/api-token`，所有非 GET 请求要求 `Authorization: Bearer`）。见 `todo.md` 第 7 项。
- [ ] 写接口目前没有鉴权层，`onRequest` 钩子只做 Host 校验——加令牌时必须同时考虑前端如何携带（localStorage 或首次输入）。
