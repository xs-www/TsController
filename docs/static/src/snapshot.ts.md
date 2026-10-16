# `src/snapshot.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

serve 路由快照：把路由状态落成一份 JSON 文件供**其它项目**读取。

动机：容器**够不到**宿主上的 tailscaled（Windows 是命名管道，跨不过 WSL2；Linux 桥接网络也到不了宿主回环），因此其它项目无法自行读取 serve 配置。消费者只需**只读挂载一个目录**——不需要网络端口、不需要令牌、也不依赖「TsController 此刻是否在跑」。

本文件是纯函数 + 一层薄 IO：`buildSnapshot()` 不碰磁盘（`generatedAt` 由调用方注入），因此所有字段都能在单测里穷举。

## 依赖 / 引用

- `node:fs/promises`、`node:path`。
- `./domain/route-path.ts` 的 `buildBaseUrl`；`./domain/types.ts` 的 `ContainerInfo`/`Mapping`/`MappingStatus`/`ServeSnapshot`/`ServiceInfo`/`TailnetInfo`；`./mappings/reconcile.ts` 的 `ReconcilePlan`。
- 被 `src/mappings/mapping-service.ts`（收敛后 / 启动 / 定期刷新）与 `src/main.ts` 使用；`test/snapshot.test.ts` 覆盖纯函数与原子写。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `findByHostPort` | `(containers, hostPort) => {name, port} \| null` | 对象或 `null` | 按宿主机端口反查容器 | `hostPort` 为 `null` → `null`；优先运行中的容器；只看 `tcp`；模块私有 |
| `buildSnapshot` | `(input: BuildSnapshotInput) => Snapshot` | `Snapshot` | **纯函数**组装快照 | 见下文逐条 |
| `FileSnapshotWriter.write` | `(snapshot) => Promise<string>` | `Promise<string>` | 原子写 `<dir>/serve-routes.json` | 自动建目录；临时文件 + rename |
| `MemorySnapshotWriter.write` | `(snapshot) => Promise<string>` | `Promise<string>` | 测试用内存写出器 | 记录每次写入的深拷贝；`last` 取最后一次 |

## 函数详情

### `findByHostPort(containers, hostPort)` — 模块私有

- **签名**：`(containers: ContainerInfo[], hostPort: number | null) => { name: string; port: number } | null`
- **入参**：`hostPort` 可为 `null`（非代理 handler）。
- **出参**：容器名与容器内端口，或 `null`。
- **功能**：给**未托管**路由补容器关联，让门户能显示「这条路由背后是哪个容器」。
- **边缘条件**：
  - 有运行中的容器时只在运行中的里面找；一个都没有时退化为全量清单（避免 Docker 全停时整个反查失效）；
  - 同端口多绑定时取清单里第一个匹配（清单已按容器名排序，因此结果稳定）；
  - 只匹配 `protocol === 'tcp'`。

### `buildSnapshot(input)`

- **签名**：`(input: BuildSnapshotInput) => Snapshot`
- **入参**：`{generatedAt, generator, tailnet, serve, mappings, plan, containers, adminPort, autoUnexpose}`。
- **出参**：`Snapshot`（`schemaVersion: 2`）。
- **功能**：逐路由算出对外 `url`、`service`、`host`、代理目标、容器关联与状态；再汇总 `summary` 与 `security`。
- **边缘条件**（每条都对应一个刻意的决定）：
  - **路由归属**：优先用 `route.mappingId` 查映射库；没有则用 `(service, servePort, path)` 三元组再查一次（兼容未标注归属的调用方）；用**小写路径**比较；
  - **对外地址只看快照自身的 `host`**（Service 级则用 Service 的 MagicDNS 名）。**刻意不拿 `tailnet.dnsName` 兜底**——那会在「读不到主机名」时产出一个看似可用、实际不该点开的链接；主机名缺失时 `url` 为 `null`；
  - **远端目标不做容器反查**：`isRemote = isProxy && !handler.loopback`，此时 `guessed = null`（那是别的机器的容器清单），因此 `containerName`/`containerPort`/`containerSource` 全为 `null`；
  - 容器关联来源优先级：映射库（`containerSource: 'mapping'`）> 端口反查（`'port'`）> `null`；
  - 非代理 handler（`text`/`file`/`other`）的 `proxy`/`targetPath`/`targetHost`/`targetHostPort` 分别为 `null`/`''`/`null`/`null`；
  - `summary` 的 8 个计数**总是全部出现**（含 `awaitingApproval: 0`），schema 稳定，消费方不必处理缺键；
  - `blocked` 与 `conflict` 合并计入 `summary.blocked`；`disabled` 与 `disabled-drift` 合并计入 `summary.disabled`；
  - 路由排序：端口 → Service 名 → 路径（稳定，便于 diff）。

