# `web/src/App.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

管理界面的根组件：把 `system` / `containers` / `mappings` / `serve` / `audit` 五个数据切片统一采集并分发给各面板，统一托管 toast 反馈、`busy` / `syncing` 加载态与所有写操作。界面本身不做任何路由与状态持久化——所有真实状态都在后端，本文件只负责「取数、防竞态、把结果说清楚」。

## 依赖 / 引用

- 外部模块：`react`（`useCallback` / `useEffect` / `useMemo` / `useRef` / `useState` / `type JSX`）。
- 同项目文件：
  - `./api`：`ApiError` / `ERROR_CODE_LABEL` / `api` / `toApiError`，以及 `ApplyResult`、`AuditEvent`、`ContainerInfo`、`ImportResponse`、`MappingDeleteResponse`、`MappingInput`、`MappingsResponse`、`MappingMutationResponse`、`RouteRef`、`ServeRoutesResponse`、`ServeRouteView`、`SystemInfo` 等类型；
  - `./utils`：`formatRouteLabel`、`formatScopedLabel`（`reportApply` 的逐条文案）；
  - `./components/*`：`SecurityBanner`、`TopBar`、`Toolbar`、`ServicePanel`、`ContainerPanel`、`MappingPanel`（并复用其 `ApiResult`）、`ExternalRoutesPanel`、`Toast`（`ToastStack` 及 `ToastDetailItem` / `ToastItem` / `ToastLevel`）；
  - `./styles.css`（副作用式引入，全站唯一样式入口）。
- 被引用：`web/src/main.tsx` 以 `<StrictMode><App /></StrictMode>` 挂载；`web/index.html` 只提供 `#root` 与 `/src/main.tsx` 入口。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `App` | `() => JSX.Element` | `JSX.Element` | 根组件：采集五个切片、分发 props、渲染全部面板与只读表 | `#root` 缺失由 `main.tsx` 抛错；`system` 未到位时用占位常量渲染 |
| `dismissToast` | `(id: number) => void` | `void` | 清掉该 toast 的定时器并移除它 | `id` 不在 `timersRef` 中时只做一次无副作用的过滤 |
| `pushToast` | `(level: ToastLevel, title: string, message?: string, code?: string, details?: ToastDetailItem[]) => void` | `void` | 造 id、按需省略空字段、头插列表并截断到 6 条、非 error 8 秒自动消失 | 空串 `message`/`code` 与空 `details` 不写入；第 7 条起被丢弃时**不清理其定时器** |
| `notify` | `(level: ToastLevel, title: string, message?: string) => void` | `void` | 面板用的简化 toast（无 `code`/`details`） | 仅转发给 `pushToast`，无独立分支 |
| `notifyError` | `(title: string, err: unknown) => void` | `void` | 把任意抛出物转成 toast（带错误码徽标） | `code === 'aborted'` 直接静默返回；`status >= 500` 或 `network` 记 `error`，其余记 `warn` |
| `reportApply` | `(apply: ApplyResult, options?: { successTitle?: string; failureTitle?: string }) => void` | `void` | 把 `ApplyResult` 的 upserted/removed/blocked/exposures/errors 逐条转成明细 toast | `inSync` 但有 blocked/exposures/errors 时**仍记 error**；明细可为空数组 |
| `loadSlice` | `<K extends Slice>(slice: K, seq: number, signal: AbortSignal) => Promise<Payload[K] \| null>` | `Promise<Payload[K] \| null>` | 按切片名发请求、校验序号后写入对应 state | 序号过期或 `AbortError` 返回 `null`；内部吞掉全部异常，**永不 reject** |
| `refreshAll` | `() => void` | `void` | 并发重取五个切片，成功后更新 `busy` / `loadedOnce` / `lastUpdated` | `abortRef.current` 为 `null` 时直接 return（不发请求）；旧序号回来时早退 |
| `mutate` | `<T>(title: string, run: () => Promise<T>) => Promise<ApiResult<T>>` | `Promise<ApiResult<T>>` | 统一的写操作外壳：`busy` + 成功刷新 + 失败转 `{code, message}` | 失败不刷新数据；`aborted` 也会以 `{code:'aborted'}` 返回给调用方 |
| `createMapping` | `(input: MappingInput) => Promise<ApiResult<MappingMutationResponse>>` | `Promise<ApiResult<MappingMutationResponse>>` | 创建映射（标题「创建映射失败」） | 透传 `mutate`，无附加处理 |
| `updateMapping` | `(id: string, input: MappingInput) => Promise<ApiResult<MappingMutationResponse>>` | `Promise<ApiResult<MappingMutationResponse>>` | 更新映射（标题「更新映射失败」） | `input` 为部分更新，字段省略即不改动 |
| `deleteMapping` | `(id: string) => Promise<ApiResult<MappingDeleteResponse>>` | `Promise<ApiResult<MappingDeleteResponse>>` | 删除映射（标题「删除映射失败」） | 成功时后端可能返回 `removed: null`，本文件不解释该字段 |
| `setEnabled` | `(id: string, enabled: boolean) => Promise<ApiResult<MappingMutationResponse>>` | `Promise<ApiResult<MappingMutationResponse>>` | 启用/禁用映射，标题随 `enabled` 变化 | 标题是二选一写死的，不做 i18n |
| `importRoutes` | `(routes?: RouteRef[]) => Promise<ApiResult<ImportResponse>>` | `Promise<ApiResult<ImportResponse>>` | 接管路由（标题「接管路由失败」） | `routes === undefined` 时后端收到 `{}`，语义是「接管全部未托管路由」 |
| `applyNow` | `() => void` | `void` | 触发一次 `apply`，回报结果并刷新数据 | **未传 `signal`**，卸载不会取消该请求；`syncing` 由 `finally` 复位 |
| `handleCopied` | `(ok: boolean, label: string, value: string) => void` | `void` | 复制成功记 `info`、失败记 `warn` 并提示手动复制 | 失败文案里回显 `value`，长文本会进入 toast 消息 |
| `onClear` | `() => void`（内联箭头，传给 `ToastStack`） | `void` | 清空全部 toast 并清掉所有在途定时器 | 只清定时器与列表，不重置 `toastSeq` |

