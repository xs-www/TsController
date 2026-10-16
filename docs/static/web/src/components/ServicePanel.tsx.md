# `web/src/components/ServicePanel.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

Tailscale Service 面板：回答「本节点上的 Service 现在是什么状态」——MagicDNS 名、对外端口、TailVIP，以及最关键的一项**本节点是否已被承认为该 Service 的 host**。后者决定「serve 配置写对了但对外仍不通」，因此未承认时面板就地展开可执行的处理办法（管理后台 Approve / `autoApprovers.services`），而不是只亮一个黄灯。

## 依赖 / 引用

- 外部：`react` 的 `JSX`（仅类型导入）。
- 同项目：`../api` 的 `ServiceInfo`（仅类型）；`./CopyButton`；`../utils` 的 `serviceShortName`。
- 引用它的人：`web/src/App.tsx`（唯一调用点，`services` / `selfTags` / `canHostService` 分别来自 `mappings?.services ?? system?.services ?? []`、`mappings?.selfTags ?? system?.selfTags ?? []`、`system?.canHostService ?? false`）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `ServicePanel` | `({ services, selfTags, canHostService, loading, onCopied }: ServicePanelProps) => JSX.Element \| null` | `JSX.Element \| null` | Service 状态面板（列表 / 空态 / 无 tag 说明） | `services.length === 0 && selfTags.length === 0` → 精简版面板（只有标题 + 一行文案）；标签列表与 `canHostService` 不一致时会出现分支错配（见边缘条件） |
| `services.map((s) => …)`（内联列表项渲染） | `(s: ServiceInfo) => JSX.Element` | `JSX.Element` | 单个 Service 卡片 | 每张卡片的 `key` 取 `s.name`（同名 Service 会产生重复 key）；`advertised === false` 时追加审批帮助；`servePorts` 为空时追加 endpoint 提示 |

## 函数详情

### `ServicePanel({ services, selfTags, canHostService, loading, onCopied })`

- **签名**：`({ services, selfTags, canHostService, loading, onCopied }: ServicePanelProps) => JSX.Element | null`
- **入参**：
  - `services`（`ServiceInfo[]`，必选）：来自 `/api/mappings`（`system` 作兜底），每项含 `name` / `dnsName` / `servePorts` / `advertised` / `vipIps`；
  - `selfTags`（`string[]`，必选）：本节点 tag；**空数组 = 本节点不可能充当 Service host**；
  - `canHostService`（`boolean`，必选）：后端结论「是否具备充当 Service host 的身份前提」，与 `selfTags.length > 0` 同义但由后端给出；
  - `loading`（`boolean`，必选）：**只影响两处空态文案**，不遮蔽列表、不禁用复制按钮；
  - `onCopied`（`(ok: boolean, label: string, value: string) => void`，必选）：复制结果上报；本文件只在 MagicDNS 名存在时使用。
- **出参**：`JSX.Element`（`section.panel`）——注意返回类型标了 `| null`，但函数体内**没有任何 `return null` 分支**，实际总是渲染面板。
- **功能**：两个顶层分支：(1) `services.length === 0 && selfTags.length === 0` → 只渲染 `panel-head`（meta 固定「本节点不是任何 Service 的 host」）与一段 `p.empty`；(2) 否则渲染完整面板——`panel-meta` 显示计数并附 tag 摘要（`canHostService` 为真时列 tag，否则提示「本节点无 tag，不能充当 Service host」），`!canHostService` 时先插一条 `warn-inline`（`role="note"` + 「注意」徽标 + `NO_TAG_HELP`），随后按 `services.length` 渲染空态段落或 `ul.service-list`；末尾在 `canHostService && services.length > 0` 时补一段「Service 对外名 vs 节点级主机名」的说明。
- **边缘条件**：
  - `services` 与 `selfTags` 同时为空 → 精简分支；此时 `canHostService` 完全不参与判断，即使它为 `true`（后端数据自相矛盾）也只显示那行「不是任何 Service 的 host」；
  - `loading === true` → 只把空态文案换成「正在读取 Service 状态…」；两个分支各有一份该文案（精简分支与列表空态分支），已加载过的旧列表不会被骨架屏替换；
  - `services.length === 0` 但 `selfTags.length > 0` → 走完整分支，空态文案区分 loading：「正在读取 Service 状态…」或「本节点有 tag 身份，但当前没有配置任何 Tailscale Service…」；
  - `canHostService === false` 但 `selfTags.length > 0` → 精简分支不会触发（因为 tag 非空），界面会同时显示 `warn-inline` 警告与 tag 列表的**省略**（meta 只显示「本节点无 tag，不能充当 Service host」，不列出实际 tag）；
  - `canHostService === true` 但 `selfTags` 为空 → meta 会渲染成 `· 本节点 tag：`（冒号后为空），不报错；
  - `services.length > 0` 且 `canHostService === false` → 列表照常渲染，每张卡片仍可能标「已承认」，此时是后端数据前后矛盾（标签身份与广告承认不是同一件事），本组件不做交叉校验；
  - `loading` 期间 `CopyButton` 依然可点（没有 `disabled` 传递），复制的是上一次响应的 `dnsName`；
  - 顶部说明段落只在 `canHostService && services.length > 0` 时出现；`canHostService && services.length === 0` 时该提示不渲染，用户看不到主机名差异说明。

