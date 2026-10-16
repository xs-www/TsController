# `web/src/components/MappingPanel.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

「端口映射」面板：按状态分组展示受管映射，支持行内编辑、启停与删除。本文件同时定义了全项目写操作的结果外壳 `ApiResult<T>`（`{ data }` 或 `{ code, message }`），`ContainerPanel` 与 `ExternalRoutesPanel` 都从这里导入它。编辑行的关键职责是**在 PATCH 语义下把 `service` / `remoteHost` 显式下发（含 `null`）**，否则「清空」类修改会被后端静默忽略。

## 依赖 / 引用

- 外部模块：`react`（`useState` / `useId` / `type JSX`）。
- 同项目文件：
  - `../api`：`ERROR_CODE_LABEL`，类型 `MappingCounts` / `MappingInput` / `MappingMutationResponse` / `MappingStatus` / `MappingView` / `PlanSummary` / `ServiceInfo`；
  - `./CopyButton`：`CopyButton`；
  - `../utils`：`formatRouteLabel`、`formatTarget`、`formatTime`、`groupByStatus`、`isRemoteTarget`、`mappingUrl`、`normalizeServiceInput`、`serviceShortName`；
  - 样式类来自 `../styles.css`（`.mapping-table` / `.status-*` / `.pill-*` / `.switch*` / `.edit-stack` / `.edit-target` / `.note-cell` / `.group-row` / `.row-open` / `.row-form`）。
- 被引用：
  - `web/src/App.tsx` 第 34、383-396 行渲染 `<MappingPanel … />` 并注入 `mappings` / `counts` / `planSummary` / `adminPort` / `services` / `busy` / `updateMapping` / `deleteMapping` / `setEnabled` / `onNotify` / `onCopied`；
  - `web/src/components/ContainerPanel.tsx` 与 `web/src/components/ExternalRoutesPanel.tsx` 导入本文件的 `type ApiResult`。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `StatusBadge` | `({ status, detail }: { status: MappingStatus; detail: string \| null }) => JSX.Element` | `JSX.Element` | 渲染状态徽标与悬停说明 | `detail` 为空串时会覆盖默认 `hint`；未知 `status` 会因 `meta` 为 `undefined` 抛 `TypeError` |
| `targetText` | `(m: MappingView) => string` | `string` | 目标列的人类可读描述 | 容器名缺失时依次回落 `containerId` 前 12 位 / `未知容器`；`containerPort` 缺失显示 `?` |
| `EditRow` | `(props: { mapping; services; busy; adminPort; onSave; onCancel }) => JSX.Element` | `JSX.Element` | 行内编辑表单 | 表单初值只在挂载时取一次，**不随 `mapping` prop 更新**；路径只 `trim()` 不做归一化 |
| `EditRow.save` | `(confirmTakeover: boolean) => Promise<void>` | `Promise<void>` | 校验 → 组装 PATCH 载荷 → 解释结果 | 6 项校验按序短路；`service` / `remoteHost` 显式下发（含 `null`）；响应形状不符时用可选链防白屏 |
| `MappingRow` | `(props: { mapping; editing; busy; services; adminPort; onStartEdit; onStopEdit; updateMapping; deleteMapping; setEnabled; onNotify; onCopied }) => JSX.Element` | `JSX.Element` | 只读行（或转交 `EditRow`） | `baseUrl` 为 `null` 时复制按钮不可用；`ownedRoutes.length > 1` 才显示占用条数 |
| `MappingRow.onSave`（内联） | `(input: MappingInput) => Promise<MutationResult>` | `Promise<MutationResult>` | 包一层 `updateMapping`，成功后弹成功提示并退出编辑 | 只判断 `result.data?.mapping !== undefined`；失败原样把 `result` 交回 `EditRow` 呈现 |
| `MappingPanel` | `(props: MappingPanelProps) => JSX.Element` | `JSX.Element` | 表头统计 + 按状态分组渲染行 | 同时只允许一行处于编辑态；空数据的文案按 `loading` 二选一 |

## 函数详情

### `StatusBadge({ status, detail })`