## 函数详情

### `App()`

- **签名**：`() => JSX.Element`
- **入参**：无（唯一 props 来源是 `main.tsx` 的 `<App />`，不带任何属性）。
- **出参**：`JSX.Element`。
- **功能**：声明 10 个 `useState`、3 个 `useRef`，通过 15 个 `useCallback` 拼出全部子面板的 props，并渲染骨架：`TopBar` → `Toolbar` → `SecurityBanner` → 骨架占位 → `ServicePanel` → `ContainerPanel` → `MappingPanel` → `ExternalRoutesPanel` → 只读的 serve 路由表 → 审计日志 → 页脚 → `ToastStack`。
- **边缘条件**：
  - 骨架只由 `showSkeleton = !loadedOnce && system === null` 控制：`system` 一到位就撤掉「正在读取系统状态…」，即使 `containers` / `mappings` 还在路上；
  - 派生值全部用可选链 + `??` 兜底：`adminPort` 未加载时用占位常量 `ADMIN_PORT_FALLBACK`（真实值一定来自后端）；`services` / `selfTags` 保持 `[]` 而非 `undefined`，子面板无需再判空；
  - 注意 `??` **不认空数组**：`mappings?.services ?? system?.services ?? []` 在 `mappings` 已加载但 `services` 为 `[]` 时不会回落到 `system`——这是刻意的（`mappings` 与 `counts` 同步刷新，`system` 只作兜底）；
  - serve 路由表为空时渲染 `.empty` 文案而非空表；审计为空时渲染「还没有审计事件。」；
  - 审计时间戳直接 `new Date(e.at).toLocaleString('zh-CN', { hour12: false })`：`at` 非法时页面会显示 `Invalid Date`（后端契约保证 ISO 字符串）；
  - 审计 `<li>` 的 key 是 `` `${e.at}-${String(i)}` ``：同一毫秒多条事件时靠索引消歧，插入式更新会让部分行重建。

### `dismissToast(id)`

- **签名**：`(id: number) => void`
- **入参**：`id`（`number`，必选）：`toastSeq` 递增产出的 toast 标识。
- **出参**：`void`。
- **功能**：先 `clearTimeout` 并删除该 id 的定时器（避免 8 秒后重复触发一次无意义的过滤），再按 id 过滤列表。
- **边缘条件**：`error` 级 toast 本来就没有定时器，`timersRef.get(id)` 为 `undefined`，走 `!== undefined` 分支判断后直接过滤；传入不存在的 id 不抛错，只是列表不变。

### `pushToast(level, title, message?, code?, details?)`

