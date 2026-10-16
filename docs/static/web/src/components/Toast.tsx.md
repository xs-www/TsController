# `web/src/components/Toast.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

顶部统一反馈栈：把 `ToastItem[]` 渲染成一组卡片（级别着色、错误码徽标、可选正文与明细列表）。**本文件不持有状态、不设任何定时器**——自动消失、条数上限、错误常驻这些策略全部在 `App.tsx` 的 `pushToast` 里，`ToastStack` 只是纯展示 + 上抛「关闭」事件。

## 依赖 / 引用

- 外部：`react` 的 `JSX`（仅类型导入，不使用任何 hook）。
- 同项目：无（`ToastLevel` / `ToastItem` / `ToastDetailItem` 都由本文件自己导出）。
- 引用它的人：`web/src/App.tsx`（`ToastStack` 组件 + `ToastDetailItem` / `ToastItem` / `ToastLevel` 三个类型；`App` 用 `id = ++toastSeq` 生成 id、`[item, ...prev].slice(0, 6)` 限流、非 `error` 级别 8 秒后自动移除、`error` 常驻）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `ToastStack` | `({ items, onDismiss, onClear }: ToastProps) => JSX.Element \| null` | `JSX.Element \| null` | 渲染反馈卡片栈 | `items.length === 0` → 返回 `null`；只有 1 条时**不渲染**「全部关闭」按钮；不排序、不自动消失 |

## 函数详情

### `ToastStack({ items, onDismiss, onClear })`

- **签名**：`({ items, onDismiss, onClear }: ToastProps) => JSX.Element | null`
- **入参**：
  - `items`（`ToastItem[]`，必选）：要渲染的卡片，渲染顺序即数组顺序（`App` 把新条目插在头部，所以最新在最上面）；
  - `onDismiss`（`(id: number) => void`，必选）：单条关闭回调，传入被点条目的 `item.id`；
  - `onClear`（`() => void`，必选）：全部关闭回调，**只在 `items.length > 1` 时才有入口**。
- **出参**：`JSX.Element | null`——空数组时 `null`，否则 `div.toast-stack`（`role="region"`、`aria-label="操作反馈"`）。
- **功能**：每条卡片渲染 `toast toast-${level}`；标题行含标题文本、可选 `code` 徽标与关闭按钮（`aria-label="关闭"`，文案 `×`）；随后按需渲染 `p.toast-message` 与 `ul.toast-details`（每项类名 `detail-${kind ?? 'note'}`）。`level === 'error'` 的卡片用 `role="alert"`，其余用 `role="status"`。多条时在卡片之前渲染 `button.toast-clear`，文案为「全部关闭（N）」。
- **边缘条件**：
  - `items` 为空数组 → 返回 `null`，不渲染空容器（也不会留下 `region` 占位）；
  - 恰好 1 条 → 没有「全部关闭」按钮，用户只能点该条自身的 `×`（或等 `App` 的 8 秒定时器）；
  - `message` 为 `undefined` **或** `''` → 整个 `<p>` 不渲染（空串不会渲染成空段落）；
  - `code` 为 `undefined` **或** `''` → 不渲染 `code.code-badge`；有值时**原样**显示（例如 `takeover-required`），本文件不做错误码到中文的映射；
  - `details` 为 `undefined` 或 `length === 0` → 不渲染 `<ul>`；明细的 `key` 是 `` `${String(i)}-${d.text}` ``，因此同一条 toast 内即使文本重复也不会撞 key，但**同一 index 上文本变化会触发重建**；
  - `detail.kind` 缺省为 `'note'`（类名 `detail-note`）；若传入约定外的字符串，类名会原样拼成 `detail-xxx`（无白名单校验）；
  - 渲染**不去重、不排序、不截断**：条数上限 6 是在 `App.tsx` 的 `pushToast` 里做的，直接给 `ToastStack` 传 20 条它会全部渲染；
  - `item.id` 只用于 `key` 与 `onDismiss` 参数，本文件不生成 id、也不校验唯一性（重复 id 会让 React 报 key 警告并可能复用错节点）；
  - 没有任何 hook、没有 `AbortController`、没有 `useId()`；组件在 `App` 的卸载路径上也不会自己清空列表。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `items` | `ToastItem[]` | 要展示的反馈卡片 | 无默认值（必选）；空数组 → 渲染 `null` |
| `onDismiss` | `(id: number) => void` | 单条关闭 | 无默认值（必选）；`id` 来自被点条目 |
| `onClear` | `() => void` | 全部关闭 | 无默认值（必选）；仅当 `items.length > 1` 时有 UI 入口 |
| `ToastItem.id` | `number` | 条目唯一标识 | 必填；由调用方生成（`App` 用递增序号），重复会导致 key 冲突 |
| `ToastItem.level` | `'info' \| 'success' \| 'warn' \| 'error'` | 级别 | 必填；决定 `toast-${level}` 类名与 `role`（只有 `error` 是 `alert`） |
| `ToastItem.title` | `string` | 标题 | 必填；空串会渲染出空标题行（无校验） |
| `ToastItem.message` | `string \| undefined` | 正文 | 可选；`undefined` 或 `''` 都不渲染 |
| `ToastItem.code` | `string \| undefined` | 错误码徽标 | 可选；`undefined` 或 `''` 都不渲染 |
| `ToastItem.details` | `ToastDetailItem[] \| undefined` | 明细列表 | 可选；空数组等同不传 |
| `ToastDetailItem.text` | `string` | 明细文本 | 必填 |
| `ToastDetailItem.kind` | `'ok' \| 'bad' \| 'note' \| undefined` | 明细着色 | 可选，默认 `'note'` |
| 内部状态 | 无 | 无 `useState` / `useEffect` / `useRef` | 自动关闭与条数上限由 `App.tsx` 负责 |

## 待办与隐患

- [ ] 无 TODO 标记。真实边界：`ToastStack` 自身没有任何「生命周期」逻辑，`error` 级别的卡片会一直留在屏幕上直到用户手点 `×` 或触发「全部关闭」——这是 `App.tsx` 的刻意策略，不要在这里补定时器，否则会出现两处计时。
- [ ] `items.length > 1` 才给「全部关闭」入口，导致只剩 2 条时清空是「全部关闭（2）」，剩 1 条时该按钮消失、行为不连续。
- [ ] `role={item.level === 'error' ? 'alert' : 'status'}` 没有被 `aria-live` 显式声明，屏幕阅读器的播报时机依赖浏览器的隐式 live region 行为。
