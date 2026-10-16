# `web/src/components/ExternalRoutesPanel.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

「未托管路由」面板：列出 serve 中已存在、但 TsController 还不认识的路由，并允许逐条接管进映射库。核心风险点是**「从 Service 配置读出的路由其 handler 树是有损的」**——目标路径读不回来，接管后第一次「应用」会按映射库重写这条路由，因此这条限制被显式写在表格上（而不只是 tooltip）。

## 依赖 / 引用

- 外部模块：`react`（`useState` / `type JSX`）。
- 同项目文件：
  - `../api`：类型 `ExternalRoute` / `ImportResponse` / `RouteRef`；
  - `./MappingPanel`：`type ApiResult`（写操作结果外壳，见 `web/src/components/MappingPanel.tsx.md`）；
  - `../utils`：`formatRouteLabel`（路由标签）、`formatTarget`（代理目标人类可读形式）、`serviceShortName`（去掉 `svc:` 前缀）；
  - 样式类来自 `../styles.css`（`.simple-table` / `.pill-*` / `.badge-calm` / `.lossy-row` / `.col-actions`）。
- 被引用：`web/src/App.tsx` 第 35、398-404 行渲染 `<ExternalRoutesPanel routes={mappings?.externalRoutes ?? []} loading={busy} busy={busy} importRoutes={importRoutes} onNotify={notify} />`。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `routeKey` | `(r: { service: string \| null; servePort: number; path: string }) => string` | `string` | 路由位置的稳定键（Service + 端口 + 路径） | `service` 为 `null` 时用 `-` 占位；**路径不做大小写折叠**（与 `App` 的 `managedKeys` 口径不同） |
| `hostText` | `(r: ExternalRoute) => string` | `string` | 代理目标主机的可读文本 | `host === null` 时按 `proxy` 是否为空区分「（非代理 handler）」/「（主机未知）」 |
| `takeover` | `(route: ExternalRoute) => void` | `void` | 单条接管：置 pending → 调 `importRoutes` → 按 `imported`/`skipped` 反馈 | 失败分支**不发提示**（依赖 `App` 的错误 toast）；`finally` 必复位 pending |
| `ExternalRoutesPanel` | `(props: ExternalRoutesPanelProps) => JSX.Element` | `JSX.Element` | 渲染未托管路由表与接管按钮、有损说明行 | 有路由在途时**禁用全部**接管按钮；`proxy === null` 的行不可接管 |

## 函数详情

### `routeKey(r)`

- **签名**：`(r: { service: string | null; servePort: number; path: string }) => string`
- **入参**：`r`（含 `service` / `servePort` / `path` 的对象，必选）：只读取这三个字段，因此 `ExternalRoute` 与 `RouteRef` 都能直接传入。
- **出参**：`string`，形如 `svc:dsh|8443|/worldforge` 或 `-|443|/worldforge`。
- **功能**：同时用于「接管中」状态判定与 React key——接管请求是异步的，需要把 pending 精确绑回某一行。
- **边缘条件**：
  - `service` 为 `null` 时用 `-` 占位（`-` 不是合法 Service 名，因此不会与真实 Service 冲突）；
  - **路径大小写敏感**：`/App` 与 `/app` 得到不同的 key。这与 `App.tsx` 的 `managedKeys`（`path.toLowerCase()`）不同，两处对「同一路由位置」的判定口径不一致；
  - 该键**不含 `host` / `handler`**：同一 `(service, 端口, 路径)` 在 serve 中只可能有一条 handler，这是后端契约。

### `hostText(r)`

- **签名**：`(r: ExternalRoute) => string`
- **入参**：`r`（`ExternalRoute`，必选）。
- **出参**：`string`——`r.host`，或两种说明性占位文本。
- **功能**：把「代理目标主机」列渲染成人类可读的一格；`host` 未知时不显示空白（空白会被误读为「本机」）。
- **边缘条件**：
  - `host === null` 且 `proxy === null` → `'（非代理 handler）'`：这是 `file` / `text` / `other` 类 handler，没有主机概念，也正是「不可接管」的判据；
  - `host === null` 但 `proxy !== null` → `'（主机未知）'`：是代理 handler 却解析不出主机，同样是不可接管的信号（按钮由 `proxy === null` 判定，因此这种行仍可点击，接管是否成功由后端决定）；
  - 返回值直接作为单元格文本，不做转义处理（React 默认转义）。

### `takeover(route)`

