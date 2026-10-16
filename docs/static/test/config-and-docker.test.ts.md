# `test/config-and-docker.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

四组**纯函数/纯解析**测试，都不需要 Docker 与 tailscale 真的存在：`loadConfig` 的配置口径与安全校验、Docker 端点解析（管道名归一化、`DOCKER_HOST`、平台默认候选、负缓存）、Docker 数据归一化（端口与容器）、以及 `reviveMapping` 的映射库读取容错与旧格式迁移。

它守的是两类「静默错误」：一类是**安全默认值**——监听地址必须是回环，任何非回环必须在启动前就抛错；另一类是**持久化数据的向前兼容**——映射库是磁盘上的 JSON，写坏一个字段不能让整条记录消失，旧版 `ownedPaths` 必须能被迁移成新的 `ownedRoutes`。

## 依赖 / 引用

- 外部：`vitest` 的 `afterEach` / `describe` / `it` / `expect`；`node:path`。
- 被测：`../src/config.ts` 的 `loadConfig`；`../src/docker/docker-client.ts` 的 `DockerEngineClient` / `normalizePipeName` / `resolveEndpoints`；`../src/docker/docker-service.ts` 的 `normalizeContainer` / `normalizePorts`；`../src/mappings/store.ts` 的 `reviveMapping`。
- 日志：`../src/logger.ts` 的 `silentLogger`。
- 运行入口：`package.json` 的 `npm test`。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `afterEach`（钩子） | `() => void` | `void` | 用 `savedEnv` 快照整体还原 `process.env` | 同步钩子；按**整个对象**替换而不是逐键删除，因此用例里 `delete` 掉的键也会被恢复 |
| `child`（内联桩） | `() => Logger` | `Logger` | 「负缓存」用例里给 `DockerEngineClient` 的 logger 补一个 `child` 方法 | 忽略入参的 scope 名，恒返回 `silentLogger`；用 `as never` 绕过类型检查 |

## 函数详情

### `afterEach`（环境变量还原钩子）

- **签名**：`() => void`
- **入参**：无。
- **出参**：`void`。
- **功能**：模块顶层先 `const savedEnv = { ...process.env }` 记下原始环境，每个用例结束后 `process.env = { ...savedEnv }` 全量替换。
- **边缘条件**：
  - 用例中被 `delete process.env.TSCONTROLLER_HOST` 删掉的键，靠这次全量替换恢复（逐键还原做不到）；
  - 还原是**替换对象**而非原地清空，因此不影响同进程内其它测试文件（vitest 默认按文件隔离）；
  - 该钩子不还原其它全局状态（例如 `path.resolve` 依赖的 cwd）——本文件的相对路径断言都用 `path.resolve(...)` 现算，不依赖写死值。

### `child()`（负缓存用例里的内联 logger 桩）

