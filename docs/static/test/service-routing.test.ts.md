# `test/service-routing.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

Service 级路由（Tailscale Services / tagged node）的**端到端**专项测试：它把 `MappingService`、真实的规则计算（`planReconcile`）与内存替身（`FakeServeGateway` / `FakeContainerSource` / `MemoryMappingStore` / `MemoryAuditLog` / `MemorySnapshotWriter`）串起来，覆盖四条与节点级完全不同的链路——写入要带 Service 维度、目标可以是**远端主机**、**「配置写对了但还没被承认」**要如实汇报且不产生多余写入、以及安全闸门与导入都必须覆盖 Service 命名空间。文件头的注释把这四条列成了清单，本文件就是它们的可执行版本。

## 依赖 / 引用

- `vitest`：`describe` / `expect` / `it`。
- `../src/mappings/mapping-service.ts`：`MappingService`（被测主体）。
- `../src/mappings/store.ts`：`MemoryMappingStore`、`MemoryAuditLog`。
- `../src/snapshot.ts`：`MemorySnapshotWriter`。
- `../src/logger.ts`：`silentLogger`。
- `./fakes.ts`：`FakeContainerSource`、`FakeServeGateway`、`makeContainer`。
- 不被任何其它文件引用。同族测试：`test/mapping-service.test.ts`（节点级 + 多端口的同一套服务层行为）、`test/reconcile.test.ts`（同一批规则在纯函数层）、`test/api.test.ts`（HTTP 层）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `setup` | `() => { gateway; store; audit; snapshot; containers; service }` | 六个对象的解构 | 每个用例一组全新的内存依赖：替身网关、映射库、审计日志、快照写出器、容器来源（预置一条 `dsh` 容器，发布 `3081`），以及装配好的 `MappingService` | 固定参数：`adminPort = 8787`、`servePort = 443`、`autoUnexpose = true`、`logger = silentLogger`；`autoUnexpose: true` 是安全闸门用例能摘除路由的前提 |
| （`it` 用例） | — | — | 见下方「用例覆盖表」；本文件没有自定义类或其它辅助构造器 | — |

## 函数详情

### `setup()`