- **签名**：`(route: ExternalRoute) => void`
- **入参**：`route`（`ExternalRoute`，必选）：被接管的那一行。
- **出参**：`void`（内部 `void importRoutes(...)` 显式忽略 promise）。
- **功能**：`setPending(routeKey(route))` 后调用 `importRoutes([{ service: route.service, servePort: route.servePort, path: route.path }])`；成功后若 `imported` 非空，用 `formatRouteLabel` 拼出全部被接管路由并追加第一条的目标地址（`formatTarget(first.target)` + `first.target.targetPath`），记 `success` toast「已接管路由」；若 `imported` 为空（全部被 `skipped`），记 `warn` toast「未能接管该路由」，正文是各条 `skipped` 的 `路径：原因`（用「；」连接，全空时回落「原因未知」）；`finally` 里 `setPending(null)`。
- **边缘条件**：
  - **路由身份是三元组 `(service, servePort, path)`**：`service` 不能漏（`null` 也要显式传），否则会去接管另一条同名路径——节点级与 Service 级是两个命名空间；
  - 只传一条路由，因此 `imported` 至多一条；`ok[0]` 仍与 `undefined` 显式比较（让索引访问在类型层面安全），并在 `first === undefined` 时把后缀置为空串；
  - **目标地址后缀只取第一条**：`ok.map(...).join(', ')` 会列出全部标签，但 `→ 目标` 只跟随第一条，多条时该后缀的归属会含糊（当前界面按单条接管设计，不会出现多条）；
  - `formatTarget(first.target)` 只给出「主机:端口」，**不含目标路径**，所以后面手动追加 `first.target.targetPath`（空串时后缀自然消失）；
  - **失败（`result.data === undefined`）时本函数不发任何提示**：错误 toast 已由 `App` 的 `mutate` → `notifyError` 弹出（标题「接管路由失败」）；这也意味着若 `mutate` 返回 `code: 'aborted'`，界面会完全静默，用户只看到按钮从「接管中…」恢复成「接管」；
  - `finally` 保证 `pending` 一定复位，包括 `importRoutes` 抛出（但 `mutate` 不抛，只返回 `{code, message}`）；
  - 请求进行中若列表刷新导致该行消失，`setPending(null)` 仍会执行（无副作用）。

### `ExternalRoutesPanel({ routes, loading, busy, importRoutes, onNotify })`

- **签名**：`(props: ExternalRoutesPanelProps) => JSX.Element`
- **入参**：
  - `routes`（`ExternalRoute[]`，必选）：`App` 传 `mappings?.externalRoutes ?? []`；
  - `loading`（`boolean`，必选）：仅用于空表时的文案二选一；
  - `busy`（`boolean`，必选）：全局加载态，与 `pending !== null` 一起禁用按钮；
  - `importRoutes`（`(routes?: RouteRef[]) => Promise<ApiResult<ImportResponse>>`，必选）：写操作入口；
  - `onNotify`（`(level: 'info' | 'success' | 'warn' | 'error', title: string, message?: string) => void`，必选）：反馈出口。
- **出参**：`JSX.Element`，一个 `.panel` 区块。
- **功能**：`lossy = routes.filter((r) => r.fromServiceConfig).length` 统计有损条目；表头显示「共 N 条 · 这些是 serve 中已存在、但 TsController 还不认识的路由」，`lossy > 0` 时再追加「其中 N 条来自 Service 配置（目标路径不可恢复）」。表格列：Service、端口、路径、代理目标主机、代理目标、handler 类型、操作。每行有一个接管按钮；`fromServiceConfig` 的行额外追加一行 `.lossy-row` 完整说明。
- **边缘条件**：
  - 空表文案二选一：`loading` 为真时「正在读取 serve 配置…」，否则「没有未托管的路由。serve 中的每条路径都由 TsController 管理，或当前没有任何路由。」；
  - 接管按钮 `disabled = busy || pending !== null || r.proxy === null`：**只要有任意一条在途，全部接管按钮都被禁用**（单飞，避免并发 import 造成映射库竞争）；`r.proxy === null`（非代理 handler）永远不可接管，title 说明「非本机代理路由无法接管」；
  - 按钮文案按 `pending === routeKey(r)` 切换「接管中…」/「接管」，因此需要 `routeKey` 的大小写敏感口径与行 key 完全一致；
  - `fromServiceConfig` 的行会渲染第二行 `.lossy-row`，`colSpan={7}` 与列数对应；该行**不是 tooltip 隐藏内容**：因为「接管后第一次应用会按映射库重写这条路由」是真实的语义变化，必须让用户先看到；
  - Service 列的 pill：`service === null` → 灰色「节点级」（title「节点级路由」）；否则蓝色 pill，显示 `serviceShortName(r.service)`，title 优先用 `r.serviceInfo?.dnsName ?? r.service`（显示短名、悬停看 MagicDNS 全名）；
  - handler 类型列显示 `r.kind`，`hostPort` 非 `null` 时追加 `:端口`（`hostPort === null` 时不显示冒号）；
  - 代理列为空时显示灰色「（非代理 handler）」，与 `hostText` 的占位文案语义一致；
  - 主行 key 是 `` `${routeKey(r)}|${r.proxy ?? r.kind}` ``——同一位置若 handler 变化会重建行；有损行 key 是 `` `${routeKey(r)}:lossy` ``。若后端返回两条 `(service, 端口, 路径)` 完全相同的记录，会出现重复 key（依赖后端已按位置去重）；
  - 面板内**没有整批接管入口**：`importRoutes` 支持省略参数接管全部，但界面只暴露单条接管。