- **签名**：`(level: ToastLevel, title: string, message?: string, code?: string, details?: ToastDetailItem[]) => void`
- **入参**：
  - `level`（`'info' | 'success' | 'warn' | 'error'`，必选）：决定左边框颜色与是否常驻；
  - `title`（`string`，必选）：标题；
  - `message`（`string`，可选）：正文，空串按「未提供」处理；
  - `code`（`string`，可选）：业务错误码，有值时 `Toast` 渲染为徽标；
  - `details`（`ToastDetailItem[]`，可选）：明细列表，空数组按「未提供」处理。
- **出参**：`void`。
- **功能**：用模块级自增 `toastSeq` 生成 `id`，用条件展开（`...(cond ? {k:v} : {})`）避免写入空串与空数组字段，然后 `[item, ...prev].slice(0, 6)` 头插并截断。`level !== 'error'` 时挂 8 秒定时器自动移除；`error` 常驻，等用户处理。
- **边缘条件**：
  - **超过 6 条的溢出丢弃不会取消被丢弃条目的定时器**：那个定时器稍后仍会触发一次「过滤一个已不存在的 id」（无害但确实存在）；`timersRef` 里对应的条目在该定时器触发时才会被删除；
  - 组件卸载时由 `useEffect` 的 cleanup 统一 `clearTimeout` 并清空 `timersRef`，因此不会在卸载后 setState；
  - `toastSeq` 只增不减，`清空` 后再弹不会复用 id，`Toast` 的 `key={item.id}` 因此始终稳定。

### `notify(level, title, message?)`

- **签名**：`(level: ToastLevel, title: string, message?: string) => void`
- **入参**：`level`（必选）、`title`（必选）、`message`（可选）。
- **出参**：`void`。
- **功能**：面板专用的窄接口——成功/提示类反馈不需要错误码与明细，收敛成一个参数更少的回调，`ContainerPanel` / `MappingPanel` / `ExternalRoutesPanel` 收到的 `onNotify` 即它。
- **边缘条件**：无独立分支；`message` 为空串时与不传等价。

### `notifyError(title, err)`

- **签名**：`(title: string, err: unknown) => void`
- **入参**：`title`（`string`，必选）：动作名（如「容器清单读取失败」）；`err`（`unknown`，必选）：任意抛出物。
- **出参**：`void`。
- **功能**：用 `toApiError` 归一化为 `ApiError`；若 `code === 'aborted'` 直接返回（卸载取消不该打扰用户）；否则用 `ERROR_CODE_LABEL` 加中文前缀，并按严重度分流：`status >= 500` 或 `code === 'network'` 记 `error`（常驻），其余（4xx 业务错误）记 `warn`（8 秒消失）。
- **边缘条件**：
  - `aborted` 被静默吞掉——这是 `refreshAll` 卸载取消不产生噪音的原因，但也意味着「用户主动取消」在界面上不可见；
  - 错误码不在 `ERROR_CODE_LABEL` 里时不加前缀，直接用后端 `message`；
  - 纯抛出的 `Error`（非 `ApiError`）被 `toApiError` 归为 `code: 'network'`、`status: 0`，因此一律按 `error` 常驻展示。

### `reportApply(apply, options?)`

- **签名**：`(apply: ApplyResult, options?: { successTitle?: string; failureTitle?: string }) => void`
- **入参**：`apply`（`ApplyResult`，必选）：`{ upserted, removed, blocked, exposures, errors, inSync }`；`options`（可选）：`successTitle` / `failureTitle` 覆盖默认标题。
- **出参**：`void`。
- **功能**：把五类结果逐条压成 `ToastDetailItem`：`upserted` / `removed` 记 `ok`（用 `formatRouteLabel` 拼 Service+端口+路径），`blocked` 记 `bad`（用 `formatScopedLabel`，因为 `blocked` 条目没有端口维度），`exposures` 与 `errors` 记 `bad`。随后判定 `bad = errors.length > 0 || blocked.length > 0 || exposures.length > 0`：`inSync && !bad` 才报成功，否则报失败。
- **边缘条件**：
  - **暴露告警优先于成功**：`exposures` 非空时即使 `inSync === true` 也只报 error——「已收敛」不能掩盖管理端口被暴露；
  - `inSync && !bad` 且 `upserted.length + removed.length === 0` 时文案是「serve 配置本来就是最新的，无需改动。」，否则是「挂载 N 条，摘除 M 条。」；
  - 失败且 `inSync === true` 时正文是「配置已收敛，但仍有需要注意的条目：」，`inSync === false` 时是「以下条目未能收敛到期望状态：」；两种情况下 `details` 都可能为空数组（此时 `pushToast` 省略明细区）。

