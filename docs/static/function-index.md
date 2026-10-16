# 静态函数文档

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 版本 | 0.1.0（首个可用版本） |
| 更新日期 | 2026-10-15 |
| 范围 | Docker 容器端口发现 → 映射库 → 与 `tailscale serve` 配置的声明式收敛 → 本机管理 API |
| 运行时 | Node.js 22.18+（原生 TS 类型擦除，无编译步骤）+ Fastify 5 + React 19 / Vite 6 |
| 外部依赖 | Tailscale CLI（唯一写入口）、Docker Engine API（经本地端点） |
| 持久化 | `<DATA_DIR>/mappings.json`（映射库）、`<DATA_DIR>/audit.jsonl`（审计日志） |
| 测试 | 70 个单元/接口测试（全部注入假实现，不需要 Docker 与 Tailscale） |

> 本文件是本项目**首次提交的全量归档**。归档范围 = `git status` 中全部新增文件。
> 后续每次改动都应在文末追加一节「变更归档」，写明修改的函数与原因。

---

## 0. 架构约束（读代码前必读）

三条约束解释了本代码库的全部结构：

1. **控制面，不是数据面。** 本进程从不转发用户流量。它只读写 `tailscaled` 的 serve 配置。因此数据链路里只有一个网关接口 `ServeGateway`，且它的写操作只有「挂载」和「摘除」两种。
2. **声明式收敛。** 映射库 = 期望状态，serve 配置 = 实际状态。二者的差异由纯函数 `planReconcile()` 计算，副作用集中在 `MappingService.applyInternal()`。所有状态判定逻辑因此可在单测中穷举。
3. **只删自己写过的路径。** 每条映射用 `ownedPaths` 记账它在 serve 中占用过的路径。`planReconcile()` 只摘除「曾被某条映射占用、且当前不在期望集合中」的路径，用户手工配置的路由永不误删。

---

## 1. `src/domain/types.ts` —— 跨层类型

无运行时依赖，只描述形状，便于测试构造替身。

| 类型 | 用途 | 关键字段 |
| --- | --- | --- |
| `ContainerPort` | 容器发布端口 | `hostIp` / `hostPort` / `containerPort` / `protocol` |
| `ContainerInfo` | 归一化容器 | `name`、`state`、`composeProject`、`ports` |
| `MappingTarget` | 映射目标 | `kind: 'container' \| 'host'`、`hostPort`、`targetPath`、`containerName`、`containerPort` |
| `Mapping` | 持久化记录 | `path`、`target`、`enabled`、`ownedPaths` |
| `MappingStatus` | 健康度 | 见下表 |
| `MappingView` | 运行时视图 | `Mapping` + `status` + `desiredProxy` + `actualProxy` + `detail` |
| `ServeHandler` | serve handler 解析结果 | `kind: 'proxy' \| 'file' \| 'text' \| 'other'` |
| `ServeSnapshot` | serve 配置快照 | `webHost`、`httpsPort`、`routes` |
| `TailnetInfo` | 本机 tailnet 身份 | `dnsName`、`baseUrl`、`ips`、`backendState` |
| `AuditEvent` | 审计事件 | `kind`、`message`、`detail` |

`MappingStatus` 取值与判定优先级（从高到低）：

```text
blocked           目标端口 == 管理端口
conflict          同一路径被多条映射占用（防御性）
disabled-drift / disabled
orphaned-target   容器型映射的目标不存在 / 未运行 / 不再发布该端口
pending           路径缺失、或指向与期望不符
active            完全一致
```

**`ownedPaths` 存在的唯一理由**：路径改名。改名后旧路径不再出现在任何 `mapping.path` 中，若不记账就会变成无人认领的孤儿 handler，继续把流量送进容器。

---

## 2. `src/domain/route-path.ts` —— 路径与代理地址纯函数

所有路径的第一道也是唯一一道关卡：API 入参、磁盘数据、从 serve 读回的值都必须先经过这里。

### `normalizeRoutePath(input): PathValidation`

- 必须以 `/` 开头；禁止空白、`?`、`#`、反斜杠、控制字符；禁止 `.` 与 `..` 段。
- 折叠重复斜杠、去掉尾斜杠（根路径 `/` 保留）。
- 大小写**保留**（serve 区分大小写），但冲突检测走 `routePathKey()` 做小写归一。

### `normalizeTargetPath(input): PathValidation`

空串与 `/` 都归一化为 `""`（表示不追加路径）。

### `buildProxyUrl(hostPort, targetPath='')` / `parseProxyUrl(raw)`

- `buildProxyUrl(443, '/api/agent')` → `http://127.0.0.1:443/api/agent`。
- `parseProxyUrl` 只接受 `http:`/`https:`，无法解析时返回 `null`（调用方据此放弃接管该路由）。

### `isValidPort(value): value is number`

1–65535 的整数。注意 `isValidPort('80') === false` —— 字符串端口必须在入参层就被拒绝。

### `isLoopbackHost(host)`

`127.0.0.1` / `localhost` / `::1`。**同时被 config 的监听校验与 app 的 Host 头校验复用**。

---

## 3. `src/docker/` —— 容器清单

### `resolveEndpoints(configured, env)` · `normalizePipeName(raw)` · `describeEndpoint(ep)`

候选端点优先级：显式配置 → `DOCKER_HOST` → 平台默认（Windows: `dockerDesktopLinuxEngine` → `docker_engine` → `dockerDesktopWindowsEngine`；POSIX: `/var/run/docker.sock` → `/run/docker.sock`）。

`normalizePipeName` 容忍 `npipe://./pipe/x`、`//./pipe/x`、`\\.\pipe\x`、`x` 四种写法。

### `class DockerEngineClient implements DockerTransport`

- `request<T>(path, opts)`：端点解析是**惰性**的，首个成功端点被缓存。请求失败（非 HTTP 错误码）时清空缓存并重新探测，兼容 Docker Desktop 重启与 WSL/Windows 引擎切换。
- `endpoint()`：未连接时返回 `(未连接)`；**因此启动流程里有一次预热调用**（见 `main.ts`），否则启动日志会误导读者。
- 传输层直接用 `node:http` 的 `socketPath` 走命名管道/Unix socket，不依赖 docker CLI，因此不需要解析人类可读输出。

### `normalizePorts(raw)` —— 唯一一处「丢弃未发布端口」的地方

`PublicPort` 缺失即未发布到宿主机 → 丢弃。同一端口若同时存在 IPv4(`0.0.0.0`) 与 IPv6(`::`) 两条记录，**两条都保留**：这是判断「容器是否绕过本工具直接监听 tailnet」的依据。

### `normalizeContainer(raw)` · `class DockerContainerService`

从 `/containers/json?all=1` 取数，只保留路由需要的字段，结果按容器名排序。

---

## 4. `src/tailscale/` —— serve 控制面

### `parseServeStatus(raw): ServeSnapshot`

解析 `tailscale serve status --json`（legacy raw serve config format）：

```json
{ "TCP": { "443": { "HTTPS": true } },
  "Web": { "<host>:<port>": { "Handlers": { "/path": { "Proxy": "http://127.0.0.1:8080" } } } } }
```

关键行为：

- 无任何配置时 tailscale 输出 `{}` → 返回空快照而不是抛错。
- 优先选择与 HTTPS 端口一致的那个 `Web` 键；否则取第一个。
- 非 `Proxy` 的 handler（`Path` / `Text`）被识别为 `file` / `text`，不参与路由托管。

### `parseHandler(value)` / `splitHostPort(key)` / `proxiedRoutes(snapshot)` / `snapshotHostname(snapshot)`

