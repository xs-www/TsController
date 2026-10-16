# `src/mappings/mapping-service.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

映射服务：把「用户意图（映射库）」收敛到「系统状态（`tailscale serve` 配置）」。模型是**声明式**的——映射库是期望状态，serve 配置是实际状态，每次增删改都自动触发一次 `apply()`。

两个不变量：

1. **收敛失败不回滚映射库。** 用户意图必须留存，`pending` + `errors` 就是重试入口。
2. **所有「读-改-写」串行化。** 经 `#serialize()` 排队，避免并发请求互相覆盖。

## 依赖 / 引用

- `node:crypto` 的 `randomUUID`。
- `../domain/route-path.ts`：`normalizeRoutePath`、`normalizeTargetPath`、`normalizeServiceName`、`normalizeRemoteHost`、`buildBaseUrl`、`isValidPort`、`serveRouteKey`、`formatRouteRef`。
- `../domain/types.ts`、`../logger.ts`、`../docker/docker-service.ts`（`ContainerSource`）、`../tailscale/tailscale-service.ts`（`ServeGateway`）。
- `./reconcile.ts`（`desiredProxyOf` / `isInSync` / `planReconcile`）、`./store.ts`（`AuditLog` / `MappingStore`）、`../snapshot.ts`（`buildSnapshot` / `SnapshotWriter`）。
- 被 `src/runtime.ts` 构造、`src/app.ts` 调用、`test/{mapping-service,service-routing,api}.test.ts` 与 `scripts/verify-*.ts` 使用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `MappingService.constructor` | `(deps: MappingServiceDeps) => MappingService` | 实例 | 注入依赖 | 无校验，`deps` 缺项会在首次调用时失败 |
| `MappingService.#serialize` | `<T>(fn: () => Promise<T>) => Promise<T>` | `Promise<T>` | 把操作排入串行队列 | `fn` 抛错不会卡死队列（`this.#queue` 吸收错误） |
| `MappingService.#audit` | `(kind, message, detail?) => Promise<void>` | `Promise<void>` | 追加审计事件 | 时间戳由这里生成 |
| `MappingService.#readTailnet` | `() => Promise<TailnetInfo \| null>` | `Promise` | 读 tailnet 身份并缓存 | 失败只警告并返回上次的缓存值（可能为 `null`） |
| `MappingService.#evaluateAll` | `() => Promise<{mappings, plan, containers, snapshot, tailnet}>` | 聚合对象 | 并发读取四路状态并算 plan | 四路并发；任一失败会整体抛出 |
| `MappingService.#toView` | `(m: Mapping, plan) => MappingView` | `MappingView` | 拼运行时视图 | 评估缺失时回落 `pending` + 现算 `desiredProxy` |
| `MappingService.overview` | `() => Promise<{mappings, externalRoutes, services, selfTags, planSummary, counts}>` | 聚合对象 | 界面主数据 | `counts` 覆盖全部 8 种状态 |
| `MappingService.#ownedKeysOf` / `#ownedKeys` | `(m) => string[]` / `(mappings) => Set<string>` | 位置键 | 归属记账 | 含「当前位置」与全部 `ownedRoutes` |
| `MappingService.#matchContainer` | `(hostPort, containerId?) => Promise<Partial<MappingTarget>>` | 目标片段 | 按端口反查容器 | 找不到返回 `{}`（不抛错） |
| `MappingService.#buildMapping` | `(input, existing?) => Promise<Mapping>` | `Promise<Mapping>` | **全部前置校验 + 构造记录** | 见下文 11 条校验顺序 |
| `MappingService.create` | `(input) => Promise<{mapping, apply}>` | 对象 | 新建并立即收敛 | 先写库再收敛；收敛失败不回滚 |
| `MappingService.update` | `(id, input) => Promise<{mapping, apply}>` | 对象 | 局部更新并收敛 | 未找到 → `not-found`；省略字段沿用旧值 |
| `MappingService.remove` | `(id) => Promise<{removed, apply}>` | 对象 | 删除并摘除占用位置 | 用 **tombstone** 参与同一次收敛 |
| `MappingService.setEnabled` | `(id, enabled) => Promise<{mapping, apply}>` | 对象 | 启停 | **不自己入队**（内部委托 `update`，再包一层会死锁） |
| `MappingService.importExternal` | `(selection?) => Promise<{imported, skipped}>` | 对象 | 接管未托管路由 | **不写 serve**；Service 端点按空目标路径接管 |
| `MappingService.apply` | `() => Promise<ApplyResult>` | `ApplyResult` | 对外的手动收敛 | 入队 |
| `MappingService.applyInternal` | `(overrideMappings?) => Promise<ApplyResult>` | `ApplyResult` | 收敛核心（唯一副作用集中点） | 逐条失败不中断；见下文顺序 |
| `MappingService.publishSnapshot` | `() => Promise<Snapshot>` | `Snapshot` | 手动发布快照 | 只读不写 serve |
| `MappingService.enforceExposureGuard` | `() => Promise<{exposures, removed}>` | 对象 | 启动安全闸门 | 独立实现，不依赖映射库 |
| `MappingService.serveRoutes` | `() => Promise<ServeRoute[]>` | `Promise<ServeRoute[]>` | 带托管标记的路由只读视图 | 归属键用三元组 |
| `MappingService.services` | `() => Promise<ServiceInfo[]>` | `Promise<ServiceInfo[]>` | Service 状态列表 | 直接来自快照 |
| `MappingService.canHostService` | `() => Promise<{tags, canHostService} \| null>` | 对象或 `null` | 本节点能否充当 Service host | 读不到 tailnet 身份时返回 `null` |