### `FileSnapshotWriter.write(snapshot)` / `get filePath`

- **签名**：`(snapshot: Snapshot) => Promise<string>`
- **出参**：写入的绝对路径（`<dir>/serve-routes.json`）。
- **功能**：`fs.mkdir(dir, {recursive:true})` → 写 `<file>.<pid>.tmp` → `rename` 覆盖。
- **边缘条件**：
  - 消费者随时打开文件都不会读到半截 JSON（rename 在同一文件系统内原子）；
  - 并发的两次写会各自用不同 pid 后缀的临时文件，最后一次 rename 生效；
  - 写失败（磁盘满/权限）会 reject，由 `MappingService` 捕获并只记警告——**快照写失败绝不影响收敛结果**。

### `MemorySnapshotWriter`

- **签名**：`write(snapshot)` / `get last`。
- **功能**：测试替身；`writes` 保存全部历史（每次都是 `structuredClone`）。
- **边缘条件**：`filePath` 固定为 `'(memory)'`。

## 接口与类型

| 名称 | 形状 | 用途 |
| --- | --- | --- |
| `SnapshotRoute` | `{service, servePort, path, host, url, proxy, targetPath, targetHost, targetHostPort, managed, mappingId, status, containerName, containerPort, containerSource, note, enabled, fromServiceConfig}` | 快照里的单条路由 |
| `SnapshotSummary` | `{total, managed, unmanaged, active, pending, disabled, orphanedTarget, blocked, awaitingApproval}` | 汇总计数 |
| `Snapshot` | `{schemaVersion, generatedAt, generator, source, servePorts, services, routes, summary, security}` | 对外契约 |
| `BuildSnapshotInput` | 见上文签名 | 纯函数入参 |
| `SnapshotWriter` | `{write(snapshot): Promise<string>; readonly filePath: string}` | 写出器接口（注入内存实现即可单测） |

`source` 字段：`{hostname, baseUrl, magicDnsSuffix, selfTags, tailnetIps, adminPort}`——**刻意不含数据目录路径与 Docker 端点**这类内部信息。

## 全局常量 / 变量

- `SNAPSHOT_SCHEMA_VERSION` = **2**：字段语义变化时递增。v1 = 路由身份「端口 + 路径」；v2 = 三元组 + `services` + `source.magicDnsSuffix/selfTags` + `summary.awaitingApproval` + 路由的 `service`/`host`/`targetHost`/`fromServiceConfig`。**消费方应据此判断兼容性**。

## 待办与隐患

- [ ] 无 TODO 标记。**消费者契约提醒**：`fromServiceConfig: true` 的路由来自 `tailscale serve get-config --all`，其 handler 树**不完整**（只有根 handler、目标路径丢失）——消费方不要据此重建配置。
- [ ] 已知边界：快照只在启动、每次收敛后、以及定期（默认 60s）刷新；TsController 未运行时文件仍存在但 `generatedAt` 会陈旧（这是「用文件而非 HTTP」的代价，见 `README.md` §9.4）。