- **签名**：`({ status, detail }: { status: MappingStatus; detail: string | null }) => JSX.Element`
- **入参**：`status`（`MappingStatus`，必选）：8 个状态之一；`detail`（`string | null`，必选）：后端给的具体说明，通常为 `null`。
- **出参**：`JSX.Element`，`<span className={\`status ${meta.cls}\`} title={detail ?? meta.hint}>`。
- **功能**：把状态映射成「中文标签 + 配色类 + 悬停说明」三件套，`STATUS_META` 是唯一数据源；同一徽标在两处复用（编辑行的状态列、分组表头）。
- **边缘条件**：
  - `detail === null` → 用 `meta.hint` 作 `title`；**`detail === ''` 不会被 `??` 兜住**，`title` 变成空串，用户悬停看不到任何说明（后端若返回空串会丢失提示）；
  - `status` 是联合类型，类型层面已穷举；但运行期不做防御——后端若返回未列入 `STATUS_META` 的状态，`meta.cls` 会抛 `TypeError` 并使整个面板渲染失败（`App.tsx` 没有错误边界，会白屏）；
  - `.status` 类带 `cursor: help`，暗示「可以悬停看说明」；配色语义见 `web/src/styles.css.md`（`status-approval` 是冷色 = 不是错误）。

### `targetText(m)`

- **签名**：`(m: MappingView) => string`
- **入参**：`m`（`MappingView`，必选）：只读取 `m.target`。
- **出参**：`string`——容器目标是 `` `${endpoint} · 容器 ${name} ${from}` ``，宿主目标只有 `endpoint`。
- **功能**：把 `formatTarget` 的「主机:端口」与背后的容器信息拼成一行，让用户知道这条映射最终打到哪个容器。
- **边缘条件**：
  - `kind === 'container'` 时名字的回落链是 `containerName ?? containerId?.slice(0, 12) ?? '未知容器'`（`containerName` 为空串**不会**回落，空串也是有效值）；
  - `containerPort === undefined` 时 `${from}` 显示 `?`；为 `0` 时显示 `0`（`=== undefined` 判断，不做真假值判断）；
  - `kind === 'host'` 时只返回端点，不追加容器信息；
  - `formatTarget` 会把空/`127.0.0.1`/`localhost` 的 `remoteHost` 统一显示为 `127.0.0.1`（详见 `web/src/utils.ts`）。

### `EditRow({ mapping, services, busy, adminPort, onSave, onCancel })`

- **签名**：`(props: { mapping: MappingView; services: ServiceInfo[]; busy: boolean; adminPort: number; onSave: (input: MappingInput) => Promise<MutationResult>; onCancel: () => void }) => JSX.Element`
- **入参**：
  - `mapping`（`MappingView`，必选）：被编辑的映射（既是初值来源，也是提交时 `kind` / 容器三元组的来源）；
  - `services`（`ServiceInfo[]`，必选）：`datalist` 选项，空数组时不挂 `list`；
  - `busy`（`boolean`，必选）：全局加载态；
  - `adminPort`（`number`，必选）：用于本地拦截管理端口；
  - `onSave`（`(input: MappingInput) => Promise<MutationResult>`，必选）：由 `MappingRow` 注入的写操作（内部再调 `updateMapping`）；
  - `onCancel`（`() => void`，必选）：退出编辑（由 `MappingPanel` 把 `editingId` 置 `null`）。
- **出参**：`JSX.Element`——`<>` 包裹的「编辑行 + 条件性的接管/错误行」（第二行 `colSpan={7}` 与 7 列对应）。
- **功能**：用 7 个 `useState` 从 `mapping` 初始化字段（Service、目标主机、路径、对外端口、目标端口、目标路径、备注），加 `pendingTakeover` / `saving` / `error`；渲染两列编辑区（`.edit-stack` + `.edit-target`）、状态徽标、期望/实际代理、备注输入与操作按钮。
- **边缘条件**：
  - **没有 `useEffect` 同步 prop**：初值只在挂载时取一次。由于 `MappingRow` 用 `key={m.id}` 且只在 `editing` 为真时渲染 `EditRow`，退出编辑会卸载组件、下次进入重新取初值；但**编辑期间的数据刷新（例如点「刷新」）会更新 `mapping` prop 而不会更新表单字段**，保存时提交的是用户手上那份值，`kind` / 容器三元组则取自最新的 `mapping.target`；
  - 「目标主机」输入框在非 Service 级时 `disabled`，但**保留已有文本**：这正是 `save` 中「非 Service 级却填了目标主机」校验可达的原因；
  - `aria-label` 齐备（Tailscale Service / 路径 / 对外端口 / 代理目标主机 / 目标端口 / 目标路径 / 备注），因为这一行没有 `label` 包裹；
  - 保存中（`saving`）时保存与取消按钮同时禁用；「确认接管」与「取消接管」的禁用条件不同——「取消接管」**不受 `disabled` 限制**，随时可关掉确认块。