## 函数详情

### `MappingService.audit` / `MappingService.#audit(kind, message, detail?)`

- **签名**：`(kind: AuditEvent['kind'], message: string, detail?: Record<string, unknown>) => Promise<void>`
- **入参**：`kind` 是事件类别（`apply` / `import` / `exposure-detected` / `exposure-removed` / `startup`）；`detail` 是结构化补充。
- **出参**：`Promise<void>`（写失败由 `FileAuditLog` 内部吞掉并 warn）。
- **功能**：统一补 `at` 时间戳后追加到审计日志。
- **边缘条件**：`detail` 未给时不写该键；**审计失败不影响业务流程**（`append` 内部捕获）。

### `MappingService.readTailnet` / `#readTailnet()`

- **签名**：`() => Promise<TailnetInfo | null>`
- **出参**：最近一次成功读到的身份；失败时是上一次的缓存（可能 `null`）。
- **功能**：`gateway.tailnet()` 的容错包装，并把结果缓存到 `#tailnet` 供 `overview().selfTags` 与 `canHostService()` 复用。
- **边缘条件**：失败只 `logger.warn`，**绝不上抛**——Tailscale 未登录时界面仍应能打开；因此调用方不能把 `null` 当成「没有 tag」（`canHostService()` 会返回 `null` 而不是 `false`）。

### `MappingService.planFor` / `#planFor(mappings)`

- **签名**：`(mappings: Mapping[]) => Promise<{ mappings; plan; containers }>`（实例私有）
- **入参**：`mappings` 是**覆盖后的**映射数组（删除流程传入的是「库里剩下的 + tombstone」）。
- **出参**：用于本次收敛的 plan 与容器清单（不含 snapshot）。
- **功能**：删除流程专用——此时映射库已经不含被删记录，但仍要按 tombstone 算一次差异。
- **边缘条件**：并发取快照与容器清单；tailnet 身份只用于拼地址，读失败不影响 plan。

### `MappingService.viewOf` / `#viewOf(id)`

- **签名**：`(id: string) => Promise<MappingView>`（实例私有）
- **出参**：写操作后的最新视图。
- **功能**：重新 `#evaluateAll()` 后按 id 找记录并转成视图（因此返回的 `status` 是**收敛后**的真实状态）。
- **边缘条件**：记录在写入后消失（不可能的正常情况）→ 抛 `not-found` 的 `MappingConflictError`，避免返回一个悬空视图。

### `constructor(deps)` / getter `adminPort`

- **签名**：`(deps: MappingServiceDeps) => MappingService`
- **入参**：`deps`（必选）：`{store, gateway, containers, audit, logger, adminPort, servePort, autoUnexpose, snapshot}`。
- **出参**：实例；`get adminPort()` 暴露管理端口供 API 层复用。
- **功能**：只做保存，不做任何 IO（构造是幂等的，便于测试注入替身）。
- **边缘条件**：`servePort` 是「新建映射的默认对外端口」，不是校验上界。

### `#serialize(fn)`

