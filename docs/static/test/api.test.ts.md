# `test/api.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

管理 HTTP API 的契约测试（Fastify `inject()`，不起真实端口）。除了「路由可用、状态码正确」之外，它守的是三件更要紧的事：**错误码到 HTTP 状态码的映射口径**（409 `exposes-admin` / `takeover-required` / `serve-port-is-admin` / `remote-host-requires-service` / `invalid-service`，400 入参，403 `forbidden-host`，404 不存在）、**Host 头防 DNS rebinding**、以及 **Service 维度（tag 身份、Service 列表、远端目标、节点级↔Service 级切换）在 API 层的完整暴露**。

依赖同样是全内存替身，因此不碰真实 Docker / tailscale；但 `buildApp` 是真实的，所以路由、序列化、状态码都是生产实现。

## 依赖 / 引用

- 外部：`vitest` 的 `afterEach` / `describe` / `it` / `expect`；`fastify` 的 `FastifyInstance` 类型。
- 被测：`../src/app.ts` 的 `buildApp`；`../src/config.ts` 的 `loadConfig` 与 `AppConfig`。
- 服务层：`../src/mappings/mapping-service.ts` 的 `MappingService`；`../src/mappings/store.ts` 的 `MemoryMappingStore` / `MemoryAuditLog`；`../src/snapshot.ts` 的 `MemorySnapshotWriter`。
- 替身：`./fakes.ts` 的 `FakeServeGateway` / `FakeContainerSource` / `makeContainer`。
- 日志：`../src/logger.ts` 的 `silentLogger`。
- 运行入口：`package.json` 的 `npm test`。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `setup` | `(handlers?: Record<string, string> = {}) => Promise<Harness>` | `Promise<Harness>` | 装配 `AppConfig` + 内存替身 + `MappingService`，再 `buildApp()` 得到可 `inject` 的 Fastify 实例 | `handlers` 只预置 serve 路由；容器清单固定含一个 `worldforge`；`dataDir` 仅为注入值，映射库/审计/快照全是内存实现 |
| `afterEach`（钩子） | `() => Promise<void>` | `Promise<void>` | 关闭上一个用例的 Fastify 实例并清空 `current` | 用例中途 `expect` 失败时仍会执行；`current` 为 `null` 时用 `?.` 跳过 |

## 函数详情

### `setup(handlers?)`

- **签名**：`(handlers: Record<string, string> = {}) => Promise<Harness>`，其中 `Harness = { app: FastifyInstance; gateway: FakeServeGateway; store: MemoryMappingStore; snapshot: MemorySnapshotWriter; config: AppConfig }`。
- **入参**：
  - `handlers`（`Record<string, string>`，可选，默认 `{}`）：预置的 serve 路由，键走 `parseFakeRouteKey` 简写（`"/p"` / `":8443/p"` / `"svc:dsh:443/p"`），值是代理地址。用来构造「已被未托管路由占用」「非默认端口上已有路由」这类前置状态。
- **出参**：`Promise<Harness>`。`app` 是尚未 `listen` 的真实 Fastify 实例（用例统一用 `app.inject()` 发请求）；其余四项供直接断言。
- **功能**：`loadConfig({ port: 8787, dataDir: 'data-test', host: '127.0.0.1' })` 造出配置（**管理端口 8787 是整套用例的判据来源**），把 8787 同时作为 `MappingService` 的 `adminPort`，再注入一个固定含 `worldforge`（宿主 4173 → 容器 8080）的 `FakeContainerSource`，最后交给 `buildApp`。
- **边缘条件**：
  - 每个用例都必须把返回值赋给模块级 `current`，否则 `afterEach` 关不掉实例；
  - `dataDir: 'data-test'` 只出现在配置对象里：本文件走的是 `buildApp` 而非 `createRuntime`，因此不会创建该目录，也不会写真实映射库；
  - 容器清单固定，所以涉及「找不到容器」的用例需要自己另建 harness（本文件没有这样的用例）。

### `afterEach`（钩子）

