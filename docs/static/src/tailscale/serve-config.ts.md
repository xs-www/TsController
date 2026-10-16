# `src/tailscale/serve-config.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

`tailscale serve` 配置的解析层。**这里有两个互不相同、且都必须读的数据源**：

| 来源 | 内容 | 入口函数 |
| --- | --- | --- |
| `tailscale serve status --json` | **只有节点级**路由（`{TCP, Web}`） | `parseServeStatus()` |
| `tailscale serve get-config --all` | **只有 Service 级**端点（`{version, services}`） | `parseServiceConfig()` |
| `tailscale status --json` → `Self.CapMap["service-host"]` | 本节点被承认服务哪些 Service | `parseServiceHostCap()`（在 `tailscale-service.ts`） |

三者由 `mergeServeSnapshots()` 合并成一份 `ServeSnapshot`。

**为什么必须读第二个**：官方明确写着这两个命令返回的信息不同，Service 列表只在 `get-config` 里（[tailscale#18289](https://github.com/tailscale/tailscale/issues/18289)）。只读 `status --json` 会让 Service 路由对 TsController 完全不可见——既管不了，**安全闸门也扫不到**。这与早期「只取一组 `Web` 导致非 443 端口不可见」是同一类缺口。

## 依赖 / 引用

- `../domain/route-path.ts`：`parseProxyUrl`、`serviceShortName`。
- `../domain/types.ts`：`ServiceInfo`、`ServeHandler`、`ServeRoute`、`ServeSnapshot`。
- 被 `src/tailscale/tailscale-service.ts`（网关）与 `test/{serve-config,service-config,reconcile,snapshot}.test.ts` 引用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `parseHandler` | `(value: unknown) => ServeHandler` | `ServeHandler` | 解析单个 handler 对象 | 非对象/无已知键 → `{kind:'other', raw: JSON}`；`Proxy` 解析失败 → `hostPort: null` 而非丢弃 |
| `splitHostPort` | `(key: string) => { host, port }` | 对象 | 从 `"host:443"` 拆出主机与端口 | 无冒号 → `port: null`；端口非整数 → `null` |
| `parseEndpointKey` | `(key: string) => { protocol, port } \| null` | 对象或 `null` | 解析 `tcp:443` / `tcp:443-8443` | 无端口（`tun`）、`0`、`>65535`、格式不符 → `null` |
| `parseServeStatus` | `(raw: unknown) => ServeSnapshot` | `ServeSnapshot` | 解析节点级 serve 配置（**遍历全部 `Web` 组**） | 空配置 `{}` → 空快照；只认 `HTTPS: true` 的 TCP 声明 |
| `parseServiceConfig` | `(raw: unknown, magicDnsSuffix?) => ServeSnapshot` | `ServeSnapshot` | 解析 `get-config --all` 的 Service 端点 | 空/未知输入 → 空快照；`tcp:`/`unix:`/无法归类的目标都归 `other` 并保留 |
| `parseServiceTarget` | `(target: string) => ServeHandler \| null` | `ServeHandler \| null` | 目标串 → handler | `tcp:`/`tls-terminated-tcp:`/`unix:` → `other`；非 http(s) → `null`；`https+insecure` → `other` |
| `mergeServeSnapshots` | `(nodeLevel, serviceLevel, serviceHosts?) => ServeSnapshot` | `ServeSnapshot` | 合并两个来源 + service-host 能力 | 只在 `serviceHosts` 里出现的 Service 也会被列出（`dnsName: null`） |
| `proxiedRoutes` | `(snapshot) => ServeRoute[]` | `ServeRoute[]` | 过滤出可托管的代理路由 | 无 `hostPort` 的代理被排除 |
| `snapshotHostname` | `(snapshot) => string \| null` | `string \| null` | 取节点级主机名 | 直接返回 `snapshot.hostname` |
| `serviceInfoOf` | `(snapshot, service) => ServiceInfo \| null` | `ServiceInfo \| null` | 按名字查 Service 状态 | 大小写不敏感；找不到返回 `null` |

## 函数详情

### `isRecord(value)` — 模块私有

- **签名**：`(value: unknown) => value is Record<string, unknown>`
- **入参**：任意值。
- **出参**：类型谓词。
- **功能**：排除 `null` 与数组的「纯对象」判定，是本文件所有解析分支的第一道守卫。
- **边缘条件**：`null`、数组、`Date`、原始值一律 `false`（因此 `[]` 不会被当成对象解析，避免了「数组被展开成数字键」的意外）。

### `parseHandler(value)`

- **签名**：`(value: unknown) => ServeHandler`
- **入参**：`value`（`unknown`）：`{"Proxy": "http://127.0.0.1:8080"}` 这类对象。
- **出参**：`ServeHandler`；proxy 变体带 `raw`、`hostPort`、`host`、`targetPath`、`loopback`。
- **功能**：按 `Proxy` → `Path`/`Text` 的顺序识别；`Path` 归 `file`、`Text` 归 `text`。
- **边缘条件**：
  - 非对象 → `{kind:'other', raw: JSON.stringify(value ?? null)}`（**不抛错**，也不丢弃）；
  - `Proxy` 存在但解析失败（例如 `https+insecure://`）→ 仍然是 `proxy` 但 `hostPort: null`、`loopback: false`；这类条目由 `proxiedRoutes()` 过滤掉，不进托管候选。

### `splitHostPort(key)`

- **签名**：`(key: string) => { host: string; port: number | null }`
- **入参**：`key`（`string`）：`Web` 的键，形如 `my-laptop.example-tailnet.ts.net:443`。
- **出参**：主机名与端口。
- **功能**：用 `lastIndexOf(':')` 拆分，因此 IPv6 主机名里的冒号不会误伤。
- **边缘条件**：无冒号 → `{ host: key, port: null }`；端口段非整数 → `port: null`（调用方回落默认端口）。

### `parseEndpointKey(key)`

- **签名**：`(key: string) => { protocol: string; port: number } | null`
- **入参**：`key`（`string`）：`get-config` 里的端点键。
- **出参**：`{ protocol, port }`（区间只取起始端口）或 `null`。
- **功能**：匹配 `^([a-z]+):(\d+)(?:-(\d+))?$`（大小写不敏感）。
- **边缘条件**：
  - `'tun'`（L3 端点，无端口）→ `null`，调用方跳过该端点；
  - `'tcp:0'`、`'tcp:70000'`、`'tcp:'` → `null`；
  - 协议名一律小写化（`'TCP:80'` → `tcp`）。

### `parseServeStatus(raw)`

- **签名**：`(raw: unknown) => ServeSnapshot`
- **入参**：`raw`（`unknown`）：`serve status --json` 的解析结果，结构为 `{TCP: {"443": {HTTPS: true}}, Web: {"host:443": {Handlers: {"/path": {Proxy: "..."}}}}}`。
- **出参**：`ServeSnapshot`（`hostname` 取第一个 `Web` 键的主机名，`routes[].service` 一律 `null`，`services: []`）。
- **功能**：**遍历全部 `Web` 组**，每个端口一条 `Web` 键（`host:443`、`host:8443`…），把路由扁平化并各自带 `servePort`。
- **边缘条件**：
  - 无配置时 tailscale 输出 `{}` → 返回空快照（`httpsPorts: []`、`hostname: null`、`routes: []`），**不抛错**；
  - `TCP` 里只统计 `HTTPS === true` 的端口（`HTTP: true` 不计入，`httpsPorts` 的语义是「需要被安全检查盯住的 HTTPS 出口」）；
  - `Web` 键缺端口时回落到最小的已声明 HTTPS 端口（正常不会发生）；
  - 非对象输入按 `{}` 处理。

### `parseServiceConfig(raw, magicDnsSuffix?)`

- **签名**：`(raw: unknown, magicDnsSuffix?: string | null) => ServeSnapshot`
- **入参**：`raw` 是 `get-config --all` 的输出；`magicDnsSuffix` 用于拼 Service 的对外主机名。
- **出参**：`ServeSnapshot`：`routes[]` 的 `service` 非空、`path` 固定 `'/'`；`services[]` 每个 Service 一条；`httpsPorts` 只含**目标为 http(s)** 的端点端口。
- **功能**：逐 Service 逐端点转换。端点键只声明 L4 监听（`tcp:443`），**真正决定这一跳是不是 HTTP 的是目标串的协议**，因此 `httpsPorts` 按目标协议判定。
- **边缘条件**：
  - 空输入 / 非对象 → 空快照；
  - 目标为空串 → 该端点不产生路由；
  - `tcp://…`（L4 转发）、`unix:…`、以及**无法归类的目标串**都归为 `other` 并**保留**在 `routes` 里（只读展示）——静默丢弃会让「本节点上还有一条我没看见的端点」这种事发生；
  - `advertised` **只在配置里显式为 `true` 时才采信**；缺省一律 `false`。理由是：本节点是否真被承认，唯一证据是 `status --json` 的 `service-host` 能力，配置里的缺省值不可信（否则一条半成品配置会让界面误报 `active`）；
  - 后缀缺失时 `host` 退化为裸 Service 名（`'dsh'`），不抛错。

### `parseServiceTarget(target)`

- **签名**：`(target: string) => ServeHandler | null`
- **入参**：`target`（`string`）：URI 形式，如 `http://host:3081` / `tcp://127.0.0.1:5432` / `unix:/path`。
- **出参**：`ServeHandler | null`：http(s) → `proxy`（带 `fromServiceConfig: true`）；`tcp:` / `tls-terminated-tcp:` / `unix:` → `other`；**其它一律 `null`**（调用方按 `other` 展示）。
- **功能**：把 `get-config` 的目标串映射成与节点级一致的 handler 形状，使上层逻辑无需区分来源。
- **边缘条件**：
  - 不以 `://` 分隔（例如用 `tcp:` 前缀但格式怪）→ 协议判定为 `''` → `null`；
  - `https+insecure://…` → `parseProxyUrl` 返回 `null` → 归 `other`（不能按普通 HTTPS 接管，因为证书校验策略不同）；
  - `http://host:3081/api` 的 `/api` 会被解析进 `targetPath`，但**上游 `get-config` 通常读不回目标路径**（见「待办与隐患」）。

### `mergeServeSnapshots(nodeLevel, serviceLevel, serviceHosts?)`

- **签名**：`(nodeLevel: ServeSnapshot, serviceLevel: ServeSnapshot, serviceHosts: Record<string, string[]> = {}) => ServeSnapshot`
- **入参**：两个来源的快照，以及（可选）`service-host` 能力映射 `{ "svc:dsh": ["100.65.32.1", …] }`。
- **出参**：合并后的 `ServeSnapshot`：端口取并集，路由拼接，`services` 按名字排序。
- **功能**：用 `serviceHosts` 给 `ServiceInfo` 补 `advertised: true` 与 TailVIP；**只在 `serviceHosts` 里出现、配置里没有端点的 Service 也会被列出**（状态是「已被承认但没有端点配置」，同样值得让用户看到）。
- **边缘条件**：
  - 两个来源的路由键不可能撞车（`service` 维度不同），因此这里是纯拼接，不做去重；
  - `hostname` 取节点级的；只有 Service 配置时为 `null`（**刻意不拿 Service 的 DNS 名冒充节点级主机名**）；
  - `serviceHosts` 里已是 `true` 的条目不会被降级为 `false`。

### `proxiedRoutes(snapshot)`

- **签名**：`(snapshot: ServeSnapshot) => ServeRoute[]`
- **出参**：`ServeRoute[]`。
- **功能**：只保留 `kind === 'proxy'` 且 `hostPort !== null` 的路由——这是「可接管候选」的定义。
- **边缘条件**：`file`/`text`/`other` 与解析不出端口的代理都被排除。

### `snapshotHostname(snapshot)`

- **签名**：`(snapshot: ServeSnapshot) => string | null`
- **出参**：节点级主机名（`snapshot.hostname`）。
- **功能**：薄查询函数，避免调用方到处写字段访问。
- **边缘条件**：只有 Service 配置、没有节点级 `Web` 时为 `null`（**刻意不拿 Service 的 DNS 名冒充**）。

### `serviceInfoOf(snapshot, service)`

- **签名**：`(snapshot: ServeSnapshot, service: string) => ServiceInfo | null`
- **出参**：`ServiceInfo` 或 `null`。
- **功能**：按名字查 Service 状态（界面与 reconcile 的 `awaitingApprovalOf` 都用它）。
- **边缘条件**：名字比较**大小写不敏感**；找不到返回 `null`（调用方据此区分「没有这个 Service」与「有但未承认」）。

## 全局常量 / 变量

- `PROXY_KEYS` = `['Proxy']`、`NON_PROXY_KEYS` = `['Path', 'Text']`：handler 识别顺序。加新键时要注意顺序即优先级。

## 待办与隐患

- [ ] **`get-config` 的往返是有损的**（上游 `runServeGetConfig` 只序列化根 handler 与端点映射，且用 `net.SplitHostPort` 拆 Proxy）：① 一个 Service 上额外 `--set-path` 挂出的子路径不会出现在读回结果里；② **目标路径会丢**。因此 Service 路由的目标路径以**映射库为唯一权威**，读回值只用于状态判定，绝不用于重建配置。
- [ ] 解析层依赖上游两种 JSON 格式；Tailscale 1.102 已引入 services 格式，未来任一格式变化都需要同步本文件。缓解：写入路径用的是稳定的 `--set-path` / `--service` CLI，解析失败时 `planReconcile` 只会认为「位置不存在」而跳过删除，不会误删已生效的路由。
