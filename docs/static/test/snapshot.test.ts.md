# `test/snapshot.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

`buildSnapshot` 与 `FileSnapshotWriter` 的契约测试，分两段：第一段是**纯函数**——把 `ServeSnapshot` + 映射库 + 容器清单 + `planReconcile` 的结果压成一份给外部消费方（门户 HomePage）读的 JSON；第二段是文件写入器——落盘、覆盖、不残留。

这份文档最值得记住的一条：快照是**读取侧的唯一契约**。路由的 `url`（443 省略端口、非 443 显式带上）、`managed` / `mappingId` / `containerSource` 的取值口径、`summary` 的八个计数，任何一处改动都会让门户显示错数据，而这里的 15 条用例就是那些口径的机器可读定义。

## 依赖 / 引用

- 外部：`node:fs`（`promises`）、`node:os`、`node:path`；`vitest` 的 `afterEach` / `describe` / `it` / `expect`。
- 被测：`../src/snapshot.ts` 的 `buildSnapshot`、`FileSnapshotWriter`、`SNAPSHOT_SCHEMA_VERSION`，以及类型 `BuildSnapshotInput` / `Snapshot`。
- 协作模块：`../src/mappings/reconcile.ts` 的 `planReconcile`（测试自己调它，把 `plan` 喂给 `buildSnapshot`，因此快照里的状态全都来自真实的差异计算）。
- 类型：`../src/domain/types.ts` 的 `ContainerInfo` / `Mapping` / `ServeRoute` / `ServeSnapshot` / `TailnetInfo`。
- 替身：`./fakes.ts` 的 `makeContainer`。
- 运行入口：`package.json` 的 `npm test`。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `snapOf` | `(partial: Partial<ServeSnapshot> & Pick<ServeSnapshot, 'routes'>) => ServeSnapshot` | `ServeSnapshot` | 补齐 v2 快照的 `httpsPorts` / `hostname` / `services`，只让用例写 `routes` | `hostname` 用 `=== undefined` 判断：显式传 `null` **不会**被替换成默认值 |
| `route` | `(servePort: number, p: string, proxy: string \| null, service?: string \| null = null, host?: string \| null = 'my-laptop.example-tailnet.ts.net') => ServeRoute` | `ServeRoute` | 造一条 serve 路由（含 `handler` 的解析结果） | `proxy === null` 时造 `text` handler（`raw: 'hi'`）；否则按 `new URL(proxy)` 解析出 `hostPort` / `host` / `targetPath` / `loopback`；`service` 非空时 `host` 由 Service 名推导 |
| `mapping` | `(partial: Partial<Mapping> & { path: string; servePort: number; hostPort: number }) => Mapping` | `Mapping` | 造一条受管映射，补齐 id / 状态 / 时间戳等样板 | `id` 默认 `m-<servePort>-<path>`；`target.kind` 默认 `host`；`remoteHost` / `containerName` / `containerPort` 只在传入时才出现；`enabled` 默认 `true` |
| `build` | `(serve: ServeSnapshot, mappings: Mapping[], overrides?: Partial<BuildSnapshotInput> = {}, containers?: ContainerInfo[] = []) => Snapshot` | `Snapshot` | 先 `planReconcile` 再 `buildSnapshot`，固定 `generatedAt` 与 `adminPort` | `overrides` 在最后展开，可覆盖任意 `BuildSnapshotInput` 字段（例如 `tailnet`、`autoUnexpose`）；`containers` 是**第 4 个**位置参数，容易漏传 |
| `afterEach`（钩子） | `() => Promise<void>` | `Promise<void>` | 递归删除用例创建的临时目录并清空 `dir` | 只对 `FileSnapshotWriter` 段生效；`dir` 为 `null` 时跳过；`force: true` 保证目录不存在也不抛错 |

## 函数详情

### `snapOf(partial)`

