# `test/fakes.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

测试替身与夹具工厂：一个纯内存的 `ServeGateway`（`FakeServeGateway`）与一个纯内存的容器来源（`FakeContainerSource`），外加 `makeContainer()` 这种「造一条容器」的便捷函数。有了它们，`MappingService` 的全部收敛逻辑与 HTTP API 行为都能在**无 Docker、无 Tailscale CLI** 的环境里被完整覆盖——这正是本文件存在的理由：真机验证脚本（`scripts/verify-*.ts`）依赖真实 tailnet，而回归防线不能依赖它。

本文件同时承载了**路由身份的测试侧编码约定**：外部用可读简写键（`"/app"`），内部一律用 `serveRouteKey()` 产出的 `service|port|path` 三元组键。

## 依赖 / 引用

- `vitest`：**不导入**（本文件不含任何用例，只是被各测试文件导入的模块）。
- `../src/domain/route-path.ts` 的 `serveRouteKey`：本文件内部键的唯一生成方式。
- `../src/domain/types.ts` 的 `ContainerInfo` / `ServeRoute` / `ServeSnapshot` / `ServiceInfo` / `TailnetInfo`（仅类型）。
- `../src/docker/docker-service.ts` 的 `ContainerSource`（仅类型）；`../src/tailscale/tailscale-service.ts` 的 `ServeGateway`（仅类型）。
- 被 `test/reconcile.test.ts`（`makeContainer` + `parseFakeRouteKey`）、`test/service-routing.test.ts`（三个都给）、`test/mapping-service.test.ts`、`test/api.test.ts` 使用。这是**测试目录里被引用最广的文件**，改它的默认值会同时影响四个测试文件。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `parseFakeRouteKey` | `(key: string) => { service; servePort; path }` | 三元组 | 把测试简写键（`"/app"` / `":8443/app"` / `"svc:dsh:443/"`）解析成 `(Service, 端口, 路径)` | 三段都是**可选的**；两段正则都可用时端口段必须先出现，否则整串被当成路径（见下方「边缘条件」，含一处易踩的文档与实现不一致） |
| `FakeServeGateway.constructor` | `(initial?: Record<string, string>, extraPorts?: number[])` | `FakeServeGateway` | 用简写键批量预置路由，并把这些端口登记为「已声明的 HTTPS 端口」 | `initial` 的键必须过 `parseFakeRouteKey`；**值必须能过 `new URL()`**（在 `snapshot()` 时才炸） |
| `FakeServeGateway.proxyOf` | `(path: string, servePort?: number = 443, service?: string \| null = null) => string \| undefined` | `string \| undefined` | 取某条路由的代理地址 | 不存在返回 `undefined`（用于断言「不该被写入的命名空间」确实是空的） |
| `FakeServeGateway.has` | `(path: string, servePort?: number = 443, service?: string \| null = null) => boolean` | `boolean` | 某条路由是否存在 | 与 `proxyOf` 同键，仅返回值不同 |
| `FakeServeGateway.set` | `(path: string, proxy: string, servePort?: number = 443, service?: string \| null = null) => void` | `void` | 直接摆一条前置状态（**不记调用轨迹**） | 顺带把 `servePort` 加进 `httpsPorts`；因此「未调用 apply 却看到端口已声明」是正常现象 |
| `FakeServeGateway.addService` | `(name: string, ports: number[], advertised?: boolean = true, vipIps?: string[] = []) => ServiceInfo` | `ServiceInfo` | 声明一个 Service（可按名覆盖已有项） | 同名旧项被**整体替换**；`ports` 会排序；`dnsName` 去掉 `svc:` 前缀后拼固定后缀 |
| `FakeServeGateway.fail` | `(path: string, servePort?: number = 443, service?: string \| null = null) => void` | `void` | 让该位置的下一次 `upsertRoute()` 抛错 | 抛的是普通 `Error`（消息含「模拟失败：无法挂载」），用于验证失败可重试 |
| `FakeServeGateway.failDeletion` | `(path: string, servePort?: number = 443, service?: string \| null = null) => void` | `void` | 让该位置的下一次 `removeRoute()` 抛错 | 消息含「模拟失败：无法摘除」 |
| `FakeServeGateway.routes` | `() => Array<{ service; servePort; path; proxy }>` | 路由数组 | 把内部键拆回结构化的全部路由位置 | 直接对 `handlers` 的插入顺序做映射，**未排序**；只用于断言集合成员，不要依赖顺序 |
| `FakeServeGateway.describeSource` | `() => string` | `'fake-tailscale'` | 数据来源描述 | 固定串，便于断言界面/日志里的来源文案 |
| `FakeServeGateway.snapshot` | `() => Promise<ServeSnapshot>` | 快照 | 把 `handlers` 现算成 serve 快照（节点级 + Service 级混合） | 逐条 `new URL(proxy)`：插入了非 URL 字符串会在此抛 `TypeError`；`host` 按有无 Service 推导；端口列表排序 |
| `FakeServeGateway.tailnet` | `() => Promise<TailnetInfo>` | tailnet 身份 | 返回 `tailnetInfo` 的**深拷贝** | 用 `structuredClone`，用例改返回值不会污染替身本身 |
| `FakeServeGateway.upsertRoute` | `(servePort, path, proxyUrl, service?) => Promise<void>` | `void` | 实现 `ServeGateway`：先记轨迹，命中 `failUpsert` 则抛错，否则写入 | 轨迹**先于**失败判定写入，因此失败调用也出现在 `calls` 里 |
| `FakeServeGateway.removeRoute` | `(servePort, path, service?) => Promise<void>` | `void` | 实现 `ServeGateway`：先记轨迹，命中 `failRemove` 则抛错，否则删除 | 删除不存在的键是静默无操作 |
| `FakeServeGateway.clearService` | `(service: string) => Promise<void>` | `void` | 摘掉某 Service 在本节点的全部路由，并把它从 `services` 里移除 | 记入 `clearedServices`；按字符串精确比较 Service 名（大小写敏感） |
| `unkey` | `(key: string) => { service; servePort; path }` | 三元组 | 内部键的逆运算：`service\|port\|path` → 对象 | `-` 还原为 `null`；模块私有，不导出 |
| `FakeContainerSource.constructor` | `(containers?: ContainerInfo[] = [])` | `FakeContainerSource` | 用一份容器清单初始化 | 持有引用而非拷贝，但 `listContainers()` 返回深拷贝 |
| `FakeContainerSource.describeSource` | `() => string` | `'fake-docker'` | 数据来源描述 | 固定串 |
| `FakeContainerSource.listContainers` | `() => Promise<ContainerInfo[]>` | 容器数组 | 返回容器清单的深拷贝 | 永不为 `null`；空清单就是空数组 |
| `makeContainer` | `(name, ports, state?) => ContainerInfo` | `ContainerInfo` | 造一条容器夹具 | `id` 补零到 64 位；`state` 决定 `status` 文案；`hostIp` 默认 `127.0.0.1`；`createdAt` 固定 |