### `loadSlice(slice, seq, signal)`

- **签名**：`<K extends Slice>(slice: K, seq: number, signal: AbortSignal) => Promise<Payload[K] | null>`
- **入参**：`slice`（`'system' | 'containers' | 'mappings' | 'serve' | 'audit'`，必选）；`seq`（`number`，必选）：本次采集的序号快照；`signal`（`AbortSignal`，必选）：来自挂载期 controller。
- **出参**：`Promise<Payload[K] | null>`，`null` 统一表示「不可用」（序号过期 / 被取消 / 出错）。
- **功能**：用三元链把 `slice` 映射到 `api.system` / `api.containers` / `api.mappings` / `api.serveRoutes` / `api.audit(50, signal)`（审计条数固定 50），成功后先比对 `seq !== seqRef.current` 决定丢弃，再按切片写对应 state（`containers` 取 `.containers`、`serve` 取 `.routes`、`audit` 取 `.events`）。
- **边缘条件**：
  - **序号比对在写入之前**：旧请求即使成功返回也不会覆盖新数据，这是本项目防竞态的主手段；
  - `AbortError`（`DOMException` 且 `name === 'AbortError'`）与序号过期都返回 `null` 且**不弹 toast**；
  - `.catch` 内除上述两种情况外一律 `notifyError`，标题按切片选中文名（系统信息 / 容器清单 / 映射列表 / serve 路由 / 审计日志）；
  - 返回的 `Promise` 永不 reject，因此 `refreshAll` 里的 `Promise.all` 一定 resolve，`.then` 必然执行；
  - 内部有多处 `as` 断言（把泛型收窄到具体响应类型），运行期不做校验：后端返回形状不符时会在写 state 时抛 `TypeError`（被同一条 `.catch` 捕获并按读取失败提示）。

### `refreshAll()`

- **签名**：`() => void`
- **入参**：无。
- **出参**：`void`（内部用 `void Promise.all(...)` 显式丢弃 promise）。
- **功能**：取 `abortRef.current`，`++seqRef.current` 作为本次序号，`setBusy(true)`，然后对五个切片并发调用 `loadSlice`；全部落定后再比一次序号，若仍是本次则 `setBusy(false)` / `setLoadedOnce(true)` / `setLastUpdated(new Date().toISOString())`。
- **边缘条件**：
  - `abortRef.current === null` 时直接 return——这种情况只在挂载副作用执行前被调用时发生（`mutate` 成功后的刷新已在挂载之后），此时界面既不刷新也不报错；
  - **旧序号早退不会复位 `busy`**：复位责任交给了更新的那次 `refreshAll`，因此不会出现「新请求还在跑、busy 被旧请求置 false」的闪烁；
  - 卸载后若仍有 `refreshAll` 被触发（例如 `applyNow` 的 `.then`），controller 已 abort，五个切片全部返回 `null`，`Promise.all` 仍 resolve，序号也未变化，于是会执行 `setBusy/setLoadedOnce/setLastUpdated`——依赖 React 对已卸载组件 setState 的忽略行为，不报错也不生效；
  - 身份稳定性：依赖数组是 `[loadSlice]`，而 `loadSlice` 只依赖 `notifyError`（`useCallback([])`），所以 `refreshAll` 在整个生命周期内保持同一引用，挂载副作用只跑一次。

### `mutate(title, run)`