- **签名**：`<T>(fn: () => Promise<T>) => Promise<T>`
- **入参**：`fn`（必选）：一个完整的读-改-写事务。
- **出参**：`fn` 的结果。
- **功能**：`this.#queue = next.catch(() => undefined)` 吸收错误，因此前一个事务失败不会让队列永久拒绝。
- **边缘条件**：**不要在一个已入队的方法内部再调用 `#serialize`**——队列会自等待而死锁（`setEnabled` 就是这样被修正的）。

### `#audit(kind, message, detail?)`

- **签名**：`(kind: AuditEvent['kind'], message: string, detail?: Record<string, unknown>) => Promise<void>`
- **出参**：`Promise<void>`（审计写失败由 `FileAuditLog` 内部吞掉并 warn）。
- **功能**：统一补 `at` 时间戳后追加。
- **边缘条件**：`detail` 未给时不写该键。

### `#readTailnet()`

- **签名**：`() => Promise<TailnetInfo | null>`
- **出参**：最近一次成功读到的身份；失败时是上一次的缓存（可能 `null`）。
- **功能**：`gateway.tailnet()` 的容错包装，并缓存到 `#tailnet` 供 `overview().selfTags` 使用。
- **边缘条件**：失败只 `logger.warn`，**绝不上抛**——Tailscale 未登录时界面仍应能打开。

### `#evaluateAll()`

- **签名**：`() => Promise<{mappings, plan, containers, snapshot, tailnet}>`
- **出参**：聚合对象；`plan` 由 `planReconcile` 算出。
- **功能**：`Promise.all` 并发读映射库、serve 快照、容器清单、tailnet 身份，然后算一次 plan。
- **边缘条件**：四路并发，任一 reject 会让整体 reject（`#readTailnet` 已内部容错，另外三路失败即视为系统不可用）。**注意不要在 `overview()` 里再单独调 `gateway.snapshot()`**——那会让一次界面刷新对 `tailscale` CLI 发起两次进程调用（历史上修过）。

### `#toView(m, plan)`

- **签名**：`(m: Mapping, plan: ReconcilePlan) => MappingView`
- **出参**：`MappingView`（`Mapping` + `status` / `desiredProxy` / `actualProxy` / `baseUrl` / `detail`）。
- **功能**：从 plan 的 `evaluations` 取结果，缺失时回落 `pending` 并现算 `desiredProxy`（防御性）。
- **边缘条件**：`baseUrl` 为 `null` 时前端会隐藏/禁用复制按钮。

### `overview()`

- **签名**：`() => Promise<{mappings: MappingView[]; externalRoutes: [...]; services: ServiceInfo[]; selfTags: string[]; planSummary; counts}>`
- **出参**：界面主数据。`externalRoutes` 每项含 `{service, servePort, path, proxy, hostPort, host, kind, fromServiceConfig, serviceInfo}`；`counts` 是 8 种状态的计数（含 `'awaiting-approval'`）。
- **功能**：未托管路由 = 「不被任何映射的 `ownedKeys` 覆盖」的位置；按端口 → Service → 路径排序。
- **边缘条件**：`selfTags` 来自缓存的 tailnet 身份，读不到时为 `[]`（此时界面按「无 tag」处理）。

### `#ownedKeysOf(m)` / `#ownedKeys(mappings)`

- **签名**：`(m: Mapping) => string[]` / `(mappings: Mapping[]) => Set<string>`
- **出参**：`serveRouteKey` 数组 / 集合。
- **功能**：候选集 = `ownedRoutes` ∪ `{当前位置}`，即「这条映射声明占用的全部位置」。
- **边缘条件**：位置键三元组比较，因此节点级 `/dsh` 与 `svc:dsh` 的 `/` 不会互相认领。

### `#matchContainer(hostPort, containerId?)`

- **签名**：`(hostPort: number, containerId?: string) => Promise<Partial<MappingTarget>>`
- **出参**：`{containerId, containerName, containerPort}` 或 `{}`。
- **功能**：在容器清单里按宿主机端口找 `protocol === 'tcp'` 的发布端口；给了 `containerId` 就只在该容器内找（支持前缀匹配）。
- **边缘条件**：找不到返回空对象（调用方据此把 `kind` 定为 `host`）；**远端目标不调用它**。

### `#buildMapping(input, existing?)`

