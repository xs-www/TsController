# `test/reconcile.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

`planReconcile()` 的纯函数规划测试——这是全项目**风险最高**的一段逻辑：它决定「哪些 serve 路由会被写入、哪些会被摘除」。摘除错了会切断用户已有的对外服务，写入错了会把内部端口暴露到 tailnet。因此本文件的用例密度也最高（6 个 `describe`、17 个 `it`），并且刻意把两类最危险的场景写成了显式断言：**未托管路由永不删除**，以及**管理端口必须被摘除（含远端同名端口不算暴露）**。

## 依赖 / 引用

- `vitest`：`describe` / `expect` / `it`。
- `../src/mappings/reconcile.ts`：`isSameProxy`、`planReconcile`（被测）。
- `../src/tailscale/serve-config.ts`：`mergeServeSnapshots`、`parseServeStatus`、`parseServiceConfig`（把原始 JSON 组装成 `planReconcile` 需要的快照）。
- `../src/domain/types.ts`：`Mapping`、`TailnetInfo`（仅类型）。
- `./fakes.ts`：`makeContainer`、`parseFakeRouteKey`。
- 不被任何其它文件引用。同族测试：`test/mapping-service.test.ts`（同一逻辑经服务层的端到端表现）、`test/service-routing.test.ts`（Service 命名空间）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `mapping` | `(partial: Partial<Mapping> & { path: string; hostPort: number }) => Mapping` | `Mapping` | 造一条映射夹具：`servePort` 默认 443、`id` 默认 `m-<port>-<path>`、`enabled` 默认 `true`、`ownedRoutes` 默认空 | `target.kind` 默认 `'host'`；仅当 `partial.target` 里**存在** `remoteHost` / `containerId` / `containerName` 时才写入对应键（因此未给时是 `undefined`、不是 `null`）；`createdAt` / `updatedAt` 固定为 `2026-01-01T00:00:00.000Z` |
| `snapshotOf` | `(handlers: Record<string, string>) => ServeSnapshot` | 快照 | 用简写键（`"/a"` / `":8443/a"`）组装 serve 的原始 `{ TCP, Web }` JSON，再交给 `parseServeStatus()` | 值（proxy）只写进 `Handlers`，端口声明由键推导；解析出的路径与端口决定分组，同端口的多条 handler 会合并进同一个 `Web` 组 |
| `serviceSnapshotOf` | `(services: Record<string, Record<string, unknown>>, serviceHosts?: Record<string, string[]> = {}) => ServeSnapshot` | 合并快照 | 组装「节点级（空）+ Service 级」合并后的快照，贴近真实网关输出 | 简写 `{ 'svc:dsh': { 'tcp:443': url } }` 会被自动包成真实结构 `{ endpoints: {...} }`；若 details 里已含 `endpoints` 或 `advertised` 则**原样使用**（因此可以精确表达 `advertised: false`）；MagicDNS 后缀固定写死 `'example-tailnet.ts.net'` |
| （`it` 用例） | — | — | 见下方「用例覆盖表」 | — |

## 函数详情

### `mapping(partial)`

- **签名**：`(partial: Partial<Mapping> & { path: string; hostPort: number }) => Mapping`
- **入参**：`partial`（必选）：至少给 `path` 与 `hostPort`；`servePort` / `id` / `service` / `enabled` / `ownedRoutes` / `target.*` 都可覆盖。
- **出参**：`Mapping`。
- **功能**：把用例里真正关心的三四个字段写出来，其余全部给稳定默认值，使断言的期望值可以少写。
- **边缘条件**：
  - `id` 的默认规则是 `` `m-${servePort}-${path}` ``——`test/reconcile.test.ts` 里大量断言（`plan.evaluations.get('m-443-/worldforge')`）都依赖它；
  - `service` 默认 `null`（节点级）；Service 级用例通过 `svcMapping()` 包装器把 `service: 'svc:dsh'` 注入；
  - `target.kind` 取 `partial.target?.kind ?? 'host'`，因此用例可以造出 `'container'` 型映射；
  - `hostPort` 用的是 `??` 而不是 `||`，但 `partial.hostPort` 是类型上必填的 `number`——只有显式传 `0` 时 `??` 会保留 0（与 `targetPath` 用 `??` 的写法一致）；`0` 不是合法端口，现有用例不会传；
  - `ownedRoutes` 默认空数组表示「这条映射还没占用过任何位置」——这正是「新映射 → 一次挂载」用例的前提。

### `snapshotOf(handlers)`