- **签名**：`<T>(title: string, run: () => Promise<T>) => Promise<ApiResult<T>>`
- **入参**：`title`（`string`，必选）：失败 toast 标题；`run`（`() => Promise<T>`，必选）：真正的写请求闭包。
- **出参**：`Promise<ApiResult<T>>`——成功是 `{ data }`，失败是 `{ code, message }`（`ApiResult` 定义在 `MappingPanel.tsx`）。
- **功能**：`setBusy(true)` → `await run()` → 成功后立即 `refreshAll()`（不等待）并返回 `{ data }`；失败时 `toApiError` 后 `notifyError(title, err)` 并返回 `{ code, message }`；`finally` 里 `setBusy(false)`。所有写操作（创建/更新/删除/启停/接管）都经它，界面因此共用一套加载态与错误呈现。
- **边缘条件**：
  - **调用方靠 `result.data !== undefined` 判定成功、靠 `result.code === 'takeover-required'` 判定「需确认接管」**，这两条是各面板分支的唯一依据；
  - 失败分支**不刷新数据**：界面保持旧快照，调用方必须自己处理（例如 `MappingPanel` 的开关会弹回原位）；
  - `aborted` 不会被特殊处理：`notifyError` 吞掉 toast，但返回的 `{ code: 'aborted', message: '请求已取消' }` 在调用方看来与普通失败无异（`ContainerPanel` / `EditRow` 会把「请求已取消」显示成行内错误）；
  - `refreshAll()` 是「发后不管」，它的 promise 未被 await，`busy` 仍由它自己复位，因此可能会出现短暂的重叠（写操作刚 `setBusy(false)`、刷新又 `setBusy(true)`）。

### `createMapping(input)`

- **签名**：`(input: MappingInput) => Promise<ApiResult<MappingMutationResponse>>`
- **入参**：`input`（`MappingInput`，必选）：后端契约字段，本层不做补全或校验。
- **出参**：`Promise<ApiResult<MappingMutationResponse>>`，成功时 `data.mapping` 是新映射、`data.apply` 是本次同步结果。
- **功能**：`mutate('创建映射失败', () => api.createMapping(input))`，作为 `ContainerPanel` 的 `createMapping` prop 下发。
- **边缘条件**：标题固定，不复用 `ContainerPanel` 的行内错误文案；校验（端口范围、路径格式）由表单侧先做，本层依赖后端返回 `invalid-*` / `takeover-required` 等错误码。

### `updateMapping(id, input)`

- **签名**：`(id: string, input: MappingInput) => Promise<ApiResult<MappingMutationResponse>>`
- **入参**：`id`（`string`，必选）：映射 id（由 `api.updateMapping` 负责 URL 编码）；`input`（`MappingInput`，必选）：部分更新语义。
- **出参**：`Promise<ApiResult<MappingMutationResponse>>`。
- **功能**：`mutate('更新映射失败', () => api.updateMapping(id, input))`，作为 `MappingPanel` 的 `updateMapping` prop 下发。
- **边缘条件**：**PATCH 语义下「字段省略 = 不改动」**，所以调用方（`EditRow`）必须显式下发 `service`（含 `null`）与 `remoteHost`（含 `null`），否则清空 Service 或清空目标主机的操作会被静默忽略；本层不做任何字段补齐。

### `deleteMapping(id)`

- **签名**：`(id: string) => Promise<ApiResult<MappingDeleteResponse>>`
- **入参**：`id`（`string`，必选）。
- **出参**：`Promise<ApiResult<MappingDeleteResponse>>`，成功时 `data.apply` 给出摘除结果、`data.removed` 为被删映射（可能为 `null`）。
- **功能**：`mutate('删除映射失败', () => api.deleteMapping(id))`。
- **边缘条件**：`removed` 为 `null` 时本文件不额外提示；`MappingPanel` 只判断 `result.data !== undefined` 就报「映射已删除」，因此即使后端告知「本就没有这条路由」也按成功呈现。

### `setEnabled(id, enabled)`

- **签名**：`(id: string, enabled: boolean) => Promise<ApiResult<MappingMutationResponse>>`
- **入参**：`id`（`string`，必选）；`enabled`（`boolean`，必选）：目标状态（不是「取反」，因此重放安全）。
- **出参**：`Promise<ApiResult<MappingMutationResponse>>`。
- **功能**：按 `enabled` 在 `'启用映射失败'` / `'禁用映射失败'` 之间选标题，调用 `api.setEnabled`。
- **边缘条件**：失败时 `MappingPanel` 的复选框会因 `checked={mapping.enabled}` 未变而回到原状态（受控组件），用户只会看到一条错误 toast。

### `importRoutes(routes?)`

- **签名**：`(routes?: RouteRef[]) => Promise<ApiResult<ImportResponse>>`
- **入参**：`routes`（`RouteRef[]`，可选）：要接管的路由位置三元组 `{ service, servePort, path }`；省略时 `api` 发送 `{}`。
- **出参**：`Promise<ApiResult<ImportResponse>>`，成功时 `data.imported` 与 `data.skipped` 分别列出成功与跳过的条目。
- **功能**：`mutate('接管路由失败', () => api.importRoutes(routes))`，供 `ExternalRoutesPanel` 单条接管使用。
- **边缘条件**：**省略 `routes` 与传 `[]` 语义不同**——省略是「接管全部未托管路由」（后端看到 `{}`），传 `[]` 是「什么都不接管」；当前界面只传单元素数组。