## 函数详情

### `parseFakeRouteKey(key)`

- **签名**：`(key: string) => { service: string | null; servePort: number; path: string }`
- **入参**：
  - `key`（`string`，必选）：测试简写键。三段语法彼此独立，按「先 Service、再端口」的顺序各匹配一次。
- **出参**：`{ service, servePort, path }` 三元组；`servePort` 恒为数字（缺省即 `TEST_SERVE_PORT` = 443）。
- **功能**：把可读简写翻译成路由身份，供构造函数与 `test/reconcile.test.ts` 的 `snapshotOf()` 组装原始 serve JSON。
- **解析规则（逐段）**：
  - **Service 段**：形如 `svc:<名字>:` 的**前缀**，正则 `^(svc:[a-z0-9._-]+):(.*)$`。只认小写字母、数字、`.`、`_`、`-`；名字里出现其它字符（例如大写）会导致整段不匹配，于是该键**退化为纯路径**（`path` 等于含 `svc:` 的原串），而不是报错。
  - **端口段**：形如 `:<数字>` 的**前缀**，正则 `^:(\d+)(\/.*)$`。必须**同时**有端口与一个以 `/` 开头的后缀；因此 `":8443"`（没有路径）不匹配，会连同整个剩余串被当成路径。
  - **路径段**：两段都没匹配到的剩余部分**原样保留**，不做归一化。