- **签名**：`() => Logger`
- **入参**：无（真实 `Logger.child(scope: string)` 的入参被忽略）。
- **出参**：`silentLogger` 常量本身。
- **功能**：让 `new DockerEngineClient(..., { ...silentLogger, child: () => silentLogger } as never, {})` 构造得起来——`DockerEngineClient` 内部会调用 `logger.child(...)`，而 `silentLogger.child` 返回自身，这里的桩只是显式再声明一次。
- **边缘条件**：`as never` 说明这个对象**不满足** `Logger` 的完整类型，仅为本用例服务；不要把它当作可复用的替身（真正需要替身时应使用 `test/fakes.ts` 里的实现或 `silentLogger`）。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `TSCONTROLLER_HOST` | 未设置 → `127.0.0.1` | 监听地址。用例覆盖 `0.0.0.0` / `100.101.102.103`（tailnet IP）/ `::` / `192.168.1.10` 必须抛 `禁止暴露在 tailnet`，以及 `127.0.0.1` / `localhost` / `::1` 必须被接受 |
| `TSCONTROLLER_PORT` | 未设置 → 配置默认端口 | `99999` 必须抛含 `TSCONTROLLER_PORT` 的错误（端口范围校验） |
| `TSCONTROLLER_DATA_DIR` | 未设置 → 配置默认数据目录 | 与 `snapshotDir` 的默认锚点联动：`<DATA_DIR>/public` |
| `TSCONTROLLER_SNAPSHOT_DIR` | 未设置 → `<DATA_DIR>/public` | 快照输出目录；NAS 部署用它把快照直接写进共享卷。纯空白字符串（`'   '`）视为未设置并回落 |
| `TSCONTROLLER_SNAPSHOT_INTERVAL_MS` | 未设置 → 配置默认值 | `0` 合法（表示只在启动与收敛后写），`15000` 合法，`'abc'` 必须抛含该变量名的错误 |
| `DOCKER_HOST` | 未设置 → 平台默认候选 | 影响 `resolveEndpoints`：`unix:///var/run/docker.sock` 与 `tcp://127.0.0.1:2375` 两种形式被显式断言 |
| `savedEnv`（模块常量） | 进程启动时的 `process.env` 拷贝 | 还原钩子的唯一数据源 |
| 真实 Docker | **不需要** | 归一化用例直接喂字面量；端点解析用例只探测一个不存在的管道并断言**失败**，不要求 Docker 在跑 |

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `loadConfig` › 默认监听回环地址 | 不设 `TSCONTROLLER_HOST` 时必须是 `127.0.0.1`。**这是「不暴露到 tailnet」的默认值本身**，改了它就是安全回归 |
| `loadConfig` › 拒绝任何非回环监听地址 | `0.0.0.0`、tailnet IP、`::`、私网 IP 四种都要在启动前抛错。`0.0.0.0` 与 `::` 是最常见的「图省事」写法，必须被同一规则挡下 |
| `loadConfig` › 接受回环别名 | `127.0.0.1` / `localhost` / `::1` 都合法，且 `host` 原样保留（不被改写成别的形式）——防止把校验写成白名单后误伤正常配置 |
| `loadConfig` › 端口越界时报错 | 负数/超 65535 的端口必须在配置阶段失败并**在错误信息里点出变量名**，否则用户不知道改哪里 |
| `loadConfig › 路径型配置` › 快照目录默认锚定到 `<DATA_DIR>/public` | 默认路径是相对 `dataDir` 推导的绝对路径；改动 `dataDir` 会影响快照落点 |
| `loadConfig › 路径型配置` › `TSCONTROLLER_SNAPSHOT_DIR` 可覆盖快照目录（NAS 部署要用） | 显式配置必须完全接管默认值（NAS 把快照写进挂载卷就靠它） |
| `loadConfig › 路径型配置` › 空字符串视为未设置，回落到默认值 | 环境变量常见污染形态（`'   '`、空串）必须等价于「未设置」，否则会出现一个名为空白的目录 |
| `loadConfig › 路径型配置` › `snapshotIntervalMs` 可配置，`0` 表示只在启动与收敛后写 | `0` 必须被当成**合法值**而不是「未设置」（这是最容易写成 `||` 的地方）；非数字必须抛错并点出变量名 |
| `Docker 端点解析` › 归一化各种管道写法 | 四种 Windows 管道写法（`npipe://./pipe/x`、`//./pipe/x`、`\\\\.\\pipe\\x`、裸名 `x`）必须归一到同一个管道名——Docker Desktop 与文档里各种写法混用，任一处漏了都会导致「连不上 Docker」 |
| `Docker 端点解析` › 显式配置是权威的，不再追加平台默认候选 | 显式给出端点时结果**只能有一条**（顺序回退会让用户以为配置没生效，实际是回退到了别的 daemon） |
| `Docker 端点解析` › 未配置时才使用平台默认候选（Windows 上至少两个命名管道） | 未配置时必须有 ≥2 个候选，且只可能是 `npipe`/`unix` 两类 —— 覆盖 Docker Desktop 与 Docker Engine 两种安装形态 |
| `Docker 端点解析` › 无法连接时抛出可读错误，且失败结果被负缓存 | 两个契约：错误信息含 `无法连接 Docker Engine`（可读）；**第二次探测必须显著快于首次**（负缓存生效，否则每次 UI 刷新都要等一次超时） |
| `Docker 端点解析` › 解析 `DOCKER_HOST` 的 `unix` 与 `tcp` 形式 | 两个字段必须完整：`unix` → `socketPath`、`tcp` → `host` + `port`。这与 Linux/NAS 部署直接相关 |
| `Docker 端点解析` › 未连接时 `endpoint` 提示未连接 | 尚未连上任何端点时 `endpoint()` 必须含「未连接」——界面顶部「数据源」一栏与启动日志都读它 |
| `Docker 数据归一化` › 丢弃未发布的端口 | 没有 `PublicPort` 的记录必须被丢弃（容器内端口在宿主机上不可达）。这是「界面显示的端口一定可达」的根据 |
| `Docker 数据归一化` › 保留 IPv4/IPv6 双记录以判断暴露面 | 同一 `hostPort` 的 `0.0.0.0` 与 `::` 两条都要留：合成一条会让「容器直接监听全部网卡」这个黄色警示失去判据 |
| `Docker 数据归一化` › 归一化容器主体 | 名字去前导 `/`、compose 项目/服务名从 labels 取、`Created` 秒 → 毫秒（`1_700_000_000` → `1_700_000_000_000`）、端口经同一套归一化。任一处偏移都会让界面显示错误的镜像归属或 1970 年的时间 |
| `reviveMapping` › 丢弃非法条目 | `null`、路径不以 `/` 开头、宿主端口为 `0`、缺 `id` —— 四种脏数据都必须返回 `null`（而不是抛错或产出半条记录）。存储层读取时不能让一条坏记录带崩整个进程 |
| `reviveMapping` › 保留合法条目并补默认值 | 路径归一化（`/ok/` → `/ok`）、`servePort` 补默认、`enabled` 默认 `true`、`note` / `ownedRoutes` 补空、字符串端口 `'8080'` 转数字、`targetPath: '/'` 归一化为 `''` |
| `reviveMapping` › 缺少 `servePort` 时补默认端口 | 缺 `servePort` → 用调用方给的默认端口；**已有合法 `servePort` 优先于默认值**；非法值（`0`）回落默认值而**不丢弃整条记录**——这是旧数据能平滑升级的关键 |
| `reviveMapping` › 迁移旧格式的 `ownedPaths`（无端口维度）到 `ownedRoutes` | 旧版只有路径列表：迁移时必须用该条映射自己的 `servePort` 补齐三元组，否则老用户的归属记录会指向 443 |
| `reviveMapping` › 新格式 `ownedRoutes` 优先于旧的 `ownedPaths`，并丢弃非法项 | 两者并存时以新格式为准（`ownedPaths` 整段被忽略）；端口非法 → 回落默认端口**保留路径**，路径非法 → 丢弃该条。逐项容错而非整段放弃，守住「一条坏归属不会连带清掉其它归属」 |

## 待办与隐患

- [ ] 负缓存用例用**墙钟时间**做断言（`Date.now() - cached < max(firstCost, 50)`），在极慢的 CI 或负载抖动下存在偶发失败风险。它守的是真实契约（缓存命中必须快一个数量级），但实现方式不是确定性的。
- [ ] 「无法连接」用例探测的是**一个不存在的命名管道**，因此在 Linux/macOS 上走的是另一条错误路径；脚本的断言只匹配错误文案前缀，未验证平台差异。
- [ ] 本文件不覆盖 `DockerEngineClient` 的**成功路径**（HTTP 请求、`/version` 响应解析、`DockerApiError` 映射），那些需要真实 daemon 或 HTTP 桩。
- [ ] `loadConfig` 的 `dockerPipe` / `tailscaleBin` / `autoUnexpose` 等字段没有用例（本文件只覆盖 host / port / dataDir / snapshotDir / snapshotIntervalMs 五项）。
