# `web/src/api.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

后端 JSON API 的**类型化客户端**。这是前端最有价值的一个文件：它把后端的全部响应结构**逐字**写成 TS 类型（字段名不做任何映射），因此后端一旦改名，前端会立刻编译失败而不是运行期静默失效。

同时提供统一 fetch 封装（错误归一化、`AbortSignal` 透传）与默认实例 `api`（同源相对路径，由 Vite proxy 或后端静态服务承接）。

## 依赖 / 引用

- 无第三方依赖（只用浏览器 `fetch` / `Response` / `DOMException` / `URL` 语义）。
- 被 `web/src/App.tsx`（采集与写操作）、`web/src/components/*`（错误码文案、类型）、`web/src/utils.ts`（类型）引用。
- **契约的另一半在 `src/app.ts`（路由与 zod 校验）与 `src/domain/types.ts`（领域类型）**：三者必须同步改，否则类型对得上但行为对不上。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `ApiError.is` | `(code: string) => boolean` | `boolean` | 判断是否带某个业务错误码 | 只做字符串相等；大小写敏感 |
| `errorBody` | `(value: unknown) => ApiErrorBody \| null` | 对象或 `null` | 从响应体里提取 `{error, code}` | 非对象或 `error` 非字符串 → `null`；缺 `code` 时回落 `'error'`（模块私有） |
| `toApiError` | `(err: unknown) => ApiError` | `ApiError` | 任意抛出物 → `ApiError` | `AbortError` → `code: 'aborted'`；其它 → `code: 'network'` |
| `readBody` | `(res: Response) => Promise<unknown>` | `Promise<unknown>` | 读响应体并尽量解析 JSON | 空体 → `null`；非 JSON → 原样字符串（模块私有） |
| `send` | `(method, path, body?, signal?) => Promise<unknown>` | `Promise<unknown>` | 统一请求 | 非 2xx 抛 `ApiError`；网络失败抛 `code: 'network'`；`AbortError` 原样上抛（模块私有） |
| `createApi` | `(base = '') => ApiClient` | `ApiClient` | 生成 11 个接口的封装 | `base` 前缀拼在所有路径前；`url()` 是内部闭包 |
| `url`（`createApi` 内闭包） | `(path: string) => string` | `string` | 拼 base 与路径 | `base` 为空时就是同源相对路径 |

`createApi` 返回对象的 11 个方法（**对象字面量成员，逐个实现**）：

| 方法 | HTTP | 路径 | 出参类型 |
| --- | --- | --- | --- |
| `system(signal?)` | GET | `/api/system` | `Promise<SystemInfo>` |
| `containers(signal?)` | GET | `/api/containers` | `Promise<ContainersResponse>` |
| `mappings(signal?)` | GET | `/api/mappings` | `Promise<MappingsResponse>` |
| `serveRoutes(signal?)` | GET | `/api/serve/routes` | `Promise<ServeRoutesResponse>` |
| `audit(limit = 50, signal?)` | GET | `/api/audit?limit=N` | `Promise<AuditResponse>` |
| `createMapping(input, signal?)` | POST | `/api/mappings` | `Promise<MappingMutationResponse>` |
| `updateMapping(id, input, signal?)` | PATCH | `/api/mappings/:id` | `Promise<MappingMutationResponse>` |
| `deleteMapping(id, signal?)` | DELETE | `/api/mappings/:id` | `Promise<MappingDeleteResponse>` |
| `setEnabled(id, enabled, signal?)` | POST | `/api/mappings/:id/enabled` | `Promise<MappingMutationResponse>` |
| `importRoutes(routes?, signal?)` | POST | `/api/mappings/import` | `Promise<ImportResponse>` |
| `apply(signal?)` | POST | `/api/apply` | `Promise<ApplyResult>` |

## 函数详情

### `ApiError.is(code)`

- **签名**：`(code: string) => boolean`
- **入参**：`code`（业务错误码，如 `'takeover-required'`）。
- **出参**：`boolean`。
- **功能**：调用方据此分支（例如 `ContainerMappingForm` 收到 `takeover-required` 时就地展开「确认接管」而不是报错）。
- **边缘条件**：`code` 为 `'network'` / `'aborted'` / `'http-<status>'` 这类非业务码时同样可以判断。

### `errorBody(value)` — 模块私有

- **签名**：`(value: unknown) => ApiErrorBody | null`
- **出参**：`{error, code}` 或 `null`。
- **功能**：只在响应体里确实有字符串 `error` 时才认。
- **边缘条件**：`error` 缺失 → `null`（调用方回落到 `HTTP <status>` 文案）；`code` 缺失 → `'error'`。

### `toApiError(err)`

- **签名**：`(err: unknown) => ApiError`
- **出参**：`ApiError`。
- **功能**：把 fetch 抛出的各种东西归一化。
- **边缘条件**：
  - 已经是 `ApiError` → 原样返回（幂等）；
  - `DOMException` 且 `name === 'AbortError'` → `{status: 0, code: 'aborted', message: '请求已取消'}`；
  - 其它（TypeError、字符串……）→ `{status: 0, code: 'network'}`，消息用 `err.message` 或 `String(err)`。

