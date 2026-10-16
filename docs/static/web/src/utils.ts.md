# `web/src/utils.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

前端的纯函数工具层。所有界面里用到的「口径」（路径归一化、Service 名归一化、路由标签、对外地址拼装、复制降级）都集中在这里，避免散落在各组件里出现多套真相。

**与后端的关系**：`normalizePathInput` / `normalizeServiceInput` 刻意只做「让用户尽早看到预期结果」的宽松归一化，**权威校验仍在后端**（`src/domain/route-path.ts`）；后端拒绝时把原因回显即可，前端不重复实现规则。

## 依赖 / 引用

- `./api` 的类型：`MappingStatus`、`MappingView`、`MappingTarget`（仅类型）。
- 被 `web/src/App.tsx` 与 `web/src/components/*` 引用；`web/src/components/shared.ts` 与本文件无关（前者是写操作反馈的类型）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `groupByStatus` | `(mappings: MappingView[]) => Array<{status, items}>` | 分组数组 | 按严重度分组 | 空组不出现；组内按 `(service ?? '')` 再按 `path` 排序 |
| `slugifyPath` | `(name: string) => string` | `string` | 容器名 → 合法路径片段 | 结果为空时回落 `'app'`；大小写折叠为小写 |
| `defaultPathFor` | `(containerName: string) => string` | `string` | 默认挂载路径 | 前缀 `/`；容器名为空 → `/app` |
| `normalizePathInput` | `(input: string) => string` | `string` | 前端侧路径归一化 | 空串 → `''`；补前导 `/`；折叠重复斜杠；去尾斜杠（保留 `/`） |
| `normalizeServiceInput` | `(input: string) => string` | `string` | Service 名归一化 | 空串/只有前缀 → `''`（= 节点级）；**大写不折叠**，交给后端拒绝 |
| `serviceShortName` | `(service: string) => string` | `string` | 去掉 `svc:` 前缀 | 无前缀原样返回 |
| `isRemoteTarget` | `(target: MappingTarget) => boolean` | `boolean` | 是否远端代理目标 | `remoteHost` 非空且不是 `127.0.0.1`/`localhost` |
| `formatTarget` | `(target: MappingTarget) => string` | `string` | 目标的可读描述 | **不含目标路径**；远端为 `host:port` |
| `joinUrl` | `(serveHost, servePort, path) => string \| null` | `string \| null` | 节点级地址拼装 | 主机名为 `null`/`''` → `null`；非 443 带端口。**当前界面已无调用方** |
| `formatRouteLabel` | `(servePort, path, service?) => string` | `string` | 路由标签 | 443 省略端口；Service 级加 `svc:x:` 前缀 |
| `mappingUrl` | `(mapping: MappingView) => string \| null` | `string \| null` | 映射的完整访问地址 | `baseUrl` 为空 → `null`（复制按钮据此禁用） |
| `formatScopedLabel` | `(service, path) => string` | `string` | 只带 Service 不带端口的标签 | `service` 为空时退化为路径 |
| `formatPort` | `(hostIp, hostPort, containerPort, protocol) => string` | `string` | 端口摘要 | 形如 `127.0.0.1:4173 → 8080/tcp` |
| `isWildcardHost` | `(hostIp: string) => boolean` | `boolean` | 是否监听全部网卡 | 剥掉 IPv6 方括号后判 `0.0.0.0` / `::` |
| `formatTime` | `(iso: string) => string` | `string` | ISO 时间 → 本地时间 | 解析失败原样返回 |
| `formatTimestamp` | `(ms: number) => string` | `string` | 毫秒时间戳 → 本地时间 | 非有限值或 `<= 0` → `'未知'` |
| `copyText` | `(text: string) => Promise<boolean>` | `Promise<boolean>` | 复制到剪贴板 | 优先 `navigator.clipboard`，失败回退 `execCommand('copy')`；两条路都失败 → `false` |

## 函数详情

### `groupByStatus(mappings)`

- **签名**：`(mappings: MappingView[]) => Array<{ status: MappingStatus; items: MappingView[] }>`
- **出参**：按 `MAPPING_STATUS_ORDER` 顺序排列的分组，空组被过滤。
- **功能**：`MAPPING_STATUS_ORDER` = `blocked → conflict → orphaned-target → disabled-drift → pending → **awaiting-approval** → active → disabled`，**顺序即严重度**（最需要处理的排最前；`awaiting-approval` 放在 `pending` 之后，因为它不需要用户点「应用」）。
- **边缘条件**：组内排序为 `(service ?? '')` 再 `path`，因此节点级路由不会与 `svc:*` 交替出现；空输入 → 空数组。