### `EditRow.save(confirmTakeover)`

- **签名**：`(confirmTakeover: boolean) => Promise<void>`
- **入参**：`confirmTakeover`（`boolean`，必选）：`true` 时在载荷里加 `confirmTakeover: true`（由「确认接管并保存」按钮触发）。
- **出参**：`Promise<void>`。
- **功能**：六步校验 → `setSaving(true)` / `setError(null)` → 组装 PATCH 载荷调 `onSave` → 解释结果（成功清 `pendingTakeover`；`takeover-required` 转入确认块；其余显示行内错误）→ `finally` 复位 `saving`。
- **边缘条件**（校验按序短路，命中即 `return`，都不发请求）：
  1. `hostPort` 必须是 1-65535 整数 → 「目标端口必须是 1-65535 的整数」；
  2. `servePort` 必须是 1-65535 整数 → 「对外端口必须是 1-65535 的整数」；
  3. **本机目标才拦管理端口**：`trimmedRemoteHost === '' && parsedPort === adminPort` → 「端口 N 是 TsController 管理端口，禁止映射」。远端目标（Service 级 + 目标主机非空）允许填与 `adminPort` 同号的端口，因为那个端口属于**另一台主机**；
  4. **对外端口任何时候都不能与管理端口同号**：`parsedServePort === adminPort` → 「对外端口 N 与管理端口同号，请换一个」（该判断独立于 Service 模式）；
  5. 非 Service 级却填了目标主机 → 「代理目标主机只在 Service 级路由上支持：请先填写 Tailscale Service，或清空目标主机」（输入框虽 `disabled` 但文本仍在，因此这条可达）；
  6. `path.trim() === '' || !path.trim().startsWith('/')` → 「路径必须以 "/" 开头」。
- **PATCH 语义相关（本文件最容易被误改的地方）**：
  - `service: serviceMode ? normalizedService : null` —— **显式下发（含 `null` = 切回节点级）**：后端是 PATCH 语义，「省略」表示不改动，若省略该字段，把 Service 级映射改回节点级的操作会被静默忽略；
  - `remoteHost: serviceMode && trimmedRemoteHost !== '' ? trimmedRemoteHost : null` —— 同样显式下发 `null`（= 本机回环），否则从远端目标切回本机时旧主机会残留；
  - `containerId` / `containerName` / `containerPort` 只在 `mapping.target.kind === 'container'` **且字段不为 `undefined`** 时通过条件展开写入，避免把宿主目标写成容器目标；
  - `path` 只做 `path.trim()`，**不做 `normalizePathInput` 归一化**：与 `ContainerPanel` 的表单不同，重复斜杠、尾斜杠会原样发给后端（校验正确性交给后端 `invalid-path`）；
  - 载荷恒带 `kind: mapping.target.kind`，因此编辑**不会**把容器目标改成宿主目标。
- **结果解释**：
  - `result.data?.mapping !== undefined` → 清 `pendingTakeover` 并返回；**成功提示与退出编辑由 `MappingRow` 的 `onSave` 包装层负责**（本组件不认识 `onNotify`）；
  - `result.code === 'takeover-required'` → `pendingTakeover = result.message ?? '该路径已被一条未托管的 serve 路由占用'`，渲染黄色确认块（`.inline-confirm`，`role="alert"`），文案包含 `formatRouteLabel(Number(servePort) || 443, path.trim(), serviceMode ? normalizedService : null)`；
  - `result.data !== undefined` 但没有 `mapping` → 「保存接口返回了意外的响应（缺少 mapping 字段），请刷新后重试」——**可选链 `result.data?.mapping` 是关键**：写操作响应形状不符（例如后端返回了别的 JSON）时，直接读 `.mapping` 会抛 `TypeError` 并白屏；
  - 其余 → 已知错误码加中文前缀（`ERROR_CODE_LABEL[code]` 存在时），再加 `result.message`，都缺时回落「保存失败」；`aborted` 会被展示成「请求已取消」。