- **签名**：`(partial: Partial<ServeSnapshot> & Pick<ServeSnapshot, 'routes'>) => ServeSnapshot`
- **入参**：
  - `partial.routes`（`ServeRoute[]`，必选）：直接放进结果，不做任何处理。
  - `partial.httpsPorts`（`number[]`，可选，默认 `[443]`）。
  - `partial.hostname`（`string | null`，可选，默认 `TAILNET.dnsName`）：**必须显式传 `null` 才会得到 `null`**（判据是 `=== undefined`，不是 falsy）。「主机名未知」那条用例正是靠这一点构造的。
  - `partial.services`（`ServiceInfo[]`，可选，默认 `[]`）：v2 新增的 Service 状态列表。
- **出参**：`ServeSnapshot`，字段齐全，可直接喂给 `planReconcile` 或 `buildSnapshot`。
- **功能**：吸收 v2 快照新增字段带来的样板代码，让每个用例只表达 `routes` 这一件事。
- **边缘条件**：传 `hostname: ''` 会保留空串（空串不等于「未知」的 `null` 语义）；`httpsPorts: []` 合法（写入器用例用它构造空快照）。

### `route(servePort, p, proxy, service?, host?)`

- **签名**：`(servePort: number, p: string, proxy: string | null, service: string | null = null, host: string | null = 'my-laptop.example-tailnet.ts.net') => ServeRoute`
- **入参**：
  - `servePort`（`number`，必选）：对外端口。
  - `p`（`string`，必选）：挂载路径。
  - `proxy`（`string | null`，必选）：代理地址；`null` 表示这条路由不是 proxy handler。
  - `service`（`string | null`，可选，默认 `null`）：Service 名（`svc:...` 或裸名）；非空时覆盖 `host`。
  - `host`（`string | null`，可选，默认 `'my-laptop.example-tailnet.ts.net'`）：仅节点级（`service === null`）时生效。
- **出参**：`ServeRoute`，`managed: false`、`mappingId: null`（未托管是默认前提，受管由映射库匹配出来）。
- **功能**：把「一条 serve 配置长什么样」压成一个调用；`handler` 里刻意重算 `loopback`（与 `parseProxyUrl` 的判据一致：`127.0.0.1` / `localhost` / `::1`），因为暴露闸门与容器反查都依赖它。
- **边缘条件**：
  - `proxy === null` → `handler = { kind: 'text', raw: 'hi' }`，此时没有 `hostPort` / `targetPath` 可供快照读取（正是「非代理 handler 的代理字段为空但路由仍被列出」那条用例的前置）；
  - `service` 非空时 `host` 一律写成 `<裸名>.example-tailnet.ts.net`，忽略第 5 个参数；
  - `host` 显式传 `null` 时写 `''`（`host ?? ''`），这是「快照主机名未知」用例的构造方式。

### `mapping(partial)`

- **签名**：`(partial: Partial<Mapping> & { path: string; servePort: number; hostPort: number }) => Mapping`
- **入参**：必选 `path` / `servePort` / `hostPort`（对应 `target.hostPort`）；其余 `Mapping` 字段可选。`target` 只读 `kind` / `targetPath` / `remoteHost` / `containerName` / `containerPort` 五个子字段。
- **出参**：`Mapping`，`createdAt` / `updatedAt` 固定为 `2026-01-01T00:00:00.000Z`（快照本身不序列化时间，写死只为消除不确定性）。
- **功能**：造「映射库里的一条记录」。`ownedRoutes` 默认 `[]` —— 这正是「未写入 → `pending`」用例需要的形态；要构造 `active` 就必须显式传 `ownedRoutes`。
- **边缘条件**：
  - `target.kind` 默认 `'host'`，要造容器型映射必须显式传 `kind: 'container'` 并同时给 `containerName` / `containerPort`；
  - 可选项用条件展开写入，因此没传的键**根本不存在**（不是 `undefined`），序列化结果与真实存储一致。

### `build(serve, mappings, overrides?, containers?)`