### `applyNow()`

- **签名**：`() => void`
- **入参**：无。
- **出参**：`void`。
- **功能**：`setSyncing(true)` → `api.apply()` → `reportApply(result)` + `refreshAll()`；失败走 `notifyError('重新同步失败', err)`；`finally` 复位 `syncing`。
- **边缘条件**：
  - **`api.apply()` 没有传 `signal`**：这次请求不随组件卸载取消，卸载后 `reportApply` / `refreshAll` / `setSyncing(false)` 仍会执行（React 忽略已卸载组件的 setState，toast 也不会出现）；
  - 该请求使用独立的 `syncing` 而非 `busy`，因此「重新同步」按钮可与其它写操作并行点击，界面不会互斥；
  - `reportApply` 在 `notifyError` 之前执行，但两者不会同时触发（`.then` 与 `.catch` 互斥）。

### `handleCopied(ok, label, value)`

- **签名**：`(ok: boolean, label: string, value: string) => void`
- **入参**：`ok`（`boolean`，必选）：复制是否成功；`label`（`string`，必选）：复制对象的名称（如「访问地址」「管理地址」）；`value`（`string`，必选）：被复制的原文。
- **出参**：`void`。
- **功能**：成功记 `info` toast（标题「已复制{label}」、正文即复制内容），失败记 `warn` toast 并把原文回显在提示里，让用户手动复制。
- **边缘条件**：`copyText` 在非安全上下文会回退到 `document.execCommand('copy')`，两条路径都失败才走 `warn` 分支；`value` 很长时整段进入 toast 正文（`Toast` 不截断，靠 `.toast-details` 的滚动兜底）。

### `onClear()`（内联，传给 `ToastStack`）

- **签名**：`() => void`
- **入参**：无。
- **出参**：`void`。
- **功能**：遍历 `timersRef.current.values()` 逐个 `clearTimeout`，清空 Map，再 `setToasts([])`——即「全部关闭」按钮的实现。
- **边缘条件**：这是 `App` 内唯一的非具名内联处理器（`ToastStack` 的 `onClear`）；它不重置 `toastSeq`，也不触碰 `busy` / `syncing`，因此清空 toast 不会取消任何在途请求。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `system` | `SystemInfo \| null` | 节点级系统信息（端口、tag、数据源、安全状态） | 初值 `null`；未到位时 `adminPort` 用占位常量、`canHostService` 用 `false` |
| `containers` | `ContainerInfo[]` | 容器清单 | 初值 `[]`；仅取响应里的 `.containers` |
| `mappings` | `MappingsResponse \| null` | 映射接口整包（含 `externalRoutes`、`services`、`selfTags`、`planSummary`、`counts`） | 初值 `null`；它是 `services` / `selfTags` / `planSummary` / `counts` 的**首选**来源 |
| `serveRoutes` | `ServeRouteView[]` | serve 路由快照（只读表） | 初值 `[]`；仅取响应里的 `.routes` |
| `audit` | `AuditEvent[]` | 审计事件 | 初值 `[]`；固定取最近 50 条 |
| `lastUpdated` | `string \| null` | 上次成功采集时间（ISO） | 初值 `null`；只在整批切片都落定后写入 |
| `busy` | `boolean` | 读/写通用加载态 | 初值 `false`；由 `refreshAll` 与 `mutate` 共同写，写操作结束与刷新开始可能短暂重叠 |
| `syncing` | `boolean` | 「重新同步」专用加载态 | 初值 `false`；与 `busy` 独立，可并行 |
| `loadedOnce` | `boolean` | 是否完成过一次成功采集 | 初值 `false`；只置 `true`，不回退 |
| `toasts` | `ToastItem[]` | 顶部提示列表 | 初值 `[]`；最新在前，最多 6 条 |
| `seqRef` | `MutableRefObject<number>` | 采集序号 | 初值 `0`；每次 `refreshAll` 自增，是丢弃过期响应的唯一依据 |
| `abortRef` | `MutableRefObject<AbortController \| null>` | 当前挂载期的取消句柄 | 初值 `null`；**每次挂载新建并写入 ref**（见下），卸载时 abort，但不清空引用 |
| `timersRef` | `MutableRefObject<Map<number, ReturnType<typeof setTimeout>>>` | toast 自动消失定时器 | 初值空 `Map`；卸载与「全部关闭」时统一清理 |
| `toastSeq` | `number`（模块级 `let`） | toast id 自增源 | 初值 `0`；只增不减，跨组件实例共享 |
| `ADMIN_PORT_FALLBACK` | `8787`（模块级 `const`） | 管理端口占位值 | 仅用于 `system` 未加载时；真实值必须来自后端 |
| `managedKeys` | `Set<string>`（`useMemo`） | 已托管路由集合，用于页脚计数 | key 为 `` `${service ?? '-'}\|${servePort}\|${path.toLowerCase()}` ``：`null` 用 `-` 占位、路径**折叠大小写**、Service 不折叠 |
| `serveRows` | `{ route; proxy; hostPort; kind }[]`（`useMemo`） | 只读 serve 表行 | `handler.kind !== 'proxy'` 时 `proxy` 与 `hostPort` 均为 `null` |
| `adminPort` | `number` | 传给子面板的管理端口 | `system?.adminPort ?? ADMIN_PORT_FALLBACK` |
| `planSummary` | `PlanSummary \| null` | 期望与实际差异摘要 | `mappings?.planSummary ?? system?.plan ?? null` |
| `counts` | `MappingCounts \| null` | 各状态条数 | `mappings?.counts ?? system?.counts ?? null` |
| `services` | `ServiceInfo[]` | 本节点上的 Tailscale Service | `mappings?.services ?? system?.services ?? []`（`mappings` 为准） |
| `selfTags` | `string[]` | 本节点 tag | `mappings?.selfTags ?? system?.selfTags ?? []` |
| `showSkeleton` | `boolean` | 首屏骨架开关 | `!loadedOnce && system === null` |