- **签名**：`(handlers: Record<string, string>) => ServeSnapshot`
- **入参**：`handlers`（必选）：键为简写路由键，值为 proxy 字符串。
- **出参**：`ServeSnapshot`（`services` 恒为空，`hostname` 恒为 `'host'`）。
- **功能**：把「某个端口上有一条指向某地址的路由」这句人话翻译成 serve 的真实 JSON 结构。派生方式：对每个键跑 `parseFakeRouteKey()` 拿到端口与路径，按 `host:<port>` 分组，再从分组键推出 `TCP` 里的端口声明（全部标 `HTTPS: true`）。
- **边缘条件**：
  - 因为分组键固定用 `host:`，所有路由的 `host` 都是 `'host'`；
  - 只生成 `Web` 组与 `TCP` 声明，**不生成 Service**；Service 场景必须走 `serviceSnapshotOf()`；
  - 端口从键推导，因此 `":8443/a"` 会同时把 8443 声明进 `TCP`；写成 `"/a"` 则只在 443 上。

### `serviceSnapshotOf(services, serviceHosts?)`

- **签名**：`(services: Record<string, Record<string, unknown>>, serviceHosts: Record<string, string[]> = {}) => ServeSnapshot`
- **入参**：
  - `services`：`Service 名 → 端点表`。可以是简写 `{ 'tcp:443': 'http://…' }`，也可以是含 `endpoints` / `advertised` 的完整形态。
  - `serviceHosts`（可选，默认 `{}`）：对应 `status --json` 的 `Self.CapMap["service-host"]`。
- **出参**：`mergeServeSnapshots(parseServeStatus({}), parseServiceConfig(...), serviceHosts)` 的结果。
- **功能**：Service 级用例的单一入口，把「配置里的端点」与「本节点是否被承认（`serviceHosts`）」这两件事分别提供——后者是 **only** 能证明 Service 已被 advertise 的证据（配置里的 `advertised` 缺省值不可信）。
- **边缘条件**：
  - **默认 `serviceHosts = {}` 即「未被承认」**：只传 `services` 的用例会得到 `advertised: false`，这正是「未被承认 → `awaiting-approval`」用例需要的状态；
  - `'endpoints' in details || 'advertised' in details` 这个判定决定「原样使用」还是「包一层 endpoints」；如果简写的端点表里恰好有个叫 `advertised` 的键，会被误当完整形态——现有用例不会踩到。

### `describe('isSameProxy')`

- 两条用例。守住「两个代理地址算不算同一个」这个判等关系：尾斜杠差异忽略，但主机、端口、目标路径三者任一不同即不等。这是幂等收敛与安全判定的公共基础。

### `describe('planReconcile（单端口）')`

- 十条用例，默认端口 443 上的主流程：新映射、已一致、目标端口变化、禁用、路径改名、容器孤儿、冲突、目标路径拼接，以及最重要的一条——**永不删除未托管的既有路由**。

### `describe('planReconcile（多端口）')`

- 三条用例，把「端口是路由身份的一半」从身份层推到规划层：同路径不同端口互不干扰、迁移端口要摘旧挂新、未托管路由的豁免按端口各自成立。

### `describe('planReconcile（Service 级）')`

- 五条用例，覆盖 Service 命名空间与节点级完全不同的几件事：写入带 Service 维度、远端目标、`awaiting-approval`（未被承认 / 被 drain）、远端目标不做孤儿检测。该分组内定义了局部包装器 `svcMapping`（见「全局常量 / 变量」）。

### `describe('planReconcile（安全）')`

