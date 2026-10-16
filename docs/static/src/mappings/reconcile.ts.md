# `src/mappings/reconcile.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

「期望状态 → 实际 serve 配置」的差异计算。**全部是纯函数**：不碰磁盘、不起进程，因此所有漂移检测逻辑都能在单测里穷举。真正的写入由 `mapping-service.ts` 依据本模块产出的 `ReconcilePlan` 执行。

**路由身份是三元组 `(service, servePort, path)`**，因此本模块全部匹配、去重、归属判断都走 `serveRouteKey()`，而不是单纯的路径比较。

## 依赖 / 引用

- `../domain/route-path.ts`：`buildBaseUrl`、`buildProxyUrl`、`parseProxyUrl`、`serveRouteKey`。
- `../domain/types.ts`：`ContainerInfo`、`Mapping`、`MappingStatus`、`MappingTarget`、`ServeSnapshot`、`TailnetInfo`。
- 被 `src/mappings/mapping-service.ts`（执行 plan）与 `test/{reconcile,snapshot}.test.ts` 引用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `desiredProxyOf` | `(target: MappingTarget) => string` | `string` | 由映射目标算出期望代理地址 | 远端为空即 `127.0.0.1`；`scheme` 缺省 `http` |
| `isSameProxy` | `(a: string, b: string) => boolean` | `boolean` | 两个代理地址是否等价 | 解析失败退化为字符串比较；**远端主机与回环不算同一目标** |
| `describeOrphan` | `(mapping, containers) => string \| null` | `string \| null` | 容器型目标是否失联 | 非 container 或**有 `remoteHost`** → `null`（不判） |
| `evaluateMapping` | `(mapping, snapshot, containers, adminPort, tailnet?) => MappingEvaluation` | `MappingEvaluation` | 单条映射状态评估 | 安全判定最前；暴露只判本机目标 |
| `awaitingApprovalOf` | `(mapping, snapshot) => string \| null` | `string \| null` | Service 级「等待审批」判定 | 节点级恒 `null`；Service 不在快照里也返回 `null` |
| `planReconcile` | `(input: PlanInput) => ReconcilePlan` | `ReconcilePlan` | 计算本轮全部 upsert / removal / blocked / exposures | 见下文逐条规则 |
| `isInSync` | `(plan: ReconcilePlan) => boolean` | `boolean` | upserts 与 removals 是否都为空 | **不含 exposures**，调用方需单独判断 |

## 函数详情

### `desiredProxyOf(target)`

- **签名**：`(target: MappingTarget) => string`
- **入参**：`target`（`MappingTarget`，必选）：`{kind, hostPort, targetPath, remoteHost?, scheme?}`。
- **出参**：`string`，例如 `http://127.0.0.1:4173` 或 `http://my-laptop.example-tailnet.ts.net:3081`。
- **功能**：`buildProxyUrl` 的唯一调用点；`MappingView.desiredProxy` 与 plan 都复用它，避免两处拼串走偏。
- **边缘条件**：`remoteHost` 为 `undefined` 时走本机；`targetPath` 为 `''`/`'/'` 时不追加路径。

### `isSameProxy(a, b)`

- **签名**：`(a: string, b: string) => boolean`
- **入参**：`a` 通常是 serve 里的实际值，`b` 是期望值。
- **出参**：`boolean`。
- **功能**：先 `parseProxyUrl` 再比对 `host` / `hostPort` / `targetPath`，因此 `http://127.0.0.1:8080` 与 `http://127.0.0.1:8080/` 视为相同——避免每次 apply 都产生一次无意义的写入。
- **边缘条件**：
  - 一侧解析失败 → `false`（宁可多写一次，也不要漏写）；
  - 字符串完全相等时短路返回 `true`；
  - **`http://127.0.0.1:3081` 与 `http://my-laptop.example-tailnet.ts.net:3081` 判为不同**（host 参与比较）。

### `describeOrphan(mapping, containers)`

- **签名**：`(mapping: Mapping, containers: ContainerInfo[]) => string | null`
- **入参**：`mapping`、当前容器清单。
- **出参**：中文说明（面向界面 `detail`）或 `null`（健康）。
- **功能**：依次检查「容器存在（先按 id，再按 name）→ `state === 'running'` → 是否仍发布该 `hostPort`（`protocol === 'tcp'`）」。
- **边缘条件**：
  - `kind !== 'container'` → `null`；
  - **`target.remoteHost !== undefined` → `null`**：远端目标的容器清单不在本机 Docker daemon 里，凭空判定「容器不存在」只会误报；这类目标通不通属于 Service host 的网络可达性问题；
  - `containerId` 前缀匹配（`c.id.startsWith(containerId)`），允许存短 id；
  - 容器存在但端口未发布 → 也判孤儿。

### `evaluateMapping(mapping, snapshot, containers, adminPort, tailnet?)`

