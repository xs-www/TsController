# `scripts/verify-live.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

真实环境端到端验证：与单测不同，它会**真的读写本机的 Docker 与 tailscale**。流程是「读现状 → 建一条临时映射 `/__tscontroller-selftest` → 经 `https://<机器名>.<tailnet>.ts.net/...` 真实请求一次 → 删映射 → 逐条比对运行前的既有路由是否原样保留」。

副作用边界很明确，也因此这个脚本必须谨慎跑：它会往真实 tailscale serve 里**增删一条路由**、往真实映射库（`data/verify/mappings.json`）写入再删除一条记录，并对 ts.net 域名发出**一次对外 HTTPS 请求**。它不启管理 HTTP 服务（`createRuntime` 只装配 Fastify 实例，不 `listen`），不修改任何 Docker 状态。

> **已声明的未验证范围**：Service 那一轮（`--service`）尚未在真实 tagged 设备上跑过——本机 `Self.Tags` 为空，且当时 tailnet 里没有已 tagged 的对端。本文件末尾「待办与隐患」第 1 条记了这条事实与补齐方式。

## 依赖 / 引用

- 外部：无第三方包（只用全局 `fetch` / `AbortController` / `setTimeout` / `process`）。
- 同项目文件：`../src/runtime.ts` 的 `createRuntime`（装配真实 Docker + tailscale 客户端 + 文件映射库/审计/快照）；`../src/domain/route-path.ts` 的 `buildServiceDnsName`、`formatRouteRef`；`../src/mappings/mapping-service.ts` 的 `MappingService`（仅类型标注）。
- 被消费的数据结构：`gateway.tailnet()` / `gateway.snapshot()` 返回的 `TailnetInfo` / `ServeSnapshot`，以及 `containers.listContainers()` 的 `ContainerInfo[]`。
- 调用方：`package.json` 的 `npm run verify:live`（即 `node scripts/verify-live.ts`）；`README.md` §3 与 §12 记录了两种用法。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `check` | `(step: string, ok: boolean, detail?: string = '') => boolean` | `boolean` | 记录一条断言并即时打印 `[PASS]`/`[FAIL]` | 返回 `ok`，但调用处基本忽略返回值（汇总在最后统一算）；`detail` 为空时不打印破折号 |
| `arg` | `(name: string, fallback: string) => string` | `string` | 读 `--name value` 形式的 CLI 参数 | 只认「`--name` 后面紧跟一个非空值」；缺失或值为空串时回落 `fallback` |
| `originOf` | `(nodeDns: string, magicDnsSuffix: string \| null, servePort: number, service: string \| null) => string` | `string` | 拼出对外的完整 origin（含端口规则） | `service` 非空时用 Service 的 MagicDNS 名；主机名最终为空则抛 `无法确定对外主机名` |
| `requestThroughTailnet` | `(url: string) => Promise<{ status: number; body: string }>` | `Promise<{status, body}>` | 经 tailnet 真实请求一次，15 秒超时 | 超时 → `AbortError` 冒泡（由调用方转成一条 FAIL）；`redirect: 'manual'`，不跟随跳转 |
| `main` | `() => Promise<void>` | `Promise<void>` | 读现状 → 选目标端口 → 节点级一轮 → 可选 Service 一轮 → 汇总退出 | tailnet 基址或可用目标端口缺失时**提前 `exit(1)`**；参数被夹带时静默忽略 |
| `round`（`main` 内局部） | `(options: { label: string; service: string \| null; hostPort: number; remoteHost?: string; servePort: number \| null }) => Promise<void>` | `Promise<void>` | 跑一轮完整的「建 → 请求 → 删 → 比对」，节点级与 Service 级共用 | 任何一步失败都继续走完并记账；`finally` 里做兜底摘除 |
| `routeKey`（`main` 内局部） | `(r: { service: string \| null; servePort: number; path: string }) => string` | `string` | 把路由位置压成 `Service\|端口\|路径` 字符串用于集合比对 | 节点级用字面量 `node` 占位（与 `svc:*` 不冲突）；**不排序**，排序由调用方 `.sort()` 负责 |
| 顶层 `catch`（匿名） | `(err: unknown) => void` | `void` | `main()` 的失败出口：打印 stack（若有）后 `process.exit(1)` | 用 `err instanceof Error ? err.stack ?? err.message : String(err)` 归一，非 `Error` 抛出物也能读 |