- **签名**：`(input: MappingInput, existing?: Mapping) => Promise<Mapping>`
- **入参**：`input`（已由 API 层做过 zod 校验）；`existing` 用于 update 语义。
- **出参**：完整的 `Mapping`（已分配 id、`createdAt`/`updatedAt`）。
- **功能**：全部前置校验与目标构造。**校验顺序**（顺序本身是设计的一部分）：

  1. 路径归一化 → `invalid-path`
  2. 目标路径归一化 → `invalid-target-path`
  3. 端口范围 → `invalid-port`
  4. Service 名归一化 → `invalid-service`（`null`/`''` = 节点级）
  5. 远端主机归一化 → `invalid-remote-host`（空串与回环 = 无远端）
  6. **`remoteHost` 有值但 `service` 为空 → `remote-host-requires-service`**
  7. 对外端口范围 → `invalid-serve-port`
  8. **`remoteHost` 为空且 `hostPort === adminPort` → `exposes-admin`**（硬拒绝，且不写 serve）
  9. **`servePort === adminPort` → `serve-port-is-admin`**
  10. 同 `(service, 端口, 路径)` 重复 → `duplicate-path`
  11. 位置被**未托管**路由占用且未带 `confirmTakeover` → `takeover-required`

- **边缘条件**：
  - 第 8 条刻意放在第 11 条之前：即使该位置被一条未托管路由占用，也不能以「接管」的名义把它变成管理端口的出口；
  - 第 8 条只对**本机目标**生效（远端同名端口不是本进程）；
  - **不校验 Service 是否已存在**——把配置推到新的 service host 上正是本工具的用法；写失败时 tailscale 的真实报错（中文翻译后）会出现在 `ApplyResult.errors` 里；
  - `kind` 推导：`input.kind` 优先；否则远端 → `host`，反查到容器 → `container`，再否则 `host`；
  - 远端目标**不写** `containerId` / `containerName` / `containerPort`。

### `create(input)`

- **签名**：`(input: MappingInput) => Promise<{ mapping: MappingView; apply: ApplyResult }>`
- **出参**：创建后的视图与本次收敛结果。
- **功能**：入队 → 构记录 → **先写映射库** → 审计 → `applyInternal()` → 重新取视图。
- **边缘条件**：校验失败在写库前抛出（库不变）；收敛失败时映射仍在库里，状态 `pending`，`apply.errors` 里带原因。

### `update(id, input)`

- **签名**：`(id: string, input: MappingInput) => Promise<{ mapping: MappingView; apply: ApplyResult }>`
- **出参**：同 `create`。
- **功能**：读库 → 合并入参（`path`/`hostPort` 必填，其余 `?? existing`）→ 复用 `#buildMapping` 的全套校验 → 覆写 → 收敛。
- **边缘条件**：
  - `id` 不存在 → `not-found`；
  - **`service` / `remoteHost` / `scheme` 用 `!== undefined` 判断**：显式传 `null` 表示「切回节点级 / 清除远端」，省略表示「不改动」——这是 PATCH 语义的关键；
  - 改端口 / 路径 / Service 时，旧位置由 `ownedRoutes` + plan 的 removals 机制摘除。

### `remove(id)`

- **签名**：`(id: string) => Promise<{ removed: Mapping | null; apply: ApplyResult }>`
- **出参**：被删除的记录与收敛结果。
- **功能**：先从库里删除，再用一条 **tombstone**（`enabled: false`，`ownedRoutes` 含原位置）参与同一次 `applyInternal([...rest, tombstone])`。
- **边缘条件**：
  - 位置摘除与记录删除**由同一套差异计算处理**，不需要为删除写第二套逻辑；
  - `tombstone.ownedRoutes` 会先剔除重复的原位置再加回，避免重复项；
  - 摘除失败时记录已从库里消失（这是有意的：用户意图是删除，残留由下次 apply 或手动清理处理）。

### `setEnabled(id, enabled)`

- **签名**：`(id: string, enabled: boolean) => Promise<{ mapping: MappingView; apply: ApplyResult }>`
- **出参**：同 `update`。
- **功能**：读一次当前值后直接委托 `update()`。
- **边缘条件**：**自身不入队**——`update` 已经入队，再包一层会因队列自等待而**死锁**（历史缺陷，已在 `history.md` 记录）。

### `importExternal(selection?)`

