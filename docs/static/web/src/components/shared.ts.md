# `web/src/components/shared.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

纯类型 + 一个常量：定义「变更类组件如何把结果告诉 `App`」的回调形状（`MutationHooks` / `ReportApply`）与 apply 反馈文案的默认值。**本文件没有任何可执行函数**，编译后只剩 `DEFAULT_APPLY_OPTIONS` 一个对象字面量，其余导出在类型层被完全擦除。

## 依赖 / 引用

- 外部：无。
- 同项目：`../api` 的 `ApplyResult`（仅类型，作为 `ReportApply` 的第一个入参）。
- 引用它的人：**目前没有任何文件引用**（在 `web/src/**` 全量检索 `shared` / `MutationHooks` / `ReportApply` / `DEFAULT_APPLY_OPTIONS` 均只命中本文件自身）。`web/src/App.tsx` 自带了同形状的 `reportApply`（默认文案「已同步」/「同步未完成」是内联字面量，并未使用本文件的 `DEFAULT_APPLY_OPTIONS`）。

## 函数清单

本文件不含函数、组件或 hook；下表登记导出符号，便于交叉引用时定位。

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `ApplyFeedbackOptions` | `interface { successTitle: string; failureTitle: string }` | —（类型） | apply 成功/失败的文案 | 两个字段都必填；只用部分字段请用 `Partial<…>` |
| `ReportApply` | `type (apply: ApplyResult, options?: Partial<ApplyFeedbackOptions>) => void` | `void` | 把 apply 结果汇报成用户可见反馈 | 实现方在 `options` 省略或只给一个字段时需自行回落（无默认值注入） |
| `MutationHooks` | `interface { refreshAll; refreshMappings; notifyError; notifySuccess; reportApply }` | —（类型） | 变更类子组件与 `App` 之间的回调契约 | 5 个成员全部必填；`notifyError` 的 `err` 是 `unknown` |
| `DEFAULT_APPLY_OPTIONS` | `ApplyFeedbackOptions`（`const`） | `ApplyFeedbackOptions` | 默认的 apply 反馈文案 | 值是可变对象（**未** `as const` / `Object.freeze`），调用方可以就地改写；目前无人引用 |

## 函数详情

本文件没有函数体可供逐条说明；下面按导出符号记录契约。

### `ApplyFeedbackOptions`（接口）

- **签名**：`interface ApplyFeedbackOptions { successTitle: string; failureTitle: string }`
- **入参 / 出参**：不适用（纯类型）。
- **功能**：为 apply 的两种结局各提供一句标题文案，供 `ReportApply` 的第二参数使用。
- **边缘条件**：
  - 两个字段都是必填；只想覆盖其中一个时必须写 `Partial<ApplyFeedbackOptions>`（`ReportApply` 就是这么用的）；
  - 空串在类型上合法，渲染层是否显示空标题由调用方决定，本文件不做校验。

### `ReportApply`（类型别名）

- **签名**：`type ReportApply = (apply: ApplyResult, options?: Partial<ApplyFeedbackOptions>) => void`
- **入参**：
  - `apply`（`ApplyResult`，必选）：来自写接口的返回体，含 `upserted` / `removed` / `blocked` / `exposures` / `errors` / `inSync`；
  - `options`（`Partial<ApplyFeedbackOptions>`，可选）：`undefined` 时由实现方决定文案。
- **出参**：`void`（实现方通常把结果投进 toast，不返回任何值）。
- **功能**：统一的「apply 之后说什么」抽象，让子组件不必知道 toast 的实现。
- **边缘条件**：
  - `options` 省略或字段缺失时**不会**自动取 `DEFAULT_APPLY_OPTIONS`（该常量不参与此类型的定义），回落逻辑完全在实现方；
  - `apply.errors` / `blocked` / `exposures` 都为空是「完全成功」的唯一充分条件，本文件不提供判断辅助函数。

### `MutationHooks`（接口）

- **签名**：`interface MutationHooks { refreshAll: () => void; refreshMappings: () => void; notifyError: (title: string, err: unknown) => void; notifySuccess: (title: string, message?: string) => void; reportApply: ReportApply }`
- **入参 / 出参**：不适用（纯类型）。
- **功能**：把「变更成功后如何刷新」与「如何提示」两件事打包，供带写操作的面板（映射增删改、启用/停用、导入路由）统一接收。
- **边缘条件**：
  - 5 个成员全部必填：只想刷新映射的面板也必须接收 `refreshAll`；
  - `notifyError` 的 `err` 类型是 `unknown`，实现方必须先归一化（当前 `App.tsx` 用 `toApiError()` 转换，并会吞掉 `'aborted'`）；
  - `notifySuccess` 的 `message` 可选，不传时实现方通常只显示标题。

### `DEFAULT_APPLY_OPTIONS`（常量）

- **签名**：`const DEFAULT_APPLY_OPTIONS: ApplyFeedbackOptions`
- **出参**：`ApplyFeedbackOptions`，值固定为 `{ successTitle: '已同步', failureTitle: '同步未完成' }`。
- **功能**：给 `ReportApply` 的实现方提供一份默认文案。
- **边缘条件**：
  - 未加 `as const` 也未冻结，任何引用方都可以就地改写字段（会影响到后续所有读者）；
  - 当前**没有任何调用点**：`App.tsx` 用的是同值的内联字面量，因此改了这里不会改变界面文案。

## 全局常量 / 变量

- `DEFAULT_APPLY_OPTIONS`：`ApplyFeedbackOptions`，`{ successTitle: '已同步', failureTitle: '同步未完成' }`。本文件唯一的运行期产物；未被引用（见上）。

## 待办与隐患

- [ ] 无 TODO 标记。真实隐患一：整个文件目前是**死代码**——没有任何模块 `import` 它，`App.tsx` 用的是同形状的本地实现；要么让 `App` 与各面板真的用上 `MutationHooks` / `DEFAULT_APPLY_OPTIONS`，要么删掉，否则「默认文案」与 `App.tsx` 的内联默认值会各自漂移。
- [ ] `DEFAULT_APPLY_OPTIONS` 与 `App.tsx` 中的默认文案是两份真相同值字面量，改一处不改另一处不会报错。