- 五条用例，专门守住安全闸门：目标指向管理端口、对外端口与管理端口同号、未托管路由指向管理端口也要摘（任意端口）、Service 命名空间同样要扫、远端同名端口不算暴露。

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `isSameProxy > 忽略尾斜杠差异` | `http://127.0.0.1:8080` 与 `…8080/` 视为等价（serve 写回时可能带尾斜杠），但端口不同（8081）或目标路径不同（`/other`）必须不等价。等价判定过松会让「目标端口已改」的映射不被重新写入，过紧会让每次 apply 都产生无意义的写操作 |
| `isSameProxy > 远端主机与回环不被视为同一目标` | `127.0.0.1:3081` 与 `my-laptop.example-tailnet.ts.net:3081` 是**两个不同的目标**。若这里相等，Service host 上的远端代理会被误判为已同步，用户以为改了目标其实没改 |
| `planReconcile（单端口） > 新映射 → 一次挂载，无摘除` | 全新映射产生一条 `upsert`（字段完整：`mappingId` / `service: null` / `servePort` / `path` / `proxy`）、`removals` 为空、状态 `pending`。这是最基础的一条：**状态不是 active 而是 pending**，意味着 apply 后还要再核对一次 |
| `planReconcile（单端口） > 已一致 → 无需任何写操作` | 当 `ownedRoutes` 覆盖当前位置且 serve 里的 proxy 与期望一致时，`upserts` 与 `removals` 都为空、状态 `active`。这是幂等性的锚点——否则常驻进程每次收敛都会重写 serve 配置 |
| `planReconcile（单端口） > 目标端口变化 → 覆盖写入` | 同路径但 `hostPort` 从 4173 变成 5000 时产生一次 `upsert` 指向新地址、状态回 `pending`。守住「改端口必须真的重新写入」，而不是因为路径没变就跳过 |
| `planReconcile（单端口） > 禁用映射 → 摘除它占用过的路由` | `enabled: false` 时摘除 `ownedRoutes` 里的位置，状态为 `disabled-drift`（而不是 `disabled`）——因为 serve 里确实还有残留。这条是「禁用要真的断开对外访问」的唯一保证 |
| `planReconcile（单端口） > 永不删除未托管的既有路由` | 快照里有 `/`、`/dsh`、`/calendar` 三条**用户手工配的**路由时，只写 `/worldforge`、`removals` 为空。**这是本文件最重要的安全不变式**：删除策略只针对 `ownedRoutes` 记账过的位置，用户用 `tailscale serve` 自己配的东西绝不能被动 |
| `planReconcile（单端口） > 路径改名 → 摘旧挂新` | `ownedRoutes` 里的 `/worldforge` 被换成 `/wf` 时：挂 `/wf`、摘 `/worldforge`。若不摘旧位置，改名会留下一个无人认领的 handler，继续把流量送进容器 |
| `planReconcile（单端口） > 容器型映射的目标容器消失 → orphaned-target` | 三种输入分别对应：容器不在清单里 → `orphaned-target`；容器存在但 `state: 'exited'` → 同样 `orphaned-target`；容器 `running` → `active`。**已停止的容器也算孤儿**（`listContainers()` 拉的是 `all=1`，所以能看见它） |
| `planReconcile（单端口） > 同一路由被两条映射占用 → conflict 且跳过写入` | `/dup` 与 `/DUP` 是**同一条**路由（大小写不敏感），两条映射都被标 `conflict` 且 `upserts` 为空。既不能随机挑一条写入（用户意图不可猜），也不能只靠大小写差异让两条都写进去 |
| `planReconcile（单端口） > 目标路径追加在代理地址之后` | `targetPath: '/api/agent'` 拼出 `http://127.0.0.1:443/api/agent`。守住「目标路径要真的出现在写入的地址里」，而不是被当成展示字段丢掉 |
| `planReconcile（多端口） > 同一路径挂在不同端口上是两条互不干扰的路由` | 443 的 `/`（已一致 → `active`）与 8443 的 `/`（新 → 一次 `upsert`）互不影响，且 **443 那条不产生写入**。这就是「端口是路由身份的一半」，破掉会让 8443 的写入覆盖掉 443 上用户正在用的入口 |
| `planReconcile（多端口） > 迁移端口 → 摘旧端口的旧路由、挂新端口` | `ownedRoutes` 记的是 443，映射现在要挂 8443：产生一次 8443 的 `upsert` **和**一次 443 的 `removal`（`currentProxy` 带上当时的实际地址）。迁移是「先挂新、再摘旧」——若只挂不摘，旧端口会长期残留一条指向同一容器的入口 |
| `planReconcile（多端口） > 某端口上已存在未托管路由时，只影响该端口` | 443 与 8443 上都有未托管的 `/`，映射只占 8443：写入 8443，`removals` 为空，**443 上的未托管 `/` 不受影响**。这是「永不删除未托管路由」在多端口下的加强版：同路径也不行，必须看端口 |
| `planReconcile（Service 级） > Service 级映射 → 写入时带 Service 维度，目标可为远端主机` | 写入条目带 `service: 'svc:dsh'`，proxy 是远端地址 `http://my-laptop.example-tailnet.ts.net:3081`；**`baseUrl` 是 `https://dsh.example-tailnet.ts.net`**（Service 的 MagicDNS 名），而不是节点名。地址用错会让用户拿到一个 404 或指向别人服务的链接 |
| `planReconcile（Service 级） > 节点级的 /dsh 与 Service 级 svc:dsh 的 / 是两条独立路由` | 两条都已在各自命名空间里一致 → `upserts` 与 `removals` 都为空、两条都 `active`。**若路由身份漏掉 Service 维度，这里会变成一条误删另一条**——这是 Service 支持里最容易被写坏的一条 |
| `planReconcile（Service 级） > Service 已被承认 → active；未被承认 → awaiting-approval（配置写对了但对外不可用）` | `serviceHosts` 里有本节点 → `active`；为空 → `awaiting-approval`，且**不产生任何写入**（`upserts` 为空）。用户看到的原因必须是「等待审批」而不是反复重写一份本来就正确的配置 |
| `planReconcile（Service 级） > Service 被 drain（advertised:false）→ awaiting-approval` | 配置里 `advertised: false` 时状态是 `awaiting-approval` 且 `detail` **包含 `'drain'`**。被 drain 与「等审批」对外表现相同（都不可用），但给用户的解释必须不同 |
| `planReconcile（Service 级） > 远端目标不做孤儿检测（那台机器的容器清单不在本机）` | `remoteHost` 非空且容器清单为空时，状态**不能**是 `orphaned-target`。远端机器上的容器不归本机 Docker 管，凭空判孤儿只会误报 |
| `planReconcile（安全） > 目标指向管理端口 → blocked，并作为暴露被摘除` | 目标就是 `adminPort` 时：进 `blocked`（原因含「禁止暴露」）、进 `exposures`、`upserts` 为空、并被摘除、状态 `blocked`。**这是本工具存在的理由之一**：管理界面绝不能被 serve 转发到 tailnet 上 |
| `planReconcile（安全） > 对外端口与管理端口同号 → blocked` | 映射的 `servePort` 恰好等于 `adminPort` 时直接 `blocked`（原因含「同号」）且无写入。端口冲突不会体现在目标地址上，因此必须是独立判定 |
| `planReconcile（安全） > 未托管的既有路由若指向管理端口，也会被摘除（任意端口）` | 即便**没有任何映射**，443 与 8443 上指向管理端口的未托管路由也会进 `exposures` 并被摘除。这是「永不删除未托管路由」的**唯一例外**，且必须跨端口生效——早期只扫默认端口的实现会留下 8443 上的这个洞 |
| `planReconcile（安全） > Service 级暴露同样被扫到并摘除` | Service 命名空间里的暴露同样进 `exposures`，且 `removals` 里带 `service: 'svc:dsh'`、`mappingId: ''`（无人认领）。安全闸门只扫节点级就等于给 Service 开了一个后门 |
| `planReconcile（安全） > 远端目标上的同名端口不算暴露（与本进程无关）` | `http://my-laptop.example-tailnet.ts.net:8787` 不进 `exposures`。`adminPort` 只对本机有意义；判定过宽会导致远端部署（NAS 代理到笔记本）的合法配置被反复摘除 |