## 函数详情

### `check(step, ok, detail?)`

- **签名**：`(step: string, ok: boolean, detail = '') => boolean`
- **入参**：
  - `step`（`string`，必选）：断言名，约定带段前缀（如 `[节点级] …`、`[Service svc:dsh] …`），便于在输出里分辨是哪一轮。
  - `ok`（`boolean`，必选）：断言结果。
  - `detail`（`string`，可选，默认 `''`）：附加证据（状态码、`upserted` 列表、错误信息等）。
- **出参**：`boolean`，即 `ok` 原样返回。
- **功能**：把 `{ step, ok, detail }` 推入模块级 `results` 数组，同时立刻向 **stdout** 打印一行 `[PASS]` / `[FAIL]`。最终统计的分子分母都来自 `results`。
- **边缘条件**：
  - **只有真正执行过的断言才进 `results`**：被跳过的段落（Service 轮）不调用 `check`，因此不计入分母——汇总里的 `N/N` 天然排除了跳过项，不会把「没验证」粉饰成「已验证」；
  - 返回值在 `main` 中未被用于控制流（例如第 1 条 `check('读取 tailnet 身份', ...)` 之后紧跟着 `if (!tailnet.baseUrl) process.exit(1)`，判据是数据本身而不是断言结果）。

### `arg(name, fallback)`

- **签名**：`(name: string, fallback: string) => string`
- **入参**：`name`（`string`，必选）：不带 `--` 的参数名；`fallback`（`string`，必选）：缺失时的默认值。
- **出参**：`string`。
- **功能**：`process.argv.indexOf('--' + name)` 定位，取下一个非空元素。
- **边缘条件**：
  - `--name` 出现在末尾（没有下一个元素）→ 回落 `fallback`；
  - `--name ''`（下一个元素为空串）→ 同样回落 `fallback`，因此**无法显式传空值**；
  - 不支持 `--name=value` 形式（会被当成一个不认识的 argv 项忽略）；
  - 重复传入时取**第一个**匹配项（`indexOf`）。

### `originOf(nodeDns, magicDnsSuffix, servePort, service)`

- **签名**：`(nodeDns: string, magicDnsSuffix: string | null, servePort: number, service: string | null) => string`
- **入参**：`nodeDns`（`string`，必选）：节点 DNS 名（调用处传 `tailnet.dnsName!`）；`magicDnsSuffix`（`string | null`，必选，可为 `null`）：MagicDNS 后缀；`servePort`（`number`，必选）：对外端口；`service`（`string | null`，必选）：Service 名或 `null`（节点级）。
- **出参**：`string`，形如 `https://<host>` 或 `https://<host>:<端口>`。
- **功能**：按 `(service, 端口)` 决定对外主机名与端口写法，与生产代码 `buildBaseUrl` 的规则一致：Service 级走 `buildServiceDnsName(service, magicDnsSuffix, nodeDns)`，节点级直接用 `nodeDns`；443 省略端口。
- **边缘条件**：
  - `buildServiceDnsName` 返回 `null`（没有 MagicDNS 后缀且无法从节点 DNS 名推导）→ 抛 `Error('无法确定对外主机名')`，由 `round` 的 `try` 冒泡到 `finally` 兜底清理；
  - 端口一律不校验：传 `0` 会得到 `https://host:0`，请求必然失败（记为一条 FAIL 而不是提前退出）。

### `requestThroughTailnet(url)`

- **签名**：`(url: string) => Promise<{ status: number; body: string }>`
- **入参**：`url`（`string`，必选）：要请求的完整地址（`origin + testPath`）。
- **出参**：`Promise<{ status: number; body: string }>`；`body` 是完整响应文本（只用于报告长度与失败片段）。
- **功能**：`AbortController` + `setTimeout(…, 15000)`，`fetch(url, { signal, redirect: 'manual' })`，`finally` 里 `clearTimeout`。
- **边缘条件**：
  - 15 秒未响应 → `abort()` 触发，`fetch` 抛 `AbortError`（**不**被本函数捕获，由 `round` 转成一条 FAIL 并附上 `err.message`）；
  - `redirect: 'manual'`：不自动跟随 3xx，状态码原样返回（对端若做跳转会得到 3xx 而不是最终页）；
  - 网络层错误（DNS 解析失败、TLS 证书不匹配、连接被拒）同样冒泡，**不会**被当成 HTTP 状态码；
  - `clearTimeout` 在 `finally` 中，因此成功路径也不会留下定时器（否则 Node 进程会多挂 15 秒）。

