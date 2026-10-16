# `test/mapping-service.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

`MappingService` 的行为契约测试，覆盖七个面：创建 / 多端口 / 状态变更 / 外部导入 / 暴露闸门 / 快照发布 / 总览。全部依赖内存替身（`FakeServeGateway` + `FakeContainerSource` + `MemoryMappingStore` + `MemoryAuditLog` + `MemorySnapshotWriter`），**不接触真实 Docker 与 tailscale**，因此可在任意沙箱里离线跑完。

这个文件的价值不在「断言是否通过」，而在于它是「用户意图不因一次 CLI 抖动而丢失」这条产品承诺的机器可读版本：写入失败 → 保留 `pending` 可重试；摘除失败 → 保留 `ownedRoutes` 可重试。任何让这两条退化（例如失败时把映射从映射库里删掉）的改动都会被它挡下。

## 依赖 / 引用

- 外部：`vitest` 的 `describe` / `it` / `expect`。
- 被测：`../src/mappings/mapping-service.ts` 的 `MappingService`、`MappingConflictError`。
- 替身：`../src/mappings/store.ts` 的 `MemoryMappingStore` / `MemoryAuditLog`；`../src/snapshot.ts` 的 `MemorySnapshotWriter`；`./fakes.ts` 的 `FakeServeGateway` / `FakeContainerSource` / `makeContainer`。
- 日志：`../src/logger.ts` 的 `silentLogger`（注入到 `MappingService`，避免测试刷屏）。
- 运行入口：`package.json` 的 `npm test`（即 `vitest run`）；由 `vitest.config.ts` 收集。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `setup` | `(options?: { handlers?: Record<string, string>; containers?: ReturnType<typeof makeContainer>[] }) => {...}` | `{ gateway, containers, store, audit, service, snapshot }` | 装配一套内存依赖并构造 `MappingService` | 不传 `options` 时无既有路由、无容器；`handlers` 的键支持 `"/p"` / `":8443/p"` / `"svc:dsh:443/p"` 三种简写 |
| `write`（测试内联） | `() => Promise<string>` | 恒抛 `Error` | 模拟「快照磁盘写入失败」的 `MemorySnapshotWriter` 子类 | 无入参；被 `override` 用于最后一个快照用例，异常类型为普通 `Error` |

## 函数详情

### `setup(options?)`

- **签名**：`(options: { handlers?: Record<string, string>; containers?: ReturnType<typeof makeContainer>[] } = {}) => { gateway: FakeServeGateway; containers: FakeContainerSource; store: MemoryMappingStore; audit: MemoryAuditLog; service: MappingService; snapshot: MemorySnapshotWriter }`
- **入参**：
  - `options`（对象，可选，默认 `{}`）：唯一的配置入口，二者都可省略。
  - `options.handlers`（`Record<string, string>`，可选，默认 `{}`）：交给 `FakeServeGateway` 构造函数，作为「真实 serve 配置」的初始内容。键的写法由 `parseFakeRouteKey` 解析：`"/app"` = 节点级 + 443；`":8443/app"` = 节点级 + 8443；`"svc:dsh:443/"` = Service 级。值是代理地址字符串。
  - `options.containers`（`ContainerInfo[]`，可选，默认 `[]`）：交给 `FakeContainerSource`，决定「按宿主机端口自动关联容器」能命中什么。用 `makeContainer(name, ports, state?)` 构造。
- **出参**：六个对象的打包 —— `gateway` / `containers` / `store` / `audit` 是可直接断言的替身，`service` 是被测对象，`snapshot` 用于读 `last` / `writes`。
- **功能**：把 `MappingService` 的九个依赖一次装好，固定 `adminPort = 8787`、`servePort = 443`、`autoUnexpose = true`，从而让每个用例只表达自己关心的那一个变量。
- **边缘条件**：
  - 不传 `handlers` 时网关里没有任何既有路由，因此「占用未托管路由需要确认接管」这类用例必须自己塞 `handlers`；
  - `containers` 为空时，`create()` 的 `target.kind` 一律是 `host`（不会误判成容器）；
  - 此函数**不清理**替身状态：每个用例各建一套，不存在跨用例串味。

### `write()`（测试内联的失败快照写入器）

