# `src/domain/route-path.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

路径、Service 名与代理地址的**纯函数**工具层。它是映射校验的唯一入口：无论是 API 入参、磁盘数据，还是从 `tailscale serve` 读回的配置，都必须先经过这里归一化。

本文件同时定义「路由身份」的唯一键函数 `serveRouteKey(service, servePort, path)`，以及两个命名空间（节点级 / Service 级）的对外地址拼装规则。

## 依赖 / 引用

- 无 import（零依赖，纯函数）。
- 被 `src/mappings/{reconcile,mapping-service,store}.ts`、`src/tailscale/serve-config.ts`、`src/config.ts`、`src/app.ts`、`src/snapshot.ts`、`test/fakes.ts` 引用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `normalizeRoutePath` | `(input: string) => PathValidation` | `PathValidation` | 校验并归一化挂载路径 | 空串/无前导斜杠/空白/`?#`/反斜杠/控制字符/`.`/`..` 段全部拒绝；折叠重复斜杠、去尾斜杠 |
| `normalizeTargetPath` | `(input?: string \| null) => PathValidation` | `PathValidation` | 归一化「追加到目标上的路径」 | 空串与 `/` 都归一化为 `""` |
| `isValidPort` | `(value: unknown) => value is number` | 类型谓词 | 1–65535 的整数判定 | 字符串 `'80'` 返回 `false`；`1.5`、`0`、`65536` 均 `false` |
| `normalizeServiceName` | `(input?: string \| null) => ServiceNameValidation` | `ServiceNameValidation` | 校验并归一化 Service 名 | 接受 `dsh`/`svc:dsh`，统一为 `svc:dsh`；**大写直接拒绝**，不折叠 |
| `serviceShortName` | `(service: string) => string` | `string` | 去掉 `svc:` 前缀 | 无前缀时原样返回 |
| `normalizeRemoteHost` | `(input?: string \| null) => { ok, host, reason }` | 对象 | 校验远端代理主机 | 空串与回环（`127.0.0.1`/`localhost`）归一化为 `host: null`；拒绝带协议、含空白、超长 |
| `buildProxyUrl` | `(parts: ProxyTargetParts) => string` / 重载 `(hostPort, targetPath?) => string` | `string` | 拼出期望的代理地址 | 远端为空即 `127.0.0.1`；`scheme` 缺省 `http`；目标路径 `''`/`'/'` 都不追加 |
| `parseProxyUrl` | `(raw: string) => ParsedProxy \| null` | `ParsedProxy \| null` | 解析 serve 里的 Proxy 串 | **显式拒绝 `https+insecure://`**；非 http(s) 返回 `null`；端口缺省按协议取 443/80 |
| `isLoopbackHost` | `(host: string) => boolean` | `boolean` | 回环主机名判定 | 大小写不敏感；剥掉 IPv6 方括号；`0.0.0.0` 与 tailnet 名都不是回环 |
| `sameRoutePath` | `(a: string, b: string) => boolean` | `boolean` | 路径是否视为同一条（大小写不敏感） | 只做 `toLowerCase` 比较，不做归一化 |
| `routePathKey` | `(path: string) => string` | `string` | 冲突检测用的路径键 | 同上 |
| `serveRouteKey` | `(service, servePort, path) => string` | `string` | **路由身份的唯一键** | 节点级 Service 位用 `-` 占位；Service 位小写归一 |
| `formatRouteRef` | `(route: {service?, servePort, path}) => string` | `string` | 日志/提示用的路由标签 | 443 省略端口（避免日志噪音）；Service 级加 `svc:x:` 前缀 |
| `buildBaseUrl` | `(hostname, servePort, service?, magicDnsSuffix?) => string` | `string` | 拼出对外基址（不含路径） | 主机名无法确定时返回空串；非 443 带上端口；Service 级用 Service 的 MagicDNS 名 |
| `buildServiceDnsName` | `(service, magicDnsSuffix, nodeDnsName?) => string \| null` | `string \| null` | 拼 Service 的 MagicDNS 名 | 后缀缺失时退回「从节点 DNS 名去掉第一段」；两者都没有返回 `null` |
| `suffixFromNodeDnsName` | `(nodeDnsName?) => string \| null` | `string \| null` | 从节点 DNS 名推导 MagicDNS 后缀 | 无点号的裸名返回 `null` |