- **签名**：`() => { gateway: FakeServeGateway; store: MemoryMappingStore; audit: MemoryAuditLog; snapshot: MemorySnapshotWriter; containers: FakeContainerSource; service: MappingService }`
- **入参**：无。
- **出参**：每次调用都是一套**互不共享**的内存对象；`gateway` 的 `handlers` / `httpsPorts` / `services` 都是全新实例，因此用例之间没有串味。
- **功能**：把 `MappingService` 需要的六项依赖一次装配好。`containers` 里预置了一条容器：名字 `dsh`、把宿主端口 `3081` 发布到容器端口 `3081`（`hostIp` 为默认的 `127.0.0.1`）——这样「本机端口 3081 对应容器 dsh」这个前提在多个用例里可以直接引用。
- **边缘条件**：
  - `MappingService` 的依赖里**没有** `tailnet`：它由服务内部按需从 `gateway.tailnet()` 读取（失败时降级为 `null`）。因此 `gateway.tailnetInfo` 的 `tags` / `magicDnsSuffix` 决定了界面地址与 `canHostService()` 的结果。
  - `MemorySnapshotWriter` 只在 `apply` 之后被写入，因此「不产生任何写入」的用例里 `snapshot.writes` 可能是空数组——断言要取 `snapshot.last!` 时必须先确认发生过一次收敛。
  - `autoUnexpose: true` 表示检测到指向管理端口的暴露会**自动摘除**；置为 `false` 的话本文件的 `enforceExposureGuard` 用例断言就会不同。

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `MappingService · Service 级路由 > 创建 Service 级映射时按 --service 维度写入，并在映射库里记下 Service` | 写入落在 **Service 命名空间**：`apply.upserted` 是 `[{service:'svc:dsh', servePort:443, path:'/'}]`，`gateway.proxyOf('/',443,'svc:dsh')` 有值而 `proxyOf('/',443,null)` 为 `undefined`，`gateway.calls[0]` 带 `service` 维度，映射库里 `service` 字段也被持久化。**若这里漏掉 Service 维度，用户的 Service 路由会被写到节点级命名空间**（对外地址完全不同） |
| `MappingService · Service 级路由 > 接受 dsh 与 svc:dsh 两种写法，并统一归一化` | 传 `'dsh'` 也归一化成 `svc:dsh`，并同样落库。API/界面允许裸名，但内部表示只有一种，否则同一个 Service 会在映射库里出现两个「不同」的名字 |
| `MappingService · Service 级路由 > 非法 Service 名 → invalid-service，且不写入 serve` | `'DSH'`（大写）被拒绝为 `invalid-service`，且 `gateway.handlers.size === 0`、`calls` 为空。**拒绝必须发生在任何写操作之前**：静默把大写折叠成小写会写到另一个 Service 上，而「写一半再报错」会留下无法追踪的残留 |
| `MappingService · Service 级路由 > Service 级与节点级可以用同一个路径，互不冲突` | 同一个 `/` 同时存在于 `svc:dsh` 与节点级，两次 `create` 都成功，两个命名空间各自指向不同端口（3081 / 8899）。这是「两个命名空间互不干扰」在服务层的锚点；破掉会让第二条创建被判成 `duplicate-path` 或覆盖第一条 |
| `MappingService · Service 级路由 > 同一 Service 上路径重复 → duplicate-path` | 同 Service 同路径再创建一次被拒绝为 `duplicate-path`。去重必须**带 Service 维度**：只比路径会让节点级与 Service 级无法共存，只比 Service 会让同一 Service 下的重复挂载悄悄覆盖 |
| `MappingService · Service 级路由 > 从 Service 级改回节点级时，摘掉 Service 上的旧路由` | `update(..., { service: null })` 之后 Service 上的 `/` 消失、节点级 `/` 出现。**旧命名空间的路由必须被摘干净**，否则 `svc:dsh` 上会留下一个继续把流量送进容器的孤儿 handler——用户以为已经「改回节点级」了 |
| `MappingService · Service 级路由 > 删除最后一条 Service 映射后，Service 上的路由被摘干净` | `remove()` 后 `gateway.handlers.size === 0`。删除映射必须真的把 serve 路由摘掉，而不是只从映射库里删记录 |
| `MappingService · Service 级路由 > Service 被承认后 → active；未被承认 → awaiting-approval 且不重写配置` | `addService(SERVICE,[443],false)` 造出「有端点配置但无 `service-host` 能力」→ 状态 `awaiting-approval`、`detail` 含 `'Service'`、`apply.upserted` 为空、`inSync === true`；随后 `addService(..., true, ['100.65.32.1'])` 让 `overview()` 里该映射自动转为 `active`，且 Service 列表带上 `advertised: true` 与 TailVIP。**「配置对但对外不可用」与「配置没写」必须区分开**，且前者绝不能触发反复重写 |
| `MappingService · 远端目标 > Service host 代理到远端主机时，写的是远端地址` | 带 `remoteHost` 创建时，serve 里写的是 `http://my-laptop.example-tailnet.ts.net:3081`（而不是 `127.0.0.1`）。Service host（例如 NAS）代理另一台机器的资源是 Service 场景的核心用法 |
| `MappingService · 远端目标 > 远端目标不会被误认成本机容器（kind 为 host）` | 目标端口 3081 恰好与本机容器 `dsh` 的发布端口相同，但给了 `remoteHost` 之后 `target.kind === 'host'` 且 `containerName` 为 `undefined`。**否则本机容器一停，远端映射会被误判成 `orphaned-target`** |
| `MappingService · 远端目标 > 远端目标只允许挂在 Service 级路由上` | 不带 `service` 却给 `remoteHost` → `remote-host-requires-service`，且 `gateway.handlers.size === 0`。节点级 serve 的目标语义就是本机回环，远端地址在节点级不可表达——必须提前拒绝而不是写出一条无效配置 |
| `MappingService · 远端目标 > 远端目标的端口即使等于管理端口也不拒绝（那是另一台机器）` | `hostPort = adminPort(8787)` 配 `remoteHost` 时 `apply.errors` 与 `apply.blocked` 都为空。安全判定只看**本机**暴露；判宽了会让 NAS 代理笔记本的正常服务无法配置 |
| `MappingService · 远端目标 > 非法远端主机名 → invalid-remote-host` | `'http://nas.ts.net'`（带协议）被拒绝为 `invalid-remote-host`。「带协议的主机名」若被接受，拼出的代理地址会变成 `http://http://nas.ts.net:3081` 这种无效 URL |
| `MappingService · Service 命名空间的安全闸门 > Service 端点指向管理端口时被检测并摘除` | `enforceExposureGuard()` 报出 `exposures: [{service:'svc:leak', servePort:443, path:'/'}]`、`removed` 同位置，`gateway.has('/',443,'svc:leak')` 变 `false`，审计日志里出现 `exposure-removed`。**安全闸门必须覆盖 Service 命名空间**，否则只要把管理端口挂到某个 Service 上就绕过了整个防护 |
| `MappingService · Service 命名空间的安全闸门 > 节点级与 Service 级同名路径互不牵连` | 摘掉 `svc:leak` 上的 `/` 之后，节点级的同名 `/` 仍是 `http://127.0.0.1:3081`。摘除动作必须**按三元组定位**：按路径删会把节点级那条无辜的路由一起干掉 |
| `MappingService · 导入 Service 端点 > 把既有 Service 端点接管为受管映射，且不改动 serve` | `importExternal()` 认领远端 Service 端点：`imported[0]` 带 `service` / `path` / `servePort`，`target` 被识别为 `kind:'host'` + `remoteHost`，`note` 含 `'Service'`；**没有任何 `upsert` 调用**（导入只认领不写配置）；导入后 `overview().externalRoutes` 为空、映射状态 `active`。若导入顺手重写 serve，就会在用户没要求的时候改动线上配置 |
| `MappingService · 导入 Service 端点 > 可只导入指定的 Service 路由` | 同时存在 `svc:dsh` 与 `svc:other` 的 `/`，传入 `[{service:'svc:other', servePort:443, path:'/'}]` 后只导入 `svc:other`。批量导入必须支持按三元组精确选择，否则多 Service 环境下无法只接管其中一个 |
| `MappingService · 导入 Service 端点 > Service 上的暴露不做接管，并给出原因` | 指向管理端口的 Service 端点被放进 `skipped`（`reason` 含「管理端口」）而 `imported` 为空。**导入不能成为绕过安全闸门的入口**，并且要告诉用户为什么跳过 |
| `MappingService · Service 状态视图 > overview 会把 Service 列表与 selfTags 一并返回` | `overview().services` 完整给出 `{name, dnsName:'dsh.example-tailnet.ts.net', servePorts:[443], advertised:true, vipIps:['100.65.32.1']}`，`selfTags` 反映 `tailnetInfo.tags`。界面据此判断「本节点能不能承载 Service」并展示原因 |
| `MappingService · Service 状态视图 > canHostService 依据本节点是否有 tag 判定` | 无 tag → `{tags:[], canHostService:false}`；有 `tag:service-host` → `canHostService:true`。**tag 是唯一依据**：没有 tag 的节点不可能成为 Service host，提前给出结论比让用户对着 CLI 报错猜要好 |
| `MappingService · Service 状态视图 > Service 路由的对外地址用 Service 的 MagicDNS 名` | `mapping.baseUrl === 'https://dsh.example-tailnet.ts.net'`（Service 名），不是节点名。地址错了用户点链接会落到节点级的另一个服务上 |
| `MappingService · Service 状态视图 > 快照带上了 Service 维度与 Service 列表（schemaVersion=2）` | 写出的快照 `schemaVersion === 2`、`services` 含 `svc:dsh`，且该路由带 `service` / `path:'/'` / `host:'dsh.example-tailnet.ts.net'` / `url:'https://dsh.example-tailnet.ts.net/'` / `managed:true` / `status:'active'`。快照是**其它容器读取路由状态的唯一渠道**，schema 版本与 Service 维度必须一起升版，否则消费方会静默解析错 |