`proxiedRoutes` 只保留「能解析出宿主机端口」的代理路由 —— 这是「可接管候选」的定义。

### `class TailscaleCli`

| 方法 | 实际命令 | 备注 |
| --- | --- | --- |
| `statusJson()` | `status --json` | |
| `serveStatusJson()` | `serve status --json` | 空输出归一化为 `{}` |
| `serveUpsert(path, proxy)` | `serve --bg --yes --set-path=<path> <proxy>` | **`--set-path` 必须在目标之前** |
| `serveRemove(path)` | `serve --yes --set-path=<path> off` | 精确摘除单条，不影响同主机其它路径 |

两处工程约束（均为真实环境实测结论）：

1. **写操作一律带 `--yes`**，否则交互式确认会把常驻进程挂死。
2. **刻意不用 `serve set-config`**。Tailscale 1.102 起 `set-config` 已转向 services 格式，喂给它 `serve status --json` 的原文会被判为 legacy 格式并警告 `ignoring node-level fields: TCP, Web` —— 即静默不生效。同时它的参数顺序要求 `set-config --all <file>`（文件必须在 `--all` 之后）。因此读用 JSON、写用 `--set-path`。

`explain(args, stderr)` 把 CLI 的小写报错翻译成中文可读原因（访问被拒绝 / tailscaled 未运行 / tailnet 未启用 HTTPS）。

### `class TailscaleServeGateway implements ServeGateway`

映射层唯一可见的网关接口，暴露 `snapshot()` / `tailnet()` / `upsertRoute()` / `removeRoute()`。刻意不暴露 CLI 细节，测试可直接换成内存实现。

### `parseTailnetInfo(raw)`

去掉 `DNSName` 的尾点，拼出 `baseUrl = https://<dnsName>`。字段缺失时不抛错（Tailscale 未登录时界面仍应能打开）。

---

## 5. `src/mappings/` —— 映射库与收敛

### `src/mappings/store.ts`

| 符号 | 说明 |
| --- | --- |
| `reviveMapping(raw, logger)` | 反序列化时的严格校验；非法条目**丢弃**而不是让脏数据流入后续流程 |
| `FileMappingStore` | 单文件 JSON + 「临时文件 + rename」原子写 |
| `MemoryMappingStore` | 测试用 |
| `FileAuditLog` | JSONL 追加；内存缓存最近 1000 条 |
| `MemoryAuditLog` | 测试用 |

`reviveMapping` 的容忍边界：`path` 非法、`hostPort` 非法、`id` 缺失 → 丢弃；`targetPath === '/'` → 归一化为 `""`；`enabled` 缺失 → `true`。

### `src/mappings/reconcile.ts` —— 全部是纯函数

#### `isSameProxy(a, b)`

先解析再比对 `host` / `hostPort` / `targetPath`，因此 `http://127.0.0.1:8080` 与 `http://127.0.0.1:8080/` 视为相同，避免每次 apply 都产生一次无意义的写入。解析失败时退化为字符串比较。

#### `describeOrphan(mapping, containers)`

仅对 `kind === 'container'` 生效，依次检查：容器是否存在（先按 id，再按 name）→ 是否 `running` → 是否仍发布该 `hostPort`。返回中文说明或 `null`。

#### `evaluateMapping(mapping, snapshot, containers, adminPort)`

单条映射的状态评估，判定顺序严格遵循第 1 节的状态优先级。**`adminPort` 判定在最前**，先于 `enabled`。

#### `planReconcile(input): ReconcilePlan`

产出 `upserts` / `removals` / `blocked` / `exposures` / `evaluations`。规则：

- **期望集合**：`enabled === true` 且状态不是 `blocked` / `conflict` 的映射路径。
- **upsert**：期望路径在 serve 中缺失，或与实际不一致。
- **removal**（三个来源，全部去重）：
  1. 某条映射的 `ownedPaths ∪ {path}` 中存在、但不在期望集合中的路径；
  2. **任何**指向 `adminPort` 的 serve handler（无论是否本工具创建）——安全兜底；
  3. `blocked` 状态映射在 serve 中残留的路径。
- 同键重复路径的两条映射都判为 `conflict` 并跳过写入（正常流程由 `MappingService` 的更早校验拦住，此处是防御）。

#### `isInSync(plan)`

`upserts` 与 `removals` 均为空。注意 `exposures` 需单独判断 —— 暴露被摘除时会体现在 `removals` 里，但检测结果本身也要向用户展示。

### `src/mappings/mapping-service.ts`

#### `MappingService` 的并发模型

所有「读-改-写」经 `#serialize()` 串行化。**注意**：`setEnabled()` 自身不入队，它读一次后直接委托给 `update()`；如果在 `setEnabled` 里再包一层 `#serialize`，会因为队列自等待而**死锁**。

#### `create(input)` / `update(id, input)` / `#buildMapping(input, existing)`

`#buildMapping` 集中做全部前置校验，按顺序：

1. 路径归一化（非法 → `invalid-path`）
2. 目标路径归一化（→ `invalid-target-path`）
3. 端口范围（→ `invalid-port`）
4. 同路径重复（→ `duplicate-path`）
5. **`hostPort === adminPort` → `exposes-admin`（硬拒绝，且不写入 serve）**
6. 路径被**未托管**的 serve 路由占用且未带 `confirmTakeover` → `takeover-required`

第 5 条刻意放在第 6 条之前：即使该路径当前被一条未托管路由占用，也不能以「接管」的名义把它变成管理端口的出口。

`#matchContainer(hostPort, containerId?)` 按宿主机端口反查容器，自动填充 `containerId` / `containerName` / `containerPort`，并把 `kind` 定为 `container`。

#### `remove(id)`

先从映射库删除，再用一条 **tombstone**（`enabled: false`，`ownedPaths` 含原路径）参与本次收敛 —— 这样「路径的摘除」和「记录的删除」由同一套差异计算处理，不需要为删除写第二套逻辑。

#### `importExternal(paths?)`

把 serve 中的未托管路由转为受管映射。**不写 serve**（只是认领），因此不会造成任何瞬时中断。跳过条件：不是可解析的本机代理路由，或指向管理端口。

#### `applyInternal(overrideMappings?)`

副作用的唯一集中点，顺序：

```text
plan → 逐条 upsert（失败收集到 errors，不中断）→ 逐条 remove（同上）
     → 审计 → 回写 ownedPaths → 复查 exposures 并记录审计 → 重新评估得到 inSync
```

**回写 `ownedPaths` 的规则**：候选集为 `enabled ? [path, ...ownedPaths] : ownedPaths`，再与「收敛后仍存在于 serve 中的路径」求交。这样摘除失败时归属被保留，下次 apply 会自动重试。

**收敛失败不回滚映射库** —— 用户意图必须留存，`pending` + `errors` 就是重试入口。

#### `enforceExposureGuard()`

启动闸门。与 `planReconcile` 的 exposure 分支功能重叠，但**刻意独立实现**：它不依赖映射库内容，因此即使映射库被写坏或为空，启动时也一定会执行一次全量扫描。`autoUnexpose === false` 时只记审计与 error 日志，不摘除。

---

## 6. `src/config.ts` —— 配置

### `loadConfig(overrides): AppConfig`

**`TSCONTROLLER_HOST` 只接受回环地址，没有开关可绕过**。这是「本应用禁止暴露在 tailnet 中」的第一层实现，其余三层在 `app.ts`（Host 头）、`mapping-service.ts`（exposures 扫描）、`main.ts`（复核内核实际绑定地址）。

`readInt` / `readBool` / `readStr`：非法值直接抛错（宁可启动失败，也不要带着一个悄悄回退的默认值运行）。

---