- **签名**：`(mapping: Mapping, snapshot: ServeSnapshot, containers: ContainerInfo[], adminPort: number, tailnet?: TailnetInfo | null) => MappingEvaluation`
- **入参**：`adminPort` 是 TsController 管理端口；`tailnet` 可选，仅用于拼 Service 的对外地址（缺失只影响 `baseUrl`，不影响状态）。
- **出参**：`MappingEvaluation`：`{status, actualProxy, desiredProxy, baseUrl, detail}`。
- **功能**：状态机，判定顺序为 `blocked → disabled* → orphaned-target → pending → active`；`baseUrl` 由 `buildBaseUrl(snapshot.hostname, servePort, service, tailnet?.magicDnsSuffix)` 算出。
- **边缘条件**：
  - **安全判定最前**，先于 `enabled`：`remoteHost === undefined && hostPort === adminPort` → `blocked`；`servePort === adminPort` → `blocked`（提示语说明了「不会泄露管理面，但会造成混淆」）；
  - **暴露只针对本机目标**：远端主机上的同名端口与本进程无关，判成 `blocked` 会让 NAS 上的正常服务无法映射；
  - `enabled === false` 且 serve 中仍有该位置 → `disabled-drift`，否则 `disabled`；
  - 位置不存在 → `pending`；存在但代理不等价 → `pending` 并在 `detail` 里带上实际值；
  - 完全一致 → `active`。

### `awaitingApprovalOf(mapping, snapshot)`

- **签名**：`(mapping: Mapping, snapshot: ServeSnapshot) => string | null`
- **入参**：`mapping`、当前快照。
- **出参**：中文说明或 `null`。
- **功能**：`service !== null` 且该 Service 出现在 `snapshot.services` 里、`advertised === false` 时返回「已被 drain / 等待批准」的说明。
- **边缘条件**：
  - 节点级映射恒 `null`；
  - Service 不在快照里 → `null`（该位置可能还没写进去，那是 `pending` 的职责）；
  - 只对「期望位置确实已在 serve 中」的映射生效——调用方在 `planReconcile` 里限定 `ev.status === 'active'` 才覆盖。

### `planReconcile(input)`

- **签名**：`(input: { mappings: Mapping[]; snapshot: ServeSnapshot; containers: ContainerInfo[]; adminPort: number; tailnet?: TailnetInfo | null }) => ReconcilePlan`
- **出参**：`ReconcilePlan`：`upserts`、`removals`、`blocked`、`exposures`、`evaluations`。
- **功能**：三个阶段的规则如下。
  1. **评估 + 冲突**：先按 `serveRouteKey` 统计期望集合里的重复键，重复的所有映射都判 `conflict` 并跳过写入（正常流程由 `MappingService` 的更早校验拦住，此处是防御）。`active` 且未获批的 Service 映射被改写为 `awaiting-approval`。
  2. **upsert**：`enabled` 且未被 `blocked`/`conflict` 的位置中，实际缺失或与期望不一致的写入。**`awaiting-approval` 不产生 upsert**（配置已经写对）。
  3. **removal**（三个来源，用 `removalSeen` 去重，`keepKeys` 保护）：
     - 某条映射的 `ownedRoutes ∪ {当前位置}` 中存在、但不在期望集合中的位置；
     - **任何**指向 `adminPort` 且 **`loopback === true`** 的 handler（无论命名空间、无论是否本工具创建）——安全兜底；
     - `blocked` 状态的映射在 serve 中残留的位置。
- **边缘条件**：
  - `removalSeen` 以「位置键」为单位去重（`mappingId: ''` 表示来源是安全扫描，不是某条映射）；
  - 排序稳定：端口 → Service 名 → 路径，便于断言与日志对比；
  - 空输入（无映射、空快照）→ 全部数组为空、`evaluations` 为空 Map。

### `isInSync(plan)`

- **签名**：`(plan: ReconcilePlan) => boolean`
- **出参**：`boolean`。
- **功能**：`upserts.length === 0 && removals.length === 0`。
- **边缘条件**：**`exposures` 需单独判断**——暴露被摘除时会体现在 `removals` 里，但「检测到暴露」这件事本身也要向用户展示（`MappingService` 的 `inSync` 因此写成 `isInSync(plan) && plan.exposures.length === 0`）。

## 补充：模块内部结构与类型

以下是模块内的辅助结构与类型定义（不是可独立调用的函数，但决定了 plan 的形状）：

| 名称 | 形状 | 说明 |
| --- | --- | --- |
| `MappingEvaluation` | `{status, actualProxy, desiredProxy, baseUrl, detail}` | 单条映射的评估结果；`plan.evaluations` 的值 |
| `PlannedUpsert` | `{mappingId, service, servePort, path, proxy}` | 待写入的位置；`mappingId` 为空串表示来自安全扫描 |
| `PlannedRemoval` | `{mappingId, service, servePort, path, currentProxy}` | 待摘除的位置；`currentProxy` 为 `null` 表示该位置是非代理 handler |
| `ReconcilePlan` | `{upserts, removals, blocked, exposures, evaluations}` | 本模块的输出 |
| `PlanInput` | `{mappings, snapshot, containers, adminPort, tailnet?}` | 本模块的输入 |
| `byRoute`（`planReconcile` 内的局部比较器） | `(a, b) => number` | 排序：端口 → Service 名 → 路径；**排序稳定**是日志与断言可比的前提 |

## 全局常量 / 变量

- 无模块级可变状态（纯函数模块）。`planReconcile` 内部使用 `routeByKey` / `desiredKeys` / `duplicateKeys` / `keepKeys` / `removalSeen` 等局部集合。

## 待办与隐患

- [ ] 无 TODO 标记。设计约束：**本文件必须保持纯函数**，任何 IO 都会破坏「状态判定可在单测里穷举」这条性质。
- [ ] 已知盲点（与安全相关，已登记在项目 `README.md` §5/§11 与 `todo.md` 第 9 项）：Service host 反向代理到**远端**本机（`remoteHost` 恰好是本机的 tailnet DNS 名 + 管理端口）时，本模块只看到「一个远端主机名 + 一个端口」，无法判定它是不是本机，因此暴露扫描按设计只覆盖 loopback 目标。