- **签名**：`() => Promise<void>`
- **入参**：无。
- **出参**：`Promise<void>`。
- **功能**：`await current?.app.close()` 后把 `current` 置 `null`，保证 Fastify 不跨用例泄漏监听器与内部状态。
- **边缘条件**：用例在 `current = await setup()` 之前就失败时 `current` 仍是 `null`（或上一个用例留下的已关闭实例），用可选链跳过；这使钩子本身永不抛错。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| （无 CLI 参数） | — | 由 `vitest run` 驱动 |
| `ADMIN_PORT`（模块常量） | `8787` | 同时作为 `config.port` 与 `MappingService.adminPort`；`/api/system.adminUrl`、`exposes-admin`、`serve-port-is-admin` 三条断言的基准值 |
| 真实 Docker / tailscale | **不需要** | 容器与 serve 配置均来自 `./fakes.ts` |
| 真实 tailnet | **不需要** | `FakeServeGateway.tailnetInfo` 固定为 `my-laptop.example-tailnet.ts.net` / 后缀 `example-tailnet.ts.net`，用例直接对它断言 |

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| 管理 API › `/api/health` 可用 | 最基础的就绪探针返回 200 与 `{ ok: true }`；这是部署脚本与入口页判断「服务活着」的唯一依据 |
| 管理 API › `/api/system` 暴露 tailnet 基址与管理端口，并报告安全状态 | 界面顶部那几个数值的来源：`baseUrl` 取 tailnet、`adminUrl` 必须是 `http://127.0.0.1:<管理端口>`（**不能**是对外地址）、`security.safe` 为真、`sources.docker` 报告数据源描述。守住「管理面只在本机回环上」的可观测性 |
| 管理 API › `/api/containers` 返回容器与端口 | 容器归一化结果经 API 直出的形状：名字与 `hostPort`/`containerPort` 必须保留（少了它们界面的容器选择器就废了） |
| 管理 API › 完整生命周期：创建 → 查询 → 改端口 → 禁用 → 删除 | 五个端点串起来的端到端契约：201/200、`id` 必须可用于后续 PATCH 与 DELETE、每一步真实反映到 serve 与映射库（禁用后网关里查不到、删除后映射库为空）。单条路由的 API 语义一次性锁死 |
| 管理 API › 拒绝建立指向管理端口的映射（409） | 服务层的 `exposes-admin` 必须被映射成 **409**，且响应体里保留 `code`（界面靠 `code` 而非文案做分支）。守住「安全拒绝是可编程的」 |
| 管理 API › 路径被未托管路由占用时要求确认接管（409 → 201） | 同一条请求因 `confirmTakeover` 一个字段从 409 变 201。守住「覆盖别人的配置必须是显式动作」这条交互契约在 HTTP 层成立 |
| 管理 API › 入参非法时返回 400 | `hostPort: 70000` 这类越界值必须被 Fastify/zod 层挡在服务层之前（400，不是 409/500） |
| 管理 API › 不存在的映射返回 404 | `DELETE /api/mappings/nope` → 404。守住「未知 id 不等于服务端错误」 |
| 管理 API › 导入既有 serve 路由 | `POST /api/mappings/import` 空载荷即全量导入，返回 `imported` 数组。门户「一键接管」按钮的契约 |
| 管理 API › 可导入指定端口上的指定路由 | 选择器必须透传到服务层：`{ servePort: 8443, path: '/a' }` 只能带回 8443 上的那条 |
| 管理 API › 可在指定对外端口上创建映射，且 `/api/system` 暴露全部端口 | 一次性锁死四个读接口的端口口径：`/api/system` 的 `servePorts` 升序全集与 `servePort` 默认值、`serveHost`、以及 `/api/serve/routes` 的 `httpsPorts` 与每条路由的 `servePort`。**同时验证 443 上的既有路由不受影响**——多端口引入后最容易漏的一条 |
| 管理 API › 拒绝对外端口与管理端口同号（409） | `serve-port-is-admin` → 409 + `code`。守住「换个对外端口把管理面绕出去」 |
| 管理 API › 对外端口越界时返回 400 | `servePort: 70000` → 400，与宿主端口越界同一口径 |
| 管理 API › `/api/serve/routes` 与 `/api/audit` 可用 | 未托管路由在 `/api/serve/routes` 里 `managed: false`；创建一次映射后 `/api/audit?limit=5` 有事件。守住「审计接口真的被服务层写入」以及 `limit` 查询参数可用 |
| 管理 API › 拒绝非回环 Host 的请求（防 DNS rebinding） | `Host: attacker.example.com` → 403 `forbidden-host`。守住「即使浏览器被诱导解析到 127.0.0.1，攻击者域名也无法调用管理 API」这条关键防线 |
| 管理 API › 接受带端口的回环 Host | `Host: 127.0.0.1:8787` → 200。防止把 Host 校验写成精确字符串比较而误伤正常浏览器请求（**这条与上一条必须同时存在**，只测一条会把功能改坏） |
| 管理 API · Service 维度 › `/api/system` 报告 tag 身份与 Service 列表 | tag 身份与 Service 三元组必须能从 `/api/system` 读到：`magicDnsSuffix`、`selfTags`、`canHostService`、以及 `services[]` 的 `name`/`dnsName`/`servePorts`/`advertised`/`vipIps`。界面靠这组字段决定「能不能建 Service 级映射」 |
| 管理 API · Service 维度 › 没有 tag 时 `canHostService` 为 false | 无 tag 时必须明确为 `false`（而不是缺字段），界面据此解释「本机为什么不承载 Service」。守住本机（用户身份）的真实状态不被当成错误 |
| 管理 API · Service 维度 › 通过 API 建立 Service 级远端映射，并在 `/api/mappings` 与快照里体现 | Service 级创建的完整契约：入参 `service: 'dsh'` 必须被归一化为 `'svc:dsh'`，`baseUrl` 用 Service 的 MagicDNS 名，`desiredProxy` 指向远端主机，代理写入到 `(svc:dsh, 443, /)` 这个三元组；`/api/mappings` 与 `/api/serve/routes` 都要带出 `services` 列表与 `service` 维度 |
| 管理 API · Service 维度 › PATCH 可以在节点级与 Service 级之间切换（摘旧挂新） | 一次 PATCH 把节点级 `(null,443,'/dsh')` 换成 Service 级 `(svc:dsh,443,'/')`：新位置挂上、**旧位置必须查不到**（`toBeUndefined()`）。守住「改归属不会在 serve 里留幽灵路由」 |
| 管理 API · Service 维度 › 远端目标只允许 Service 级（409 `remote-host-requires-service`） | 节点级路由不允许指定 `remoteHost`（节点级目标只能是本机）。守住「远端代理是 Service host 的能力，不是随便谁都能开」 |
| 管理 API · Service 维度 › 非法 Service 名返回 409 `invalid-service` | `service: 'DSH'`（大写）被拒：Service 名大小写敏感，静默小写化会指向另一个名字 |
| 管理 API · Service 维度 › `/api/mappings/import` 接受 Service 维度的路由选择 | 导入选择器必须支持 `service` 维度：同样 `(443,'/')`，`svc:dsh` 与 `svc:other` 是两条不同路由，只能导入被点名的那个 |

## 待办与隐患

- [ ] 全部用例走 `app.inject()`，**不覆盖真实 HTTP 监听、TLS、静态资源与 CORS**。`/api/system` 的 403 校验也只验证了 `Host` 头一条防线。
- [ ] `awaiting-approval` 状态在 API 层只被间接涉及（Service 创建用例的前置条件是已承认的 Service）；审批态的服务级映射由 `test/service-routing.test.ts` 覆盖。
- [ ] 容器清单在 `setup()` 里固定为单个 `worldforge`，因此「容器不存在 / 目标容器已停止」这类 API 行为不在这里守（在 `test/reconcile.test.ts`）。
- [ ] `dataDir: 'data-test'` 与 `port: 8787` 是硬编码；若将来管理端口可配置化，这里的 409/`adminUrl` 断言要跟着改（改动本身是好事，说明口径被守住了）。