- **示例**：`"/app"` → `{service: null, servePort: 443, path: "/app"}`；`":8443/app"` → `{service: null, servePort: 8443, path: "/app"}`。
- **边缘条件**：
  - 文档（文件头与函数注释）写的示例 `"svc:dsh:443/"` 与实现**不一致**：Service 正则要求 `svc:` 与下一个 `:` 之间只能是 `[a-z0-9._-]`，而 `dsh:443` 含 `:`，因此该正则不匹配；随后剩余串 `svc:dsh:443/` 也不匹配端口正则（端口段必须在串首），最终结果是 `{service: null, servePort: 443, path: "svc:dsh:443/"}`，而不是「Service = `svc:dsh`、端口 443」。**要同时给出 Service 与端口，只能写成 `"svc:dsh:/path"` 之类的「Service 段 + 剩余即路径」形态，端口则必须靠显式参数**（例如 `proxyOf(path, 8443, 'svc:dsh')` 或 `parseFakeRouteKey` 之后自行改端口）；现有测试均未使用该写法（`test/reconcile.test.ts` 只用 `"/a"` 与 `":8443/a"`），所以这个不一致不会让红。
  - 空串 `""` → `{service: null, servePort: 443, path: ""}`。`serveRouteKey(null, 443, '')` 仍会生成合法的键 `-|443|`（只是末段为空），不会被任何真实路由命中。
  - 端口段虽然限制了 `\d+`，但没限制范围：`:0/a` 与 `:99999/a` 都会被接受并原样转成数字（本文件不承担端口校验，那是 `src/domain/route-path.ts` 的 `isValidPort()` 的职责）。
  - 名为 `svc:my-app_1.web` 的 Service 能正确进入 Service 段；`svc:DSH` 不能。

### `FakeServeGateway` 的字段与键格式

- **字段清单**：
  - `handlers`：`Map<string, string>`，键为 `serveRouteKey(service, servePort, path)`，值就是「真实」的 serve 配置里那条 `Proxy` 字符串。
  - `httpsPorts`：`Set<number>`，初始为 `{443}`，`set()` / `addService()` / `upsertRoute()` / 构造函数都会往里加端口。它是 `snapshot().httpsPorts` 的唯一来源。
  - `services`：`ServiceInfo[]`，默认空；由 `addService()` 写入、`clearService()` 删除。真实网关注入的 `serviceHosts` 不在字段里，而是靠 `addService` 的 `advertised` 参数模拟。
  - `tailnetInfo`：可整体替换的对象（用例用 `gateway.tailnetInfo = { ...gateway.tailnetInfo, tags: [...] }` 这种写法改 tag）。
  - `failUpsert` / `failRemove`：两个 `Set<string>`，装「要失败的键」。
  - `calls`：`{ op: 'upsert' | 'remove'; service; servePort; path; proxy? }[]`，是断言「到底往哪个命名空间写了」的主要依据。
  - `clearedServices`：`string[]`，`clearService()` 的调用轨迹（对应 `ServeGateway.clearService` 这个**可选能力**）。
- **内部键编码**：`<service|->|<servePort>|<path 小写>`，例如节点级 443 的 `/App` 编码为 `-|443|/app`，Service `svc:dsh` 的同一路径编码为 `svc:dsh|443|/app`。`-` 是节点级（`service === null`）的占位符，由 `serveRouteKey()` 统一产出、由 `unkey()` 还原为 `null`。
- **边缘条件**：`unkey()` 用 `split('|')` 做逆运算，因此**路径里出现 `|` 会被截断**（`parts[2]` 只取到第一个 `|` 之前）。`normalizeRoutePath()` 不禁止 `|`，所以含 `|` 的路径在这个替身上会表现异常——现有用例的路径都不含 `|`，但这属于替身与真实网关的差异，写新用例时要避开。

### `FakeServeGateway.snapshot()`

- **签名**：`() => Promise<ServeSnapshot>`
- **出参**：`ServeSnapshot`，字段全部由当前内存状态现算：`httpsPorts` 升序、`hostname` 固定为 `my-laptop.example-tailnet.ts.net`、`routes` 排序、`services` 深拷贝。
- **功能**：这是整个替身里唯一「把内存状态翻译成真实网关输出形状」的地方，因此它也刻意复刻了两条真实语义：
  - 有 `service` 的路由，`host` 是 `<short service>.example-tailnet.ts.net`；节点级则是节点 DNS 名；
  - 有 `service` 的路由，`handler` 上会带 `fromServiceConfig: true`——与真实网关「Service 配置读回来的端点带该标记」一致，防止测试把两种来源混为一谈。
