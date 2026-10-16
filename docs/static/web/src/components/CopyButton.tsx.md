# `web/src/components/CopyButton.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

复制到剪贴板的小按钮：点击后调 `utils.copyText`，成功后短暂时（1500 ms）把文案切成「已复制」，并把结果通过 `onResult` 上抛给调用方弹 toast。本文件是 `web/src/components/` 里**少数持有内部状态（`useState` + `useRef` 定时器）的展示型组件**，`value` 为空时自身进入禁用态。

## 依赖 / 引用

- 外部：`react` 的 `useEffect` / `useRef` / `useState` / `JSX`。
- 同项目：`../utils` 的 `copyText`（剪贴板实现与回退方案在同文件，见 `docs/static/web/src/utils.ts.md`，由另一位维护者负责）。
- 引用它的人：`web/src/components/TopBar.tsx`（3 处）、`web/src/components/ServicePanel.tsx`（1 处）、`web/src/components/MappingPanel.tsx`（1 处）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `CopyButton` | `({ value, label = '复制', className, title, onResult }: CopyButtonProps) => JSX.Element` | `JSX.Element` | 复制按钮（含「已复制」瞬时反馈） | `value` 为 `null`/`''` → `disabled`；`label` 传 `''` 会渲染空按钮；卸载时清掉定时器 |
| `handleClick` | `() => void`（组件内箭头函数） | `void` | 点击处理：复制、刷新「已复制」、回调 | `value` 为空时**提前 return**（不发请求、不改状态、不回调）；复制失败时仍会启动定时器并回调 `onResult(false, value)` |

## 函数详情

### `CopyButton({ value, label, className, title, onResult })`

- **签名**：`({ value, label = '复制', className, title, onResult }: CopyButtonProps) => JSX.Element`
- **入参**：
  - `value`（`string | null`，必选但可空）：要复制的文本，`null` 视为「无可复制内容」；
  - `label`（`string`，可选，默认 `'复制'`）：按钮文案；复制成功后临时替换为「已复制」；
  - `className`（`string`，可选）：自定义类名，未传（`undefined`）时用 `'btn btn-mini'`；
  - `title`（`string`，可选）：按钮 `title`；未传时回落为 `value ?? '无可复制内容'`；
  - `onResult`（`(ok: boolean, value: string) => void`，可选）：复制结果回调，用于弹 toast。
- **出参**：`JSX.Element`，单个 `<button type="button">`；`disabled` 由 `value === null || value === ''` 决定。
- **功能**：内部只有两个状态载体：`copied`（`useState(false)`）与 `timer`（`useRef<ReturnType<typeof setTimeout> | null>(null)`），没有 `useId()`、不生成 id、不依赖 `AbortController`。点击走 `handleClick`：`copyText(value)` 成功后 `setCopied(ok)`，清掉上一次定时器并新起一个 1500 ms 定时器把 `copied` 复位，最后调用 `onResult?.(ok, value)`。卸载时的 `useEffect`（依赖数组为空）清理函数会 `clearTimeout(timer.current)`，因此卸载后不会再 `setState`。
- **边缘条件**：
  - `value === null` 或 `value === ''` → 按钮渲染为 `disabled`；此时 `title` 回落成 `value ?? '无可复制内容'`，而 `value === ''` 会让 `title` 变成**空串**（浏览器不显示任何提示），所以「空串」这一路既禁用又没有说明；
  - `label` 的默认值只在 `undefined` 时生效：显式传 `label=""` 会渲染**没有文字**的按钮，调用方需自行保证非空；
  - `className` 同理：传 `''` 会得到 `class=""`（样式全失效），只有不传才拿到 `btn btn-mini`；
  - 复制失败（`copyText` 返回 `false`）→ `copied` 保持 `false`（文案不变），但定时器仍会启动一次、`onResult(false, value)` 仍会被调用，由调用方负责显示「复制失败」提示；
  - 连续点击：每次点击都会 `clearTimeout` 上一次定时器再重新计时，所以「已复制」的 1500 ms 窗口从**最后一次**点击算起，期间不会闪回原文案；
  - 剪贴板请求在途时**不禁用**按钮（没有 `loading`/`busy` 态），快速双击会并发调用两次 `copyText`；
  - 未传 `onResult` 时完全没有反馈出口（只有按钮上的瞬时文案），不会报错（可选链调用）；
  - 组件卸载前若已经触发过复制，1500 ms 内的 `setCopied(false)` 会被清理函数取消，不会产生卸载后更新。

### `handleClick()`

- **签名**：`() => void`
- **入参**：无（闭包捕获 `value`、`onResult` 与 `timer` ref）。
- **出参**：`void`（异步部分用 `void copyText(...).then(...)` 显式丢弃 Promise）。
- **功能**：先做空值守卫，再调用 `copyText(value)`；`then` 中依次执行 `setCopied(ok)`、清理并重启 1500 ms 定时器、`onResult?.(ok, value)`。
- **边缘条件**：
  - `value === null || value === ''` → 立即 `return`：不发剪贴板请求、不设状态、不回调（与 `disabled` 形成双保险，正常 UI 路径下不可能点到这里）；
  - 没有 `.catch()`：`copyText` 自身把异常吞掉并返回布尔值，所以正常不会产生未处理的 rejection；
  - `onResult` 抛错不会被捕获（会冒泡成事件处理器的异常），调用方应保证回调自身安全。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `value` | `string \| null` | 要复制的文本 | 无默认值（必选）；`null` 或 `''` → 按钮 `disabled` |
| `label` | `string \| undefined` | 按钮文案 | 默认 `'复制'`（仅 `undefined` 触发；`''` 会渲染空文案） |
| `className` | `string \| undefined` | 自定义类名 | 默认 `'btn btn-mini'`（仅 `undefined` 触发；`''` 会清掉样式） |
| `title` | `string \| undefined` | 原生 tooltip | 默认 `value ?? '无可复制内容'`；`value === ''` 时 title 为空串 |
| `onResult` | `((ok: boolean, value: string) => void) \| undefined` | 复制结果回调 | 可选；未传则无任何外部反馈 |
| `copied`（内部 state） | `boolean` | 是否刚复制成功 | 初值 `false`；成功后 1500 ms 复位 |
| `timer`（内部 ref） | `ReturnType<typeof setTimeout> \| null` | 复位定时器句柄 | 初值 `null`；卸载时 `clearTimeout`，避免卸载后 `setState` |
| 内部状态 | `useState` / `useRef` / `useEffect` | 唯一的定时器清理点 | 无 `useId()`；不注册全局事件、不监听键盘 |

## 待办与隐患

- [ ] 无 TODO 标记。真实边界：`value === ''` 时按钮禁用但 `title` 也是空串，用户看不到「为什么不能点」的提示（只有 `null` 分支会显示「无可复制内容」）。
- [ ] 1500 ms 是硬编码常量，且「已复制」状态在多个 `CopyButton` 实例之间互不影响（各自持有 `copied`），快速连续复制多行时会出现多个按钮同时显示「已复制」。
- [ ] 点击不检查剪贴板权限/安全上下文（`copyText` 内部静默回退到 `textarea + execCommand`），因此「复制成功」的语义是「写入尝试返回 true」，不是「系统剪贴板内容已确认」。
