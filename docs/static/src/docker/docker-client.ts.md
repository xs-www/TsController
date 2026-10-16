# `src/docker/docker-client.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

Docker Engine API 的极简客户端。直接走 Docker 的**本地端点**（Windows 命名管道 / Unix socket / TCP），不依赖 `docker` CLI——因此不需要解析人类可读输出，也不受 CLI 版本输出变化影响。

端点解析是**惰性 + 并发探测 + 负缓存**的：第一次成功请求的端点被缓存；传输失败时重新探测（兼容 Docker Desktop 重启与 WSL/Windows 引擎切换）；整体探测失败做 5 秒负缓存，避免 Docker 未运行时界面每次请求都卡满超时。

## 依赖 / 引用

- `node:http`（`socketPath` / `host:port`）。
- `../logger.ts` 的 `Logger`。
- 被 `src/runtime.ts` 构造，被 `src/docker/docker-service.ts`（经 `DockerTransport` 接口）与 `test/**` 使用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `normalizePipeName` | `(raw: string) => string` | `string` | 把四种管道写法归一化成裸名字 | 空串返回空串；不做存在性检查 |
| `resolveEndpoints` | `(configured: string\|null, env?) => DockerEndpoint[]` | `DockerEndpoint[]` | 解析显式配置 / `DOCKER_HOST` / 平台默认候选 | **显式配置是权威的**：一旦有值就不再追加平台默认；无法解析的 `DOCKER_HOST` 被静默忽略 |
| `describeEndpoint` | `(ep: DockerEndpoint) => string` | `string` | 人类可读端点描述 | 判别联合已穷举，无 default 分支 |
| `rawRequest` | `(ep, path, options) => Promise<{status, body}>` | `Promise` | 发一次 HTTP 请求（不解析 JSON、不判状态码） | 超时后 `destroy` 并抛 `DockerApiError`；网络错误原样 reject |
| `DockerEngineClient.#probe` | `() => Promise<DockerEndpoint>` | `Promise` | 并发探测全部候选，取最先成功者 | 命中负缓存直接抛上次的错误；全部失败时记录负缓存 |
| `DockerEngineClient.request` | `<T>(path, options?) => Promise<T>` | `Promise<T>` | 请求 Engine API，传输失败时重探测并重试一次 | HTTP ≥400 是业务错误，**不**重试；最多两次尝试 |
| `DockerEngineClient.endpoint` | `() => string` | `string` | 当前实际端点描述 | 未连接时返回 `(未连接)` |
| `DockerApiError.constructor` | `(message, status?) => DockerApiError` | `DockerApiError` | 携带可选 HTTP 状态码的错误 | `status === null` 表示传输层错误（与业务错误区分） |

## 函数详情

### `normalizePipeName(raw)`

- **签名**：`(raw: string) => string`
- **入参**：`raw`（`string`，必选）：`npipe://./pipe/x`、`//./pipe/x`、`\\.\pipe\x`、`x` 四种写法之一。
- **出参**：`string`，裸管道名（如 `dockerDesktopLinuxEngine`）。
- **功能**：依次剥掉 `npipe://`、`\\\\.\\pipe\\`、`//./pipe/`、前导 `/`、`./pipe/` 前缀，使调用方只需拼一次 `//./pipe/<name>`。
- **边缘条件**：
  - 空串 / 只有前缀 → 返回空串（调用方会得到 `//./pipe/`，最终连接失败并进入正常的探测失败路径）；
  - 大小写不敏感匹配前缀（`/i`），但名字本身大小写保留。

### `resolveEndpoints(configured, env?)`

- **签名**：`(configured: string | null, env: NodeJS.ProcessEnv = process.env) => DockerEndpoint[]`
- **入参**：
  - `configured`（`string | null`，必选）：`TSCONTROLLER_DOCKER_PIPE` 的值，`null` 表示未配置；
  - `env`（`NodeJS.ProcessEnv`，可选，默认 `process.env`）：注入环境便于测试。
- **出参**：`DockerEndpoint[]`，按优先级去重后的候选列表（按 `JSON.stringify` 比较去重）。
- **功能**：优先级为「显式配置 → `DOCKER_HOST` → 平台默认」。平台默认在 Windows 上是 `dockerDesktopLinuxEngine` → `docker_engine` → `dockerDesktopWindowsEngine`，其它平台是 `/var/run/docker.sock` → `/run/docker.sock`。
- **边缘条件**：
  - **`out.length > 0` 时直接返回**，不再追加平台默认——这是刻意设计：把 `DOCKER_HOST` 指向远程 Engine 的用户，绝不能在远程不可达时被静默回落到本机 Docker Desktop（那是最难排查的一类故障）；
  - `tcp:` / `http(s):` 前缀走 URL 解析，端口缺省为 `2375`；解析失败静默忽略该条目；
  - 无法识别的写法一律当作管道名处理（容错优先）。