- **边缘条件**：
  - 每条路由都跑 `new URL(proxy)`：`set()` / 构造函数里塞了非 URL 字符串（例如 `"nonsense"`）会在**快照阶段**抛 `TypeError`，而 `parseServiceTarget()` 对同样的输入只会归为 `other`。替身比真实解析器更严格。
  - `handler.hostPort` 来自 `Number(parsed.port)`；`http://127.0.0.1` 这类省略端口的地址会得到 `NaN`，而真实的 `parseProxyUrl()` 会按协议回落到 80/443。
  - `handler.targetPath` 把 `'/'` 归一化为 `''`（与真实解析器一致）。
  - `host` 直接用 `URL.hostname`，**IPv6 会保留方括号**（`http://[::1]:8443` → `'[::1]'`）；真实链路里的 `parseProxyUrl()` 会额外 `replace(/^\[|\]$/g, '')` 去掉方括号。因此含 IPv6 目标的断言在替身与真实实现下会得到不同的 `host` 字符串——现有用例只用 IPv4/主机名，没有踩到。
  - 端口列表、路由列表都重新排序，因此快照的 `routes` 顺序是确定的：先 `servePort`，再 `service`（`null` 视作 `''`，排在所有 `svc:*` 之前），最后 `path`。

### `FakeServeGateway.upsertRoute()` / `removeRoute()`

- **签名**：`(servePort: number, path: string, proxyUrl: string, service?: string | null) => Promise<void>` / `(servePort: number, path: string, service?: string | null) => Promise<void>`
- **功能**：实现 `ServeGateway` 的两个写接口，并在写之前把调用推进 `calls`。**先记轨迹、后判失败**，所以一次「模拟失败」的调用既能被断言「确实尝试过」，又能被断言「状态没有改变」。
- **边缘条件**：
  - 命中 `failUpsert` / `failRemove` 时抛普通 `Error`（不是 `DockerApiError` 之类的领域错误），`MappingService` 会把它转成 `apply.errors` 里的一条字符串。
  - `removeRoute()` 对不存在的键静默成功（`Map.delete` 语义）。
  - 失败标记是**持久的**：只要不移除 `failUpsert` 里的键，之后每次写同一位置都会失败——这正是「失败可重试」用例需要的行为。

### `FakeServeGateway.clearService()`

- **签名**：`(service: string) => Promise<void>`
- **功能**：模拟真实网关的可选能力「摘掉某个 Service 在本节点上的全部端点配置」：把 `handlers` 里所有 `unkey().service === service` 的项删掉，并把该 Service 从 `services` 里移除。
- **边缘条件**：
  - 只比较**精确字符串**（大小写敏感），不经过 `serviceShortName()`；传裸名 `dsh` 不会删掉 `svc:dsh` 的项。真实实现会交给 CLI，由上游决定大小写语义。
  - 遍历前先 `[...this.handlers.entries()]` 拷贝，避免边遍历边删。
  - 删掉 `services` 项会让该 Service 从后续快照中消失，从而让依赖「Service 是否被承认」的状态判定发生变化。

### `unkey(key)`

- **签名**：`(key: string) => { service: string | null; servePort: number; path: string }`
- **入参**：`key`（`string`，必选）：`serveRouteKey()` 产出的内部键。
- **出参**：三元组；`service` 为 `null` 表示节点级。
- **功能**：`serveRouteKey()` 的逆运算，供 `routes()` 与 `clearService()` 使用。
- **边缘条件**：模块私有（不导出），且不做校验——段数不足时 `Number(undefined)` 得到 `NaN`、`parts[2]` 得到 `undefined`（类型断言掩盖了这一点）。它只被喂本文件自己生成的键，因此现状安全；但**不要**在测试里手工往 `handlers` 里塞非规范键。

### `FakeContainerSource`

- **签名**：`constructor(containers: ContainerInfo[] = [])`、`describeSource() => string`、`listContainers() => Promise<ContainerInfo[]>`
- **功能**：`ContainerSource` 的内存实现。`listContainers()` 返回 `structuredClone`，因此 `MappingService` 对结果的任何加工都不会回写夹具；反过来，用例也可以在 `service.create()` 之后修改 `containers.containers` 来模拟容器消失。
- **边缘条件**：没有「失败」开关——本替身无法模拟 Docker 不可用；需要那条路径的用例必须自己写一个 `ContainerSource` 实现。

### `makeContainer(name, ports, state?)`