## 7. `src/app.ts` —— HTTP 管理面

### `buildApp(deps): FastifyInstance`

| 层次 | 实现 |
| --- | --- |
| 错误映射 | `statusFor()`：`ZodError`→400、`MappingConflictError`→404/409、`TailscaleError`→502、`DockerApiError`→503、其余 500 |
| Host 校验 | `onRequest` 钩子，主机名必须过 `isLoopbackHost()`，否则 403 `forbidden-host` |
| 静态资源 | 仅当 `<WEB_ROOT>/index.html` 存在才注册 `@fastify/static`；否则 `/` 返回一段说明 API 已就绪的 HTML |
| SPA 回落 | `setNotFoundHandler`：`/api/*` 返回 404 JSON，其余返回 `index.html` |

`messageOf()` 对 `ZodError` 会把 `issues` 展平成 `字段: 原因; ...`，这样前端拿到的 `error` 字段直接可读。

---

## 8. `src/runtime.ts` / `src/main.ts`

### `createRuntime(overrides): Promise<Runtime>`

依赖装配的唯一入口。每一层都可以通过 `RuntimeOverrides` 注入替身，因此端到端验证脚本与单测共用同一套装配逻辑。

### `main()`

启动顺序（顺序本身是设计的一部分）：

```text
1. createRuntime()                 读配置、建目录、装配
2. enforceExposureGuard()          安全闸门 —— 先于监听
3. containers.listContainers()     Docker 预热，让启动日志显示真实数据源
4. app.listen()                    此时才开始对外提供管理接口
5. 复核 server.address()           非回环则自我关闭
6. 打印横幅 + 注册 SIGINT/SIGTERM 优雅退出
```

第 5 步是纵深防御：即使 `config` 与 `listen` 之间出现任何偏差（例如被中间件改写），进程也会自行退出而不是静默暴露。

---

## 9. `web/` —— 管理界面（前端）

Vite 6 + React 19 + TypeScript，无 UI 框架，纯手写 CSS。构建产物 `web/dist` 由后端以静态资源方式托管（见 `buildApp`）。

### 构建配置的两个坑（已在文件注释中说明）

1. **`vite.config.ts` 必须显式设置 `root`。** 启动命令是根目录下的 `vite --config web/vite.config.ts`，此时 Vite 默认会把 root 解析成配置文件所在目录，而 CLI 传入的 root 语义容易与 `--config` 叠加出错位；显式固定为 `web/` 的绝对路径后，`outDir` 才会落在 `web/dist`。
2. **`web/tsconfig.json` 与根 `tsconfig.json` 是两套独立的编译环境。** 前端用 `moduleResolution: bundler` + `jsx: react-jsx` + `lib: DOM`；根配置用 `NodeNext` + `types: node`。`npm run lint` 依次跑两者。

### `web/src/api.ts` —— 契约层

**这是前端最有价值的一个文件**：它把后端的全部响应结构逐字写成 TS 类型（字段名不做任何映射），因此后端一旦改名，前端会立刻编译失败而不是运行期静默失效。

| 符号 | 作用 |
| --- | --- |
| `ApiClient` / `createApi(base)` | 11 个接口的类型化封装；`api` 是走同源相对路径的默认实例 |
| `class ApiError` | 携带 `status` 与后端返回的 `code`；`is(code)` 用于分支 |
| `toApiError(err)` | 把任意抛出物（含 `AbortError`）归一化为 `ApiError`，中止的请求标记为 `aborted` |
| `ERROR_CODE_LABEL` | `exposes-admin` / `takeover-required` 等错误码 → 中文提示前缀 |
| `send()` | 统一 fetch：非 2xx 时优先解析 `{error, code}`，解析不出再退化为 `HTTP <status>` |

### `web/src/utils.ts` —— 纯函数

| 函数 | 说明 |
| --- | --- |
| `groupByStatus(mappings)` | 按 `MAPPING_STATUS_ORDER` 分组，**顺序即严重度**：blocked → conflict → orphaned → disabled-drift → pending → active → disabled |
| `slugifyPath` / `defaultPathFor` | 容器名 → 默认路径（小写、非 `[a-z0-9._-]` 折成 `-`、去首尾 `-.`），空结果兜底 `app` |
| `normalizePathInput` | 补前导 `/`、折叠重复斜杠；**不做更严格的校验**，非法路径交给后端拒绝并回显原因 |
| `joinUrl` / `isWildcardHost` / `formatTime` / `formatTimestamp` / `copyText` | 复制走 `navigator.clipboard`，失败时回退到 `execCommand('copy')` 的隐藏 textarea |

### 组件结构

| 组件 | 职责 | 关键设计 |
| --- | --- | --- |
| `App` | 数据采集与写操作编排 | 见下 |
| `TopBar` | tailnet 地址、管理地址、后端状态、数据源 | 地址均可一键复制 |
| `Toolbar` | 刷新 / 重新同步 / 计划摘要 | `inSync` 用绿点，否则黄点并列出待挂载/待摘除/被阻止数量 |
| `SecurityBanner` | 管理面暴露告警 | `safe` 时绿条；否则红条并逐条列出 `{path, proxy}` |
| `ContainerPanel` | 容器清单与端口 | 端口绑定 `0.0.0.0`/`::` 时打「全网卡」徽标；`hostPort === adminPort` 时按钮禁用并打「管理端口」徽标 |
| `ContainerMappingForm` | 内联建映射表单 | 收到 `takeover-required` 时**不报错**，而是就地展开「确认接管」二次确认区 |
| `MappingPanel` / `MappingRow` / `EditRow` | 映射表格 | 按状态分组；行内编辑；删除需二次确认 |
| `ExternalRoutesPanel` | 未托管路由 | 单条「接管」按钮 → `importRoutes([path])`；若 `skipped` 非空，把跳过原因原样展示 |
| `Toast` / `CopyButton` / `shared.ts` | 反馈与通用件 | error 级 toast 常驻（需用户处理），其余 8 秒自动消失 |

### `App` 的并发控制（易踩坑处）

两套机制刻意分工，不要合并：

- **请求序号 `seqRef`**：防竞态。每次采集递增，旧请求返回时序号已过期即丢弃结果。用 abort 上一次请求会让「刷新」在快速连点时抛出一堆 `AbortError`。
- **`AbortController`**：只负责组件卸载时取消在途请求。React 19 StrictMode 会挂载两次，因此 controller 存在 ref 上、每次挂载都新建，避免第一次挂载的 cleanup 误伤第二次挂载发出的请求。

`mutate()` 是所有写操作的统一外壳：包 busy 状态、转换错误、成功后自动 `refreshAll()`。返回 `{ data }` 表示成功，返回 `{ code, message }` 表示失败 —— 调用方据此区分「接管确认」等可重试分支。

## 10. 测试与验证

### 单元/接口测试（`npm test`，70 个）

| 文件 | 覆盖 |
| --- | --- |
| `test/route-path.test.ts` | 路径归一化的接受/拒绝边界、代理地址往返、回环判定 |
| `test/serve-config.test.ts` | 用**本机真实** `serve status --json` 的同构结构做解析回归；`parseTailnetInfo` 容错 |
| `test/reconcile.test.ts` | 12 个差异计算场景，含「永不删除未托管路由」「改名摘旧挂新」「暴露摘除」「孤儿检测」「同路径冲突」 |
| `test/mapping-service.test.ts` | 创建/更新/删除/启停/导入/安全闸门；含「写入失败后保留 pending 并可重试」「摘除失败后保留归属并可重试」 |
| `test/api.test.ts` | 完整 REST 生命周期、409 的三种 code、400/404、DNS rebinding 防护 |
| `test/config-and-docker.test.ts` | 非回环监听必须抛错、管道名归一化、未发布端口丢弃、`reviveMapping` 脏数据丢弃 |