### `defaultPathFor(containerName)`

- **签名**：`(containerName: string) => string`
- **入参**：`containerName`（`string`，必选）：容器名（可能含中文/大写/点号）。
- **出参**：`string`，形如 `/worldforge`。
- **功能**：`'/' + slugifyPath(containerName)`，用于「从容器一键建映射」时的默认挂载路径。
- **边缘条件**：容器名为空或全是非法字符 → `/app`（`slugifyPath` 的兜底值）；不会返回 `/`（根路径需用户显式输入）。

### `slugifyPath(name)`

- **签名**：`(name: string) => string` / `(containerName: string) => string`
- **功能**：小写化 → 非 `[a-z0-9._-]` 折成 `-` → 折叠连续 `-` → 去首尾 `-.`。
- **边缘条件**：结果为空（例如全中文容器名）→ `slugifyPath` 返回 `'app'`，因此 `defaultPathFor` 得到 `/app`；`name` 为 `null`/`undefined` 时因 `(name ?? '')` 不会抛错。

### `normalizePathInput(input)`

- **签名**：`(input: string) => string`
- **出参**：归一化后的路径（可能是 `''`）。
- **功能**：trim → 补前导 `/` → 按 `/` 分段过滤空段 → 重新拼接（因此 `//a//b/` → `/a/b`）。
- **边缘条件**：
  - 空串/纯空白 → `''`（调用方需自行判空，不会得到 `'/'`）；
  - `'/'` → `'/'`（分段后无内容，拼回 `'/'`）；
  - **不做** `..`/空白/`?` 的拒绝——那是后端 `normalizeRoutePath` 的职责，前端只做「让用户尽早看到预期结果」。

### `normalizeServiceInput(input)`

- **签名**：`(input: string) => string`
- **出参**：`'svc:<name>'` 或 `''`（= 节点级）。
- **功能**：trim → 剥掉已有的 `svc:` 前缀（大小写不敏感）→ 空则返回 `''` → 否则统一加回 `svc:` 前缀。
- **边缘条件**：
  - `'svc:'`（只有前缀）→ `''`（视为未填，而不是非法）；
  - **`'DSH'` → `'svc:DSH'`**（不折叠大写）：后端会拒绝它，这正是想要的行为——静默改写会指向另一个不存在的 Service；
  - 不做字符集校验，非法名由后端返回 `invalid-service` 并回显原因。

### `serviceShortName(service)`

- **签名**：`(service: string) => string`
- **入参**：`service`（`string`，必选）：`'svc:dsh'` 或 `'dsh'`。
- **出参**：`string`，裸名 `'dsh'`。
- **功能**：界面徽标与提示里展示短名（少了 `svc:` 前缀更易读）。
- **边缘条件**：大小写不敏感匹配前缀；无前缀时原样返回，**不抛错**（因此脏数据不会白屏）。

### `isRemoteTarget(target)`

- **签名**：`(target: MappingTarget) => boolean`
- **入参**：`target`（`MappingTarget`）：含可选 `remoteHost`。
- **出参**：`boolean`。
- **功能**：判定该映射是否代理到**远端主机**（界面据此区分「哪台机器上的端口」）。
- **边缘条件**：`remoteHost` 为 `undefined`/`''`/`'127.0.0.1'`/`'localhost'` 都返回 `false`（与后端 `normalizeRemoteHost` 的口径一致：回环等同「未指定远端」）。

### `formatTarget(target)`

- **签名**：见表格。
- **功能**：`serviceShortName` 去前缀（界面徽标用）；`isRemoteTarget` 判定是否远端（`remoteHost` 非空且非回环）；`formatTarget` 产出 `127.0.0.1:4173` / `my-laptop.example-tailnet.ts.net:3081`。
- **边缘条件**：`formatTarget` **不含目标路径**（调用方按需追加）；`target.remoteHost` 为 `undefined`/`''` 时展示 `127.0.0.1`。

### `joinUrl(serveHost, servePort, path)`

- **签名**：`(serveHost: string | null, servePort: number, path: string) => string | null`
- **出参**：完整 URL 或 `null`。
- **功能**：`servePort === 443` 省略端口（`https://host` 与 `https://host:8443` 是两个不同 origin，不能省非 443 端口）。
- **边缘条件**：`serveHost` 为 `null` 或 `''` → `null`。
- **注**：Service 级路由的对外基址在 `MappingView.baseUrl`（由后端算好），因此本函数在 Service 上线后**界面里已无调用方**，保留给只有 `serveHost` 的节点级场景。

