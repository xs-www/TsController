# `web/src/components/TopBar.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

顶部信息条：只读展示一份 `SystemInfo`（tailnet 地址、管理地址、tailscaled 状态、serve 端口/主机名、Docker 与 Tailscale 数据源、数据目录、快照路径）。本组件不发请求、不持有状态，唯一的交互「复制」也交给 `CopyButton`，结果通过 `onCopied` 上交给 `App` 去弹 toast。

## 依赖 / 引用

- 外部：`react` 的 `JSX`（**仅类型导入**，不引入任何 hook 或运行时值）。
- 同项目：`../api` 的 `SystemInfo`（仅类型）；`./CopyButton` 的 `CopyButton`；`../utils` 的 `formatTime`。
- 引用它的人：`web/src/App.tsx`（唯一调用点，`<TopBar system={system} loading={busy} lastUpdated={lastUpdated} onCopied={handleCopied} />`）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `StatePill` | `({ state }: { state: string \| null }) => JSX.Element` | `JSX.Element` | 把 tailscaled 状态渲染成彩色徽标 | `null` / `''` → 灰色「未知」；仅 `running`（大小写不敏感）为绿，其余一律红；首尾空白不 trim |
| `TopBar` | `({ system, loading, lastUpdated, onCopied }: TopBarProps) => JSX.Element` | `JSX.Element` | 顶部信息条整体 | `system === null` 时早退为「品牌区 + 一行占位文案」，`loading` 决定占位文案；该分支不渲染任何 `CopyButton` |

## 函数详情

### `StatePill({ state })`

- **签名**：`({ state }: { state: string | null }) => JSX.Element`
- **入参**：
  - `state`（`string | null`，必选）：来自 `SystemInfo.backendState`，后端未采集到时为 `null`。
- **出参**：`JSX.Element`，一个 `span.pill`；文本是该 state 的**原样输出**（不做中文化映射）。
- **功能**：判定条件是 `state.toLowerCase() === 'running'`，命中渲染 `pill-green`，否则 `pill-red`。
- **边缘条件**：
  - `state === null` 或 `state === ''` → 固定渲染 `pill-grey` + 「未知」，不会出现空徽标；
  - 任何非 `running` 的值（`Stopped` / `NeedsLogin` / `NoState` …）→ 红徽标并原样显示该值，没有第三种颜色；
  - 不做 `trim()`，因此 `' running'` 会落到红徽标分支。

### `TopBar({ system, loading, lastUpdated, onCopied })`

- **签名**：`({ system, loading, lastUpdated, onCopied }: TopBarProps) => JSX.Element`
- **入参**：
  - `system`（`SystemInfo \| null`，必选）：`null` = 尚未取到系统信息；
  - `loading`（`boolean`，必选）：**仅**在 `system === null` 分支使用，其余情况传什么都无影响；
  - `lastUpdated`（`string \| null`，必选）：ISO 时间串，用于「· 更新于 …」；
  - `onCopied`（`(ok: boolean, label: string, value: string) => void`，必选）：来自 `CopyButton` 的 `onResult`，`label` 由本文件硬编码。
- **出参**：`JSX.Element`，`header.topbar`：品牌区 + `dl.topbar-grid`（8 个 `topbar-cell`）。
- **功能**：把 `SystemInfo` 摊平成只读信息网格。tailnet 地址与管理地址各带一个 `CopyButton`；Tailscale 单元格为 `StatePill` + `serveHost`（+ 版本）；端口/主机名单元格做 `servePorts` → `servePort` 的回落；最后三个 wide 单元格分别显示 `sources.docker` / `sources.tailscale` / `sources.dataDir`（附 `formatTime(lastUpdated)`），以及 `sources.snapshotFile`（附「复制路径」按钮）。
- **边缘条件**：
  - `system === null` → 早退分支：只渲染品牌区，`topbar-empty` 显示 `loading ? '正在读取系统信息…' : '系统信息不可用'`；此时 `lastUpdated` 与 `onCopied` 完全不参与渲染；
  - `system.baseUrl === null` → tailnet 地址单元格只渲染 muted 文本 `system.dnsName ?? '未获取到 tailnet 域名'`，**既没有链接也没有复制按钮**（即便 `dnsName` 有值也拿不到复制入口）；
  - `system.tailscaleVersion === null` → 不追加版本后缀；非空时拼成 ` · v${version}`（`v` 是前端加的前缀）；
  - `system.serveHost === null` → 显示「无 Web 服务」；
  - `system.servePorts` 为空数组 → 端口位置回落为 `String(system.servePort)`（默认对外端口），不是「无」也不是空串；
  - `system.tailnetIps` 为空数组 → 含前导 ` · ` 的整段 IP 后缀不渲染（`null` 返回的是 `null`，不是空串）；
  - `lastUpdated === null` → 数据目录单元格只显示路径，不显示「更新于」；
  - `sources.snapshotFile` 为空串 → 不禁用也不隐藏，「复制路径」按钮由 `CopyButton` 自身进入 `disabled` 态（`title` 也会退化为空串，见 `CopyButton.tsx.md`）；
  - `adminUrl` 在类型上不可空，因此该单元格**总是**渲染 `<a href={system.adminUrl}>` 与复制按钮；链接均为 `target="_blank" rel="noreferrer noopener"`；
  - 深层字段（`system.sources.*`、`system.servePorts`）刻意不做可选链：JSON 契约若缺 `sources`，这里直接抛 `TypeError`（只靠后端契约与 TS 类型保证，前端无兜底、无错误边界）。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `system` | `SystemInfo \| null` | 系统信息快照 | 无默认值（必选）；`null` 触发早退分支 |
| `loading` | `boolean` | 是否正在读取 | 无默认值（必选）；只在 `system === null` 时可见 |
| `lastUpdated` | `string \| null` | 最近一次数据刷新时间（ISO 串） | 无默认值（必选）；`null` 时整段「更新于」不渲染 |
| `onCopied` | `(ok: boolean, label: string, value: string) => void` | 复制结果上报（调用方弹 toast） | 无默认值（必选）；`ok=false` 的文案由调用方决定 |
| `state`（`StatePill` 的 props） | `string \| null` | tailscaled 后端状态 | 无默认值；`null` / `''` → 「未知」 |
| 内部状态 | 无 | 本文件不使用 `useState` / `useEffect` / `useRef`，无 `useId()` | — |

## 待办与隐患

- [ ] 无 TODO 标记。真实边界：`baseUrl === null` 时 `dnsName` 只以纯文本呈现、无复制入口，与同一网格里其余单元格的交互不一致。
- [ ] `onCopied` 的 `label` 全部硬编码在本文件（`'tailnet 地址'` / `'管理地址'` / `'快照路径'`），而 toast 文案在 `App.tsx` 里拼装并回显 `value`；改文案需同时看两处。
