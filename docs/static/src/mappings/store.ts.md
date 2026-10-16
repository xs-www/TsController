# `src/mappings/store.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

映射库与审计日志的持久化。数据量极小（几十条），因此用**单文件 JSON + 原子替换**，不引入原生依赖（无 sqlite / leveldb）。

两个关键设计：**反序列化严格校验**（磁盘文件可能被手工编辑或来自旧版本，非法条目丢弃而不是让脏数据流进后续流程）、**写入原子**（临时文件 + rename，读方永远看不到半截 JSON）。

## 依赖 / 引用

- `node:fs/promises`、`node:path`。
- `../domain/route-path.ts`：`normalizeRoutePath`、`normalizeServiceName`、`isValidPort`、`serveRouteKey`、`normalizeRemoteHost`。
- `../domain/types.ts`、`../logger.ts`。
- 被 `src/runtime.ts` 构造，被 `mapping-service.ts`（经接口）、`app.ts`（读当前值）、`test/**` 使用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `reviveOwnedRoutes` | `(raw, fallbackPort, fallbackService?) => OwnedRoute[]` | `OwnedRoute[]` | 校验并归一化「已占用位置」数组 | 非数组 → `[]`；非法路径/端口/Service 项被丢弃；同键去重；模块私有 |
| `reviveMapping` | `(raw, defaultServePort, logger?) => Mapping \| null` | `Mapping \| null` | 反序列化 + 严格校验 + 旧格式迁移 | 见下文逐条容忍边界 |
| `FileMappingStore.read` | `() => Promise<Mapping[]>` | `Promise<Mapping[]>` | 读映射库 | 文件不存在 → `[]`；JSON 解析失败 → 记 error 并按空库启动 |
| `FileMappingStore.write` | `(mappings) => Promise<void>` | `Promise<void>` | 原子写 | 自动 `mkdir -p`；失败时残留 `.tmp` 但不损坏原文件 |
| `MemoryMappingStore.read` / `write` | 同上 | `Promise` | 测试用内存实现 | `structuredClone` 隔离，避免测试互相污染 |
| `FileAuditLog.#load` | `() => Promise<void>` | `Promise<void>` | 首次读时把 JSONL 载入内存缓存 | 单行解析失败被丢弃；只加载一次 |
| `FileAuditLog.append` | `(event) => Promise<void>` | `Promise<void>` | 追加一行 JSON 并维护缓存 | 缓存上限 1000 条（滑窗）；写失败只 warn |
| `FileAuditLog.tail` | `(limit) => Promise<AuditEvent[]>` | `Promise<AuditEvent[]>` | 取最近 N 条（倒序） | `limit` 由调用方 clamp（`app.ts` 限制 1–500） |
| `MemoryAuditLog.append` / `tail` | 同上 | `Promise` | 测试用 | 无上限 |

## 函数详情

### `reviveOwnedRoutes(raw, fallbackPort, fallbackService?)` — 模块私有

- **签名**：`(raw: unknown, fallbackPort: number, fallbackService: string | null = null) => OwnedRoute[]`
- **入参**：`raw` 是磁盘上的 `ownedRoutes`（未知形状）；`fallbackPort` 用于补端口；`fallbackService` 用于补 Service 维度（旧格式没有）。
- **出参**：`OwnedRoute[]`，每项 `{service, servePort, path}`。
- **功能**：逐项校验后按 `serveRouteKey` 去重。
- **边缘条件**：
  - 非数组 → `[]`；
  - 非对象项、路径非法 → 跳过该项（**不整条丢弃映射**）；
  - `servePort` 非法 → 回落到 `fallbackPort`（而不是丢弃路径）；
  - `item.service` 缺失 → 归属到 `fallbackService`；`item.service` 存在但非法 → 跳过该项。

### `reviveMapping(raw, defaultServePort, logger?)`

- **签名**：`(raw: unknown, defaultServePort: number, logger?: Logger) => Mapping | null`
- **入参**：`raw`（磁盘上的一条记录）；`defaultServePort`（缺端口时的默认值，来自配置）；`logger` 可选（记丢弃原因）。
- **出参**：`Mapping` 或 `null`（`null` = 丢弃）。
- **功能**：严格校验 + **三处向后兼容迁移**：缺端口补默认、旧 `ownedPaths: string[]` → `ownedRoutes`（归属到自己端口）、缺 `service` → 节点级。
- **边缘条件**（容忍边界，逐条对应实现）：
  - 非对象 / 缺 `id` → 丢弃；
  - `path` 非法 → 丢弃并 warn；
  - `target.hostPort` 非 1–65535 → 丢弃并 warn；
  - `target.remoteHost` 非法（带协议、含空白、超长）→ **丢弃整条**并 warn（该字段会影响代理目标，不能猜）；
  - `target.scheme` 只接受 `'https'`，其它值静默忽略（即回落 `http`）；
  - 有 `remoteHost` 时**删除 `containerId`**（远端目标不可能是本机容器的已发布端口）；
  - `targetPath === '/'` → 归一化为 `''`；
  - `servePort` 非法 → 回落 `defaultServePort`；
  - `service` 非法但存在 → 记 warn 并按**节点级**处理（不丢弃整条）；
  - `enabled` 缺失 → `true`；`note` 缺失 → `''`；时间戳缺失 → 当前时间。

