# `src/tailscale/tailscale-service.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

Tailscale 网关：把 CLI 输出整理成领域模型，并向映射层暴露**最小接口**（`ServeGateway`）。刻意不暴露 CLI 细节——测试可以用内存假实现替换，无需真实 Tailscale。

本层承担两件容易漏掉的事：**合并节点级与 Service 级两个数据源**（见 `serve-config.ts` 的说明），以及**从 `status --json` 里解析本节点的 tag 与 service-host 能力**（后者是「等待审批」状态与「能否充当 host」的唯一依据）。

## 依赖 / 引用

- `../domain/route-path.ts` 的 `suffixFromNodeDnsName`；`../domain/types.ts` 的 `ServeSnapshot` / `TailnetInfo`；`../logger.ts` 的 `Logger`。
- `./serve-config.ts`：`mergeServeSnapshots`、`parseServiceConfig`、`parseServeStatus`；`./tailscale-cli.ts`：`TailscaleCli`。
- 被 `src/runtime.ts` 构造；`src/mappings/mapping-service.ts` 与 `src/snapshot.ts` 经 `ServeGateway` 接口消费；`test/fakes.ts` 提供内存替身。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `parseServiceHostCap` | `(capMap: unknown) => Record<string, string[]>` | 映射 | 解析 `Self.CapMap` 里的 service-host 能力 | 兼容对象与数组两种形态；只收 `svc:` 前缀的键；非数组值给 `[]`；解析不出就返回空对象 |
| `parseTailnetInfo` | `(raw: unknown) => TailnetInfo` | `TailnetInfo` | 解析 `status --json` | 字段缺失不抛错；`DNSName` 尾点被去掉；MagicDNS 后缀缺失时从节点 DNS 名推导 |
| `TailscaleServeGateway.describeSource` | `() => string` | `string` | 数据来源描述 | 直接返回 CLI 路径 |
| `TailscaleServeGateway.snapshot` | `() => Promise<ServeSnapshot>` | `Promise<ServeSnapshot>` | **合并两个来源**成一份快照 | `get-config` 失败只降级（记警告），**绝不让整个快照失败** |
| `TailscaleServeGateway.tailnet` | `() => Promise<TailnetInfo>` | `Promise<TailnetInfo>` | 读本机 tailnet 身份 | 失败上抛（由 `MappingService.#readTailnet` 容错） |
| `TailscaleServeGateway.upsertRoute` | `(servePort, path, proxyUrl, service?) => Promise<void>` | `Promise<void>` | 挂载/覆盖 | 透传到 CLI |
| `TailscaleServeGateway.removeRoute` | `(servePort, path, service?) => Promise<void>` | `Promise<void>` | 摘除 | 透传到 CLI |
| `TailscaleServeGateway.clearService` | `(service) => Promise<void>` | `Promise<void>` | 摘除该 Service 的全部端点 | **当前无调用方**（见待办） |

## 函数详情

### `parseServiceHostCap(capMap)`

- **签名**：`(capMap: unknown) => Record<string, string[]>`
- **入参**：`capMap`（`unknown`）：`status --json` 的 `Self.CapMap`。
- **出参**：`{ "svc:dsh": ["100.65.32.1", "fd7a::1"], … }`。
- **功能**：找 `service-host`（或带命名空间的 `tailscale.com/cap/service-host`）能力，把它的值收成「Service 名 → TailVIP 列表」。
- **边缘条件**：
  - `capMap` 是数组（不同版本的序列化形态）→ 逐个元素找 key；找不到 key 时再尝试把元素本身当映射读一次；
  - 值不是数组 → `[]`（**不丢弃该 Service**：「出现过」本身就已经是「被承认」的证据）；
  - 非 `svc:` 前缀的键一律忽略；
  - 完全解析不出 → `{}`——**静默降级是刻意的**：该值只用于把 Service 标成「已承认」，解析失败退化成「未承认」只会让界面提示更保守，不会造成危险。

### `parseTailnetInfo(raw)`

- **签名**：`(raw: unknown) => TailnetInfo`
- **入参**：`raw`：`status --json` 的解析结果。
- **出参**：`TailnetInfo`：`{dnsName, baseUrl, ips, hostname, backendState, version, magicDnsSuffix, tags, serviceHosts}`。
- **功能**：读 `Self`（`DNSName`/`TailscaleIPs`/`HostName`/`Tags`/`CapMap`）、根级 `BackendState`/`Version`、以及 `CurrentTailnet.MagicDNSSuffix`。
- **边缘条件**：
  - 字段缺失一律给 `null` / `[]`，**不抛错**（Tailscale 未登录时界面仍应能打开）；
  - `DNSName` 的尾点被剥掉（`baseUrl` 因此不带尾点）；
  - `magicDnsSuffix` 优先取 `CurrentTailnet.MagicDNSSuffix`，为空时用 `suffixFromNodeDnsName(dnsName)` 兜底，最后清掉首尾点；
  - `Tags` 非数组或含非字符串 → 过滤成 `[]`（**`tags` 为空就意味着本节点不可能充当 Service host**）。