- **签名**：`(selection?: Array<{service?: string | null; servePort: number; path: string}>) => Promise<{ imported: Mapping[]; skipped: Array<{service, servePort, path, reason}> }>`
- **入参**：省略即接管全部未托管路由。
- **出参**：被接管的记录与被跳过项（含中文原因）。
- **功能**：**只认领，不写 serve**，因此不会造成任何瞬时中断。
- **边缘条件**：
  - 跳过条件：非 HTTP(S) 代理（`tcp/unix/text` 等）、本机目标指向管理端口、对外端口与管理端口同号（每条都有独立的中文原因）；
  - 远端目标自动落成 `kind: 'host'` + `remoteHost`；
  - **Service 端点的目标路径按空串接管**（`get-config` 读不回来），备注里写明「apply 后会按映射库重写」；
  - 幂等：已被接管的键会被 `managedKeys` 跳过。

### `apply()` / `applyInternal(overrideMappings?)`

- **签名**：`() => Promise<ApplyResult>` / `(overrideMappings?: Mapping[]) => Promise<ApplyResult>`（private）
- **出参**：`ApplyResult`：`{upserted, removed, blocked, exposures, errors, inSync}`；`upserted`/`removed` 是 `RouteRef[]`（含 `service`）。
- **功能**：唯一副作用集中点，顺序为

  ```text
  plan → 逐条 upsert（失败收集到 errors，不中断）→ 逐条 remove（同上）
       → 审计 → 回写 ownedRoutes → 复查 exposures 并记录审计 → 重新评估得到 inSync
       → 刷新快照（失败只警告）
  ```

- **边缘条件**：
  - **回写 `ownedRoutes` 的规则**：候选集为 `enabled ? [当前位置, ...ownedRoutes] : ownedRoutes`，再与「收敛后仍存在于 serve 中的位置」求交。摘除失败时归属被保留，下次 apply 会自动重试；
  - **收敛失败不回滚映射库**；
  - 快照写失败绝不能影响收敛结果（`#publishSnapshot` 用 `.catch` 只记 warn）；
  - `inSync` 需要同时满足 `isInSync(plan)` 与 `exposures.length === 0`。

### `publishSnapshot()` / `get snapshotFilePath()`

- **签名**：`() => Promise<Snapshot>` / `string`
- **出参**：写出的快照对象 / 快照文件绝对路径。
- **功能**：`#evaluateAll()` → `buildSnapshot()` → 交给 `SnapshotWriter`。**只读不写 serve 配置**（定期刷新走这条路径）。
- **边缘条件**：`#publishSnapshot` 内部在 `tailnet` 为 `null` 时会再试一次 `gateway.tailnet()`（可能抛错，由调用方 catch）。

### `enforceExposureGuard()`

- **签名**：`() => Promise<{ exposures: ReconcilePlan['exposures']; removed: RouteRef[] }>`
- **出参**：检测到的暴露与成功摘除的位置。
- **功能**：启动闸门。**独立实现**，不依赖映射库内容——即使映射库被写坏或为空，启动时也一定会执行一次全量扫描。
- **边缘条件**：
  - 扫描 `r.handler.kind === 'proxy' && hostPort === adminPort && r.handler.loopback`：即「全部 HTTPS 端口 × 两个命名空间，但只判本机目标」；
  - `autoUnexpose === false` 时只审计 + `logger.error`，**不摘除**；
  - 单条摘除失败只记 error，不影响其余。

### `serveRoutes()` / `services()` / `canHostService()`

- **签名**：`() => Promise<ServeRoute[]>` / `() => Promise<ServiceInfo[]>` / `() => Promise<{tags, canHostService} | null>`
- **功能**：三个只读查询，供界面「系统路由」与「Service」面板使用。
- **边缘条件**：`serveRoutes` 会用映射库算归属标记（`managed` / `mappingId`）；`canHostService` 的判定是 `tags.length > 0`，读不到身份时返回 `null`（界面据此不显示确定结论）。

## 全局常量 / 变量

- 无模块级常量。实例状态：`#deps`、`#queue`（串行队列）、`#tailnet`（身份缓存）。

## 待办与隐患

- [ ] **`clearService()` 未被调用**：`ServeGateway` 与 `TailscaleCli` 都实现了 `serve clear svc:<name>`，但本文件没有任何代码路径调用它——删除最后一条 Service 映射时只摘那条路由，不会顺手停掉 advertise。这是刻意的（避免误停别人的 Service host），已在项目 `README.md` §11 登记。
- [ ] 已知边界：`importExternal` 对 Service 端点只能按空目标路径接管（上游 `get-config` 不返回目标路径）。
