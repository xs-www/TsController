# `web/src/styles.css`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

TsController 管理界面的**唯一**样式表：纯手写 CSS，不引入任何 UI 框架、CSS Modules 或预处理器（无 Tailwind / 无 Sass）。整站是深色主题，设计令牌集中在 `:root` 的自定义属性里，其余按界面区块用注释分段组织（顶部信息条 / 工具条 / 按钮 / 横幅 / 面板 / 容器列表 / 表格 / 徽标状态 / 行内表单 / Service 卡片 / 开关 / 审计日志 / toast / 页脚 / 窄屏）。类名是全局作用域，由各 `.tsx` 文件以字符串字面量引用——**CSS 与组件之间没有编译期约束，改类名必须同时改 TSX**。

## 结构说明

### 1. 设计令牌（`:root`）

- 背景层次：`--bg`（页面）、`--bg-soft`（卡片/面板内的次级底）、`--panel`（面板底）、`--panel-2`（按钮/表单底）、`--line` / `--line-soft`（两级描边）。
- 文字层次：`--text`（正文）、`--text-dim`（次要，`.muted`）、`--text-faint`（最弱，表头与标签）。
- 强调与语义色：`--accent` / `--accent-strong`（蓝，主操作）、`--green` / `--green-soft`（成功、安全）、`--yellow` / `--yellow-soft`（注意、待同步）、`--orange` / `--orange-soft`（漂移、目标失联）、`--red` / `--red-soft`（错误、阻止）、`--grey`（中性）。每条语义色都是「主色 + `-soft` 底色」成对出现，用于徽标（半透明底 + 亮色文字）与横幅（`-soft` 底 + 主色描边）。
- `--radius: 10px`：面板/横幅圆角基准；按钮、输入框、徽标各自使用更小的字面量（8px / 7px / 999px）。
- `--mono`：等宽字体栈（`ui-monospace` → `Cascadia Mono` → `Consolas` → …），由 `code` 与 `.mono` 共用，用于端口、路径、代理地址、容器 id 等需要逐字符对齐的内容。

### 2. 基础与排版

- `* { box-sizing: border-box }`；`html, body` 设定深色底、`--text` 字色、系统中文字体栈（`system-ui` / `Segoe UI` / `Microsoft YaHei`）、`14px` / `1.55`。
- `a` 用 `--accent` 且默认无下划线、悬停加下划线（界面上链接几乎都是外部跳转）。
- `code, .mono`：等宽 + `12.5px`（比正文小一档，抵消等宽字体的视觉放大）。
- 通用工具类：`.muted`（`--text-dim`）、`.small`（`12px`）；它们常与其它类叠加使用（如 `className="muted small mono"`），因此**不得**设为 `!important` 或带背景。
- `.app`：内容最大宽度 `1500px`、水平居中、底部留 `60px`。

### 3. 各区块（按用途）