### `MappingRow({ mapping, editing, busy, services, adminPort, onStartEdit, onStopEdit, updateMapping, deleteMapping, setEnabled, onNotify, onCopied })`

- **签名**：`(props: { mapping: MappingView; editing: boolean; busy: boolean; services: ServiceInfo[]; adminPort: number; onStartEdit: () => void; onStopEdit: () => void; updateMapping: MappingPanelProps['updateMapping']; deleteMapping: MappingPanelProps['deleteMapping']; setEnabled: MappingPanelProps['setEnabled']; onNotify: MappingPanelProps['onNotify']; onCopied: MappingPanelProps['onCopied'] }) => JSX.Element`
- **入参**：`mapping`（必选）；`editing`（`boolean`，必选）：是否处于编辑态；`busy`（必选）；`services`（必选）；`adminPort`（必选，透传给 `EditRow`）；`onStartEdit` / `onStopEdit`（必选）；`updateMapping` / `deleteMapping` / `setEnabled` / `onNotify` / `onCopied`（必选，直接取自 `MappingPanelProps`）。
- **出参**：`JSX.Element`——`editing` 为真时是 `EditRow`，否则是一个 `<tr>` 只读行。
- **功能**：只读行展示 7 列：路由（Service pill + `formatRouteLabel` 文本 + 复制按钮 + 占用条数）、目标、状态、期望/实际代理、备注与详情、启停开关、操作（编辑 / 删除，删除带二次确认）。
- **边缘条件**：
  - `fullUrl = mappingUrl(mapping)` 在 `baseUrl === null` 时是 `null`，`CopyButton` 的 `value` 因此为 `null`、`title` 变为「对外主机名未知（无法拼出完整地址），暂时无法复制」——按钮仍在，但点不出内容；
  - `ownedRoutes.length > 1` 时显示「占用 N 条」，`title` 用 `formatRouteLabel` 列出全部历史位置（一条映射可能同时占用多个 `(Service, 端口, 路径)`）；
  - 状态列用 `StatusBadge`；备注列在 `note === ''` 时显示灰色「（无备注）」，`detail !== null` 时追加黄色 `.detail-text`，状态为 `awaiting-approval` 时再追加冷色 `.detail-calm` 的完整帮助文案（见 `AWAITING_APPROVAL_HELP`）；
  - 「更新于」用 `formatTime(mapping.updatedAt)`，`title` 里给出原始的 `createdAt` / `updatedAt`（ISO 字符串，解析失败时 `formatTime` 原样返回）；
  - **开关是受控的**：`checked={mapping.enabled}`，`onChange` 只发请求；请求失败时 `mapping.enabled` 未变，复选框会**自动弹回原位**，用户只能从错误 toast 得知失败。开关成功后 `onNotify('success', '映射已启用'/'映射已禁用', result.data.mapping?.path ?? mapping.path)`——`mapping?.path` 用了可选链，`result.data` 存在但缺 `mapping` 时回落到当前行的路径；
  - 删除是两段式：先 `setConfirmDelete(true)` 切换成「确认删除？/ 删除 / 取消」，删除按钮 `disabled={busy}`；`deleteMapping` 只在 `result.data !== undefined` 时提示「映射已删除」（正文是进入确认前的 `label`，不是响应里的新值）；失败时确认块已经关闭（`setConfirmDelete(false)` 在发请求前执行），错误由 `App` 的 toast 承担；
  - **`EditRow` 的 `onSave` 包装层**：先 `await updateMapping(mapping.id, input)`，再看 `result.data?.mapping`——有值则 `onNotify('success', '映射已更新', \`${formatRouteLabel(...)} → ${updated.desiredProxy}\`)` 并 `onStopEdit()`，然后把**原样的 `result`** 返回给 `EditRow`。因此「保存成功」的判定在两层各做一次（外层决定提示与退出、内层决定清 `pendingTakeover`），失败路径只有内层处理；
  - `mapping.id` 不做本地 URL 编码（由 `api.ts` 的 `encodeURIComponent` 负责）。

### `MappingPanel({ mappings, counts, planSummary, loading, adminPort, services, busy, updateMapping, deleteMapping, setEnabled, onNotify, onCopied })`

