# `src/tailscale/tailscale-cli.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

`tailscale` CLI 的薄封装。之所以走 CLI 而不是直连 LocalAPI：Windows 上 tailscaled 的命名管道位于 `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`，直连需要管理员权限，而 `tailscale.exe` 自身已经处理了与服务端的鉴权。

**所有写操作都带 `--yes`**，否则交互式确认会把常驻进程挂死。**Service 与节点级是两套命名空间**：带 `--service=svc:x` 的命令只作用于该 Service 的配置组。

## 依赖 / 引用

- `node:child_process` 的 `execFile`。
- `../logger.ts` 的 `Logger`（记录每条写命令）。
- 被 `src/runtime.ts` 构造，由 `src/tailscale/tailscale-service.ts`（网关）调用；`test/service-config.test.ts` 用假 `CommandRunner` 断言参数顺序。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `explain` | `(args: string[], stderr: string) => string` | `string` | 把 CLI 报错翻译成中文 | 未命中任何模式时给通用文案；大小写不敏感；模块私有 |
| `ExecFileRunner.run` | `(bin, args, timeoutMs?) => Promise<RunResult>` | `Promise<RunResult>` | 真实 spawn（不经 shell） | 启动失败（ENOENT）→ reject；超时 → 退出码按 err.code 取 |
| `TailscaleCli.#run` | `(args, timeoutMs?) => Promise<RunResult>` | `Promise<RunResult>` | 执行命令 | 执行器抛错 → 包装成 `TailscaleError` 并提示用 `TSCONTROLLER_TAILSCALE_BIN` 指定路径 |
| `TailscaleCli.#runOrThrow` | `(args, timeoutMs?) => Promise<string>` | `Promise<string>` | 非 0 退出即抛 | 抛出的消息来自 `explain()` |
| `TailscaleCli.statusJson` | `() => Promise<unknown>` | `Promise<unknown>` | `status --json` | JSON 解析失败 → `TailscaleError`（带前 200 字符原文） |
| `TailscaleCli.serveStatusJson` | `() => Promise<unknown>` | `Promise<unknown>` | `serve status --json`（**只有节点级**） | 空输出归一化为 `{}` |
| `TailscaleCli.serveGetConfig` | `() => Promise<unknown>` | `Promise<unknown>` | `serve get-config --all`（**Service 级**） | 空输出/`{}` 归一化为 `{}`（不是 host 时属正常状态） |
| `TailscaleCli.#parseJson` | `(out, args) => unknown` | `unknown` | 统一 JSON 解析 | 空串 → `{}`；解析失败 → `TailscaleError`；模块私有 |
| `TailscaleCli.serveUpsert` | `(servePort, path, proxyUrl, service?) => Promise<void>` | `Promise<void>` | 挂载/覆盖一条路径 | **`--service` 与 `--set-path` 都必须在目标之前** |
| `TailscaleCli.serveRemove` | `(servePort, path, service?) => Promise<void>` | `Promise<void>` | 精确摘除一条路径 | `off` 必须在最后 |
| `TailscaleCli.serveClear` | `(service) => Promise<void>` | `Promise<void>` | `serve clear svc:<name>` | 该命令**不接受** `--yes`（没有交互确认） |

## 函数详情

### `explain(args, stderr)` — 模块私有

- **签名**：`(args: string[], stderr: string) => string`
- **入参**：`args` 用于兜底文案；`stderr` 是 CLI 原文。
- **出参**：中文可读原因。
- **功能**：按关键词匹配五类已知故障：`access is denied`（权限/会话）、`not running` / `failed to connect to local tailscaled`（未登录）、`serve is not enabled` / `https is not enabled`（tailnet 未开 HTTPS 证书）、**`tagged node` / `must be tagged`**（Service host 需要 tag 身份——这是 Service 模式最容易撞上的一条）、`unknown flag` / `unknown subcommand`（版本不支持）。
- **边缘条件**：全部小写后匹配；都没命中 → `tailscale <args> 执行失败（退出码非 0）。`

### `ExecFileRunner.run(bin, args, timeoutMs?)`

- **签名**：`(bin: string, args: string[], timeoutMs = 15000) => Promise<RunResult>`
- **入参**：`timeoutMs` 默认 15000ms；`maxBuffer` 固定 8MB、`windowsHide: true`、`encoding: 'utf8'`。
- **出参**：`Promise<RunResult>`：`{code, stdout, stderr}`。
- **功能**：`execFile` 直接 spawn，**不经过 shell**（避免引号转义与注入风险）。
- **边缘条件**：
  - `err.code` 是字符串（`ENOENT` 等启动错误）→ **reject**，交给 `#run` 包装；
  - 非 0 退出（`err.code` 是数字）→ resolve 一个带退出码的结果（不抛），由调用方决定；
  - 超时时 Node 会 kill 子进程并以非 0 退出码 settle——因此行为等价于「命令失败」。

### `TailscaleCli.run` / `#run(args, timeoutMs?)`