- **签名**：`() => Promise<string>`
- **入参**：无（`MemorySnapshotWriter.write(snapshot)` 被覆写，参数被忽略）。
- **出参**：声明为 `Promise<string>`，但**从不返回**——直接 `throw new Error('模拟磁盘故障')`。
- **功能**：在「快照写入失败不影响收敛结果」用例里替换掉注入给 `MappingService` 的 `snapshot`，验证快照是**旁路**：磁盘炸了也不能让 serve 的写入结果变成失败。
- **边缘条件**：抛的是普通 `Error`（不是 `MappingConflictError`），因此如果 `MappingService` 没把快照异常吞掉，用例会在 `expect(result.apply.errors).toEqual([])` 处直接失败。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| （无 CLI 参数） | — | 由 `vitest run` 驱动，用例不读任何环境变量 |
| `TSCONTROLLER_*` | 不读取 | 本文件所有配置都经 `setup()` 显式注入，**不依赖真实环境**，因此可离线跑 |
| 真实 Docker / tailscale | **不需要** | 容器清单来自 `FakeContainerSource`，serve 配置来自 `FakeServeGateway` |
| `ADMIN_PORT`（模块常量） | `8787` | 注入的 `adminPort`；「指向管理端口」类用例的判据就是它 |

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `MappingService.create` › 创建后立即写入 serve 并持久化 | 创建**不是**只写映射库：serve 的 `upserted` 必须恰好是 `(service=null, 443, 路径)` 一条、`inSync` 为真、网关里真能查到代理地址；`ownedRoutes` 同时落库——「归属」与「配置」必须同时到位，否则后续摘除会找不到自己写过什么 |
| `MappingService.create` › 自动按宿主机端口关联容器 | 目标端口能唯一对上容器端口时，`target.kind` 必须是 `container`，并带上容器名与容器内端口。守住「用户填一个宿主端口，界面就能显示背后是哪个容器」这条便利契约 |
| `MappingService.create` › 拒绝指向管理端口的映射 | 目标端口 == 管理端口 → `exposes-admin`，且**网关里一条都不许写**（`handlers.size === 0`）。这是「本应用禁止暴露在 tailnet」在创建入口的第一道闸 |
| `MappingService.create` › 拒绝对外端口与管理端口同号的映射 | `servePort === adminPort` → `serve-port-is-admin`，同样零写入。守住「换个对外端口把管理面绕出去」这条变形 |
| `MappingService.create` › 目标路径非法时拒绝 | 两类非法输入：`path` 不以 `/` 开头、`targetPath` 含空格。守住「校验唯一入口是 `normalizeRoutePath` / `normalizeTargetPath`」，任何绕过归一化的写法都会在这里被挡 |
| `MappingService.create` › 同一端口上路径重复时拒绝 | 路径唯一性按**端口维度**判定：`/wf` 已在 443 上就不许再建（哪怕换宿主端口），错误码 `duplicate-path` |
| `MappingService.create` › 占用未托管路由时需要显式确认接管 | 既有未托管路由不会被静默覆盖：先 409 `takeover-required`，带 `confirmTakeover: true` 才允许，且接管后代理地址确实等于新值。守住「别人的配置不能被我悄悄改掉」 |
| `MappingService.create` › 写入失败时保留映射并给出可重试的 pending 状态 | **本文件最重要的一条**：CLI 抖动导致 `upsert` 抛错时，映射必须留在映射库里且状态为 `pending`（网关里没有路由），清掉故障后一次 `apply()` 就能挂上并转 `active`。守住「用户意图不因一次 CLI 抖动丢失」 |
| `MappingService 多端口` › 默认端口来自依赖注入，可在创建时覆盖 | 不传 `servePort` 用注入的 443；传了就用 8443。两条路由在同一宿主端口上互不干扰，`proxyOf` 需按端口区分读取 |
| `MappingService 多端口` › 同一路径可以同时挂在两个端口上 | 路径本身没有全局唯一性：`/` 可以同时在 443 与 8443 上指向不同宿主端口。守住「端口是路由身份的一维」这条 Service 级改动后的核心模型 |
| `MappingService 多端口` › 改端口时摘掉旧端口上的路由 | `update({ servePort })` 必须「先摘旧、后挂新」，否则 serve 里会残留一条落到错误 origin 的路由 |
| `MappingService 多端口` › 在非默认端口上也能禁用与删除 | 状态操作必须带上正确的端口去读写网关（硬编码 443 会在这里失败）；`remove().apply.removed` 也要报出真实端口 |
| `MappingService 多端口` › 删除非默认端口的映射后，再 apply 不会误删其它端口的路由 | 摘除只针对自己 `ownedRoutes` 里的三元组。守住「收敛不会误伤同路径其它端口上的路由」——这是多端口引入后最容易写错的一处 |
| `MappingService 状态变更` › 禁用会摘除 serve 路由，重新启用会挂回 | 禁用 = 摘除配置 + 状态转 `disabled`；启用 = 重新挂载 + 转 `active`。往返必须可逆 |
| `MappingService 状态变更` › 删除会摘除 serve 路由且不再留下归属 | 删除后映射库为空，且后续 `apply()` 不会把手动塞进去的 `/` 路由当成自己的残留删掉——`ownedRoutes` 清干净了 |
| `MappingService 状态变更` › 改名时摘掉旧路径 | 改 `path` 走同一套「先摘旧后挂新」，旧路径不能留在 serve 里成为幽灵入口 |
| `MappingService 状态变更` › 摘除失败时保留归属，下次 apply 重试 | **与第 8 条对称的另一半**：`removeRoute` 抛错时状态必须是 `disabled-drift`（而不是 `disabled`），且 `ownedRoutes` **原样保留**；故障清除后 `apply()` 的 `removed` 能对上，网关里最终消失。守住「摘除失败不能把归属一起丢掉，否则这条路由永远没人再管」 |
| `MappingService.importExternal` › 把既有 serve 路由接管为受管映射，并自动关联容器 | 四种既有形态都必须被正确解析：443 `/`、443 `/worldforge`、带目标路径的 `/agent`、以及 `:8443/` 上的非默认端口路由。导入后 `externalRoutes` 变空（都成了受管）、容器关联生效、`targetPath` 保留；**且导入过程不得改 serve 配置本身**（`upsert` 调用轨迹为空） |
| `MappingService.importExternal` › 拒绝接管指向管理端口的路由 | 导入不能成为绕开闸门的旁路：指向管理端口的既有路由进 `skipped` 而不是 `imported` |
| `MappingService.importExternal` › 可只导入指定路由（端口 + 路径） | 选择器必须同时匹配端口与路径：`{8443,'/a'}` 不能把 443 上的 `/a` 一起带进来 |
| `MappingService.enforceExposureGuard` › 摘除暴露管理端口的路由并留下审计 | 闸门必须真的删配置（不只是报告），且 `exposure-detected` 与 `exposure-removed` 两种审计事件都要落；同批的无关路由 `/ok` 保持不动 |
| `MappingService.enforceExposureGuard` › 扫描范围覆盖全部 HTTPS 端口，不只 443 | **扫描必须遍历 `httpsPorts` 全集**。早期实现只解析 443 那一组，挂在 8443 上的暴露对闸门完全不可见——这条守住那个真实缺口 |
| `MappingService.enforceExposureGuard` › 没有暴露时什么都不做 | 干净环境下的返回值必须是 `{ exposures: [], removed: [] }` 且审计为空：闸门不能因为「没找到」就写一条噪音审计 |
| `MappingService 快照发布` › 每次收敛后刷新快照，内容反映收敛后的真实状态 | 快照是**收敛后的结果**而不是意图：`/wf` 标 `managed: true, status: 'active'`，既有 `/external` 标 `managed: false`，`summary` 的 total/managed/unmanaged/active 四个数要对得上。守住门户读到的永远是真实状态 |
| `MappingService 快照发布` › 删除后快照不再包含该路由 | 删除也必须刷新快照，否则门户会一直显示一条已经不存在的路由 |
| `MappingService 快照发布` › `publishSnapshot` 可在无变更时手动调用（启动与定期刷新走这条路径） | 无变更路径下也要产出快照，且**未托管路由不该被认领**（`managed: false`）。守住启动时与定时器里的那次刷新 |
| `MappingService 快照发布` › 快照写入失败不影响收敛结果 | 快照是旁路：`apply.errors` 为空、映射为 `active`、网关里路由已挂上。守住「磁盘故障不能让已经生效的 serve 配置被回滚或标记失败」 |
| `MappingService.overview` › 区分受管与未托管路由 | `overview` 的三个字段口径：`externalRoutes` 只列未托管的、`counts.active` 只数受管的、`planSummary.inSync` 表示「配置就是期望的样子」 |
| `MappingService.overview` › 同名的未托管路由只在对应端口上被认作未托管 | 未托管判定同样按三元组：443 上的 `/` 未被认领，不代表 8443 上自己的 `/` 也是未托管。守住端口维度的归属判定 |
| `MappingService.overview` › `serveRoutes` 标记归属且带端口 | 界面用的路由列表里，Service 级那两条字段必须齐全：受管的带 `mappingId`，未托管的 `mappingId` 为 `null` |

## 待办与隐患

- [ ] 本文件**没有** `awaiting-approval`（Service host 未获承认）、`blocked`（目标/端口撞管理面）、`orphaned-target`（容器消失）三种状态的用例——它们分别落在 `test/service-routing.test.ts` 与 `test/reconcile.test.ts`。读这份文档时不要把「这里没测」误读成「平台没覆盖」。
- [ ] 全部用例都走假网关，因此**证明不了真实 `tailscale serve` 的行为**：命令拼装、CLI 报错翻译、`get-config --all` 与 `status --json` 的差异都需要 `scripts/verify-live.ts` / `scripts/verify-security.ts` 在真机上补。假网关只保证「本工具内部的状态机正确」。
- [ ] `FakeServeGateway.clearService` 与 `c.clearedServices` 在本文件未被使用（Service 清理路径由 `service-routing.test.ts` 覆盖）。
- [ ] 「写入失败后可重试」只验证了**失败一次、随后成功**。没有覆盖「连续多次失败」「失败期间进程重启」这两条更长的路径。