| 区块 | 主要类名 | 控制什么 |
| --- | --- | --- |
| 顶部信息条 | `.topbar` `.brand` `.brand-mark` `.brand-sub` `.topbar-empty` `.topbar-grid` `.topbar-cell` | 品牌块与 `system` 信息网格；`.topbar-grid` 用 `repeat(auto-fit, minmax(260px, 1fr))` 自适应列数，单元格的 `dd` 允许 `overflow-wrap: anywhere`（长 DNS 名/URL 不撑破布局） |
| 工具条 | `.toolbar` `.toolbar-actions` `.plan-summary` `.plan-ok` `.plan-dirty` `.plan-danger` `.dot` `.dot-green` `.dot-yellow` | 按钮组与同步摘要；`.dot` 是 8px 圆点，绿=已同步、黄=待同步（`.dot-*` 只由 `Toolbar.tsx` 使用） |
| 按钮 | `.btn` `.btn-primary` `.btn-danger` `.btn-danger-ghost` `.btn-ghost` `.btn-mini` | 基础按钮 + 四个语义变体 + 小尺寸；`:hover:not(:disabled)` 才变亮，`:disabled` 统一 `opacity: .45` + `cursor: not-allowed`（**禁用态的唯一视觉表达**，不额外降饱和） |
| 横幅 | `.banner` `.banner-safe` `.banner-danger` `.banner-icon` `.exposure-list` `.exposure-path` `.exposure-proxy` `.arrow` | 安全横幅：安全=绿色软底，危险=红色软底 + 外发光 `box-shadow`；`.exposure-list` 列出被暴露的管理端口路由 |
| 面板 | `.panel` `.panel-head` `.panel-meta` `.empty` | 面板容器与标题行；`.empty` 是虚线描边的空态块（服务于「没有容器 / 没有映射 / 没有审计事件」等文案） |
| 容器列表 | `.container-list` `.container-card` `.container-idle` `.container-head` `.container-title` `.container-sub` `.warn-inline` | 容器卡片；`.container-idle` 只降透明度（`opacity: .72`）表示非运行中；`.warn-inline` 是黄色软底的行内告警（全网卡端口、无 tag 提示） |
| 表格 | `table` `.port-table` `.simple-table` `.mapping-table` `th` `td` `.row-open` `.row-form` `.group-row` `.col-actions` `.col-toggle` | 三张表共用一套 `th` / `td` 规则（表头小号大写字母 + `--text-faint`、单元格 `vertical-align: top`、末行去描边）；`.row-open`（展开编辑行）与 `.row-form`（表单/确认行）用更亮的底色区分层级；`.group-row` 是映射表的状态分组标题行；`.col-actions` / `.col-toggle` 用 `width: 1%` + `white-space: nowrap` 把动作列压到内容宽度 |
| 徽标 / 状态 | `.pill` `.status` `.badge` 及其配色类 | 见下方「语义约定」 |
| 行内表单 | `.inline-form` `.inline-form-grid` `.field` `.field-wide` `.input` `.input-port` `.inline-form-hint` `.inline-confirm` `.inline-error` `.row-actions` `.path-cell` `.path-text` `.edit-target` `.edit-stack` `.lossy-row` | 建映射表单与编辑行；`.inline-form-grid` 用 `minmax(190px, 1fr)` 自动换列，`.field-wide` 跨整行（备注）；`.inline-confirm` 用黄色软底承载「确认接管」；`.inline-error` 用红色软底；`.lossy-row` 用极淡的冷色底标记「目标路径不可恢复」说明行 |
| Service 卡片 | `.service-list` `.service-card` `.service-head` `.service-grid` `.service-vip` `.service-help` `.note-cell` | Service 面板的卡片与 `dl` 网格；`.service-help` 用冷色（青）承载「等待审批」的操作指引；`.note-cell` 限制备注列宽度（`max-width: 320px`）避免长文挤走其它列 |
| 开关 | `.switch` `.switch-track` `.switch-label` | 映射的启用/禁用开关 |
| 审计日志 | `.audit-list` | 无符号列表，`max-height: 320px` + `overflow: auto`（最近 50 条不会把页面拉长） |
| toast | `.toast-stack` `.toast` `.toast-head` `.toast-title` `.toast-message` `.toast-details` `.detail-ok` `.detail-bad` `.toast-close` `.toast-clear` `.code-badge` `.toast-info` `.toast-success` `.toast-warn` `.toast-error` | 固定右上角（`top/right: 14px`、`z-index: 50`、宽度 `min(430px, calc(100vw - 28px))`）；每条 toast 用 `border-left: 4px` 表达级别，`error` 额外换深红底；`.toast-details` 内部滚动 |
| 页脚 | `.footer` | 顶部细描边的说明条（已托管路由数、管理端口、回环监听声明） |
| 窄屏 | `@media (max-width: 760px)` | 见下方「响应式/布局策略」 |

### 4. 语义约定（改动配色前必须读）

- **冷色（青，`rgba(93, 214, 214, …)` / `#8fe4e4`）= 不是错误。** `.status-approval`、`.pill-calm`、`.badge-calm`、`.plan-calm`、`.detail-calm`、`.service-help`、`.lossy-row` 都使用这套冷色，语义有两类：
  1. **`awaiting-approval`（等待审批）**：配置已经正确写入 serve，只差管理员在 Tailscale 后台批准 Service host 广告——用红/黄会让用户以为出了故障，去排查一个不存在的问题。CSS 里为此留了显式注释：「用红色会让用户以为出了故障，从而去做无用的排查」。
  2. **「来自 Service 配置的有损信息」**：`.badge-calm` + `.lossy-row` 标记「读出的 handler 树有损、目标路径不可恢复」，是**信息性**而非错误性提示。
- **红色 = 会被安全策略拒绝 / 冲突 / 操作失败**：`.status-blocked`（暴露管理端口）、`.status-conflict`（路径被外部占用）、`.pill-red`（审计日志里的 exposure 事件）、`.badge-danger`、`.btn-danger`、`.inline-error`、`.banner-danger`。
- **黄色 = 需要用户注意但未失败**：`.status-pending`（待同步）、`.pill-yellow`（未托管）、`.badge-warn`、`.warn-inline`、`.inline-confirm`（接管确认是「等你决定」，不是错误）、`.detail-text`。
- **橙色 = 漂移 / 目标失联**：`.status-drift`、`.status-orphan`（比黄色更严重、比红色轻）。
- **绿色 = 生效 / 安全**：`.status-active`、`.pill-green`、`.dot-green`、`.banner-safe`。
- **蓝色 = 强调与 Service 维度**：`.pill-blue` 用于 Service 名 pill 与 compose 信息，`.btn-primary` / `.input:focus` 环用 `--accent`。
- **灰色 = 中性**：`.pill-grey` / `.status-disabled`（节点级路由、已禁用）、`.toast` 的默认左边框。
- **同一视觉语义由多个选择器共享**（`.pill-red, .status-blocked, .status-conflict` 写在同一条规则里）：要改某一语义色，必须整组一起改，漏一个就会出现「同一含义两种颜色」。
- **只有基础色走进了 `:root`**：表头字色、行高亮（`#1f2a3f` / `#1a2436`）、输入框底（`#101725`）、徽标文字色（`#ff9c93` / `#6fdfa3` / `#8fe4e4` …）都是硬编码字面量，调整主题需要逐条 grep，不能只改变量。