## 函数详情

### `normalizeRoutePath(input)`

- **签名**：`(input: string) => PathValidation`
- **入参**：`input`（`string`，必选）：任意用户输入或磁盘值。
- **出参**：`PathValidation`，`{ ok, path, reason }`；`ok === false` 时 `path` 为 `''`、`reason` 为中文原因。
- **功能**：先 trim，再逐条拒绝非法形态，最后把 `//` 折叠、去掉尾斜杠。**大小写保留**（serve 区分大小写），冲突检测另行小写归一。
- **边缘条件**：
  - 空串 / 全空白 → `路径不能为空`；
  - 不以 `/` 开头 → `路径必须以 "/" 开头`；
  - 含 `\`、空白、`?`、`#`、控制字符（`\u0000-\u001f`）→ 各自的原因；
  - 任一段为 `.` 或 `..` → 拒绝（serve 会对请求路径解码后匹配，`..` 语义不可预测）；
  - `'/'` → `{ ok: true, path: '/' }`；`'//calendar//ics//'` → `'/calendar/ics'`。

### `normalizeTargetPath(input?)`

- **签名**：`(input?: string | null) => PathValidation`
- **入参**：`input`（可选，`undefined`/`null` 视为空串）。
- **出参**：`PathValidation`。
- **功能**：空串与 `'/'` 都归一化为 `''`（语义是「不追加路径」），其余交给 `normalizeRoutePath`。
- **边缘条件**：`'/api/agent/'` → `'/api/agent'`；非法路径原样返回拒绝原因。

### `isValidPort(value)`

- **签名**：`(value: unknown) => value is number`
- **入参**：`value`（`unknown`）：可能是字符串（来自 JSON 或表单）。
- **出参**：类型谓词；`true` 时收窄为 `number`。
- **功能**：`Number.isInteger` + `1..65535`。
- **边缘条件**：`'80'`（字符串）→ `false`——字符串端口必须在入参层就被拒绝，不能在这里宽容；`NaN`/`Infinity`/`1.5` → `false`。

### `normalizeServiceName(input?)`

- **签名**：`(input?: string | null) => ServiceNameValidation`
- **入参**：`input`（可选）：`'dsh'` / `'svc:dsh'` / 空。
- **出参**：`{ ok, service, reason }`；`ok` 为真时 `service` 形如 `'svc:dsh'`。
- **功能**：统一两种写法，内部只保留带前缀的一种表示；字符集为 `^[a-z0-9][a-z0-9._-]*$`。
- **边缘条件**：
  - 空串 / 只有 `svc:` 前缀 → 拒绝；
  - **大写直接拒绝**（`'DSH'` → `ok: false`）：名字大小写不同就是不同的 Service，静默改写会指向一个不存在的名字；
  - 点号允许出现在中间（`my-app_1.web` 合法）。

### `serviceShortName(service)` / `isValidPort(value)`

（`isValidPort` 见上表：`(value: unknown) => value is number`，只接受 1–65535 的整数。）

- **签名**：`(service: string) => string`
- **入参**：`service`（`string`，必选）。
- **出参**：`string`，去掉前缀的裸名。
- **功能**：用于拼 MagicDNS 名与界面展示。
- **边缘条件**：大小写不敏感匹配前缀；无前缀时原样返回（不抛错）。

### `normalizeRemoteHost(input?)`