### `services.map((s) => …)`（内联列表项渲染）

- **签名**：`(s: ServiceInfo) => JSX.Element`
- **入参**：`s`（`ServiceInfo`，由 `services` 数组逐项给出）：`name`（`svc:dsh`）、`dnsName`（可为 `null`）、`servePorts`（升序数组）、`advertised`、`vipIps`（可为空）。
- **出参**：`JSX.Element`，`li.service-card`：`service-head`（原名 + 承认状态徽标）→ `dl.service-grid`（MagicDNS 名 / 对外端口 / TailVIP）→ 可选的两段帮助文本。
- **功能**：`advertised === true` 渲染绿色 `pill` 「已承认」（`title` 说明 Service 级路由对外可用）；`false` 渲染 `pill-calm` 「等待审批」（`title` 说明广告尚未批准）并在卡片底部追加 `APPROVAL_HELP`。MagicDNS 名存在时显示裸名 + 「复制地址」按钮（复制值是 `https://${s.dnsName}`，不是裸名）；`servePorts` 为空显示 muted「未配置」并追加「必须与 Service 的 endpoint 端口一致」的提示；`vipIps` 为空显示 muted「未知」，否则逐 IP 渲染 `span.service-vip`。
- **边缘条件**：
  - `key={s.name}`：若同一响应里出现两个同名 Service，会产生重复 key（React 警告，可能复用节点）；
  - `s.dnsName === null` → 只渲染 muted「未知」，**没有** `CopyButton`（与 `TopBar` 的 `baseUrl === null` 分支同一策略）；`dnsName` 为空串（类型上可能）会渲染空文本 + 一个值为 `https://` 的复制按钮；
  - `s.servePorts.length === 0` → 「未配置」+ 端点提示两段都出现，文案强调「对外端口必须与这里列出的端口一致，否则写入 serve 后依然不会对外可用」；
  - `s.vipIps` 用 IP 作 `key`：同一 Service 重复返回同一 IP 会撞 key；
  - `serviceShortName(s.name)` 的结果**只用于 toast 文案**（`Service ${short} 地址`），卡片标题仍显示带 `svc:` 前缀的原始 `s.name`；
  - `onCopied` 的 `label` 形如 `Service dsh 地址`，`value` 是 `CopyButton` 回传的实际复制内容；
  - 卡片内的两个帮助段落互相独立：未承认 + 无端口时会同时出现「去后台 Approve」与「endpoint 未配置」两段提示。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `services` | `ServiceInfo[]` | 本节点的 Service 列表 | 无默认值（必选）；空数组 + `selfTags` 空 → 精简分支 |
| `selfTags` | `string[]` | 本节点 tag | 无默认值（必选）；空数组表示不可能充当 Service host |
| `canHostService` | `boolean` | 是否具备充当 Service host 的身份前提 | 无默认值（必选）；`App` 用 `system?.canHostService ?? false`，`system` 未加载时恒为 `false` |
| `loading` | `boolean` | 是否正在读取 | 无默认值（必选）；只切两处空态文案，不影响列表与按钮 |
| `onCopied` | `(ok: boolean, label: string, value: string) => void` | 复制结果上报 | 无默认值（必选）；仅 MagicDNS 名非 `null` 时被调用 |
| `NO_TAG_HELP`（模块常量） | `string` | 无 tag 的完整说明（为什么不可用 + 两条出路） | 在精简分支与 `warn-inline` 中各用一次；精简分支会再拼上「当前节点上也没有配置任何 Service。」（中间无空格） |
| `APPROVAL_HELP`（模块常量） | `string` | 未被承认时的处理办法 | 仅在 `advertised === false` 时渲染 |
| 内部状态 | 无 | 无 `useState` / `useEffect` / `useRef` / `useId()` | — |

## 待办与隐患

- [ ] 无 TODO 标记。真实边界：返回类型写着 `JSX.Element | null` 但函数体没有任何提前 `return null`，调用方无需做空值兜底——类型比实现更宽松。
- [ ] `canHostService` 与 `selfTags.length > 0` 是两个可独立变化的输入：`canHostService === false && selfTags.length > 0` 时不显示实际 tag 列表，`canHostService === true && selfTags.length === 0` 时 meta 会渲染出空的 `tag：`，建议统一以 `selfTags` 为准或加断言。
- [ ] `services.map` 的两个帮助段落没有与「已承认 + 无端口」等组合做过互斥，极端数据下同一张卡片会同时出现「去 Approve」与「endpoint 未配置」两类建议。