`test/fakes.ts` 提供 `FakeServeGateway`（内存 serve 配置 + 可注入的 upsert/remove 失败 + 调用轨迹）、`FakeContainerSource`、`makeContainer`。

### 真实环境验证（需 Docker + Tailscale，不在沙箱内运行）

- `scripts/verify-live.ts`：真实建映射 → 真实 HTTPS 请求 → 真实删映射，并逐条比对运行前后的 serve 路径集合。实测 9/9 通过（`HTTP 200`，响应 626 字节来自容器）。
- `scripts/verify-security.ts`：真实复现「serve 中存在指向管理端口的路由」，验证被检测、被摘除、写入审计、且不误伤其它端口；再验证 API 拒绝建立该类映射。实测 10/10 通过。

两个脚本都在 `finally` 中兜底摘除测试路径，并对「原有 serve 配置是否原样保留」做断言。

---

## 11. 变更归档

### 2026-10-15 · 首个可用版本（全量新增）

新增文件：`package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`、`src/**`（15 个 TS 文件）、`test/**`（6 个测试文件 + `fakes.ts`）、`scripts/verify-live.ts`、`scripts/verify-security.ts`。

**本次确立且后续不应推翻的决定**：

1. 采用**控制面**方案托管 `tailscale serve`，不接管数据面（用户在三个方案中选定）。
2. 读 serve 配置用 `serve status --json`，写用 `serve --set-path` CLI；**禁用 `set-config`**（见第 4 节实测原因）。
3. `Mapping.ownedPaths` 记账机制 + 「只删自己写过的路径」策略。
4. `TSCONTROLLER_HOST` 硬性只允许回环，无绕过开关。

**开发过程中修正的实质问题**（供后续排查参考）：

1. `tailscale serve set-config` 在本机版本上会以 legacy 格式警告并**静默忽略**节点级字段（`TCP`、`Web`），初次探测时退出码仍为 0 —— 只检查退出码会误判为成功。已改用 `--set-path` CLI。
2. `set-config` 的参数顺序要求 `--all` 在文件名之前，否则报 `must specify filename`。
3. Zod 校验失败原本落到 500；已在 `statusFor()` 中显式映射为 400。
4. `private async #method()` 同时使用 `private` 与 `#` 是 TS 错误（TS18010），已统一为 `#method()`。
5. `setEnabled()` 内部委托 `update()`，因此自身不能包 `#serialize()`，否则队列自等待死锁。
6. 启动日志中的 Docker 端点原本恒为 `(未连接)`（端点解析是惰性的），已在监听前增加一次预热调用。
7. 不得用 PowerShell 的 `Get-Content -Raw` + `Set-Content -Encoding utf8` 改这些源码：无 BOM 的 UTF-8 中文会被按 ANSI 读出再写回，直接损坏文件。改用编辑工具。

### 2026-10-15 · 首个版本交付前的自查修正

在首版代码写完、测试全绿之后，对四个「测试测不出来但真实使用会踩」的点做了修正：

1. **Docker 端点探测从串行改并发，并加负缓存**（`src/docker/docker-client.ts`）。
   - 问题：Windows 上 `dockerDesktopWindowsEngine` 管道存在但不响应，串行探测会被它单独拖满 3s 超时 —— 实测首次连接耗时 **2528ms**。
   - 改法：`#probe()` 改为「所有候选并发发起，最先成功者胜出」（手写 race，而不是 `Promise.allSettled` —— 后者会等全部结束，等于没并发）。新增 `PROBE_TIMEOUT_MS = 2500` 与 `PROBE_FAILURE_TTL_MS = 5000` 负缓存。
   - 结果：实测 **27ms** 完成连接；Docker 未运行时后续请求直接命中负缓存，界面不再每次卡一轮超时。

2. **显式 Docker 端点是权威的**（`resolveEndpoints`）。
   - 问题：原实现在显式配置之后**仍会追加平台默认候选**。把 `DOCKER_HOST` 指向远程 Engine 的用户，会在远程不可达时被静默回落到本机 Docker Desktop —— 最难排查的一类故障。
   - 改法：`out.length > 0` 时直接返回，不再追加默认值。测试从「显式配置优先」改为「显式配置是权威的」。

3. **`dataDir` 与 `webRoot` 锚定到项目根目录**（`src/config.ts`）。
   - 问题：原本相对 `process.cwd()` 解析。本工具最终会被注册为计划任务/服务，那时 cwd 往往是 `C:\Windows\System32`，数据目录与前端目录会双双指错。
   - 改法：新增 `PROJECT_ROOT`（由 `import.meta.url` 推导），默认值改为 `path.join(PROJECT_ROOT, ...)`；环境变量仍按 cwd 解析（显式给出就该按用户的意图来）。

4. **`overview()` 不再重复读取 serve 快照**（`src/mappings/mapping-service.ts`）。
   - 问题：它先调 `#evaluateAll()`（内部已取快照），又单独调了一次 `gateway.snapshot()`，一次界面刷新会对 `tailscale` CLI 发起两次进程调用。
   - 改法：`#evaluateAll()` 的返回值中加入 `snapshot`，`overview()` 复用之。

测试数从 68 增至 **70**（新增「显式配置是权威的」「未配置时才使用平台默认候选」「无法连接时抛出可读错误且被负缓存」）。

`scripts/verify-live.ts` 与 `verify-security.ts` 在本次修正后重新执行，结果仍为 **9/9** 与 **10/10** 通过。

### 2026-10-15 · 管理界面交付 + 路由模型复核

**新增**：`web/` 全量前端（14 个源文件 + `vite.config.ts` + `tsconfig.json` + `index.html`），详见第 9 节。

**路由模型复核（本次最重要的结论）**

需求方提出「可以配置 `dsh.xxx.ts.net` 这样的 ts 域名，不必挂在路径上」。该说法在 Tailscale 里成立，但在本机身份下**取不到**，三条实测证据：

| 探测 | 结果 |
| --- | --- |
| `tailscale cert dsh.example-tailnet.ts.net` | `invalid domain "dsh.example-tailnet.ts.net"; must be one of ["my-laptop.example-tailnet.ts.net"]` |
| `tailscale serve --bg --yes --service=svc:tsctest --https=443 http://127.0.0.1:8080` | `service hosts must be tagged nodes` |
| `tailscale status --json` → `Self.Tags` | 空（用户账号拥有的节点） |

根因：`<任意名字>.<tailnet>.ts.net` 只能由 Tailscale Services 提供，而 Services 要求**服务宿主机使用 tag 身份**，tag 身份与用户身份互斥。已在 `README.md` §12 完整记录代价（Taildrop 失效、不能 SSH 到用户身份的机器、不能被分享、ACL 语义变化、tag 粘性、key expiry 默认关闭、官方劝退笔记本）与替代方案（用另一台已 tagged 的常开设备当 service host，本机身份不动）。

**决策**：路由键保持**路径**。服务主机名模式作为可选项记录在 `todo.md` 第 9 项，并写明了届时需要的最小改动面（`MappingTarget.remoteHost` + service 维度的网关读写 + `services` 配置段解析 + 安全闸门扩展到 service 级）。

**验证（全部在最终代码上重跑）**