- **签名**：`(name: string, ports: Array<{ hostPort: number; containerPort: number; hostIp?: string }>, state = 'running') => ContainerInfo`
- **入参**：
  - `name`（`string`，必选）：容器名，同时被复用到 `image`、`composeProject`、`composeService`；
  - `ports`（数组，必选）：每项给出 `hostPort` 与 `containerPort`，`hostIp` 可选（默认 `127.0.0.1`，即「只在回环发布」）；
  - `state`（`string`，可选，默认 `'running'`）：Docker 状态串。
- **出参**：`ContainerInfo`。
- **功能**：造一条容器夹具，字段取值刻意固定，让断言可以写死。
- **边缘条件**：
  - `id` 为 `` `id-${name}` `` 后再 `padEnd(64, '0')`；`name` 长度 ≥ 61 时**不会**截断（`padEnd` 不裁剪），会得到超长 id——而 `src/docker/docker-service.ts` 的 `normalizeContainer` 在名字缺失时才回落到「id 前 12 位」，所以这里的超长 id 不影响现有用例。
  - `status` 只区分 `'running'` 与其它：`state === 'running'` → `'Up 2 hours'`，否则 `'Exited (0) 5 minutes ago'`。写别的状态（如 `'paused'`）会得到「Exited」文案，但 `state` 字段仍如实保留。
  - `hostIp` 只可能是 `127.0.0.1` 或调用方显式给的值——**本函数无法造出 `0.0.0.0` / `::` 的双记录**，因为它不做端口展开。
  - 空 `ports` 数组合法，得到 `ports: []`。
  - `createdAt` 固定为 `1_700_000_000_000`（2023-11-14T22:13:20Z），与真实时钟无关，因此时间相关断言是稳定的。

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| （无） | 本文件是纯替身模块，**不含 `describe` / `it`**。它的契约由四个使用方间接守住，见「待办与隐患」。 |

## 全局常量 / 变量

- `TEST_SERVE_PORT`：`number`，值为 `443`。所有助手方法的默认端口，也是 `parseFakeRouteKey` 缺省时的端口。改它会让四个测试文件里的默认端口断言同时失效。
- `TEST_SERVICE`：`string`，值为 `'svc:dsh'`。Service 相关用例的默认名字。
- `FakeServeGateway.tailnetInfo`（实例默认值）：`dnsName` / `hostname` / `baseUrl` 固定为 `my-laptop.example-tailnet.ts.net`，`ips` 为 `['100.101.102.103']`，`backendState` 为 `'Running'`，`version` 为 `'1.102.4'`，`magicDnsSuffix` 为 `'example-tailnet.ts.net'`，`tags` 为空、`serviceHosts` 为空。**`tags` 默认为空**是「`canHostService()` 默认不可用」这条用例的前提。
- `FakeServeGateway.services`（实例默认值）：`[]`。真实网关注入的 `serviceHosts` 只能通过 `addService()` 的 `advertised` / `vipIps` 参数间接模拟。
- `FakeServeGateway.handlers` / `httpsPorts`（实例默认值）：空 Map / `{443}`。

### `FakeServeGateway.constructor(initial?, extraPorts?)`

- **签名**：`(initial: Record<string, string> = {}, extraPorts: number[] = []) => FakeServeGateway`
- **入参**：`initial` 是「简写键 → proxy 串」的初始 serve 配置；`extraPorts` 是额外声明已存在的 HTTPS 端口。
- **出参**：实例。
- **功能**：逐条调用 `parseFakeRouteKey` 把简写键展开成三元组键写入 `handlers`，并把端口并入 `httpsPorts`。
- **边缘条件**：键写错（例如非法的 Service 前缀）不会抛错，只会被解析成节点级 —— 这也是它容易被误用的地方（见「待办与隐患」）。

### `FakeServeGateway.proxyOf(path, servePort?, service?)`

- **签名**：`(path: string, servePort = 443, service: string | null = null) => string | undefined`
- **出参**：该位置的 proxy 串，或 `undefined`。
- **功能**：断言「某位置当前指向什么」的主入口。
- **边缘条件**：默认参数是**节点级 + 443**；要查 Service 级必须显式传第三个参数（漏传会得到 `undefined`，看起来像「没写进去」）。

### `FakeServeGateway.has(path, servePort?, service?)`

- **签名**：`(path: string, servePort = 443, service: string | null = null) => boolean`
- **出参**：`boolean`。
- **功能**：判断某位置是否存在。
- **边缘条件**：与 `proxyOf` 同样的默认参数陷阱。

