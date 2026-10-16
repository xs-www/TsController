# `src/domain/types.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

跨层共享的领域类型。**刻意不引入任何运行时依赖**（全部是 `interface` / `type`），因此可以在测试里自由构造替身，也不会让类型层拖入副作用。

本文件同时是「路由身份」这份契约的定义处：**路由身份是三元组 `(service, servePort, path)`**，`service === null` 表示节点级路由，`service === 'svc:xxx'` 表示 Tailscale Service 级路由。

## 依赖 / 引用

- 无依赖（零 import）。
- 被几乎所有模块引用：`src/domain/route-path.ts`、`src/mappings/*`、`src/tailscale/*`、`src/docker/*`、`src/snapshot.ts`、`src/app.ts`、`test/fakes.ts`；前端有一份逐字镜像：`web/src/api.ts`。

## 类型清单

| 类型 | 用途 | 关键字段 / 取值 |
| --- | --- | --- |
| `ContainerPort` | 容器发布端口 | `hostIp`、`hostPort`、`containerPort`、`protocol: 'tcp'\|'udp'\|'sctp'` |
| `ContainerInfo` | 归一化容器 | `id`、`name`（无前导斜杠）、`state`、`composeProject`、`createdAt`（毫秒）、`ports` |
| `ServiceName` | Service 名别名 | `string`，**约定始终带 `svc:` 前缀**（由 `normalizeServiceName()` 保证） |
| `TargetKind` | 目标类别 | `'container'`（可追踪容器生命周期）/ `'host'` |
| `MappingTarget` | 一条映射的目标 | `kind`、`hostPort`、`targetPath`、`remoteHost?`、`scheme?`、`containerId?`、`containerName?`、`containerPort?` |
| `OwnedRoute` | serve 中占用过的位置 | `service`、`servePort`、`path` |
| `RouteRef` | 位置引用（= `OwnedRoute`） | 同上 |
| `Mapping` | 持久化记录 | `id`、`service`、`path`、`servePort`、`target`、`note`、`enabled`、`ownedRoutes`、`createdAt`、`updatedAt` |
| `MappingStatus` | 健康度 | 8 种取值，见下 |
| `MappingView` | 运行时视图 | `Mapping` + `status`、`desiredProxy`、`actualProxy`、`baseUrl`、`detail` |
| `ServeHandler` | handler 解析结果 | 判别联合：`{kind:'proxy', raw, hostPort, host, targetPath, loopback, fromServiceConfig?}` 或 `{kind:'file'\|'text'\|'other', raw}` |
| `ServeRoute` | serve 中的一条路由 | `service`、`servePort`、`host`、`path`、`handler`、`managed`、`mappingId` |
| `ServiceInfo` | 单个 Service 的状态 | `name`、`dnsName`、`servePorts`、`advertised`、`vipIps` |
| `ServeSnapshot` | serve 配置（两个来源合并） | `httpsPorts`、`hostname`、`routes`、`services` |
| `TailnetInfo` | 本机 tailnet 身份 | `dnsName`、`baseUrl`、`ips`、`hostname`、`backendState`、`version`、`magicDnsSuffix`、`tags`、`serviceHosts` |
| `AuditEvent` | 审计事件 | `at`、`kind`、`message`、`detail?` |

`MappingStatus` 判定优先级（从高到低，由 `planReconcile()` 实现）：

```text
blocked            本机目标端口 == 管理端口；或对外端口与管理端口同号
conflict           同一 (service, 端口, 路径) 被多条映射占用（防御性）
disabled-drift     已禁用但 serve 中仍有残留
disabled           已禁用且已清理
orphaned-target    容器型映射的目标容器不存在 / 未运行 / 不再发布该端口（远端目标不判）
pending            位置缺失、或指向与期望不符
awaiting-approval  Service 级：配置已写对，但本节点尚未被承认为该 Service 的 host
active             完全一致
```

`AuditEvent.kind` 取值：`exposure-detected` / `exposure-removed` / `exposure-blocked` / `apply` / `import` / `startup`。

## 边缘条件与设计约束

- **`OwnedRoute.service` 存在的唯一理由**：位置改名（路径 / 端口 / Service 任一变化）。旧位置不再出现在 `Mapping` 的当前字段里，若不记账就会变成无人认领的孤儿 handler，继续把流量送进容器。
- **`MappingTarget.remoteHost` 的语义**：省略 = 本机回环。取值只能是主机名或 IP（不带协议、不带端口），由 `normalizeRemoteHost()` 校验；`127.0.0.1` / `localhost` 会被归一化为「未指定」。**只在 Service 级路由上被接受**，否则 `MappingService` 抛 `remote-host-requires-service`。
- **`MappingTarget.scheme`**：省略即 `http`；只允许 `'http' | 'https'`。`https+insecure` 明确不支持（`parseProxyUrl` 也拒绝解析它）。
- **`ServeHandler['proxy'].hostPort` 可以为 `null`**：目标是 `unix:` / 无法解析的形态时。这类路由只读展示，不参与托管（`proxiedRoutes()` 会过滤掉）。
- **`ServeHandler['proxy'].fromServiceConfig`**：标明该 handler 是从 `serve get-config --all` 读出的，其 handler 树**不完整**（只有根路径、目标路径丢失）。消费方不要据此重建配置。
- **`ServeSnapshot.hostname` 是节点级主机名**，Service 的对外主机名在 `ServeRoute.host` 与 `ServiceInfo.dnsName` 上。
- **`TailnetInfo.tags` 为空 = 本节点不可能充当 Service host**；这是界面 `canHostService` 的唯一依据。
- **`TailnetInfo.serviceHosts`**：`{ "svc:dsh": ["100.65.32.1", …] }`，来自 `status --json` 的 `Self.CapMap["service-host"]`，是「本节点被承认为该 Service 的 host」的**唯一证据**。

## 待办与隐患

- [ ] 无 TODO 标记。注意：本文件只描述形状，任何校验逻辑都在 `src/domain/route-path.ts` 与各服务层，**不要在这里加运行时校验函数**（会破坏「零依赖」这条约束）。