### `main()`

- **签名**：`() => Promise<void>`
- **入参**：无（参数经 `arg()` 从 `process.argv` 读取）。
- **出参**：`Promise<void>`；正常路径结尾显式 `process.exit(0)` 或 `process.exit(1)`。
- **功能**，按源码顺序：
  1. 解析参数，并以 `config: { dataDir: 'data/verify', port: 8788, host: '127.0.0.1' }` 调 `createRuntime()` —— 注意 `8788` **只是配置值，本脚本不会 listen**；
  2. 读现状：`gateway.tailnet()`、`gateway.snapshot()`、`containers.listContainers()`；把既有路由压成 `beforeKeys`（`routeKey` + `sort()`），打印容器端口表、既有路由、已声明 HTTPS 端口、本节点 tag、以及已有的 Service 列表；
  3. 选目标端口（见下）；
  4. **节点级一轮**（始终执行）：`round({ label: '节点级', service: null, hostPort, servePort })`；
  5. **Service 一轮**（仅当 `--service` 非空且前提满足）；
  6. 汇总：`results` 里有 FAIL 就逐条打印并 `exit(1)`，否则打印全部通过并 `exit(0)`。
- **目标端口的选法**（第 3 步）：候选 = 「`state === 'running'` 且有已发布端口」的容器里 `protocol === 'tcp'` 的端口。给了 `--port` 就按 `hostPort` 精确匹配；没给则**优先取 `hostIp === '127.0.0.1'`** 的那条，再退回「第一个候选」。
- **边缘条件**：
  - `tailnet.baseUrl` 为空 → 打印 `无法确定 tailnet 基址，终止验证。` 并 `exit(1)`（**提前终止，不是跳过**，因为节点级那一轮同样无从下手）；
  - 找不到任何可用 TCP 目标端口 → 打印 `找不到可用的 TCP 目标端口，终止验证。` 并 `exit(1)`（同理：没有目标就无法验证）；
  - `--port` 指定的端口不在候选里（容器未运行、端口未发布、或用了非 TCP 协议）→ 走上面同一条终止路径，输出里**不会**明确说「你指定的端口没找到」；
  - 显式 `--port` 可能选中一个只发布在非回环 IP 上的端口，而映射的代理地址恒为 `http://127.0.0.1:<hostPort>`（节点级 `remoteHost` 为空即回环）——此时真实请求可能失败；自动挑选之所以优先 `127.0.0.1` 就是为了避开这种情况；
  - `dataDir: 'data/verify'` 会被真实创建与写入（映射库、审计、快照），清理交给 `npm run clean:verify`；
  - 本脚本**不启动**管理 HTTP 服务，端口 `8788` 全程无人监听。

### `round(options)`

- **签名**：`(options: { label: string; service: string | null; hostPort: number; remoteHost?: string; servePort: number | null }) => Promise<void>`
- **入参**：
  - `label`（`string`，必选）：用于断言名与分隔标题（`节点级` / `Service svc:dsh`）。
  - `service`（`string | null`，必选）：`null` = 节点级；非空 = Service 级（原样透传给 `MappingService.create`，由服务层归一化成 `svc:<名>`）。
  - `hostPort`（`number`，必选）：映射要指向的宿主机端口（来自上面选定的候选）。
  - `remoteHost`（`string`，可选）：Service 级代理的目标主机。**只在 `!== undefined` 时才写进 `create()` 入参**，因此省略与显式传空串语义不同（空串会被服务层的 `normalizeRemoteHost` 归一回环）。
  - `servePort`（`number | null`，必选）：`null` = 不指定，用服务默认端口；非 `null` 时作为 `create()` 的 `servePort`。