| 检查 | 结果 |
| --- | --- |
| `npm run lint`（后端 + 前端两套 tsconfig） | 0 错 |
| `npm test` | **70/70 通过** |
| `npm run web:build` | 成功，39 modules → `web/dist`（index 0.48 kB / js 261 kB / css 10.9 kB） |
| `scripts/verify-live.ts --port 8080` | **9/9 通过**（`HTTP 200`，626 字节来自容器） |
| `scripts/verify-security.ts` | **10/10 通过** |
| 后端托管前端 | `/` → SPA、`/assets/*` → 200、`/deep/spa/route` → 回落 index.html、`/api/nope` → 404 JSON |
| 最终 serve 配置 | 与开工前完全一致（原 7 条路由未被改动） |

**过程中修掉的实质性缺陷**

1. **前端白屏风险**：写操作成功回调假设响应必有 `{ mapping }`，形状不符时会在 `result.data.mapping.path` 抛 TypeError 白屏。已改为可选链 + 「响应异常」内联提示。真后端确实返回 `{ mapping, apply }`，属防御性加固，但该分支在验证中被真实触发过。
2. **PATCH 请求体会丢容器关联**：编辑映射时若只发 `path/hostPort/targetPath/note`，后端会按端口反查容器；当容器已停止时反查失败，`kind` 会被降级为 `host`。前端因此把 `kind` / `containerId` / `containerName` / `containerPort` 一并回传（后端忽略未声明字段）。
3. **构建产物污染仓库根目录**：前端验证期有两个临时产物（`__smoke.css` / `__smoke.mjs`）落到项目根并被 `git add`。文件已删除，索引中的 `AD` 幽灵条目已用 `git reset` + 重新 `git add -A` 清理；新增 `.gitattributes`（`* text=auto eol=lf`）统一换行符，避免 Windows 上 `core.autocrlf` 造成的整文件 diff。

### 2026-10-15 · 首次真实使用反馈：目标路径与挂载前缀的对应关系

首次由真实使用暴露的问题（非代码缺陷，是**语义理解成本**）：

用户把映射的挂载路径由 `/agent` 改成 `/api/addSchedule`，但**目标路径仍是 `/api/agent`**，随后 `POST https://…/api/addSchedule` 返回 404。

根因链条：

1. `tailscale serve` 转发时会**剥掉挂载前缀**，因此「挂载 `/api/addSchedule` + 目标 `/api/agent`」意味着——请求正好命中挂载路径时剥完是空串，后端收到 `/api/agent`；
2. 而 SisiCalendar 的后端只有 `POST /api/agent/events` 与 `GET /api/agent/events/{event_id}`（`app/routers/api_agent.py`），**没有** `/api/agent` 这个路由 → 404。

诊断证据（区分「路由没生效」与「后端没这个路由」的关键）：404 响应体是 FastAPI 形状 `{"error":{"code":"not_found","message":"Not Found","fields":null}}`，说明流量确实打到了日历容器；而已改名前的 `/agent` 摘除后，`POST /agent/events` 返回的是 `{"error":"unauthorized"}` —— 与 `/dsh/agent/events` 的响应逐字相同，即落到了 `/` 兜底上的 DSH，而非日历。

**结论与改动**：映射的「外部路径」只是别名，决定命中后端哪条路由的是**目标路径**。将目标路径改为 `/api/agent/events` 后，`POST /api/addSchedule` 与 `GET /api/addSchedule/{id}` 均正确命中后端并返回日历的 401（缺 Bearer 令牌），链路打通。**代码零改动**，只通过 `PATCH /api/mappings/:id` 调整了映射数据。

**归档的文档增量**：`README.md` 新增 §9.1「挂载路径会被剥掉（最容易踩的一个坑）」，写明两条规则（别名 ≠ 后端路由名；请求正好等于挂载路径时后端收到目标路径本身），并给出 `/calendar.ics` 这个同名对照例子。

**两项已决策不做**（记录以免日后重复评估）：

1. **界面内联表单提示不加强前缀剥离说明。** 该规则已写入 `README.md` §9.1，文档足够；不值得为一句提示引入前端改动 + 重新构建。若第二次踩同一个坑再回来做。
2. **不把 `/agent` 加回为第二条映射。** 需求方明确只要新地址 `/api/addSchedule`，接受旧地址退役；因此 `/agent` 目前落到 `/` 兜底（DSH）返回 401 属于预期状态，不是缺陷。

> 附带确认了一条 serve 行为：**请求路径正好等于挂载路径时，目标路径被原样使用，不会追加尾斜杠**。证据是 `/calendar.ics → http://127.0.0.1:443/calendar.ics` 这个既有映射——它是 exact match，且返回的是应用层的 404 文案而非 FastAPI 的 307 重定向，说明路径按原样到达后端。这正是 `POST /api/addSchedule → POST /api/agent/events` 能成立的前提。

### 2026-10-15 · 容器化可行性调研（结论：不做）

被问到「能不能挂在 Docker 里」，做了实测调研。**代码零改动，不新增 Dockerfile**，结论归档为 `README.md` §13 与 `todo.md`「已探明、决定不做」A 项。

**决定性实测数据**（本机 Windows + Docker Desktop）：

| 观察 | 结果 |
| --- | --- |
| tailscaled（pid 7392/11848）监听端口 | 仅 `100.101.102.103:443`（serve 数据面）、`100.101.102.103:38081`（PeerAPI）、`[fd7a:…]:443/:50559`。**无任何回环 TCP** |
| tailscale CLI 的连接目标 | `open \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`（取自一次权限不足的报错原文） |
| `docker info --format {{.OSType}}` | `linux`（Docker Desktop，WSL2 后端；`vmmemWSL` 进程存在） |
| 容器内的 `host.docker.internal` | `192.168.65.254` —— 只能访问 Windows 宿主的 **TCP** 端口 |

**推理链**：`serve` 配置只能经 tailscaled LocalAPI 修改 → Windows 上该 API 只有命名管道这一条传输 → 命名管道跨不过 WSL2 边界（容器是 WSL2 内的 Linux）→ 容器化的 TsController 能列容器但所有 tailscale 操作失败，而后者是其全部意义。

**Linux 宿主的可行条件**（记录下来备查）：`network_mode: host` 是硬要求而非优化项——因为「只允许监听回环」在代码里无绕过开关（`loadConfig()` 抛错 + `main.ts` 监听后复核内核绑定地址），若用 `-p 127.0.0.1:8787:8787` 则容器内必须 bind `0.0.0.0`，会被直接拒绝；只有 host 网络能让容器内的 `127.0.0.1` 真为宿主回环，该安全保证才既成立又通过检查。另需挂 `/var/run/docker.sock` 与 `/var/run/tailscale/tailscaled.sock`，并保持镜像内 CLI 版本与宿主 daemon 大致匹配。

**明确不做的理由**：挂 `docker.sock` 进容器 ≈ 容器获得宿主 root 等价权限，给一个设计目标为「禁止暴露在 tailnet 中」的工具增加容器逃逸面，方向相反；且单机单用户控制面无扩缩容需求，零功能收益；同时会把「只监听回环」这条代码层强制的安全不变量，退化为依赖部署者记得写 `network_mode: host`。

**顺带澄清的两个相邻模型**（易混淆，一并归档）：

1. **在 NAS 上跑 ≠ 管这台笔记本。** 该工具天生宿主作用域（读本机 Docker daemon、写本机 tailscaled），在 NAS 上运行得到的是 NAS 控制器，与 `my-laptop` 上的路由无关。要管两台就跑两个实例。
2. **把 tailscaled 跑进容器**（官方 `tailscale/tailscale` 镜像）是另一个产品：容器成为独立 tailnet 节点，产出 `<容器节点名>.<tailnet>.ts.net`，`serve` 从容器发出，本机现有路由一条都管不到。

