# `web/src/components/Toolbar.tsx`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

工具条：刷新、重新同步两个动作按钮，加上一行同步计划摘要（`PlanSummary` + `MappingCounts`）。动作本身不做任何请求，全部通过 `onRefresh` / `onApply` 回调交给 `App`；「等待审批」这类不体现在 `plan` 里的状态由 `counts` 单独提示。

## 依赖 / 引用

- 外部：`react` 的 `JSX`（仅类型导入）。
- 同项目：`../api` 的 `MappingCounts`、`PlanSummary`（仅类型）。
- 引用它的人：`web/src/App.tsx`（唯一调用点，`plan`/`counts` 来自 `mappings?.planSummary ?? system?.plan` 与 `mappings?.counts ?? system?.counts`）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `planText` | `(plan: PlanSummary) => string` | `string` | 把计划摘要压成一行中文 | `plan.inSync === true` → 固定文案「serve 配置与映射库一致」，此时 `upserts/removals/blocked` 一个都不显示 |
| `Toolbar` | `({ plan, counts, loading, applying, adminUrl, onRefresh, onApply }: ToolbarProps) => JSX.Element` | `JSX.Element` | 两个动作按钮 + 计划摘要 | `plan === null` → 摘要整块不渲染（无占位）；`counts === null` → `awaiting` 视为 0；`adminUrl === null` → 不渲染 `/api/system` 链接（但链接地址并非取自 `adminUrl`） |

## 函数详情

### `planText(plan)`

- **签名**：`(plan: PlanSummary) => string`
- **入参**：`plan`（`PlanSummary`，必选）：后端算好的差异摘要，含 `upserts` / `removals` / `blocked` / `exposures` / `inSync`。
- **出参**：`string`，一行中文；**不含** `exposures`（它由 `Toolbar` 单独以红色强调块追加）。
- **功能**：`inSync` 为真时返回「serve 配置与映射库一致」；否则用 `String()` 拼出「待挂载 N · 待摘除 N · 被阻止 N」。
- **边缘条件**：
  - `inSync === true` → 即使 `upserts/removals/blocked` 非 0 也不显示它们（`inSync` 是唯一开关）；
  - 计数为 `0` → 仍然显示「待挂载 0 · …」，不做省略；
  - 负数或非整数不会被过滤，`String()` 原样输出（后端保证取值）。

### `Toolbar({ plan, counts, loading, applying, adminUrl, onRefresh, onApply })`

- **签名**：`({ plan, counts, loading, applying, adminUrl, onRefresh, onApply }: ToolbarProps) => JSX.Element`
- **入参**：
  - `plan`（`PlanSummary \| null`，必选）：`null` = 还没拿到映射数据；
  - `counts`（`MappingCounts \| null`，必选）：映射状态计数，用于提示「等待审批」这类 `plan` 不体现的状态；
  - `loading`（`boolean`，必选）：数据刷新中，禁用「刷新」；
  - `applying`（`boolean`，必选）：apply 进行中，禁用「重新同步」；
  - `adminUrl`（`string \| null`，必选）：**只当可见性开关**使用，不参与任何 URL 拼装；
  - `onRefresh`（`() => void`，必选）：刷新回调；
  - `onApply`（`() => void`，必选）：重新同步回调。
- **出参**：`JSX.Element`，`div.toolbar`：`toolbar-actions`（按钮组）+ 可选的 `plan-summary`。
- **功能**：刷新按钮在 `loading` 时文案变「刷新中…」并 `disabled`；重新同步按钮在 `applying` 时变「同步中…」并 `disabled`（两个按钮各自独立禁用，互不阻塞）；`plan` 非空时渲染摘要行——左侧彩点（`inSync` → `dot-green` / `plan-ok`，否则 `dot-yellow` / `plan-dirty`），右侧依次追加 `exposures > 0` 的红色「管理端口暴露 N 条」和 `awaiting > 0` 的「等待审批 N 条」。
- **边缘条件**：
  - `plan === null` → `plan-summary` 整块不渲染，`planText` 不会被调用（不会出现空白条）；
  - `counts === null` → `counts?.['awaiting-approval'] ?? 0` 得 0，「等待审批」提示不出现；计数对象里缺该键同样视为 0；
  - `plan.inSync === true` 但 `plan.exposures > 0` → 摘要仍是绿色 `plan-ok`，同时追加红色暴露提示（两个字段互相独立，`inSync` 不代表安全）；
  - `adminUrl === null` → 不渲染第三个链接；**非 `null` 时链接的 `href` 仍是硬编码的 `/api/system`**，与 `adminUrl` 的取值无关（同源相对路径，靠 Vite proxy 或后端静态服务承接）；
  - 「等待审批」的 `strong` 带 `title` 提示（指向 Tailscale 管理后台的 Services → Service hosts → Approve），文案前有一个独立的 `{' '}` 空格；该提示只在 `awaiting > 0` 且 `plan !== null` 时出现；
  - 按钮禁用只防重复提交，不弹任何确认框；`loading` 与 `applying` 也可能同时为真（由 `App` 的 `busy` / `syncing` 决定），此时两个按钮都不可点。

## Props / 内部状态

| 名称 | 类型 | 含义 | 默认 / 边界 |
| --- | --- | --- | --- |
| `plan` | `PlanSummary \| null` | 同步计划摘要 | 无默认值（必选）；`null` → 不渲染摘要块 |
| `counts` | `MappingCounts \| null` | 各 `MappingStatus` 的计数 | 无默认值（必选）；`null` 或缺少 `'awaiting-approval'` 键 → 0 |
| `loading` | `boolean` | 数据刷新中 | 无默认值（必选）；仅控制「刷新」按钮 |
| `applying` | `boolean` | apply 进行中 | 无默认值（必选）；仅控制「重新同步」按钮 |
| `adminUrl` | `string \| null` | 管理地址（**仅用于判空**） | 无默认值（必选）；作为 `href` 使用会失效，`href` 固定为 `/api/system` |
| `onRefresh` | `() => void` | 刷新回调 | 无默认值（必选） |
| `onApply` | `() => void` | 重新同步回调 | 无默认值（必选） |
| 内部状态 | 无 | 本文件不使用 `useState` / `useEffect` / `useRef` | — |

## 待办与隐患

- [ ] 无 TODO 标记。真实隐患：`adminUrl` 是必选 prop 且非 `null` 就当开关用，但链接写死 `/api/system`——若管理端改为非同源地址，这个按钮会静默指向错误位置。
- [ ] `planText` 漏掉 `plan.exposures`（靠 `Toolbar` 里的独立分支补），任何新增的计划字段都需要同时改两处判断才能显示。