- **签名**：`(input?: string | null) => { ok: boolean; host: string | null; reason: string }`
- **入参**：`input`（可选）：主机名或 IP 字面量。
- **出参**：`ok` 为真时 `host` 是归一化后的主机名，或 `null` 表示「未指定远端」。
- **功能**：把「本机」与「未指定」合并成同一个语义（`host: null`），使调用方只需判断 `host !== null` 就知道要不要写远端地址。
- **边缘条件**：
  - `''` / `'127.0.0.1'` / `'localhost'` → `{ ok: true, host: null }`（**这是刻意的**：`remoteHost` 的语义就是「非本机」）；
  - 含 `://` → `ok: false`（协议由 `scheme` 字段表达）；
  - 含空白或超长（>253）→ `ok: false`；
  - 允许的字符集包含 `[]:`，以便 IPv6 字面量书写。

### `buildProxyUrl(partsOrPort, targetPathArg?)`

- **签名**：重载 —— `(parts: ProxyTargetParts) => string` 与 `(hostPort: number, targetPath?: string) => string`。
- **入参**：
  - 对象形式：`hostPort`（必选）、`targetPath?`、`remoteHost?`、`scheme?`；
  - 兼容形式：`hostPort`、`targetPath`（旧调用点保留，行为逐字不变）。
- **出参**：`string`，例如 `http://127.0.0.1:443/api/agent` / `http://my-laptop.example-tailnet.ts.net:3081`。
- **功能**：远端为空即 `127.0.0.1`；`targetPath` 为 `''` 或 `'/'` 时不追加。
- **边缘条件**：布尔判断用 `typeof partsOrPort === 'number'`，因此**传 `0` 会走数字分支**（会拼出 `:0`）；调用方必须先过 `isValidPort`。

### `parseProxyUrl(raw)`

- **签名**：`(raw: string) => ParsedProxy | null`
- **入参**：`raw`（`string`，必选）：serve 配置里的 `Proxy` 原文。
- **出参**：`ParsedProxy | null`：`{ host, hostPort, targetPath, loopback }`；`null` 表示这不是能接管的代理形态。
- **功能**：`new URL` 解析后只接受 `http:`/`https:`，剥掉 IPv6 方括号，路径 `'/'` 归一化为 `''`。
- **边缘条件**：
  - **`https+insecure://…` 显式返回 `null`**（`new URL` 会接受这种伪协议，必须提前排除，否则会被当成 HTTPS 目标接管）；
  - 端口缺省按协议取 `443`/`80`；
  - 非法端口（`isValidPort` 不过）→ `null`；
  - `http://host:3081/api` → `targetPath === '/api'`。

### `isLoopbackHost(host)`

- **签名**：`(host: string) => boolean`
- **入参**：`host`（`string`，必选）。
- **出参**：`boolean`。
- **功能**：`127.0.0.1` / `localhost` / `::1` / `0:0:0:0:0:0:0:1` 判定；被 `config.ts`（监听地址校验）与 `app.ts`（Host 头校验）复用，也在暴露判定里区分本机与远端目标。
- **边缘条件**：`0.0.0.0`、`100.x`、tailnet 名一律 `false`；输入带方括号或大写都能正确判定。

### `sameRoutePath(a, b)` / `routePathKey(path)`

- **签名**：`(a: string, b: string) => boolean` / `(path: string) => string`
- **出参**：`boolean` / `string`。
- **功能**：冲突检测按大小写不敏感处理（用户在界面里输入 `/App` 与 `/app` 更可能是同一条路由）。
- **边缘条件**：只做 `toLowerCase`，**不**折叠斜杠、不去尾斜杠——归一化是 `normalizeRoutePath` 的职责。

### `NODE_SCOPE`

- **签名**：模块私有常量，`'-'`。
- **功能**：`serveRouteKey` 里节点级路由的 Service 位占位符，保证它不会与任何 `svc:*` 冲突。
- **边缘条件**：`null` / `undefined` / `''` 三种「无 Service」表示都会走它。

### `serveRouteKey(service, servePort, path)`

