# `src/docker/docker-service.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

容器清单归一化：把 Docker Engine `/containers/json` 的原始结构压成路由所需的 `ContainerInfo`。这里的**唯一一处「丢弃未发布端口」**与**保留 IPv4/IPv6 双记录**都是刻意的，后者是「容器是否绕开本工具直接监听 tailnet」的判断依据。

## 依赖 / 引用

- `../domain/types.ts` 的 `ContainerInfo` / `ContainerPort`。
- `./docker-client.ts` 的 `DockerTransport`。
- 被 `src/runtime.ts` 构造；`MappingService` 经 `ContainerSource` 接口消费；`test/fakes.ts` 提供内存替身。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `normalizePorts` | `(raw: RawPort[] \| null \| undefined) => ContainerPort[]` | `ContainerPort[]` | 只保留已发布到宿主机的端口 | 缺 `PrivatePort`/`PublicPort` 即丢弃；未知协议回落 `tcp`；`0.0.0.0` 与 `::` 两条都保留 |
| `normalizeContainer` | `(raw: RawContainer) => ContainerInfo` | `ContainerInfo` | 单容器归一化 | 名字为空时回落 `id` 前 12 位；`Created` 秒 → 毫秒；缺失字段给空值而非抛错 |
| `DockerContainerService.describeSource` | `() => string` | `string` | 数据来源描述 | 未连接时是 `(未连接)`（继承自 transport） |
| `DockerContainerService.listContainers` | `() => Promise<ContainerInfo[]>` | `Promise<ContainerInfo[]>` | 拉全量容器并按名字排序 | 传 `all=1`（含已停止）；响应非数组时按空数组处理 |

## 函数详情

### `normalizePorts(raw)`

- **签名**：`(raw: RawPort[] | null | undefined) => ContainerPort[]`
- **入参**：`raw`（Docker 的 `Ports` 字段，可为 `null`）。
- **出参**：`ContainerPort[]`，按 `hostPort` 升序、同端口按 `hostIp` 字典序。
- **功能**：把 `{IP, PrivatePort, PublicPort, Type}` 映射为 `{hostIp, hostPort, containerPort, protocol}`。
- **边缘条件**：
  - `raw` 为 `null`/`undefined` → 返回 `[]`（**不抛错**，Docker 对无端口容器确实返回 `null`）；
  - `PublicPort` 缺失 → **丢弃该条目**。这是「未发布到宿主机」的唯一判据，也是本模块被单独文档化的原因：**不要**在这里加「回落成 PrivatePort」之类的容错，那会让界面把不可达端口显示成可用；
  - `PrivatePort` 非数字 → 丢弃；
  - `Type` 缺失或不在 `{tcp,udp,sctp}` → 回落 `tcp`；
  - 同一 `hostPort` 同时存在 `0.0.0.0` 与 `::` 两条记录时**两条都保留**：这是「容器直接监听全部网卡」这个黄色徽标的判据（见 `web/src/utils.ts` 的 `isWildcardHost`）。

### `normalizeContainer(raw)`

- **签名**：`(raw: RawContainer) => ContainerInfo`
- **入参**：`raw`（`RawContainer`，字段全部可选，按需读取）。
- **出参**：`ContainerInfo`。
- **功能**：取第一个名字并去掉前导 `/`，从 labels 里取 compose 项目/服务名，把 Docker 的**秒级** `Created` 转成毫秒。
- **边缘条件**：
  - `Names` 为空或首个元素为空串 → 用 `Id` 前 12 位当名字；`Id` 也缺 → 空串；
  - `Created` 非数字 → `createdAt = 0`（`web/src/utils.ts` 的 `formatTimestamp` 会显示「未知」）；
  - `Labels` 缺失 → 两个 compose 字段均为 `null`；
  - `state` 缺失 → `'unknown'`。

### `DockerContainerService.describeSource()`

- **签名**：`() => string`
- **出参**：`string`，实际使用的端点描述（`npipe:\\.\pipe\…` / `unix:…` / `tcp:…`）。
- **功能**：供界面顶部「数据源」一栏显示，也是启动日志里那一行的来源。
- **边缘条件**：尚未成功连接过时返回 `(未连接)`——这正是 `src/main.ts` 要在监听前**预热**一次 `listContainers()` 的原因。

### `DockerContainerService.listContainers()`

- **签名**：`() => Promise<ContainerInfo[]>`
- **出参**：`Promise<ContainerInfo[]>`，按容器名升序。
- **功能**：请求 `/containers/json?all=1`（**含未运行容器**，因为「孤儿目标」判定需要看到已停止的容器），逐条归一化后排序。
- **边缘条件**：
  - 响应不是数组（`null` / 异常结构）→ 按 `[]` 处理，不抛错；
  - 传输层或 HTTP 错误原样抛出（`DockerApiError`），由 `src/app.ts` 映射为 503。

## 全局常量 / 变量

- `KNOWN_PROTOCOLS`：`Set{'tcp','udp','sctp'}`，协议白名单；不在此列一律回落 `tcp`。

## 待办与隐患

- [ ] 无 TODO 标记。已知边界（记在项目 `todo.md` 第 5 项）：只能看到**已发布到宿主机**的端口；容器内网端口（未 `-p`）当前无法映射。