- **出参**：`Promise<void>`，不返回断言结果（结果全在 `results` 里）。
- **功能**（**节点级与 Service 级共用同一段代码**，这是刻意的：两条路径的差异只允许体现在入参上，任何只在其中一轮里修好的 bug 都会在另一轮暴露）：
  1. `mappingService.create({ path: testPath, hostPort, service, [remoteHost], [servePort], note: '自检临时映射' })`；记下 `createdId` 与 `effectivePort = created.mapping.servePort`；断言「创建映射并写入 serve」——要求 `upserted` 里存在 `(service, effectivePort, testPath)` 且 `errors` 为空；
  2. 若 `status === 'awaiting-approval'`，额外提示「该 Service host 尚未被承认（等待管理员审批）；下面的真实请求预期会失败，这是预期状态」；
  3. 重新 `gateway.snapshot()`，断言该路由已出现在 serve 里且 `handler.kind === 'proxy'`；
  4. 用 `originOf(...)` 拼 URL，真实请求一次；判定 `status > 0 && status < 500` 为通过（`1xx`–`4xx` 都算「链路通了」，只有 `5xx` 与网络异常记 FAIL），失败时打印响应前 200 字节；
  5. `mappingService.remove(createdId)` 并立刻 `createdId = null`，断言 `removed` 里有这条路由；再断言 serve 里该路由已消失；
  6. 断言 `afterKeys`（删除后的全部路由键，排序后）与运行前的 `beforeKeys` **逐字符串相等**——「既有路由原样保留」。
- **边缘条件**：
  - `effectivePort` 初值是 `options.servePort ?? 443`，创建成功后**被真实返回的 `mapping.servePort` 覆盖**，所以断言用的是实际生效端口而不是入参；
  - 第 5 步成功后立即把 `createdId = null`，是为了让 `finally` 的兜底只处理「还没删掉」的情况，避免重复摘除；
  - **`finally` 的兜底摘除**（两段）：① `createdId` 仍非空 → 再 `mappingService.remove(createdId)` 一次，异常被吞掉（注释说明「下面的兜底会再摘一次」）；② 重新 `gateway.snapshot()`，筛出所有 `path === testPath` 的残留路由，**直接调 `gateway.removeRoute(servePort, path, service)` 绕过映射库**逐条摘除，成功打印 `[清理] 兜底摘除残留路由 …`，失败打印 `[清理失败] …` 而不抛错。这一段是「映射库被写坏或中途异常时，也不会在真实 serve 里留下垃圾路由」的保证；
  - 第 ② 段的 Service 过滤条件是 `options.service === null ? true : (r.service ?? null) === options.service`：**节点级那一轮会摘掉所有同名路径的残留（含任何 Service）**，Service 轮只摘自己命名空间下的；
  - `round()` 内部引用的是 `main` 中在它**之后**才声明的 `const mappingService`（`const` 的暂时性死区），因此 `round()` 只能在第 3 步之后被调用——先调会抛 `ReferenceError`；
  - 一轮里的任何断言失败都不中断后续步骤：脚本会跑完全部 check 再统一汇总，因此一次运行能看到全部问题。

### `routeKey(r)`

- **签名**：`(r: { service: string | null; servePort: number; path: string }) => string`
- **入参**：`r`（路由位置，必选）：只读 `service` / `servePort` / `path` 三个字段（结构类型，不要求完整 `ServeRoute`）。
- **出参**：`string`，形如 `node:443:/` 或 `svc:dsh:443:/`。
- **功能**：把路由身份压成可 `JSON.stringify` 比较的字符串，用于「运行前 / 运行后路由集合完全一致」这条最强断言（比逐条对象比较更严格，也更易读）。
- **边缘条件**：节点级用字面量 `node` 占位（与 `svc:*` 命名空间不冲突，与 `serveRouteKey` 用 `-` 占位是不同实现、同样目的）；**本身不排序**——调用方必须 `.sort()` 后再比较，否则 serve 返回顺序一变就会误报。

### 顶层 `main().catch(...)` 处理器