- **签名**：`(args: string[], timeoutMs?: number) => Promise<RunResult>`（实例私有）
- **出参**：原始命令结果 `{code, stdout, stderr}`。
- **功能**：调用注入的 `CommandRunner`；执行器**启动失败**（ENOENT 等）时包装成 `TailscaleError`，消息里提示用 `TSCONTROLLER_TAILSCALE_BIN` 指定可执行文件路径。
- **边缘条件**：命令本身非 0 退出**不在这里抛错**（由 `#runOrThrow` 决定），因此需要读原始结果的方法可以直接用 `#run`。

### `TailscaleCli.runOrThrow` / `#runOrThrow(args, timeoutMs?)`

- **签名**：`(args: string[], timeoutMs?: number) => Promise<string>`（实例私有）
- **出参**：`Promise<string>`（stdout）。
- **功能**：`code !== 0` 时抛 `TailscaleError(explain(args, stderr), args, stderr.trim())`。
- **边缘条件**：`TailscaleError` 携带 `args` 与 `stderr` 原文，`src/app.ts` 会把它映射为 HTTP 502；因此「tailscale 没装/没登录/没开 HTTPS」对界面表现为 502 + 中文原因。

### `statusJson()` / `serveStatusJson()`

- **签名**：`() => Promise<unknown>`
- **出参**：解析后的 JSON（形状由上游决定，本层不校验）。
- **功能**：分别是 `status --json` 与 `serve status --json`。
- **边缘条件**：
  - `serve status --json` 在**无任何 serve 配置**时 tailscale 打印 `{}`（合法），空串也归一化为 `{}`；
  - 解析失败抛 `TailscaleError`，消息里带前 200 字符原文便于定位。

### `serveGetConfig()`

- **签名**：`() => Promise<unknown>`
- **出参**：`get-config --all` 的 JSON（`{version, services}`）或 `{}`。
- **功能**：**Service 路由的唯一读取入口**（`serve status --json` 里没有 Service）。
- **边缘条件**：本节点不是任何 Service 的 host 时上游输出 `{}` → 归一化为 `{}`，属正常状态而非错误；老版本 CLI 不认识 `--all` 时抛出，由 `TailscaleServeGateway.snapshot()` 降级处理（只记警告）。

### `#parseJson(out, args)` — 模块私有

- **签名**：`(out: string, args: string[]) => unknown`
- **入参**：`out` 是 CLI 原始 stdout；`args` 仅用于错误消息。
- **出参**：`unknown`（形状校验交给上层解析器）。
- **功能**：空串/纯空白一律归一化为 `{}`——`serve status --json` 与 `get-config --all` 在「没有配置」时都可能输出空或 `{}`，两者语义相同。
- **边缘条件**：非空但解析失败 → 抛 `TailscaleError`，消息里带前 200 字符原文（便于定位是哪个版本改了格式）。

### `serveUpsert(servePort, path, proxyUrl, service?)`

- **签名**：`(servePort: number, path: string, proxyUrl: string, service?: string | null) => Promise<void>`
- **入参**：`service` 省略/null 表示节点级；实参形如 `svc:dsh`。
- **出参**：`Promise<void>`，失败抛 `TailscaleError`。
- **功能**：拼出 `serve --bg --yes [--service=svc:x] --https=<port> --set-path=<path> <proxyUrl>`，并先写一条 info 日志（含 `service`/`servePort`/`path`/`proxyUrl`）。
- **边缘条件**：
  - **参数顺序是硬要求**：所有 flag 必须在目标之前；`--service` 在 `--https` 之前；`--set-path` 在目标之前。顺序错了会改错命名空间或改错端口组；
  - `--https=<port>` 显式给出而不是依赖默认——serve 的每个 HTTPS 端口是独立配置组，省略会落到 443 组。

### `serveRemove(servePort, path, service?)`

- **签名**：`(servePort: number, path: string, service?: string | null) => Promise<void>`
- **功能**：`serve --yes [--service=svc:x] --https=<port> --set-path=<path> off`。
- **边缘条件**：`off` 必须在最后；该命令只摘这一条，不影响同端口/同命名空间的其它路径。

### `serveClear(service)`

- **签名**：`(service: string) => Promise<void>`
- **功能**：`serve clear svc:<name>`，摘除该 Service 在本节点上的**全部**端点配置。
- **边缘条件**：
  - **不支持 `--yes`**（该子命令没有交互确认），因此不能照抄其它写方法的参数模板；
  - 它会同时停止 advertise，副作用比 `serveRemove` 大得多；
  - **当前没有任何代码路径调用它**（见 `mapping-service.ts` 的待办）。

## 接口与类型

| 名称 | 形状 | 用途 |
| --- | --- | --- |
| `RunResult` | `{ code: number; stdout: string; stderr: string }` | 命令结果 |
| `CommandRunner` | `{ run(bin, args, timeoutMs?): Promise<RunResult> }` | 执行器抽象，测试注入假实现 |
| `TailscaleError` | `Error & { args: string[]; stderr: string }` | 被 `app.ts` 映射为 502 |

## 待办与隐患

- [ ] 无 TODO 标记。**三条工程约束（都来自真实环境实测，改动前请先读 `history.md`）**：① 写操作一律带 `--yes`；② 刻意不用 `serve set-config`（1.102 起它已转向 services 格式，喂 `status --json` 原文会被判 legacy 并**静默忽略**，退出码仍为 0）；③ `serve status --json` 不含 Service，必须用 `get-config --all`。