### `readBody(res)` — 模块私有

- **签名**：`(res: Response) => Promise<unknown>`
- **出参**：解析后的 JSON、原文字符串、或 `null`。
- **功能**：先 `text()` 再尝试 `JSON.parse`，因此**不吞掉非 JSON 响应**（HTML 错误页会以字符串形式返回，便于诊断）。
- **边缘条件**：空体 → `null`；`204` 响应同样得到 `null`。

### `send(method, path, body?, signal?)` — 模块私有

- **签名**：`(method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>`
- **入参**：`body === undefined` 时不发请求体、不带 `content-type`；否则 JSON 序列化并带 `content-type: application/json`。始终带 `accept: application/json`。
- **出参**：`Promise<unknown>`（调用方按具体类型断言）。
- **功能**：`fetch` → 读体 → 非 2xx 抛错 → 返回解析结果。
- **边缘条件**：
  - **网络层失败**（fetch 本身 reject）→ 抛 `ApiError('无法连接管理接口 <path>：…', 0, 'network')`；
  - **`AbortError` 原样上抛**（不包装），这样上层的 `toApiError` 才能识别成 `aborted`；
  - 非 2xx 且响应体是 `{error, code}` → 抛带该 `code` 的 `ApiError`（HTTP 状态保留在 `status`）；
  - 非 2xx 且响应体无法识别 → 抛 `code: 'http-<status>'`。

### `createApi(base?)`

- **签名**：`(base: string = '') => ApiClient`
- **入参**：`base` 可省略；默认 `''` 表示同源。
- **出参**：`ApiClient`（11 个方法，见上表）。
- **功能**：每个方法都是 `send(...)` 的一行封装；`id` 会经 `encodeURIComponent` 再拼进路径。
- **边缘条件**：`base` 末尾不要带 `/`（否则会出现 `//api/...`）；`audit` 的 `limit` 未传时默认 50（后端会再 clamp 到 1–500）。

## 领域类型与契约（必须与后端逐字一致）

**路由身份**：`RouteRef = {service, servePort, path}`；`service === null` 表示节点级路由。`MappingView` 额外带 `service` 与 **`baseUrl`**（对外完整基址，不含路径；非 443 已带端口）。

| 类型 | 关键字段 / 说明 |
| --- | --- |
| `MappingStatus` | `active` / `pending` / `disabled` / `disabled-drift` / `orphaned-target` / `blocked` / `conflict` / **`awaiting-approval`** |
| `MappingTarget` | `kind`、`hostPort`、`targetPath`、**`remoteHost?`**、**`scheme?`**、`containerId?` / `containerName?` / `containerPort?` |
| `MappingView` | `Mapping` 字段 + `status`、`desiredProxy`、`actualProxy`、`baseUrl`、`detail` |
| `ServiceInfo` | `name`、`dnsName`、`servePorts`、`advertised`、`vipIps` |
| `ExternalRoute` | `service`、`servePort`、`path`、`proxy`、`hostPort`、`host`、`kind`、`fromServiceConfig`、`serviceInfo` |
| `SystemInfo` | …、`magicDnsSuffix`、**`selfTags`**、**`canHostService`**、**`services`**、`serveHost`（**节点级**主机名） |
| `MappingsResponse` | `mappings`、`externalRoutes`、**`services`**、**`selfTags`**、`planSummary`、`counts` |
| `ServeRoutesResponse` | `serveHost`、`httpsPorts`、**`services`**、`routes` |
| `Exposure` | `service`、`servePort`、`path`、`proxy` |
| `ApplyResult` | `upserted` / `removed`（`RouteRef[]`）、`blocked`（含 `service`）、`exposures`、`errors`、`inSync` |
| `ImportResponse` | `imported`、`skipped`（含 `service`） |
| `MappingInput` | 全部字段可选（PATCH 语义）；**`service` / `remoteHost` 省略 = 不改动，`null` = 清空** |

## 错误码表

`KNOWN_ERROR_CODES`（仅用于提示文案，不做强制收窄）：`exposes-admin`、`serve-port-is-admin`、`duplicate-path`、`takeover-required`、`invalid-path`、`invalid-port`、`invalid-serve-port`、`invalid-target-path`、**`invalid-service`**、**`invalid-remote-host`**、**`remote-host-requires-service`**、**`invalid-scheme`**、`not-found`。

`ERROR_CODE_LABEL` 把错误码映射成中文前缀（含 `bad-host` / `forbidden-host` / `not-found-route` 这类非业务码）。

## 待办与隐患

- [ ] 无 TODO 标记。**改动纪律**：本文件是契约层，任何字段改名都必须同时改 `src/app.ts` 与 `src/domain/types.ts`；只改一边的后果是「前端编译不过」或「后端多返回了一个没人读的字段」，后者不会报错但会让两处真相分叉。
- [ ] 已知边界：**本文件不携带任何凭据**。管理 API 目前没有鉴权层（同机容器可伪造 `Host` 绕过回环校验），因此界面只在本机使用；加令牌时必须同时改这里（`send` 统一注入头）与 `src/app.ts`。