- **签名**：`(service: string | null | undefined, servePort: number, path: string) => string`
- **出参**：`-|443|/app`（节点级）或 `svc:dsh|443|/`（Service 级）。
- **功能**：**跨路由匹配、去重、归属判断的唯一键**。三个维度缺一不可：Service 决定对外主机名，端口决定 origin，路径是挂载点。
- **边缘条件**：Service 位小写归一（`svc:DSH` 与 `svc:dsh` 同键）；路径位小写归一；端口原样。

### `formatRouteRef(route)`

- **签名**：`(route: { service?: string | null; servePort: number; path: string }) => string`
- **出参**：`/worldforge`（节点级 443）、`:8443/`（节点级非 443）、`svc:dsh:/`（Service 级）。
- **功能**：日志与界面统一标签，与前端 `formatRouteLabel` 同构。
- **边缘条件**：443 一律省略端口（既有约定，改动会破坏日志断言）。

### `buildBaseUrl(hostname, servePort, service?, magicDnsSuffix?)`

- **签名**：`(hostname: string | null, servePort: number, service?: string | null, magicDnsSuffix?: string | null) => string`
- **入参**：`hostname` 是**节点级**主机名；Service 级时忽略它，改用 `buildServiceDnsName(service, magicDnsSuffix, hostname)`。
- **出参**：`string`，如 `https://host.ts.net` / `https://host.ts.net:8443` / `https://dsh.ts.net`；无法确定主机名时返回 `''`。
- **功能**：对外链接的唯一拼装点（`reconcile.evaluateMapping` 与 `snapshot.buildSnapshot` 都用它）。
- **边缘条件**：
  - `hostname` 为 `null` 且 `service` 为 `null` → `''`（调用方据此隐藏链接，而不是给一个错地址）；
  - Service 级在后缀与节点 DNS 名都拿不到时同样返回 `''`；
  - 非 443 端口**必须**带上：`https://host:8443` 与 `https://host` 是两个不同 origin。

### `buildServiceDnsName(service, magicDnsSuffix, nodeDnsName?)`

- **签名**：`(service: string, magicDnsSuffix: string | null, nodeDnsName?: string | null) => string | null`
- **入参**：后缀优先取 `status --json` 的 `CurrentTailnet.MagicDNSSuffix`；`nodeDnsName` 是兜底。
- **出参**：`string | null`，如 `dsh.example-tailnet.ts.net`。
- **功能**：拼 Service 的对外名字（不含端口）。
- **边缘条件**：`magicDnsSuffix` 为空时退回 `suffixFromNodeDnsName(nodeDnsName)`；两者都空返回 `null`；后缀的首尾点会被清掉。

### `suffixFromNodeDnsName(nodeDnsName?)`

- **签名**：`(nodeDnsName?: string | null) => string | null`
- **出参**：`string | null`。
- **功能**：`my-laptop.example-tailnet.ts.net` → `example-tailnet.ts.net`（去掉第一段）。
- **边缘条件**：空、无点号（`'laptop'`）、以点结尾（先剥尾点再取）都有明确结果。

## 全局常量 / 变量

- `LOOPBACK_HOST` = `'127.0.0.1'`：本机代理目标的默认主机。
- `SERVICE_PREFIX` = `'svc:'`：Service 名前缀，前后端对齐（前端在 `web/src/utils.ts` 有同名常量）。
- `NODE_SCOPE` = `'-'`：模块私有，`serveRouteKey` 里节点级的占位符。

## 待办与隐患

- [ ] 无 TODO 标记。设计约束：**本文件必须保持零依赖、纯函数**——一旦引入 IO 或 logger，`planReconcile` 的可穷举测试能力就会被破坏。
- [ ] 已知边界：`normalizeServiceName` 的字符集是按 Tailscale Service 名的实际约束收窄的；若上游放宽（例如允许大写），这里必须同步，否则会拒绝合法名字。