- **签名**：`(serve: ServeSnapshot, mappings: Mapping[], overrides: Partial<BuildSnapshotInput> = {}, containers: ContainerInfo[] = []) => Snapshot`
- **入参**：
  - `serve`（`ServeSnapshot`，必选）：当前 serve 配置，通常由 `snapOf()` 造。
  - `mappings`（`Mapping[]`，必选）：映射库内容。
  - `overrides`（`Partial<BuildSnapshotInput>`，可选，默认 `{}`）：在固定参数之后展开，可覆盖 `generatedAt` / `tailnet` / `autoUnexpose` / `adminPort` 等。
  - `containers`（`ContainerInfo[]`，可选，默认 `[]`）：**第 4 个**参数，容器反查用例必须传它。
- **出参**：`Snapshot`。
- **功能**：按生产顺序走一遍 —— `planReconcile({ mappings, snapshot: serve, containers, adminPort: 8787, tailnet: TAILNET })` 得到状态与目标差异，再 `buildSnapshot(...)` 得到对外 JSON。测试因此同时覆盖了两个模块的接缝。
- **边缘条件**：
  - `generatedAt` 固定为 `'2026-10-16T00:00:00.000Z'`、`adminPort` 固定 `8787`，所以「同输入 → 同输出」可断言；要测时间相关行为必须用 `overrides` 显式覆盖；
  - `containers` 传空数组时所有路由的 `containerName` / `containerSource` 都是 `null`（不会瞎猜）；
  - `planReconcile` 若抛错会直接冒泡（本函数不捕获）。

### `afterEach`（钩子）

