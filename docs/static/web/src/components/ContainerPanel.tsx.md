# `web/src/components/ContainerPanel.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

「Docker 容器」面板：按容器列出已发布到宿主机的端口，并可就地为某个端口展开一张内联表单直接创建映射。面板本身**不发请求**——真正的写操作由 `App` 通过 `createMapping` prop 注入，这里只负责校验与结果解释。

## 依赖 / 引用

- 外部模块：`react`（`useEffect` / `useId` / `useState` / `type JSX`）。
- 同项目文件：
  - `../api`：`ERROR_CODE_LABEL`（错误码中文前缀）、类型 `ContainerInfo` / `ContainerPort` / `MappingInput` / `MappingMutationResponse` / `ServiceInfo`；
  - `./MappingPanel`：`type ApiResult`（写操作结果外壳，见 `web/src/components/MappingPanel.tsx.md`）；
  - `../utils`：`defaultPathFor`（默认路径）、`formatRouteLabel`（成功提示里的路由标签）、`formatTarget`（预览目标地址）、`formatTimestamp`（创建时间）、`isWildcardHost`（全网卡判定）、`normalizePathInput`、`normalizeServiceInput`、`serviceShortName`；
  - 样式类来自 `../styles.css`（`.container-list` / `.container-card` / `.port-table` / `.inline-form*` / `.warn-inline` 等）。
- 被引用：`web/src/App.tsx` 第 32、371-381 行渲染 `<ContainerPanel … />`，并注入 `containers` / `adminPort` / `defaultServePort={system?.servePort ?? 443}` / `services` / `canHostService={system?.canHostService ?? false}` / `busy` / `createMapping` / `onNotify={notify}`。本文件的 `CreateMappingFn` / `CreateMappingResult` 只在本文件内使用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `ContainerMappingForm` | `(props: InlineFormProps) => JSX.Element` | `JSX.Element` | 单端口的内联「创建映射」表单 | 容器/端口/默认端口变化时整表重置；不做管理端口校验 |
| `ContainerMappingForm.submit` | `(confirmTakeover: boolean) => Promise<void>` | `Promise<void>` | 校验输入 → 调 `createMapping` → 解释结果 | 校验不过只设行内错误、不发请求；`takeover-required` 转成确认块 |
| `ContainerPanel` | `(props: ContainerPanelProps) => JSX.Element` | `JSX.Element` | 容器列表 + 端口表 + 展开表单 | 空清单给定向文案；`openKey` 不随刷新清理；行 key 可能重复 |
| （内联处理器） | `onCancel: () => void`、`onCreated: (m) => void` | `void` | 收起表单 / 收起并弹成功提示 | 两者都不做额外校验；`onCreated` 用渲染时捕获的 `p` 拼提示文案 |

## 函数详情

### `ContainerMappingForm({ container, port, defaultServePort, services, canHostService, busy, onCancel, createMapping, onCreated })`

- **签名**：`(props: InlineFormProps) => JSX.Element`（`InlineFormProps` 为本文件私有接口）。
- **入参**：
  - `container`（`ContainerInfo`，必选）：目标容器（用于默认路径、`kind: 'container'` 三元组）；
  - `port`（`ContainerPort`，必选）：被映射的那条宿主机端口记录（`hostIp` / `hostPort` / `containerPort` / `protocol`）；
  - `defaultServePort`（`number`，必选）：对外 HTTPS 端口的预填值（由 `App` 传 `system?.servePort ?? 443`）；
  - `services`（`ServiceInfo[]`，必选）：用于 `datalist` 快速选择，空数组时不挂 `list`；
  - `canHostService`（`boolean`，必选）：`false` 时显示「无 tag」告警；
  - `busy`（`boolean`，必选）：全局加载态，与内部 `submitBusy` 取或后禁用按钮；
  - `onCancel`（`() => void`，必选）：收起表单（由父级把 `openKey` 置 `null`）；
  - `createMapping`（`CreateMappingFn`，必选）：`(input: MappingInput) => Promise<ApiResult<MappingMutationResponse>>`；
  - `onCreated`（`(mapping: { servePort; path; service }) => void`，必选）：创建成功后的回调。