### `formatRouteLabel(servePort, path, service?)`

- **签名**：`(servePort: number, path: string, service?: string | null) => string`
- **出参**：`'svc:dsh:/'`（443）、`'svc:dsh:8443/x'`、`'/worldforge'`。
- **功能**：与后端 `formatRouteRef` 保持同构（便于日志与 toast 对照）。
- **边缘条件**：443 一律省略端口；`service` 为空/未传时退化为旧的两参行为（老调用点逐字不变）。

### `mappingUrl(mapping)`

- **功能**：`mappingUrl` = `baseUrl + path`；`formatScopedLabel` 产出 `svc:dsh/path`（**不含端口**，因为 `ApplyResult.blocked` 里没有 `servePort`）。
- **边缘条件**：`baseUrl` 为 `null`/`''` → `mappingUrl` 返回 `null`，`CopyButton` 据此禁用（而不是复制出一个错地址）。

### `formatScopedLabel(service, path)`

- **签名**：`(service: string | null, path: string) => string`
- **入参**：`service`（可空）、`path`。
- **出参**：`string`，形如 `svc:dsh/path` 或 `/path`。
- **功能**：**不含端口**的路由标签，专供 `ApplyResult.blocked` 这类只有 `{mappingId, service, path, reason}` 的场景（那里拿不到 `servePort`）。
- **边缘条件**：`service` 为空 → 退化为裸路径；不要用它做「唯一键」（缺端口维度）。

### `formatPort(hostIp, hostPort, containerPort, protocol)`

- **签名**：`(hostIp: string, hostPort: number, containerPort: number, protocol: string) => string`
- **出参**：`string`，形如 `127.0.0.1:4173 → 8080/tcp`。
- **功能**：容器面板里展示端口映射的可读形式。
- **边缘条件**：不做任何校验/补默认值；`protocol` 原样拼进结果。

### `isWildcardHost(hostIp)`

- **功能**：`formatPort` 产出 `127.0.0.1:4173 → 8080/tcp`；`isWildcardHost` 判断端口是否绑定全部网卡。
- **边缘条件**：`isWildcardHost` 会先剥掉 IPv6 方括号，因此 `'[::]'` 与 `'::'` 都判为 `true`——黄色徽标「已监听全部网卡」的判据（提示 tailnet 内其它设备可绕过本工具直连）。

### `formatTime(iso)` / `formatTimestamp(ms)`

- **功能**：都是 `toLocaleString('zh-CN', { hour12: false })`。
- **边缘条件**：`formatTime` 在 `Date.parse` 得到 `NaN` 时**原样返回输入**（便于看出是脏数据）；`formatTimestamp` 对 `0`/负数/`NaN`/`Infinity` 返回 `'未知'`（`createdAt` 缺失时后端给 `0`）。

### `copyText(text)`

- **签名**：`(text: string) => Promise<boolean>`
- **出参**：是否复制成功。
- **功能**：优先 `navigator.clipboard.writeText`；异常或 API 不存在时回退到隐藏 `<textarea>` + `document.execCommand('copy')`。
- **边缘条件**：
  - 非安全上下文（`http://` 非 localhost）下 `navigator.clipboard` 可能为 `undefined` → 走回退；
  - 回退路径在 `try/catch` 内，且**无论成功与否都会移除 textarea**；
  - 两条路都失败 → 返回 `false`，由 `CopyButton` 显示失败反馈。

## 全局常量 / 变量

- `MAPPING_STATUS_ORDER`：`MappingStatus[]`，8 项，顺序即严重度（见 `groupByStatus`）。
- `SERVICE_PREFIX`：`'svc:'`，与后端 `src/domain/route-path.ts` 的同名常量对齐。

## 待办与隐患

- [ ] 无 TODO 标记。**口径提醒（已发现的真实不一致，未修）**：
  1. `App.managedKeys` 对 path 做 `toLowerCase()` 折叠（用于「已托管」计数），而 `ExternalRoutesPanel` 的 `routeKey` 大小写敏感（用于「接管中」判定与 React key）——同一份数据在两处口径不同；
  2. `EditRow` 的 path 只 `trim()`，而创建表单用 `normalizePathInput`（折叠斜杠、去尾斜杠）——同一路径可能以两种形态提交；
  3. `joinUrl` 目前是死代码。
- [ ] 已知边界：`normalizePathInput` / `normalizeServiceInput` 都不拒绝非法输入，因此**界面必须把后端的 `invalid-path` / `invalid-service` 文案回显出来**，否则用户会以为是自己网络问题。