- **签名**：`() => Promise<void>`
- **入参**：无。
- **出参**：`Promise<void>`。
- **功能**：`fs.rm(dir, { recursive: true, force: true })` 删掉 `fs.mkdtemp` 造的临时目录，然后 `dir = null`。
- **边缘条件**：用例在 `dir = await fs.mkdtemp(...)` 之前失败时 `dir` 为 `null`，直接跳过；`force: true` 使「目录被用例自己删过」也不报错，从而不会用一个清理失败掩盖真正的断言失败。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| （无 CLI 参数） | — | 由 `vitest run` 驱动 |
| 真实 Docker / tailscale | **不需要** | 容器清单由 `makeContainer` 造，serve 配置由 `snapOf` / `route` 造 |
| 临时文件系统 | `os.tmpdir()` | `FileSnapshotWriter` 段用 `fs.mkdtemp(path.join(os.tmpdir(), 'tsc-snap-'))` 建目录，`afterEach` 负责删除 |
| `TAILNET`（模块常量） | `my-laptop.example-tailnet.ts.net` | 全套用例的固定 tailnet 身份（含 `magicDnsSuffix: 'example-tailnet.ts.net'`、`tags: []`、`serviceHosts: {}`） |
| `adminPort`（写死在 `build` 内） | `8787` | 暴露判定与 `source.adminPort` 的基准值 |

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `buildSnapshot` › 输出稳定 schema 与来源信息 | 快照的骨架：`schemaVersion` 必须等于 `SNAPSHOT_SCHEMA_VERSION`（消费方靠它判断兼容性）、`generatedAt` 原样透传、`source` 三段（hostname / baseUrl / adminPort）、`servePorts`、空 `routes`、`security` 初始为 `{ autoUnexpose: true, exposures: [] }` |
| `buildSnapshot` › 443 省略端口，非 443 显式带上 | `url` 的拼接口径。**这条最容易改坏**：省略 8443 会让用户拿到指向 443 上另一个服务的链接，多写 443 又会破坏证书匹配 |
| `buildSnapshot` › 主机名未知时 url 为 null，其余字段仍可用 | 两种「没有主机名」要区分开：tailnet 身份缺 `dnsName` **不影响**节点级路由的 `url`（它由**快照主机名**决定）；只有快照自己也没有主机名时 `url` 才是 `null`，而此时 `proxy` 仍必须照常给出——门户在没有对外地址时依然能显示「这条路由指向哪里」 |
| `buildSnapshot` › 区分受管与未托管，并带上映射元数据 | 受管路由必须带 `managed: true` / `mappingId` / `status` / 容器信息 / `note` / `enabled`；未托管的那条反过来必须是 `mappingId: null, status: null, note: null, enabled: null`。守住「门户不会把别人的路由显示成自己的」 |
| `buildSnapshot` › 汇总计数覆盖各状态 | `summary` 八个数的口径：`total` 是路由条数（含未托管）、`managed`/`unmanaged` 互补、`active`/`pending`/`disabled` 按映射状态计。数错一个，门户顶部统计就与列表自相矛盾 |
| `buildSnapshot` › 同一路径出现在两个端口时互不混淆 | 路由身份是三元组：`/` 在 443 上未托管、在 8443 上受管，两个字段必须各自独立判定。这是 Service/多端口改动后最核心的不变量 |
| `buildSnapshot` › 非代理 handler 的代理字段为空但路由仍被列出 | 非 proxy 的 serve 配置（`text` handler）不能被静默丢掉，但也不能编造 `proxy` / `targetHostPort`（必须为 `null`，`targetPath` 为 `''`）。守住「门户显示的每一条都是 serve 里真实存在的」 |
| `buildSnapshot` › 暴露会被写进 security 段 | 暴露扫描结果要进快照：多端口（443 与 8443）上的两条泄漏都必须列出，且 `autoUnexpose: false` 要如实透传。门户据此显示安全告警 |
| `buildSnapshot` › 路由按端口再按路径排序 | 输出顺序稳定（先端口后路径），否则每次快照都会产生无意义 diff，消费方也无法做有序对比 |
| `buildSnapshot` › 未托管路由也能按宿主机端口反查容器（门户需要这个） | **门户的容器关联**：未托管路由没有 `mappingId`，但仍要能按宿主端口查到容器并标 `containerSource: 'port'`；查不到时三个字段一律 `null`——**宁可空着也不瞎猜**，猜错会让用户以为服务在某台容器里 |
| `buildSnapshot` › 映射库的容器归属优先于端口反查，并用 `containerSource` 标明来源 | 两个数据源冲突时**映射库胜出**（用户显式指定的目标优先于端口巧合），并用 `containerSource: 'mapping'` 让消费方能区分来源 |
| `buildSnapshot` › 已停止的容器不参与端口反查（优先运行中的） | 同一端口上有 `exited` 与 `running` 两个容器时，必须选运行中的。守住「门户不会把当前实际提供服务的容器认成已停止的那个」 |
| `buildSnapshot` › 可被 JSON 序列化（消费方直接 JSON.parse） | `JSON.parse(JSON.stringify(snap))` 必须与原对象深相等：快照里不能出现 `undefined` 值、`Map`/`Set`、`Date` 等不可往返的类型。这是「门户通过一个静态 JSON 文件消费」的前提 |
| `FileSnapshotWriter` › 创建目录并写出可解析的 JSON | 文件名与路径契约：`write()` 返回 `<dir>/serve-routes.json`，目录不存在时自己建，内容可 `JSON.parse` 且 `schemaVersion` 正确 |
| `FileSnapshotWriter` › 重复写入覆盖而不是追加，且不残留临时文件 | 第二次写入必须**覆盖**（不是追加成非法 JSON），且目录里最终**只有** `serve-routes.json` —— 守住「原子写用的临时文件必须被清掉」，否则门户的目录会越跑越脏 |

## 待办与隐患

- [ ] 本文件只测 `buildSnapshot` 的纯函数行为；`MappingService` 何时触发写快照、写入失败如何降级由 `test/mapping-service.test.ts` 覆盖。
- [ ] 没有覆盖 **Service 维度路由的 `url` 拼接**（`service` 非空时走 `buildServiceDnsName`）：`route()` 助手虽支持 `service` 参数，但没有用例断言带 Service 的快照字段。Service 级快照的完整形状目前只有单元层面的间接证据。
- [ ] `summary` 的 `orphanedTarget` / `blocked` / `awaitingApproval` 三个计数在「汇总计数覆盖各状态」用例里被断言为 `0`，但**没有非零用例**（对应的状态构造在 `test/reconcile.test.ts`）。
- [ ] `FileSnapshotWriter` 段没有覆盖写入失败（权限/磁盘满）与并发写入；「原子性」只由「不残留临时文件」间接守住。