## 全局常量 / 变量

- `ADMIN_PORT`：`number`，值为 `8787`。安全用例里「管理端口」的取值；同时用于构造「目标指向管理端口」与「对外端口与管理端口同号」两种场景。
- `TAILNET`：`TailnetInfo`，与 `test/fakes.ts` 的默认值同构（`my-laptop.example-tailnet.ts.net` / `100.101.102.103` / `example-tailnet.ts.net` / 空 `tags` / 空 `serviceHosts`）。传给 `planReconcile` 只影响 `baseUrl` 的拼装。
- `svcMapping`（`describe('planReconcile（Service 级）')` 内）：局部包装器 `(partial) => mapping({ service: 'svc:dsh', ...partial })`，等价于「再造一条 Service 级映射」。

## 待办与隐患

- [ ] 无 TODO 标记。真实观察：本文件**完全通过 `planReconcile` 的纯函数接口**验证，因此「写失败后如何重试」「摘除失败时映射库是否保留 ownedRoutes」这类**跨调用的状态机行为不在这里**，由 `test/mapping-service.test.ts` 覆盖——两份文件必须一起看才完整。
- [ ] 源码里 `describeOrphan()` 支持「用 `containerId` 前缀匹配」（`c.id.startsWith(mapping.target.containerId)`），本文件只按容器名/完整 id 断言，前缀匹配分支未覆盖。
- [ ] `conflict` 状态在本文件里**只有一条来源**：两条映射占用同一个 `(service, port, path)` 键。源码核查确认，当期望位置被一条**外部未托管**路由占用（proxy 与期望不一致）时，`evaluateMapping()` 给的是 `pending`（`detail` 为「serve 中该路由指向 …，与期望不一致」），而不是 conflict——「外部占用」与「映射互相冲突」是两种不同处置，本文件没有区分断言。
- [ ] 「容器存在但**未发布**目标端口」（`describeOrphan()` 的 `published` 分支：`tcp:5432` 在容器上但宿主没发布 `hostPort`）没有用例；本文件只覆盖了「容器不存在」与「容器已停止」。
- [ ] `planReconcile` 对 `tailnet` 缺省（`undefined`）时的 `baseUrl` 行为没有断言。