- **签名**：`(props: MappingPanelProps) => JSX.Element`
- **入参**：见下「Props」表（全部必填，无默认值）。
- **出参**：`JSX.Element`，一个 `.panel` 区块。
- **功能**：`useState` 保存 `editingId`，`groups = groupByStatus(mappings)` 按 `MAPPING_STATUS_ORDER`（严重度顺序）分组；表头拼出统计串——总数、`counts !== null` 时的「已生效/待同步/被阻止/冲突」、`counts['awaiting-approval'] > 0` 时的「等待审批 N」、`planSummary !== null && !planSummary.inSync` 时的「需同步 N 项」（`upserts + removals`）；表体先渲染每个分组的 `.group-row`（状态徽标 + 条数 + `hint`），再渲染该组内的 `MappingRow`。
- **边缘条件**：
  - 空数据文案按 `loading` 二选一：`loading` 为真「正在读取映射…」，否则「还没有任何映射。请在下方容器面板里点「建立映射」，或接管一条既有的 serve 路由。」（文案里的「下方」是布局约定：`ContainerPanel` 渲染在 `MappingPanel` 之前）；
  - 分组顺序与「哪些组会出现」完全由 `utils.groupByStatus` 决定：顺序即严重度，**空组不渲染**；`blocked` / `conflict` / `orphaned-target` / `disabled-drift` 排在最前，`active` 与 `disabled` 在最后；
  - `counts` 与 `planSummary` 为 `null` 时对应的统计片段整体不出现（**首屏不会显示 0**）；
  - `editingId` 不随数据刷新清空：若被编辑的映射被删除，`editingId` 仍指向旧 id，只是没有行匹配 `editing`，界面上看不到编辑态（无害残留）；
  - 同时只有一行可编辑（单个 `editingId` 字符串），点另一行的「编辑」会直接切换；
  - `groups.map` 的 `key` 是 `` `${group.status}:head` ``，行 key 是 `m.id`（稳定，允许 React 在刷新后保留行的 DOM 与开关状态）。

## Props / 内部状态

### `ApiResult<T>`（**导出类型**，全项目写操作的统一外壳）

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `data` | `T \| undefined` | 成功时的响应体（数据已刷新） | 由 `App.mutate` 在成功分支填充；**调用方据此判定成功** |
| `code` | `string \| undefined` | 失败时的业务错误码 | 例如 `takeover-required`（可重试的接管确认分支）、`aborted`（卸载取消，UI 上会被当成失败） |
| `message` | `string \| undefined` | 失败时的可读消息 | 未知错误码时直接展示；已知错误码前会拼 `ERROR_CODE_LABEL` |

### `MappingPanelProps`（导出接口，全部必填）

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `mappings` | `MappingView[]` | 当前映射列表 | 无默认；`App` 传 `mappings?.mappings ?? []` |
| `counts` | `MappingCounts \| null` | 各状态条数 | 无默认；`null` 时表头不显示统计片段 |
| `planSummary` | `PlanSummary \| null` | 期望/实际差异摘要 | 无默认；`null` 或 `inSync` 时不显示「需同步」 |
| `loading` | `boolean` | 读取中 | 无默认；仅影响空数据文案 |
| `adminPort` | `number` | 管理端口 | 无默认；用于本地拦截（`EditRow` 的两条校验） |
| `services` | `ServiceInfo[]` | Tailscale Service 列表 | 无默认；空数组时不挂 `datalist` |
| `busy` | `boolean` | 全局加载态 | 无默认；禁用保存/删除/开关 |
| `updateMapping` | `(id: string, input: MappingInput) => Promise<MutationResult>` | 更新写操作 | 无默认 |
| `deleteMapping` | `(id: string) => Promise<ApiResult<unknown>>` | 删除写操作 | 无默认；成功只判 `data !== undefined` |
| `setEnabled` | `(id: string, enabled: boolean) => Promise<MutationResult>` | 启停写操作 | 无默认；传目标状态而非「取反」 |
| `onNotify` | `(level: 'info' \| 'success' \| 'warn' \| 'error', title: string, message?: string) => void` | 成功/提示出口 | 无默认；`App` 传 `notify` |
| `onCopied` | `(ok: boolean, label: string, value: string) => void` | 复制结果出口 | 无默认；`App` 传 `handleCopied` |

### `MappingStatus` 与 `STATUS_META`（模块级常量，8 个状态）