- **签名**：`(err: unknown) => void`
- **入参**：`err`（`unknown`）：归一为 `Error.stack ?? Error.message`，非 `Error` 则 `String(err)`。
- **出参**：`void`（终止进程，退出码 1）。
- **功能**：打印 `验证脚本异常：<stack>` 到 **stderr** 并 `process.exit(1)`。这是「脚本自己崩了」（而不是某条断言失败）的出口——栈信息在这里有意义，因为崩的是脚本逻辑/环境，不是被验证的行为。
- **边缘条件**：与断言失败共用退出码 1，因此 CI 里只能靠输出区分「有 FAIL」和「脚本异常」；`finally` 里的清理**已经**执行完（异常从 `round` 冒泡前会先跑 `finally`），但若异常发生在节点级 `round` 之外（例如 `createRuntime` 阶段），则不会有任何清理动作——那时也还没有写入任何路由。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--port <宿主端口>` | `''`（自动挑选） | 指定映射要指向的宿主机端口。必须能在「运行中容器已发布的 TCP 端口」里找到，否则脚本打印「找不到可用的 TCP 目标端口」并 `exit(1)`。不传时优先选 `hostIp === '127.0.0.1'` 的那条，再退回第一个候选。**语义是宿主机端口，不是容器内端口** |
| `--path <挂载路径>` | `/__tscontroller-selftest` | 自检路由的挂载路径。改它只影响「临时路由叫什么」，不影响清理（清理复用同一变量）；不要用生产路径，否则删除阶段会摘掉真实路由 |
| `--serve-port <对外端口>` | `''` → `null`（用服务默认端口，通常 443） | 指定这一轮挂在哪个对外端口上。传 `null` 语义时 `create()` 不写 `servePort`，服务层用配置默认值；有效端口以**创建结果返回的 `mapping.servePort`** 为准并用于全部后续断言与清理 |
| `--service <Service 名>` | `''`（不跑 Service 轮） | 追加一轮 Service 级验证。该 Service 必须**已在本节点的 serve 配置里存在**且至少有一个端点端口，否则**跳过**（不是失败）。名字按 `toLowerCase()` 与 `before.services[].name` **字面比对**，快照里的名字带 `svc:` 前缀，因此要传 `svc:dsh` 而非 `dsh`——传裸名会因找不到而被判为「本节点上没有该 Service 的配置」整个跳过 |
| `--remote-host <主机名>` | `tailnet.dnsName` | 仅 Service 轮使用：Service host 通常不在本机，代理目标要写成节点自己的 tailnet DNS 名，由 service host 反向代理回来。取值为空串时不写进 `create()` 入参 |
| 位置参数 / 未知参数 | 忽略 | `arg()` 只按 `--name value` 精确查找，不做校验也不报错 |
| `config.dataDir`（写死） | `data/verify` | 真实映射库与审计的落点，由 `npm run clean:verify` 清理 |
| `config.port`（写死） | `8788` | 仅作为配置值；本脚本不 `listen`，因此该端口无人监听 |
| 真实环境前提 | — | 必须能读到 Docker 容器清单、`tailscale serve` 配置与 tailnet 身份；节点级一轮要求至少有一个运行中且已发布 TCP 端口的容器 |
| 退出码 | `0` / `1` | 全部通过 `0`；有 FAIL 或提前终止或脚本异常均 `1` |

## 待办与隐患

- [ ] **Service 那一轮尚未在真实 tagged 设备上验证过。** 本机 `Self.Tags` 为空、tailnet 里也没有已 tagged 的对端，所以代码路径（含 `--remote-host` 远端目标与 `awaiting-approval` 提示）只有「假网关单测 + 真实 CLI 对无 tag 节点的拒绝」两类间接证据。补齐方式：在 NAS 上打 tag，然后 `node scripts/verify-live.ts --service svc:<名字> --remote-host <本机 DNS 名>`（`docs/static/history.md` 的归档条目与 `todo.md` 第 1 项记录了同一事实）。
- [ ] 跳过与失败在源码里是两种出口，但**提前终止**（无 tailnet 基址 / 无目标端口）复用退出码 1，与「有 FAIL」不可区分；CI 里必须读输出文本。
- [ ] `--port` 指定的端口不在候选集时，错误信息只说「找不到可用的 TCP 目标端口」，没有回显用户传的值与候选清单。
- [ ] 脚本对节点的真实 serve 配置有**短暂的写入窗口**（创建到删除之间）。中途被 Ctrl-C 强杀时，`finally` 可能来不及执行——此时会残留 `/__tscontroller-selftest` 路由，需要手工或再跑一次脚本清除。
- [ ] 断言「通过 ts.net 访问到容器」只要求 `status < 500`，因此一个 404/403 也算通过；它的目标是「链路通了」而不是「内容正确」，不要把它当成端到端功能验证。
- [ ] 脚本不校验它删掉的路由是不是**自己**创建的（同一个 `--port`/`--path` 若被另一次运行占用，两轮会互相摘除）。单人本机使用没问题，不适合并行跑。
