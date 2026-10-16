# `web/src/components/SecurityBanner.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

安全横幅：当 serve 配置里存在指向 TsController 管理端口的路由时，把这条最严重的风险摆在最上面（含逐条暴露地址）。判定完全依赖后端给出的 `system.security`，本组件只做渲染，不复制、不请求、不修改任何东西。

## 依赖 / 引用

- 外部：`react` 的 `JSX`（仅类型导入）。
- 同项目：`../api` 的 `SystemInfo`（仅类型，读取 `security` 与 `adminPort`）；`../utils` 的 `formatRouteLabel`。
- 引用它的人：`web/src/App.tsx`（唯一调用点，`<SecurityBanner system={system} onCopied={handleCopied} />`）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `SecurityBanner` | `({ system }: SecurityBannerProps) => JSX.Element \| null` | `JSX.Element \| null` | 按 `security.safe` 渲染安全横幅 | `system === null` → 返回 `null`（整块消失，无骨架）；`safe === false` 且 `exposures` 为空数组 → 渲染「检测到 0 条」+ 空 `<ul>`；`onCopied` 在函数体内未被使用 |

## 函数详情

### `SecurityBanner({ system })`

- **签名**：`({ system }: SecurityBannerProps) => JSX.Element | null`
- **入参**：
  - `system`（`SystemInfo \| null`，必选）：只用到 `system.security`（`autoUnexpose` / `exposures` / `safe`）与 `system.adminPort`；
  - `onCopied`（`(ok: boolean, label: string, value: string) => void`，必选）：**声明了但解构时被省略**，函数体内没有任何复制入口，因此这个回调永远不会被触发（调用方仍需按类型传入）。
- **出参**：`JSX.Element | null`——`null` 或 `section.banner`（`banner-safe` 或 `banner-danger`）。
- **功能**：`security.safe === true` 时渲染绿色 `role="status"` 横幅，文案说明「当前 serve 配置里没有指向管理端口 `adminPort` 的路由」，并按 `security.autoUnexpose` 追加「自动摘除已开启…」或「注意：自动摘除当前是关闭状态。」；`safe === false` 时渲染红色 `role="alert"` 横幅，给出暴露条数、`adminPort`，并逐条列出 `exposures`（`formatRouteLabel(servePort, path, service)` → `e.proxy`），末尾同样按 `autoUnexpose` 区分「可尝试『重新同步』触发清理」与「需要手工处理」。
- **边缘条件**：
  - `system === null` → 返回 `null`：既不显示安全也不显示风险，容易被误读为「安全」，实际语义是「还不知道」；
  - `safe === false` 而 `exposures` 为空数组 → 文字显示「检测到 0 条 serve 路由…」，同时渲染一个**空**的 `ul.exposure-list`（分支只看 `safe`，不校验列表长度）；
  - `autoUnexpose` 的两种文案都在同一句里以括号/句子形式追加，不做按钮，用户不会从这里触发自动摘除；
  - `adminPort` 通过 `String(adminPort)` 输出，非整数不受过滤；
  - 列表 `key` 由 `` `${e.service ?? '-'}|${e.servePort}|${e.path}|${e.proxy}` `` 组成：节点级路由（`service === null`）用 `-` 占位；两条完全相同的 exposure 会产生重复 key（React 只警告、不会合并渲染）；
  - `formatRouteLabel` 会省略 443 端口、并在 `service` 非空时加上 `svc:…:` 前缀，因此列表里看到的路径标签与纯 `path` 不同；
  - 组件不使用任何 hook，`exposures.map` 的渲染顺序即后端数组顺序，本文件不排序。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `system` | `SystemInfo \| null` | 系统信息快照（只读 `security` 与 `adminPort`） | 无默认值（必选）；`null` → 渲染 `null` |
| `onCopied` | `(ok: boolean, label: string, value: string) => void` | 复制结果上报 | 无默认值（必选）但**本组件内未使用**，传入不会产生任何效果 |
| `security.safe` | `boolean`（来自 `SystemInfo`） | 管理端口是否未被暴露 | 唯一的分支依据；为 `true` 时不看 `exposures` |
| `security.autoUnexpose` | `boolean` | 自动摘除是否开启 | 只影响同一段文案的后半句 |
| `security.exposures` | `Exposure[]` | 指向管理端口的 serve 路由 | 只在 `safe === false` 时渲染；空数组时渲染空列表 |
| 内部状态 | 无 | 无 `useState` / `useEffect` / `useRef` / `useId()` | — |

## 待办与隐患

- [ ] 无 TODO 标记。真实隐患：`SecurityBannerProps.onCopied` 是必选 prop 却完全未使用（`App.tsx` 仍在传 `handleCopied`），属于契约噪音——要么删掉，要么给暴露列表补上复制地址的能力。
- [ ] `safe === false` 且 `exposures.length === 0` 时文案与空列表自相矛盾（「检测到 0 条」），建议以 `exposures.length > 0` 作为是否进入危险分支的前置条件。