| `status` | `label` | `cls` | `hint` |
| --- | --- | --- | --- |
| `active` | 已生效 | `status-active`（绿） | serve 配置与期望一致 |
| `pending` | 待同步 | `status-pending`（黄） | serve 配置缺失或指向别处，需要「重新同步」 |
| `disabled` | 已禁用 | `status-disabled`（灰） | 在 TsController 中被禁用，serve 中已无该路径 |
| `disabled-drift` | 禁用漂移 | `status-drift`（橙） | 已禁用但 serve 中仍有残留路由 |
| `orphaned-target` | 目标失联 | `status-orphan`（橙） | 目标容器没有运行中的容器发布该端口 |
| `blocked` | 被阻止 | `status-blocked`（红） | 该映射会暴露管理端口，被安全策略拒绝 |
| `conflict` | 路径冲突 | `status-conflict`（红） | 期望路径被外部未托管路由占用 |
| `awaiting-approval` | 等待审批 | `status-approval`（**冷色**） | `AWAITING_APPROVAL_HELP` 全文 |

### `EditRow` 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `service` | `string` | Service 输入原文 | `mapping.service ?? ''`；提交时归一化，空 = `null` |
| `remoteHost` | `string` | 代理目标主机 | `mapping.target.remoteHost ?? ''`；非 Service 级时输入框禁用但文本保留 |
| `path` | `string` | 挂载路径 | `mapping.path`；提交只 `trim()` |
| `servePort` | `string` | 对外端口（文本） | `String(mapping.servePort)` |
| `hostPort` | `string` | 目标端口（文本） | `String(mapping.target.hostPort)` |
| `targetPath` | `string` | 目标路径 | `mapping.target.targetPath` |
| `note` | `string` | 备注 | `mapping.note` |
| `pendingTakeover` | `string \| null` | 待确认接管说明 | `null`；非 `null` 时渲染接管确认块 |
| `saving` | `boolean` | 保存中 | `false`；与 `busy` 取或 |
| `error` | `string \| null` | 行内错误 | `null` |
| `serviceListId` | `string` | `datalist` id | `useId()` |

### `MappingRow` / `MappingPanel` 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `confirmDelete`（`MappingRow`） | `boolean` | 删除二次确认开关 | `false`；发请求前先置回 `false` |
| `editingId`（`MappingPanel`） | `string \| null` | 当前编辑行的映射 id | `null`；单值 ⇒ 同时只一行可编辑；不随刷新清理 |

### 模块级常量

| 名称 | 类型 | 含义 | 边界 |
| --- | --- | --- | --- |
| `AWAITING_APPROVAL_HELP` | `string`（常量） | `awaiting-approval` 的完整说明 | 明确写出可执行的下一步：Services → 该 Service → Service hosts → Approve，或在 ACL 配 `autoApprovers.services` |
| `STATUS_META` | `Record<MappingStatus, StatusMeta>` | 状态 → 标签/配色/说明 | 八项穷举；运行期不防未知状态 |

## 待办与隐患

- [ ] 无 TODO / FIXME 标记。已知取舍与真实边界：
  - **`service` / `remoteHost` 必须显式下发（含 `null`）**：后端 PATCH 语义下「省略 = 不改动」，任何把它们改成条件展开（`...(x ? { service: x } : {})`）的重构都会让「清空 Service / 清空远端主机」静默失效，这是本文件最容易被误改的一处；
  - **写操作响应形状不符时用可选链**（`result.data?.mapping`）：避免后端返回意外 JSON 时读属性抛 `TypeError` 导致整页白屏（`App.tsx` 没有错误边界）；
  - 编辑表单不跟随 prop 刷新（挂载时取初值），编辑期间点「刷新」会出现「表格是新数据、表单是旧数据」，保存时容器三元组取自新 `mapping`、其余取自表单；
  - `EditRow` 的路径只 `trim()`、不归一化，与 `ContainerPanel` 的 `normalizePathInput` 口径不同（后者会折叠重复斜杠、去掉尾斜杠）；
  - `StatusBadge` 对未知 `status` 不设防，且 `detail === ''` 会让 `title` 变空（`??` 不兜空串）；
  - 开关失败会视觉回弹，但**不会**给出「操作未生效」之外的额外说明（`setEnabled` 的失败提示由 `App` 的 toast 承担）。