### React 19 StrictMode 与两套并发控制（本文件的并发约定）

- **请求序号 `seqRef` 负责「丢弃过期响应」**：`refreshAll` 每次自增并把快照 `seq` 传给 `loadSlice`；响应回来先比 `seq !== seqRef.current`，不等就丢弃（不写 state、不报错）。**不用 abort 上一次请求来防竞态**，因为 abort 会让上一次请求以「取消」告终、无法区分「被新请求取代」与「用户离开」。
- **`AbortController` 只负责「卸载取消」**：controller 在 `useEffect` **内部**创建、写进 `abortRef`（存在组件实例上），cleanup 时 `controller.abort()`。
- **为什么 controller 必须存在 ref 上、且每次挂载新建**：React 19 StrictMode 会「挂载 → 卸载 → 再挂载」，第一次挂载的 cleanup 必然执行。若 controller 由 `useRef(new AbortController())` 之类在挂载前一次性构造，第一次 cleanup 就会 abort 掉**第二次挂载**正在发出的那批请求，界面会永久停在加载态；改为「每次挂载新建 + 句柄写 ref」，第一次 cleanup 只作废自己那一批，第二次挂载拿到全新句柄，请求正常完成。
- `seqRef` 在卸载时**不重置**：abort 已经让在途请求返回 `null`，无需再靠序号拦截。

## 待办与隐患

- [ ] 无 TODO / FIXME 标记。已知取舍与真实边界：
  - `pushToast` 截断到 6 条时，被丢弃 toast 的 8 秒定时器不会被取消（会触发一次无用过滤，且 `timersRef` 中该条目要到定时器触发才清除）；
  - `applyNow` 调用 `api.apply()` 时**没有传 `AbortSignal`**，卸载后该请求会继续跑完并进入 `finally`（依赖 React 忽略已卸载组件的 setState）；
  - `mutate` 把 `aborted` 当普通失败返回，调用方（`ContainerPanel` / `EditRow`）会把它显示成行内错误「请求已取消」，与「卸载取消不打扰用户」的设计意图不一致；
  - `managedKeys` 折叠路径大小写（`toLowerCase()`），而 `ExternalRoutesPanel.routeKey` 不折叠，两处对「同一路由位置」的判定口径不同；
  - 派生值用 `??` 串联：`mappings.services` 为空数组时**不会**回落到 `system.services`（`??` 只对 `null` / `undefined` 生效），行为正确但容易在阅读时误判为「有兜底」。