- **出参**：`JSX.Element`，一段 `.inline-form`。
- **功能**：维护 7 个文本字段（Service、路径、对外端口、代理目标主机、目标端口、目标路径、备注）与 3 个状态（`pendingTakeover` / `submitBusy` / `error`）；渲染字段网格、按需的「无 tag」告警、访问地址→目标的预览、路径剥离说明、Service 级说明、接管确认块、错误块与两个按钮。`serviceMode`（`normalizedService !== ''`）决定「代理目标主机」字段是否出现、目标端口标签是「目标主机端口」还是「本机端口」。
- **边缘条件**：
  - `useEffect` 的依赖是 `[container.id, container.name, port.hostPort, port.containerPort, defaultServePort]`：这些值变化时**全部字段与错误被重置**，用户正在输入的内容会丢失——由于依赖是原始值而非对象引用，常规的后台刷新（同一容器同一端口）不会触发重置；
  - `remoteHost` 输入框只在 `serviceMode` 为真时渲染，从「Service 级」切回「节点级」会让已输入的远端主机文本从界面上消失，但 state 中仍保留；提交时 `serviceMode === false` 就不会带上 `remoteHost`，不会误发；
  - 预览用 `Number.isInteger(Number(hostPort)) ? Number(hostPort) : port.hostPort`：输入非法时预览回落到真实端口，避免显示 `NaN`；
  - `canHostService === false` 时只显示告警，**不阻止提交**——「无 tag」是身份前提问题，最终由后端与管理员审批决定；
  - `useId()` 生成 `serviceListId`：即使同一容器展开多个表单，`datalist` 的 id 也不会撞车。

### `ContainerMappingForm.submit(confirmTakeover)`

- **签名**：`(confirmTakeover: boolean) => Promise<void>`
- **入参**：`confirmTakeover`（`boolean`，必选）：`true` 表示「确认接管」按钮触发的重试，会把 `confirmTakeover: true` 一并下发。
- **出参**：`Promise<void>`（调用点用 `void submit(...)` 显式忽略）。
- **功能**：依次校验目标端口 → 对外端口 → 路径，然后 `setSubmitBusy(true)` / `setError(null)`，调 `createMapping` 并解释三种结果：(1) `result.data?.mapping` 有值 → 清空接管态并 `onCreated(...)`；(2) `result.code === 'takeover-required'` → 把 `result.message`（缺省时用兜底文案「该路径已被一条未托管的 serve 路由占用」）放进 `pendingTakeover`，渲染确认块；(3) 其余 → 行内错误。`finally` 里 `setSubmitBusy(false)`。
- **边缘条件**：
  - 校验顺序固定，命中即 `return`：`hostPort` 必须是 1-65535 的整数（错误「目标端口必须是 1-65535 的整数」）→ `servePort` 同理（「对外端口必须是 1-65535 的整数」）→ `normalizePathInput(path) === ''` 时「路径不能为空，且必须以 "/" 开头」。注意 `Number('')` 是 `0`，会被判为非法；`Number('0x10')` 是合法的 `16`，会被放行（依赖后端 `invalid-port` 兜底）；
  - **`service` 一律显式下发**：`normalizedService === '' ? null : normalizedService`。空串写 `null` 是刻意的——后端是 PATCH 语义，字段省略 = 不改动，若省略 `service`，在 Service 级路由上「清空 Service 切回节点级」的操作会被静默忽略；
  - `remoteHost` 只在 `serviceMode && trimmedRemoteHost !== ''` 时通过条件展开写入，否则**整个字段不出现**在请求体里（后端只在 Service 级路由上接受它）；
  - `confirmTakeover` 同样用条件展开，只有确认为 `true` 时才带上；
  - **本表单不做管理端口校验**（`adminPort` 根本没传进来）：拦截靠父级把 `p.hostPort === adminPort` 的按钮禁用，服务端再用 `exposes-admin` 兜底；
  - **写操作响应形状不符时用可选链防白屏**：`result.data?.mapping` 与后续显式的 `result.data !== undefined` 判断，避免「成功外壳但缺 `mapping`」时读取属性抛 `TypeError`；这种情况会给出「创建接口返回了意外的响应（缺少 mapping 字段），请刷新后重试」；
  - 错误文案前缀只在 `ERROR_CODE_LABEL[result.code] !== undefined` 时拼接，未知错误码直接用后端 `message`，两者都缺时回落「创建失败」；
  - 首次 409 时用户会**同时**看到 `App` 的 `warn` toast（`mutate` → `notifyError`）与本表单的接管确认块，这是双重反馈但语义不冲突；
  - 确认接管按钮再次走完整校验，因此期间若用户改了字段，会按新值校验；接管成功或明确失败后才清掉 `pendingTakeover`。

### `ContainerPanel({ containers, loading, adminPort, defaultServePort, services, canHostService, busy, createMapping, onNotify })`