### `describeEndpoint(ep)`

- **签名**：`(ep: DockerEndpoint) => string`
- **入参**：`ep`（判别联合，必选）。
- **出参**：`string`：`npipe:\\.\pipe\<name>` / `unix:<path>` / `tcp:<host>:<port>`。
- **功能**：仅用于日志与界面显示（`DockerContainerService.describeSource()` 直接返回它）。
- **边缘条件**：联合已穷举，不会返回 `undefined`。

### `rawRequest(ep, path, options)` — 模块私有

- **签名**：`(ep: DockerEndpoint, path: string, options: DockerRequestOptions) => Promise<{ status: number; body: string }>`
- **入参**：`timeoutMs`（可选，默认 `8000`）；`method`（可选，默认 `GET`）。
- **出参**：`Promise<{status, body}>`，**body 为原始字符串**，由调用方决定是否 `JSON.parse`。
- **功能**：按端点类型选 `socketPath` 或 `host/port`；固定发送 `Host: localhost` 与 `Accept: application/json`（Docker 要求 Host 合法）。
- **边缘条件**：
  - 超时 → `req.destroy(new DockerApiError('Docker 请求超时（<ms>ms）：<path>'))`，即 reject 一个 `DockerApiError`（`status === null`）；
  - 非 2xx **不在这里报错**，只把状态码交回调用方；
  - 响应体无上限保护（Docker 容器清单在本地，可接受）。

### `DockerEngineClient.#probe()` — 私有

- **签名**：`() => Promise<DockerEndpoint>`
- **出参**：`Promise<DockerEndpoint>`，最先成功的端点。
- **功能**：对 `#endpoints` 全部候选**并发**发 `/version`，第一个 `200` 胜出并被缓存到 `#resolved`，同时清空 `#probeFailure` 并写一条 info 日志。手写 race 而不是 `Promise.allSettled`——后者会等全部结束，等于没并发。
- **边缘条件**：
  - 命中负缓存（`Date.now() - at < PROBE_FAILURE_TTL_MS`）→ 直接抛上次的错误，不再探测；
  - 全部失败 → 聚合每个端点的失败原因成一条可读错误，写入负缓存并 reject；
  - **候选列表为空** → 直接 reject `没有可用的 Docker 端点候选。`；
  - `settled` 标志保证只有第一个结果生效；迟到的响应被丢弃。

### `DockerEngineClient.request<T>(path, options?)`

- **签名**：`<T>(path: string, options?: DockerRequestOptions) => Promise<T>`
- **入参**：`path`（必选，如 `/containers/json?all=1`）；`options.timeoutMs`（可选）、`options.method`（可选）。
- **出参**：`Promise<T>`；**空响应体解析为 `undefined`**（Docker 的 204 场景）。
- **功能**：未连接时先 `#probe()`；请求失败且属于**传输错误**时清空 `#resolved`、重新探测并再试一次；最多两次尝试。
- **边缘条件**：
  - HTTP ≥ 400 → 抛 `DockerApiError(status)`；`err.status !== null` 时**立即 break，不重探测**（状态码是业务错误，重探测没有意义）；
  - 两次都失败 → 抛最后一次错误；理论上 `lastError` 不可能为 `null`（循环至少跑一次），兜底给一条通用错误；
  - 响应体不是合法 JSON → `JSON.parse` 抛 `SyntaxError`，会被当作传输错误路径处理（清缓存并重新探测一次）。

## 全局常量 / 变量

- `WINDOWS_PIPE_CANDIDATES`：`['dockerDesktopLinuxEngine', 'docker_engine', 'dockerDesktopWindowsEngine']`，Windows 平台默认候选。
- `POSIX_SOCKET_CANDIDATES`：`['/var/run/docker.sock', '/run/docker.sock']`。
- `PROBE_TIMEOUT_MS` = `2500`：单次探测超时；由于是并发探测，这也是整体探测耗时上限。
- `PROBE_FAILURE_TTL_MS` = `5000`：探测失败负缓存时长。

## 待办与隐患

- [ ] 无 TODO 标记。历史实测（见 `history.md`）：并发探测把首次连接从 **2528ms** 降到 **27ms**；这是 `#probe()` 写成手写 race 的量化理由。
- [ ] 已知边界：HTTP 请求体不受限（本客户端只做 GET 语义的读操作，不需要）。