### `isRecord(v)` — 模块私有

- **签名**：`(v: unknown) => v is Record<string, unknown>`
- **入参**：任意值。
- **出参**：类型谓词。
- **功能**：排除 `null` 与数组的纯对象判定，`reviveMapping` / `reviveOwnedRoutes` 与 `read()` 的顶层形状判断都依赖它。
- **边缘条件**：数组返回 `false`——所以一个被误写成 `[]` 的 `ownedRoutes` 会被当作「无归属」而不是展开成数字键。

### `FileMappingStore.read()`

- **签名**：`() => Promise<Mapping[]>`
- **出参**：`Promise<Mapping[]>`；解析出的每条都过 `reviveMapping`，`null` 被过滤。
- **功能**：兼容两种顶层形状：裸数组、或 `{version, mappings}`。
- **边缘条件**：
  - 文件不存在（`ENOENT`）→ `[]`；
  - 其它读错误（权限等）→ 原样抛出；
  - JSON 解析失败 → `logger.error('mappings.json 解析失败，按空库启动')` 并返回 `[]`（**不抛错**：宁可空库启动，也不要让进程起不来）。

### `FileMappingStore.write(mappings)`

- **签名**：`(mappings: Mapping[]) => Promise<void>`
- **出参**：`Promise<void>`。
- **功能**：写 `<dataDir>/mappings.json`，载荷为 `{version: 1, mappings}`（**注意这个 `version` 是存储封装版本，与快照的 `schemaVersion`、与 Mapping 的字段演进无关**）；先写 `<file>.<pid>.tmp` 再 `rename`。
- **边缘条件**：
  - 目录不存在时自动 `mkdir -p`；
  - `rename` 在同一文件系统内是原子的；进程被杀最多留下一个 `.tmp` 文件，**原文件始终是完整的**；
  - 并发写由 `MappingService` 的串行队列保证不会交错。

### `MemoryMappingStore`

- **签名**：`constructor(initial: Mapping[] = [])`；`read()` / `write()` 同接口。
- **功能**：测试替身。
- **边缘条件**：进出都 `structuredClone`，因此测试之间以及与调用方的对象不会共享引用。

### `FileAuditLog.#load()` / `append()` / `tail()`

- **签名**：见表格。
- **功能**：JSONL 追加；内存缓存最近 **1000** 条（超出滑窗）供 `GET /api/audit` 快速读取。
- **边缘条件**：
  - `#load` 只执行一次（`#loaded` 标志），文件不存在 → 空缓存；
  - 单行 JSON 解析失败 → 该行被丢弃（不抛错）；
  - `append` 写盘失败 → `logger.warn`，**内存缓存仍会记录**（界面能看到刚发生的事）。

### `MemoryAuditLog`

- **签名**：`append(event)` / `tail(limit)`。
- **功能**：测试替身，无上限、无落盘。

## 接口与类型

| 名称 | 形状 | 用途 |
| --- | --- | --- |
| `MappingStore` | `{ read(): Promise<Mapping[]>; write(mappings): Promise<void> }` | 映射库接口；`MappingService` 只依赖它 |
| `AuditLog` | `{ append(event): Promise<void>; tail(limit): Promise<AuditEvent[]> }` | 审计接口 |
| `StoredShape` | `{ version: number; mappings: Mapping[] }` | 磁盘封装形状（模块私有） |

## 待办与隐患

- [ ] 无 TODO 标记。**事故备忘**：`data/mappings.json` 与验证脚本的 `data/verify*` 子目录同级，曾经被 `Remove-Item -Recurse -Force data` 误删（见 `history.md`）。清理必须用 `npm run clean:verify`（`scripts/clean-verify.ts`，只删白名单子目录）。
- [ ] 已知边界：`FileMappingStore` 不做文件锁。多进程同时指向同一 `dataDir` 会互相覆盖——设计前提是「单机单实例控制面」。