## 全局常量 / 变量

- `ADMIN_PORT`：`number`，值为 `8787`。传给 `MappingService` 的管理端口，也是「远端同名端口不算暴露」用例的目标端口。
- `SERVICE`：`string`，值为 `'svc:dsh'`。本文件里唯一的 Service 名。
- `REMOTE`：`string`，值为 `'my-laptop.example-tailnet.ts.net'`。远端主机名。
- `setup()` 里预置的容器夹具：`makeContainer('dsh', [{ hostPort: 3081, containerPort: 3081 }])`——`state` 默认 `'running'`，所以本文件默认没有孤儿场景。

## 待办与隐患

- [ ] 无 TODO 标记。真实观察：本文件的 `gateway` 是内存替身，因此**真实的 CLI 参数顺序**（`--service` 必须在 `--https` 之前）在这里**看不出来**——它由 `test/service-config.test.ts` 的参数数组断言守住。两份文件合起来才覆盖「Service 级写入」的完整链路。
- [ ] `setup()` 固定 `autoUnexpose: true`，因此 `autoUnexpose: false`（只报告不摘除）的行为在本文件里没有对照用例。
- [ ] `enforceExposureGuard()` 的返回值里 `removed` 只断言了位置，没有断言「摘除失败时（`failDeletion`）`removed` 与实际状态是否一致」——Service 命名空间下的摘除失败路径未覆盖。
- [ ] `importExternal()` 的分支里，「不是可接管的 HTTP(S) 代理路由（`tcp`/`unix`/`text`）」、「对外端口与管理端口同号」两类 `skipped` 原因没有用例（本文件只覆盖了「暴露」这一种）；另外「该位置已被受管映射占用」是 `continue` 而非 skip，因此不会出现在 `skipped` 里，这条语义差也没有断言。