## Props / 内部状态

### `ExternalRoutesPanelProps`（导出接口，全部必填，无默认值）

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `routes` | `ExternalRoute[]` | 未托管路由 | 无默认；`App` 传 `mappings?.externalRoutes ?? []`，映射未加载时为空数组（会显示「没有未托管的路由」而非加载中，除非 `loading` 为真） |
| `loading` | `boolean` | 读取中 | 无默认；`App` 传全局 `busy` |
| `busy` | `boolean` | 全局加载态 | 无默认；禁用全部接管按钮 |
| `importRoutes` | `(routes?: RouteRef[]) => Promise<ApiResult<ImportResponse>>` | 接管写操作 | 无默认；省略参数 = 接管全部 |
| `onNotify` | `(level, title, message?) => void` | 反馈出口 | 无默认；不携带错误码，失败提示由 `App` 的 `mutate` 负责 |

### `ExternalRoute` 中被本面板读取的字段（类型来自 `../api`）

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `service` | `string \| null` | 所属 Service | `null` = 节点级；参与 `routeKey` 与请求体 |
| `servePort` | `number` | 对外 HTTPS 端口 | 参与 `routeKey` 与请求体 |
| `path` | `string` | 路由路径 | 参与 `routeKey` 与请求体；大小写敏感 |
| `proxy` | `string \| null` | 代理目标地址原文 | `null` = 非代理 handler，不可接管 |
| `hostPort` | `number \| null` | 目标端口 | `null` 时不显示端口后缀 |
| `host` | `string \| null` | 代理目标主机 | `null` 由 `hostText` 转成占位文本 |
| `kind` | `string` | handler 类型 | 直接以灰色 pill 展示 |
| `fromServiceConfig` | `boolean` | 是否从 Tailscale Service 配置读出（handler 树有损） | `true` 时追加说明行与「服务配置」徽标 |
| `serviceInfo` | `ServiceInfo \| null` | Service 状态 | 仅用于 pill 的 `title`（`dnsName`） |

### 组件内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `pending` | `string \| null` | 正在接管的路由 key | `null`；非 `null` 时禁用全部按钮，`finally` 必复位 |

### 模块级常量

| 名称 | 类型 | 含义 | 边界 |
| --- | --- | --- | --- |
| `SERVICE_CONFIG_LOSSY_NOTE` | `string`（常量） | 「从 Service 配置读出的 handler 树有损、目标路径无法恢复」的完整说明 | 同时用作徽标 `title` 与说明行正文；说明中明确「接管会以空目标路径纳入管理，第一次应用会按映射库重写它——若原本带目标路径，请接管后在编辑行里补回」 |

## 待办与隐患

- [ ] 无 TODO / FIXME 标记。已知取舍与真实边界：
  - **有损接管是刻意暴露给用户的语义**：`fromServiceConfig` 的路由接管后目标路径为空串，第一次 apply 会重写该路由；界面用独立说明行 + 徽标 + `SERVICE_CONFIG_LOSSY_NOTE` 三重提示，不做自动补回；
  - 接管失败**没有行内错误位**：完全依赖 `App` 的 toast，`aborted` 情况下会静默（`mutate` 把 `aborted` 当普通失败返回但 `notifyError` 吞掉了它）；
  - `routeKey` 大小写敏感，而 `App.tsx` 的 `managedKeys` 折叠大小写：同一个路由在「已托管判定」与「接管 pending 判定」两处可能得出不同结论；
  - 多路由的一次性接管路径（`importRoutes()` 省略参数、或传多条）在界面上不可达，`takeover` 的成功文案只为单条设计（多条时「→ 目标」后缀只跟随第一条）。