**常驻的正确路径**：Windows 计划任务（登录时触发、以当前用户身份运行）。不可用 `LocalSystem`——`Tailscale` 命名管道位于 `ProtectedPrefix\Administrators` 下，服务账户会话拿不到。见 `todo.md` 第 2 项。

### 2026-10-16 · 多端口支持（修复安全缺口）+ 一次数据误删事故

#### 起因

需求方把 `homepage-portal` 挂到 `/home`，页面 200 但白屏。诊断结论：该应用用**根绝对路径**引用静态资源（`/assets/index-CEaepkfb.js`），而 `/assets/**` 不在 `/home` 前缀内 → 落到 `/` 兜底 → 打到 DSH 返回 401（实测响应体 `{"error":"unauthorized"}`，与 `/dsh/agent/events` 逐字相同，可据此区分「路由没生效」与「打到兜底」）。同一诊断也确认了 `POST /api/addSchedule → POST /api/agent/events` 的映射正确性（响应体是日历的 FastAPI 形状，证明命中了后端路由，只差 Bearer 令牌）。

解法是**换端口而非换路径**：`https://<主机>:8443/` 是独立 origin，根路径天然正确。实测 `:8443/`、`:8443/assets/index-*.js`、`:8443/assets/index-*.css` 全部 200，且 TLS 证书有效（证书绑主机名，与端口无关）。

但由此暴露了本次修复的真正对象：**`parseServeStatus` 只取一组 `Web` 配置，因此挂在非 443 端口上的路由对 TsController 完全不可见——安全闸门也扫不到。** 这是一处真实的安全缺口（`README.md` §5 曾承诺「任何指向管理端口的 handler 一律摘除」，对非 443 端口当时并不成立）。

#### 改动清单（路由身份从「路径」升级为「端口 + 路径」）

| 文件 | 改动 |
| --- | --- |
| `src/domain/types.ts` | `Mapping` 新增 `servePort`；`ownedPaths: string[]` → `ownedRoutes: OwnedRoute[]`（`{servePort, path}`）；`ServeRoute` 新增 `servePort`/`host`；`ServeSnapshot` 的 `webHost`/`httpsPort` → `httpsPorts: number[]`/`hostname`；新增 `RouteRef` |
| `src/domain/route-path.ts` | 新增 `serveRouteKey(port, path)`（唯一键）、`buildBaseUrl(hostname, port)`、`formatRouteRef(route)`（443 省略端口以免日志噪音） |
| `src/tailscale/serve-config.ts` | **`parseServeStatus` 遍历全部 `Web` 组**，路由扁平存放并各自带 `servePort`；`snapshotHostname` 改为直接返回 `snapshot.hostname` |
| `src/tailscale/tailscale-cli.ts` | `serveUpsert`/`serveRemove` 显式带 `--https=<port>` |
| `src/tailscale/tailscale-service.ts` | `ServeGateway.upsertRoute`/`removeRoute` 签名加端口 |
| `src/mappings/store.ts` | `reviveMapping(raw, defaultServePort, logger)`；新增 `reviveOwnedRoutes`；**迁移旧格式** `ownedPaths` → `ownedRoutes`（旧格式无端口维度，归属到该映射自身端口）；`FileMappingStore` 接收默认端口 |
| `src/mappings/reconcile.ts` | 全部匹配/去重/归属改用 `serveRouteKey`；`PlannedUpsert`/`PlannedRemoval`/`exposures` 均带 `servePort`；新增「对外端口 == 管理端口」判定；暴露扫描覆盖全部端口 |
| `src/mappings/mapping-service.ts` | `MappingInput.servePort`；`#buildMapping` 校验端口并新增 `serve-port-is-admin`；`#ownedKeysOf`/`#ownedKeys` 辅助；`importExternal(selection: {servePort,path}[])`；`ApplyResult.upserted`/`removed` 改为 `RouteRef[]`；`enforceExposureGuard` 跨端口扫描 |
| `src/app.ts` | 请求体加 `servePort`；`/api/system` 的 `webHost` → `serveHost` + `servePorts`；`/api/serve/routes` 同步；import 请求体 `paths` → `routes` |
| `web/src/**` | 类型同步；新增 `formatRouteLabel`；`joinUrl(serveHost, servePort, path)`；创建表单与编辑行新增「对外端口」字段；serve 路由表与未托管路由表新增端口列；**顺手补上了 README §9.1 那套「前缀会被剥掉」的表单内提示**（此前评估过不做，本次因为改动已经落到同一个文件而一并完成） |

**CLI 行为实测**（改动的地基，先验证再动手）：`serve --bg --yes --https=8443 --set-path=/x <url>` 只作用于 8443 组；`serve --yes --https=8443 --set-path=/x off` 精确摘除该条；`--https=443` 显式给出与省略等价；`serve status --json` 中每个端口是一个独立的 `Web` 键（`host:443`、`host:8443`）。

#### 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 0 错 |
| `npm test` | **96/96 通过**（自 70 增加 26 个：多端口 reconcile / 映射服务 / API / 迁移用例） |
| `npm run web:build` | 成功 |
| `scripts/verify-live.ts --port 8080`（443 回归） | **9/9** |
| `scripts/verify-live.ts --port 8899 --serve-port 8443` | **9/9**（真实请求 `https://…:8443/__tscontroller-selftest` → HTTP 200） |
| `scripts/verify-security.ts` | **14/14**，含新增的 D 组断言：**8443 上的暴露被检测并摘除**，且该端口上的既有路由未被牵连 |
| 通过 API 在 8443 建/删映射 | `:8443/__api8443` 真实访问 HTTP 200，删除后 `inSync: true` |
| 旧格式 `ownedPaths` 迁移 | `reviveMapping` 单测覆盖 + 真实映射库迁移后 7 条全 `active`、`inSync: true` |

#### 事故：误删真实映射库（`data/mappings.json`）

**经过**：连续执行验证脚本后，用 `Remove-Item -Recurse -Force data` 清理临时数据，但真实映射库 `data/mappings.json` 与验证脚本的 `data/verify*` 子目录同级，**一并被删除**（审计日志 `data/audit.jsonl` 同样丢失）。

**为什么没有造成实际故障**：serve 配置从未被破坏，且「只删自己写过的路径」策略意味着**映射库丢失后 TsController 只会不再认领路由，而不会删除它们**。失效表现仅为所有路由显示为「未托管」、备注与归属记账丢失。

**恢复方式**：按会话中此前读到的 `mappings.json` 原文 + 审计日志逐条重建 7 条映射（5 条原始导入 + `/home` + 8443 上的 `/`）。重建后 `inSync: true`、`upserts: 0`、`removals: 0` —— 即重建结果与 serve 现状完全一致，证明恢复无损。

**防复发措施**：

1. 新增 `scripts/clean-verify.ts`（`npm run clean:verify`）：**只删白名单内的验证子目录**（`data/verify*`、`data/smoke`），对每个路径做两次断言——必须落在 `data/` 之下，且目录名必须以 `verify`/`smoke` 开头；结束时报告真实映射库是否仍在。
2. `README.md` §3 增加显式警告：不要 `rm -rf data`，用 `npm run clean:verify`。

**教训（写给下一次的自己）**：临时数据与真实数据同级存放时，清理命令必须按**已知的白名单子目录**逐个删除，绝不对父目录做递归删除。这一条已固化进清理脚本的断言里，而不是只写在文档中。

### 2026-10-16 · serve 路由快照 + 一处安全论断被实测推翻

#### 起因

需求方提出：其它项目也需要读 tailscale serve 路由，但它们跑在容器里（够不到宿主 tailscaled）；而 TsController 从终端启动，因此考虑由它暴露一个 HTTP 接口供调用。

调研这个问题时先做了一次连通性实测，结果推翻了本文件此前写下的一个安全论断。