### `describeSource()`

- **签名**：`() => string`
- **出参**：`string`，即 tailscale 可执行文件路径。
- **功能**：界面「数据源」一栏与启动日志使用。
- **边缘条件**：不做存在性检查（路径错了会在第一次真实调用时报错，错误信息里会提示用 `TSCONTROLLER_TAILSCALE_BIN` 指定）。

### `TailscaleServeGateway.snapshot()`

- **签名**：`() => Promise<ServeSnapshot>`
- **出参**：合并后的 `ServeSnapshot`。
- **功能**：`Promise.all` 并发取 `serve status --json` 与 `status --json`，分别解析成节点级快照与 tailnet 身份；再单独取 `serve get-config --all` 解析出 Service 级快照，最后 `mergeServeSnapshots(nodeLevel, serviceLevel, tailnet.serviceHosts)`。
- **边缘条件**：
  - **`get-config` 失败只降级**：把 `serviceLevel` 置为空快照并 `logger?.warn`。这保证「读不到 Service」不会连带让节点级路由全部不可见——代价是那一轮 Service 路由（含安全闸门视野）不可见，已在 `README.md` §11 登记；
  - `logger` 未注入时（测试构造）静默跳过警告；
  - 两个 `status` 调用各发一次，**不重复调用**（一次界面刷新只应有固定次数的 CLI 进程调用）。

### `tailnet()`

- **签名**：`() => Promise<TailnetInfo>`
- **出参**：`Promise<TailnetInfo>`。
- **功能**：`parseTailnetInfo(await cli.statusJson())` 的薄封装。
- **边缘条件**：底层 CLI 失败会抛 `TailscaleError`，由 `MappingService.#readTailnet()` 容错（只警告并沿用上次缓存）——因此**调用方不应假定它一定成功**。

### `upsertRoute(servePort, path, proxyUrl, service?)`

- **签名**：`(servePort: number, path: string, proxyUrl: string, service?: string | null) => Promise<void>`
- **入参**：`service` 省略/null 表示节点级。
- **出参**：`Promise<void>`。
- **功能**：委托 `TailscaleCli.serveUpsert`（参数顺序的约束见 `tailscale-cli.ts.md`）。
- **边缘条件**：失败抛 `TailscaleError`，由 `MappingService.applyInternal` 收进 `ApplyResult.errors`，**不中断其余条目**。

### `removeRoute(servePort, path, service?)`

- **签名**：`(servePort: number, path: string, service?: string | null) => Promise<void>`
- **出参**：`Promise<void>`。
- **功能**：委托 `TailscaleCli.serveRemove`，只摘这一条。
- **边缘条件**：同上；摘除失败时 `MappingService` 会保留归属记账，下次 apply 自动重试。

### `clearService(service)`

- **签名**：`(service: string) => Promise<void>`
- **出参**：`Promise<void>`。
- **功能**：委托 `TailscaleCli.serveClear`，摘除该 Service 在本节点上的**全部**端点配置。
- **边缘条件**：**当前没有任何代码路径调用它**（见「待办与隐患」）；它会同时停掉 advertise，副作用远大于 `removeRoute`。

### `describeSource()`

- **签名**：`() => string`
- **出参**：`string`，即 tailscale 可执行文件路径。
- **功能**：界面「数据源」一栏与启动日志使用。
- **边缘条件**：不做存在性检查（路径错了会在第一次真实调用时报错，错误信息里会提示用 `TSCONTROLLER_TAILSCALE_BIN` 指定）。

## 接口与类型

| 名称 | 形状 | 用途 |
| --- | --- | --- |
| `ServeGateway` | `{ snapshot(); tailnet(); upsertRoute(port,path,proxy,service?); removeRoute(port,path,service?); clearService?(service); describeSource() }` | **映射层唯一可见的网关接口**；`test/fakes.ts` 提供内存实现 |
| `RawSelf` | `{ DNSName?, TailscaleIPs?, HostName?, Tags?, CapMap? }` | `status --json` 里 `Self` 的按需读取形状（模块私有） |

`clearService` 在接口上是**可选方法**（`?`），因此假实现可以省略；调用方必须先判存在。

## 待办与隐患

- [ ] **`clearService` 无调用方**：能力已实现并透传，但 `MappingService` 里没有任何路径调用它。删除最后一条 Service 映射时不会停掉 advertise（刻意：避免误停别人的 Service host）。
- [ ] 已知边界：`snapshot()` 对 `get-config` 的失败**静默降级**，因此「Service 面板为空」既可能是「本节点没有 Service」，也可能是「CLI 太老/权限不足」。日志里有 warning，但界面目前无法区分这两者——如果需要，应在 `ServeSnapshot` 上补一个 `serviceReadError` 字段。