### `FakeServeGateway.set(path, proxy, servePort?, service?)`

- **签名**：`(path: string, proxy: string, servePort = 443, service: string | null = null) => void`
- **功能**：**绕过调用轨迹**直接布置前置状态（因此不会污染 `calls` 断言）。
- **边缘条件**：会同时把端口并入 `httpsPorts`；不校验 proxy 是否可解析（真的写了脏串，`snapshot()` 会在 `new URL` 处抛错）。

### `FakeServeGateway.addService(name, ports, advertised?, vipIps?)`

- **签名**：`(name: string, ports: number[], advertised = true, vipIps: string[] = []) => ServiceInfo`
- **出参**：写入的 `ServiceInfo`。
- **功能**：声明一个 Service（同名会被替换），并把它作为「已被承认」或「等待审批」注入快照。
- **边缘条件**：`advertised = false` 是构造 `awaiting-approval` 用例的唯一方式；`ports` 会并入 `httpsPorts`。

### `FakeServeGateway.fail(path, servePort?, service?)`

- **签名**：`(path: string, servePort = 443, service: string | null = null) => void`
- **功能**：让指定位置的 `upsertRoute` 抛错，用于验证「写入失败后保留 pending 并可重试」。
- **边缘条件**：只影响 upsert，不影响 remove。

### `FakeServeGateway.failDeletion(path, servePort?, service?)`

- **签名**：`(path: string, servePort = 443, service: string | null = null) => void`
- **功能**：让指定位置的 `removeRoute` 抛错，用于验证「摘除失败后保留归属并可重试」。
- **边缘条件**：失败时**不会**从 `handlers` 删除（模拟真实 tailscale 未生效）。

### `FakeServeGateway.routes()`

- **签名**：`() => Array<{service, servePort, path, proxy}>`
- **出参**：把内部三元组键拆开的扁平数组。
- **功能**：断言全量路由集合（例如「既有路由原样保留」）。
- **边缘条件**：顺序是 `Map` 的插入顺序，**不排序**；需要稳定比较时调用方自己排。

### `FakeServeGateway.describeSource()`

- **签名**：`() => string`
- **出参**：固定 `'fake-tailscale'`。
- **功能**：界面/日志里区分真伪数据源，也是「测试没有误用真实 CLI」的信号。
- **边缘条件**：无。

### `FakeServeGateway.tailnet()`

- **签名**：`() => Promise<TailnetInfo>`
- **出参**：`tailnetInfo` 的深拷贝。
- **功能**：返回本机的伪 tailnet 身份。
- **边缘条件**：返回的是拷贝，因此在测试里改返回值**不会**影响后续调用；要改身份必须直接赋值 `gateway.tailnetInfo`。

### `FakeContainerSource.listContainers()`

- **签名**：`() => Promise<ContainerInfo[]>`
- **出参**：`containers` 的深拷贝。
- **功能**：容器清单替身。
- **边缘条件**：同样是拷贝（避免测试之间互相污染）；`describeSource()` 固定返回 `'fake-docker'`。

## 待办与隐患

- [ ] **文档与实现不一致（建议修文档或补齐解析）**：文件头注释把 `"svc:dsh:443/"` 描述为「指定 Service 与端口」，但 `parseFakeRouteKey` 的两段正则都匹配不上它，实际得到 `{service: null, servePort: 443, path: "svc:dsh:443/"}`。现有用例没用到该写法，所以文档里这句示例是**误导性**的：照它写用例会得到一条路径奇怪的节点级路由，而不是 Service 路由。
- [ ] 替身的 `snapshot()` 比真实解析链更严格：非 URL 的 Proxy 串在快照阶段抛 `TypeError`，而真实的 `parseServiceTarget()` 只把它归为 `other`。因此「无法解析的目标归为 other」这类用例**无法**用 `FakeServeGateway.set()` 表达，只能在 `test/service-config.test.ts` 里直接喂原始 JSON。
- [ ] `unkey()` 无法还原含 `|` 的路径；`normalizeRoutePath()` 不禁止 `|`。这是替身与真实网关的已知差异，未加断言。
- [ ] `FakeContainerSource` 没有失败开关，Docker 不可用（503）路径只能由别的测试自己实现接口。
- [ ] `makeContainer` 无法造出 `0.0.0.0` / `::` 双记录，因此「容器直接监听全部网卡」的判定没有被这套夹具覆盖。