- **签名**：`(props: ContainerPanelProps) => JSX.Element`
- **入参**：`containers`（`ContainerInfo[]`，必选，默认无——`App` 保证至少传 `[]`）、`loading`（`boolean`，必选）、`adminPort`（`number`，必选，用于禁用管理端口行）、`defaultServePort`（`number`，必选）、`services`（`ServiceInfo[]`，必选）、`canHostService`（`boolean`，必选）、`busy`（`boolean`，必选）、`createMapping`（`CreateMappingFn`，必选）、`onNotify`（`(level, title, message?) => void`，必选）。
- **出参**：`JSX.Element`，一个 `.panel` 区块。
- **功能**：统计 `running`（`state === 'running'` 的数量）并按「运行中优先、其次按名字」排序后渲染容器卡片；每张卡片显示名称、状态 pill、compose 项目/服务、镜像、`status`、创建时间、id 前 12 位、必要的「全网卡」告警，以及一张端口表。端口表按 `openKey` 决定是否在行下追加一行承载 `ContainerMappingForm`。
- **边缘条件**：
  - **空清单**：`containers.length === 0` 时渲染「没有发现容器。请确认 Docker 正在运行，或检查上方「Docker 数据源」是否正确。」；同时若 `loading` 为真则再显示「正在读取容器清单…」——两条文案可能同时出现（首屏即空）；
  - `running` 只认字符串 `'running'`：`paused` / `restarting` / `created` 等状态既不计入「运行中」，排序时也被排到后面，卡片带 `.container-idle`（`opacity: .72`）；
  - 端口行为空的容器只显示「该容器没有发布任何宿主机端口，无法建立映射。」，不渲染表；
  - 只要有任意一条端口记录的 `hostIp` 命中 `isWildcardHost`（`0.0.0.0` / `::`，方括号会被剥掉），整张卡片显示黄色告警：该端口监听全部网卡，tailnet 内设备可绕过本工具直连 `100.x` 地址；
  - 管理端口行：`p.hostPort === adminPort` 时打 `badge-danger`「管理端口」并把「建立映射」按钮 `disabled`（title 说明禁止原因）；
  - **`flatMap` 生成的行 key 是** `` `${c.id}:${p.hostIp}:${p.hostPort}:${p.containerPort}:${p.protocol}` ``：Docker 若对同一容器上报两条完全相同的端口记录（例如同端口同时出现在两张网卡上而 `hostIp` 也相同），React 会收到重复 key 并告警；正常数据下 `hostIp` 不同即不冲突；
  - `openKey` 是单一字符串，**同时最多展开一个表单**；点击已展开的行按钮会收起（`setOpenKey(isOpen ? null : key)`）；刷新后若该端口仍在，展开态保留；若容器消失，`openKey` 仍指向旧值，只是不再有匹配行（无副作用残留）；
  - 表单的 `key` 由 `flatMap` 里的 `` `${key}:form` `` 决定，端口记录消失即卸载表单，内部 state 一并丢弃；
  - `c.id.slice(0, 12)` 与 `c.image` 直接使用，不做空值保护（由 `api.ts` 的类型与后端契约保证非空）；
  - 排序用 `a.name.localeCompare(b.name)`（未指定 locale），中文/大小写混排时顺序依赖运行环境默认排序规则。

### 内联处理器（`onCancel` / `onCreated`）

- **签名**：`onCancel: () => void`；`onCreated: (created: { servePort: number; path: string; service: string | null }) => void`
- **入参**：`onCreated` 的 `created` 来自 `result.data.mapping` 的三个字段（`servePort` / `path` / `service`）。
- **出参**：`void`。
- **功能**：`onCancel` 把 `openKey` 置 `null`（收起表单）；`onCreated` 也把 `openKey` 置 `null`，并调 `onNotify('success', '映射已创建', …)`，正文形如「`svc:dsh:8443/worldforge` 已指向 `127.0.0.1:8080`」。
- **边缘条件**：
  - 成功提示里的目标地址用的是**渲染时捕获的** `p`（闭包），不是重新查询的容器状态：若期间容器重启导致端口变化，提示仍显示旧端口（提示与后端实际一致，因为请求就是按旧值发的）；
  - `formatRouteLabel(created.servePort, created.path, created.service)` 已包含 Service 与端口信息，因此提示里不再重复；
  - 表单的「收起」按钮 `disabled={submitBusy}`（提交中不能收起），而「确认接管」块里的「取消接管」与 `onCancel` 无关——它只清 `pendingTakeover`，表单保持展开。

## Props / 内部状态