### 5. 交互与无障碍细节

- `.btn` 使用 `appearance: none` + `font-family: inherit`（避免 WebKit 默认按钮字体与中文回退不一致）；过渡只作用于 `background` / `border-color` / `opacity`（120ms）。
- `.input:focus` 用 `outline: none` + 3px 半透明蓝色 `box-shadow` 环（不用 `outline` 是为了圆角贴合；代价是强制色彩模式下看不到焦点环）。
- **开关**：`.switch input` 被 `position: absolute; opacity: 0; width: 0; height: 0` 视觉隐藏（但不 `display: none`，保留键盘可达与 `checked` 伪类），滑块由 `.switch-track` 的 `::after` 圆点实现，选中态用 `.switch input:checked + .switch-track` ——因此**标记结构必须让 `input` 紧邻 `.switch-track`**（`MappingPanel.tsx` 正是 `input` → `span.switch-track` → `span.switch-label` 的顺序）；`:focus-visible` 时给轨道加环，保证键盘用户看得到焦点。
- `.status { cursor: help }`：状态徽标悬停有 `title` 说明。
- toast 的 `role` 由组件给出（`error` → `alert`，其余 → `status`），CSS 只负责视觉层级（`z-index: 50`）。

### 6. 响应式 / 布局策略

- **整体**：Flex + Grid `auto-fit minmax()` 优先，几乎不写死断点；`gap` 统一由容器控制，子元素尽量 `min-width: 0` / `overflow-wrap: anywhere`，以容纳超长 MagicDNS 名与 IPv6 地址。
- **唯一的媒体查询 `@media (max-width: 760px)`**：
  - `.app` 与 `.panel` 缩小内边距；
  - `.mapping-table, .simple-table, .port-table` 改为 `display: block; overflow-x: auto; white-space: nowrap`——即**窄屏下三张表退化为横向滚动的块**，而不是把表格变成卡片列表。这是刻意的取舍：路由表列宽差异大、单元格内容是路径/端口这类不可换行文本，横向滚动比堆叠卡片更好读，代价是丢失表格的语义布局（表头与数据行仍靠 DOM 结构关联，屏幕阅读器仍可读）。
- 无 `prefers-color-scheme` 分支（只有深色主题）、无 `prefers-reduced-motion` 处理（唯一的过渡是 120–150ms 的颜色/位移，风险很低）。

## 引用方

- **唯一样式入口**：`web/src/App.tsx` 第 38 行 `import './styles.css';`（Vite 副作用式引入）。`web/src/main.tsx` 与 `web/index.html` 都不引用样式表——`index.html` 只有 `<div id="root">` 与 `/src/main.tsx` 的 `<script type="module">`，没有任何 `<link rel="stylesheet">`。
- **类名消费方**（字符串引用，按文件分布）：
  - `web/src/App.tsx`：`.panel` `.panel-head` `.panel-meta` `.empty` `.simple-table` `.pill` / `.pill-grey` / `.pill-blue` / `.pill-green` / `.pill-yellow` / `.pill-red` `.mono` `.small` `.muted` `.audit-list` `.footer`；
  - `web/src/components/ContainerPanel.tsx`：`.container-*` `.port-table` `.warn-inline` `.badge-warn` `.badge-danger` `.inline-form*` `.field*` `.input*` `.row-actions` `.inline-confirm` `.inline-error` `.col-actions` `.row-open` `.row-form` `.pill-*`；
  - `web/src/components/MappingPanel.tsx`：`.mapping-table` `.status-*`（8 个）`.switch*` `.edit-stack` `.edit-target` `.note-cell` `.group-row` `.row-open` `.row-form` `.path-cell` `.path-text` `.detail-text` `.detail-calm` `.col-toggle` `.col-actions` `.btn-ghost`；
  - `web/src/components/ExternalRoutesPanel.tsx`：`.simple-table` `.pill-grey` `.pill-blue` `.badge-calm` `.lossy-row` `.col-actions`；
  - 本文件范围之外但同样依赖此样式表的组件：`TopBar.tsx`（`.topbar*` `.brand*`）、`Toolbar.tsx`（`.toolbar*` `.plan-*` `.dot-*`）、`SecurityBanner.tsx`（`.banner*` `.exposure-*` `.arrow`）、`ServicePanel.tsx`（`.service-*` `.pill-calm` `.badge-*`）、`Toast.tsx`（`.toast*` `.code-badge` `.detail-ok` / `.detail-bad`）、`CopyButton.tsx`（复用 `.btn*`）。
- 因此：**任何类名重命名/删除都必须同步这些 TSX**，编译器不会报错，只会在界面上静默丢样式。反向也成立——样式表里存在的类可能只服务于某个面板（例如 `.pill-calm` 只出现在 `ServicePanel.tsx`，`.lossy-row` 只出现在 `ExternalRoutesPanel.tsx`）。