#### 实测证据链（Windows + Docker Desktop）

| 探针 | 结果 | 含义 |
| --- | --- | --- |
| 容器内 `tailscale serve` / named pipe | 不可达 | 既有结论，容器够不到宿主 tailscaled |
| `docker run ... wget host.docker.internal:8787/api/health` | `403 forbidden-host` | Host 校验拦住了「天真客户端」 |
| 同上 + 伪造 `Host: 127.0.0.1:8787` | `200 {"ok":true}` | **Host 校验可被绕过** |
| 伪造 Host `GET /api/system` | 完整数据返回 | 读接口对容器完全开放 |
| 伪造 Host `POST /api/mappings`（指向管理端口） | `409 exposes-admin` | 请求**已通过鉴权**，仅被业务规则拒绝 → 写权限同样开放 |
| 临时探针打印 `req.socket.remoteAddress` | 本机直连 / 容器自然请求 / 容器伪造 Host **三者都是 `127.0.0.1`** | **无法靠来源地址区分** |

根因两条，缺一不可：Docker Desktop 把 `host.docker.internal` 代理到宿主 loopback（**绑回环 ≠ 隔离容器**）；`Host` 头由客户端完全可控。

**被推翻的论断**：本文件与 `README.md` §5 曾称「只监听回环 → 其它设备无法直连 + Host 白名单」构成有效的管理面边界。**该结论对网络对端成立，对同机容器不成立。**

需要注意的边界差异：Linux 桥接网络下容器**到不了**宿主回环（`docker0` 网关上没有该监听），所以这个问题在当前平台（Docker Desktop）上更严重。这一点也影响了「将来容器化到 NAS」的评估——届时把 TsController 放进专用 compose 网络、绑容器内 `0.0.0.0` 但不 publish，可达范围反而**比绑宿主回环更窄**。

**未修**：可靠判别只能依赖「容器拿不到的东西」——宿主文件系统上的令牌。已记入 `todo.md`（写接口令牌）。

#### 本次实现：serve 路由快照

新增 `src/snapshot.ts`：

| 符号 | 说明 |
| --- | --- |
| `SNAPSHOT_SCHEMA_VERSION` | schema 版本，字段语义变化时递增 |
| `Snapshot` / `SnapshotRoute` / `SnapshotSummary` | 快照结构。每条路由含 `servePort`/`path`/`url`/`proxy`/`targetPath`/`targetHostPort`/`managed`/`mappingId`/`status`/`containerName`/`containerPort`/`note`/`enabled` |
| `buildSnapshot(input): Snapshot` | **纯函数**。相同输入必得相同输出（`generatedAt` 由调用方注入），因此可穷举测试 |
| `SnapshotWriter` | 写出器接口，便于注入内存实现 |
| `FileSnapshotWriter` | 写 `<dir>/serve-routes.json`，**临时文件 + rename** 原子替换，消费方永远读不到半截 JSON |
| `MemorySnapshotWriter` | 测试用 |

**接线的关键决定**：

1. **位置** `<DATA_DIR>/public/`，不是 `<DATA_DIR>` 根下——消费方只挂这一个目录，不必顺带暴露 `mappings.json` 与 `audit.jsonl`。
2. **刷新时机**：`MappingService.applyInternal()` 收敛之后写一次（消费方读到的应是收敛后的真实状态）；`main.ts` 启动时写一次（必须在可供调用之前存在）；另有定期定时器。
3. **定期刷新只读不写**：`publishSnapshot()` 只做 `snapshot()` 读取 + 写文件，**绝不改 serve 配置**。实测确认定时器推进时 `tailscale serve status` 逐字节不变。
4. **失败不影响收敛**：快照写失败只 `logger.warn`，`apply` 的返回值与错误列表不受影响（有单测覆盖）。
5. **刻意不含**：数据目录路径、Docker 端点等内部信息；文件内无任何密钥。
6. 定时器 `unref()`，不阻止进程退出。

新增配置：`TSCONTROLLER_SNAPSHOT_DIR`（默认 `<DATA_DIR>/public`）、`TSCONTROLLER_SNAPSHOT_INTERVAL_MS`（默认 60000，0 关闭）。
`/api/system` 的 `sources` 新增 `snapshotFile`，界面顶部信息条展示并可一键复制。

#### 验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 0 错 |
| `npm test` | **112/112**（自 96 增加 16：12 个快照单测 + 4 个收敛集成断言） |
| `npm run web:build` | 成功 |
| 启动后快照生成 | `data/public/serve-routes.json`，4616B，8 条路由 / 7 受管 / 1 未托管 |
| **容器只读挂载读取** | `docker run -v "...\data\public:/tscontroller:ro" cat /tscontroller/serve-routes.json` → 正常读出 |
| 写穿透 | 通过 API 建映射后文件 `LastWriteTime` 与路由数同步更新；删除后回落 |
| 定期刷新 | `generatedAt` 在一个周期后推进（23:38:34 → 23:39:18） |
| 定期刷新不改 serve | 前后 `tailscale serve status --json` 逐字节相同 |

### 2026-10-16 · NAS 部署准备 + 容器化实测

#### 起因

最终目标是 NAS 部署，需求方要一份能带到 NAS 上照着做的文档，并问「快照文件路径在 NAS 上怎么决定」。

#### 修掉的一个「文档承诺了但代码没实现」

`README.md` 早已写明 `TSCONTROLLER_SNAPSHOT_DIR` 可覆盖快照目录，但 `loadConfig()` **从未读取它**（与其他路径型配置不同，只写了 `path.join(dataDir, 'public')`）。已按 `TSCONTROLLER_DATA_DIR` / `TSCONTROLLER_WEB_ROOT` 的同一模式接通（显式值按 cwd 解析，空串视为未设置），并补了 4 个单测覆盖默认值、覆盖值、空串回落、间隔参数校验。**本机实测确认文件确实落在指定目录。**

#### 快照新增：未托管路由的容器关联

原先 `containerName` / `containerPort` 只来自映射库，因此**未托管**路由在快照里是空的。但门户恰恰需要知道每条路由背后是哪个容器。

`buildSnapshot()` 的输入因此新增 `containers: ContainerInfo[]`，并新增 `containerSource` 字段（`'mapping' | 'port' | null`）标明来源：

- 优先用映射库的归属（人工确认过）；
- 没有映射时按 `targetHostPort` 在容器清单里反查，**优先运行中的容器**；
- 都查不到就保持 `null`，不猜。

实测效果（容器内跑真实 docker.sock）：

| path | targetHostPort | containerName | containerSource |
| --- | --- | --- | --- |
| `/` | 8080 | cs22-web | port |
| `/calendar` | 443 | sisi-calendar | port |
| `/portal` | 8899 | homepage-portal | port |

#### 新增部署资产

| 文件 | 说明 |
| --- | --- |
| `deploy/Dockerfile` | 多阶段：`node:22-bookworm-slim` 构建前端 → 运行阶段用 `npm ci --omit=dev`。**选 Debian 而非 Alpine**，因为宿主的 tailscale 二进制会被 bind-mount 进来，glibc 兼容性更好。构建时断言 Node ≥ 22.18（原生类型擦除）。 |
| `deploy/docker-compose.yml` | `network_mode: host`（硬要求，见下）、三个挂载（data / docker.sock / tailscaled.sock）、healthcheck |
| `.dockerignore` | 排除 `node_modules`、`data`、`web/dist`（镜像内重建）等 |
| `docs/nas-deployment.md` | 部署指南：路径决定逻辑、探路清单、逐步部署、验证、回滚、故障排查表 |