### `ContainerPanelProps`（导出接口，全部必填，无默认值）

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `containers` | `ContainerInfo[]` | 容器清单 | 无默认；`App` 传 `containers` state（至少 `[]`） |
| `loading` | `boolean` | 读取中 | 无默认；仅用于空清单时的加载文案 |
| `adminPort` | `number` | 管理端口 | 无默认；`App` 传 `system?.adminPort ?? 8787`，可能与真实端口不同（首屏） |
| `defaultServePort` | `number` | 新建映射的对外端口预填值 | 无默认；`App` 传 `system?.servePort ?? 443` |
| `services` | `ServiceInfo[]` | Tailscale Service 列表 | 无默认；空数组时不挂 `datalist` |
| `canHostService` | `boolean` | 本节点是否具备充当 Service host 的身份前提 | 无默认；`App` 传 `system?.canHostService ?? false`，未加载时按 `false`（会显示告警） |
| `busy` | `boolean` | 全局加载态 | 无默认；与内部 `submitBusy` 取或 |
| `createMapping` | `CreateMappingFn` | 写操作入口 | 无默认；由 `App` 提供 |
| `onNotify` | `(level, title, message?) => void` | 成功/提示反馈 | 无默认；`App` 传 `notify`（不带错误码） |

### `InlineFormProps`（私有接口，全部必填）

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `container` / `port` | `ContainerInfo` / `ContainerPort` | 目标容器与端口 | 无默认 |
| `defaultServePort` | `number` | 对外端口预填 | 无默认 |
| `services` / `canHostService` | `ServiceInfo[]` / `boolean` | 选择项与身份告警 | 无默认 |
| `busy` | `boolean` | 外部加载态 | 无默认 |
| `onCancel` / `onCreated` | 回调 | 收起 / 成功后回调 | 无默认 |

### `ContainerMappingForm` 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `service` | `string` | Service 输入原文（可为 `dsh` 或 `svc:dsh`） | `''`；经 `normalizeServiceInput` 归一化，空串 = 节点级 |
| `remoteHost` | `string` | 代理目标主机 | `''`；仅 `serviceMode` 为真时渲染且会被下发 |
| `path` | `string` | 对外挂载路径 | `defaultPathFor(container.name)`（`/` + slug） |
| `hostPort` | `string` | 目标端口（文本） | `String(port.hostPort)` |
| `servePort` | `string` | 对外 HTTPS 端口（文本） | `String(defaultServePort)` |
| `targetPath` | `string` | 转发时追加的目标路径 | `''` = 不追加 |
| `note` | `string` | 备注 | `''` |
| `pendingTakeover` | `string \| null` | 待确认接管的说明文案 | `null`；非 `null` 时渲染 `role="alert"` 确认块 |
| `submitBusy` | `boolean` | 本表单提交中 | `false`；与 `busy` 取或后禁用全部按钮 |
| `error` | `string \| null` | 行内错误 | `null`；校验失败与业务失败共用同一位置 |
| `serviceListId` | `string` | `datalist` 的 id | `useId()` 生成 |

### `ContainerPanel` 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `openKey` | `string \| null` | 当前展开表单的端口行 key | `null`；全局同时只允许一行展开 |

### 模块级常量

| 名称 | 类型 | 含义 | 边界 |
| --- | --- | --- | --- |
| `WILDCARD_WARNING` | `string`（常量） | 端口监听全部网卡时的黄色警示文案 | 同时用作卡片告警与「全网卡」徽标的 `title` |
| `NO_TAG_WARNING` | `string`（常量） | 本节点无 tag 时「不可能充当 Service host」的说明 | 只在 `canHostService === false` 时渲染，不阻止提交 |

## 待办与隐患

- [ ] 无 TODO / FIXME 标记。已知取舍与真实边界：
  - 「目标路径」与「挂载路径」的关系是**必须留在界面上**的解释成本：挂载路径在转发时会被剥掉，决定命中后端哪条路由的是目标路径；表单用两段 hint 文案说明，并给出 `/api/addSchedule` + `/api/agent/events` 的例子；
  - 目标端口只用 `1-65535` 的整数校验，**不做与 `adminPort` 的比对**（`adminPort` 未传入表单），管理端口拦截完全落在父级的按钮禁用与服务端 `exposes-admin` 上；
  - 容器/端口变化会重置整张表单（`useEffect` 全量 `setState`），用户在刷新间隙的输入可能丢失；
  - 端口行的 React key 依赖 `hostIp` 唯一性，Docker 上报重复记录时会触发重复 key 告警。