**`network_mode: host` 是硬要求而非优化项**：本应用硬性拒绝绑定非回环地址且无绕过开关，若用 `ports: ["127.0.0.1:8787:8787"]`，容器内必须 bind `0.0.0.0` 才能被 publish，会被直接拒绝。host 网络让容器内的 `127.0.0.1` 就是宿主回环，该约束既成立又能通过检查。

**排查到的一个真实错误**：compose 里的相对路径是**相对 compose 文件所在目录**解析的，`./data` 会得到 `deploy/data`，与文档写的 `/volume1/docker/tscontroller/data` 不符。已改为 `../data`，并用 `docker compose config` 验证解析结果落到仓库根。

#### 容器化实测（本机 Linux 容器，用 tailscale 桩替身）

没有 NAS，但镜像与整条软件链路可以在本机 Docker 里验证：

| 检查 | 结果 |
| --- | --- |
| `docker build -f deploy/Dockerfile .` | ✅ 成功；镜像内 `node -v` = **v22.23.3** |
| 容器内读宿主 Docker | ✅ `7` 个容器，`unix:/var/run/docker.sock` |
| 容器内调用 tailscale CLI | ✅ 通过桩替身，生成 3 条路由的快照 |
| 快照写入宿主挂载卷 | ✅ `data/public/serve-routes.json` |
| 管理 API / 前端在容器内 | ✅ `/api/system` 返回正确字段、`/` 返回 SPA |
| tailscale 缺失时的降级 | ✅ 只 warn 不崩；管理界面照常可用，日志给出可读原因 |
| `npm test` | **119/119** |
| `docker compose config` | ✅ 解析通过 |

**仍未验证**（已在文档中明确标注）：宿主的**真实** tailscale 二进制能否在镜像内执行、`tailscaled.sock` 的读/写权限。这两项本机是 Windows，无对应物可测。

### 2026-10-16 · 镜像发布链路（ghcr.io）

需求方已能远程访问绿联 DX4600 Pro（管理员权限），问如何打包镜像并推送到 ghcr.io。

#### 新增文件

| 文件 | 说明 |
| --- | --- |
| `.github/workflows/docker-publish.yml` | 两段式：`verify`（`npm ci` → `npm run lint` → `npm test`）→ `build-and-push`。**测试不过就不构建镜像**。触发方式为 tag 推送（`v*`）或手动 `workflow_dispatch`。 |
| `docs/image-publishing.md` | 手动推送与 Actions 两条路径、PAT 权限要求、架构确认、NAS 侧拉取与排查、以及 `network_mode: host` 的提醒 |

#### 工作流里三个刻意的处理

1. **显式把镜像名转小写。** ghcr.io 的镜像路径必须全小写，而 GitHub 的用户名/仓库名可以含大写；直接用 `${{ github.repository }}` 会在 push 时报 `invalid reference format`。用了一个独立步骤 `echo "IMAGE_NAME=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"`（bash 的 `${VAR,,}` 小写展开）消除这个坑。
2. **先跑 verify 再构建。** 推到 registry 的镜像应当是通过验证的——NAS 上拉到坏镜像的排查成本远高于 CI 里多跑一分钟。测试全部使用假实现、不需要 Docker 与 Tailscale，因此在 GitHub runner 上可直接跑。
3. **只建 `linux/amd64`。** 绿联 DX4600 Pro 及同代 NAS 基本是 Intel x86_64。文件中注明了改多架构的方法（`platforms: linux/amd64,linux/arm64`）与代价（arm64 走 QEMU，`npm ci` 明显变慢）。

#### 前置事实核查

- 本机 `docker buildx` = v0.37.1；`docker version` 平台 = `linux/amd64`
- 仓库状态：**57 个文件在索引里、零提交、无 remote**、当前分支 `master`。因此 `image-publishing.md` 明确区分了「手动推送（不需要 Git 远端）」与「Actions（需要先推仓库）」两条路
- 排查确认待提交内容里没有 `.env` / token / 密钥类文件；`data/` 同时被 `.gitignore` 与 `.dockerignore` 排除，不进仓库也不进镜像

#### 验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 0 错 |
| `npm test` | **119/119** |
| `npm run web:build` | 成功 |
| `docker build -f deploy/Dockerfile .` | ✅ 成功；镜像内 `node -v` = v22.23.3 |
| 镜像自检（`ls web/dist`） | ✅ `assets` + `index.html` 都在 |
| workflow YAML 解析（pyyaml） | ✅ `jobs: [verify, build-and-push]`、`triggers: [push, workflow_dispatch]` |

**未验证**：工作流本身未在 GitHub 上真实运行过（需要先把仓库推上去）。

### 2026-10-16 · 首次发布到 GitHub + 公开仓库的个人信息清理

#### 发布

仓库 <https://github.com/xs-www/TsController>（空仓库）→ 首次提交 → `main` 分支。当前 `main` = `d0e29cd`，59 个文件。

- `git remote add origin https://github.com/xs-www/TsController.git`，分支 `master` → `main`
- 提交前核查：待提交内容里无 `.env` / token / 密钥类文件；`data/` 同时被 `.gitignore` 与 `.dockerignore` 排除
- `.gitignore` 补充 `vol/`（与 `.dockerignore` 保持一致）

#### 清理（这是本节的重点）

发布后发现**仓库是公开的**，而文档示例与测试夹具里含真实的 tailnet 名称、tailnet IP 与主机名。运行时设计本身没有问题——tailnet 名称是从 `tailscale status --json` 现读的（`parseTailnetInfo`），TsController **不持久化它**，`data/` 里只有映射（路径 + 端口）。泄露纯粹来自「为了写实测证据链而把真实值抄进了文档和夹具」。

处理方式：13 个文件、约 90 处替换，**改写提交后强推**（`415c65e` → `d0e29cd`），而不是补一个提交把旧值留在历史里。

替换覆盖四类：**主机名**、**tailnet 标识**、**tailnet IPv4/IPv6**、**开发机绝对路径**，分别换成占位值 `my-laptop` / `example-tailnet` / `100.101.102.103`（IPv6 用 `fd7a:115c:a1e0::9999`）/ `D:\apps\TsController`。

> 本文件**刻意不列出被替换的原值**——在公开仓库里记录「原值 → 占位值」的对照表，等于把刚抹掉的东西又写回去。
> 第一次提交这份归档时就是这么干的，随后被自己的残留扫描逮到。归档只描述类别，不复现内容。

注意：`git grep -l <pattern> HEAD` 会给每条路径加 `HEAD:` 前缀，直接拿去 `Resolve-Path` 会全部失败——第一次尝试因此一个字都没改。要用不带 revision 的 `git grep -l` 搜工作区。

**未被强推解决的部分**：旧提交仍可按 SHA 直接访问（GitHub 不立即回收未引用对象）。彻底清除只能删库重建。风险定级**低**——泄漏物是 tailnet 名称（经 Cloudflare DoH 核实公网 NXDOMAIN；注意本机 `Resolve-DnsName -Server 1.1.1.1` 会被 Tailscale 的 DNS 拦截给出假阳性）与 CGNAT 段 IP（不可公网路由），**不含凭据**。决策记在 `todo.md` 2.6。

#### 验证

| 检查 | 结果 |
| --- | --- |
| 残留扫描（tailnet 名/IP/主机名/个人路径/邮箱） | ✅ 0 处 |
| 远端 `main` 抽查（README / function-index / fakes） | ✅ 无个人信息 |
| 中文编码完好性 | ✅（用 .NET `UTF8Encoding($false)` 显式无 BOM 写入） |
| `npm run lint` | 0 错 |
| `npm test` | **119/119**（替换保持了夹具自洽性） |
