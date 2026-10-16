# `scripts/verify-docs.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动 + 静态文档重构）。

## 文件概述

静态文档的**四重校验**（技能包 Phase 5）。四项标准全部落地，且**只以 `docs/static/manifest.txt` 为唯一数据源**：

1. **数量校验**：待归档源文件数 = 已生成文档数 + 明确跳过数；
2. **结构校验**：每个非跳过条目都必须存在 `docs/static/<相对路径>.md`；
3. **覆盖校验**：文档里的函数条目数（`###` 且标题含反引号）≥ 源文件里粗筛出的函数数；
4. **格式校验**：代码文档必须含「文件概述 / 函数清单 / 函数详情 / 边缘条件」，配置文档含「文件概述 / 结构说明」，纯类型文档用「类型清单」替代「函数清单」。

另外做一次**反向校验**：文档目录里不允许出现 manifest 未登记的 `.md`（防止手工新增文档后忘记登记）。

## 依赖 / 引用

- `node:fs/promises`、`node:path`、`node:url`。
- 只读 `docs/static/manifest.txt`、`docs/static/**/*.md` 与源码文件；**除了 `--stats` 时回写 `docs/static/README.md` 的统计标记区，不写任何其它文件**。
- 由 `npm run verify:docs` / `npm run docs:stats` 调用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `readManifest` | `() => Promise<ManifestEntry[]>` | 条目数组 | 解析 `manifest.txt` | 空行与 `#` 注释被跳过；字段不足 3 个的行被跳过；`\` 归一化为 `/` |
| `docPathOf` | `(rel: string) => string` | 绝对路径 | 源相对路径 → 文档绝对路径 | 固定规则：`docs/static/<rel>.md` |
| `extractFunctionNames` | `(source: string) => string[]` | 名字数组 | 从源码**粗筛**函数/方法名 | **宁可少算不可多算**；见下文 |
| `countDocEntries` | `(doc: string) => number` | 数字 | 数文档里的函数条目 | 只认 `###` 开头且标题内含反引号的标题 |
| `isSkipped` | `(e: ManifestEntry) => boolean` | `boolean` | 该条目是否不生成镜像文档 | `category` 为 `skip`/`doc`，或状态为 `skipped` |
| `inspect` | `(entry) => Promise<DocResult>` | 检查结果 | 检查单个条目的文档是否存在、缺哪些小节、函数数对比 | 读文件失败按「不存在/0 个函数」处理，不抛错 |
| `main` | `() => Promise<void>` | `Promise<void>` | 跑全部校验、打印表格、可选写回统计、失败退出码 1 | 找不到 STATS 标记时只警告，不失败 |

## 函数详情

### `readManifest()`

- **签名**：`() => Promise<ManifestEntry[]>`
- **出参**：`ManifestEntry[]`：`{status: 'pending'|'done'|'skipped', category: 'code'|'config'|'doc'|'skip', rel: string}`。
- **功能**：按**制表符**分列解析；忽略注释与空行。
- **边缘条件**：字段少于 3 个的行被静默跳过（因此格式写错的行会「消失」而不是报错——这是刻意的宽松，避免一处笔误让整个校验崩掉；代价是漏登记的条目不会被发现）。

### `extractFunctionNames(source)`

- **签名**：`(source: string) => string[]`
- **入参**：源码全文。
- **出参**：去重后的名字数组（无序）。
- **功能**：只认三类明确形态——① 顶层 `function name(` / `async function name(`；② `export const name = (` 形式的具名箭头函数；③ **缩进且行尾为 `{`** 的类方法（因此接口成员与重载签名被排除）。
- **边缘条件**：
  - **设计方向是「宁少算不多算」**：这个数字是文档条目数的下界基准，高估会制造假失败（要求文档列出根本不存在的函数）。因此刻意**不**收集对象字面量成员（`createApi` 返回的那批）、`.then((res) => …)` 这类内联回调；
  - 注释行（`*` / `//` / `/*` 开头）被跳过，避免把文档示例里的签名算进来；
  - `CONTROL_KEYWORDS`（`if`/`for`/`describe`/`it`/`expect`…）被剔除；
  - `constructor` 与 `super` 被剔除（文档里并入类或调用点的说明）。

### `countDocEntries(doc)`

- **签名**：`(doc: string) => number`
- **出参**：条目数。
- **功能**：`/^###\s+.*`[^`]+`/gm` —— 只要 `###` 标题里出现反引号标识符就算一条，因此同时支持 `` ### `foo()` ``、`` ### `Class.method()` ``、`` ### `foo()` / `bar()` ``、`` ### `reviveMapping(raw, defaultServePort, logger?)` `` 这些写法。
- **边缘条件**：`####`（四级标题）与不含反引号的标题不计入（避免把说明性小节算成函数条目）。

### `isSkipped(e)`

- **签名**：`(e: ManifestEntry) => boolean`
- **出参**：`boolean`。
- **功能**：`category === 'skip'`（依赖/产物/运行时数据/二进制）、`category === 'doc'`（仓库根 `README.md`、`todo.md`、`docs/*.md`——本就是给人读的文档，重复归档会造成两份真相）、或显式 `skipped`。
- **边缘条件**：被跳过的条目仍会在校验输出里占一行吗？否——`results` 只包含非跳过条目，但**跳过总数会打印在汇总行**，便于人工复核豁免是否合理。

### `inspect(entry)`

- **签名**：`(entry: ManifestEntry) => Promise<DocResult>`
- **出参**：`{rel, category, status, docExists, srcFunctions, docEntries, missingSections}`。
- **功能**：读文档、读源文件（仅 `code` 类且扩展名在白名单内）、算缺哪些小节。
- **边缘条件**：
  - 读文档失败 → `docExists: false` 且 `missingSections` 为全部必填小节；
  - 读源文件失败 → `srcFunctions = 0`（不会因为读不到源码就误报覆盖不足）；
  - 纯类型文件（文档里含 `## 类型清单`）自动改用类型文件的必填小节集合。

### `docPathOf(rel)`

- **签名**：`(rel: string) => string`
- **入参**：`rel`（`string`）：源码相对路径（已把 `\` 归一化为 `/`）。
- **出参**：`string`，文档的绝对路径。
- **功能**：实现「文档目录树 = 源码目录树」这条约定的**唯一映射规则**：`docs/static/<rel>.md`。
- **边缘条件**：不做存在性检查、不做大小写处理（Windows/macOS 大小写不敏感文件系统上，`Foo.ts` 与 `foo.ts` 会互相覆盖——技能包注意事项第 2 条，本项目目前没有这种冲突）。

### `countDocEntries(doc)`

- **签名**：`(doc: string) => number`
- **出参**：条目数。
- **功能**：`/^###\s+.*`[^`]+`/gm` —— 只要 `###` 标题里出现反引号标识符就算一条，因此同时支持 `` ### `foo()` ``、`` ### `Class.method()` ``、`` ### `foo()` / `bar()` ``、`` ### `reviveMapping(raw, defaultServePort, logger?)` `` 这些写法。
- **边缘条件**：`####`（四级标题）与不含反引号的标题不计入（避免把说明性小节算成函数条目）。

### `isSkipped(e)`

- **签名**：`(e: ManifestEntry) => boolean`
- **出参**：`boolean`。
- **功能**：`category === 'skip'`（依赖/产物/运行时数据/二进制）、`category === 'doc'`（仓库根 `README.md`、`todo.md`、`docs/*.md`——本就是给人读的文档，重复归档会造成两份真相）、或显式 `skipped`。
- **边缘条件**：被跳过的条目不出现在逐条表格里，但**跳过总数会打印在汇总行**，便于人工复核豁免是否合理。

### `inspect(entry)`

- **签名**：`(entry: ManifestEntry) => Promise<DocResult>`
- **出参**：`{rel, category, status, docExists, srcFunctions, docEntries, missingSections}`。
- **功能**：读文档、读源文件（仅 `code` 类且扩展名在白名单内）、算缺哪些小节。
- **边缘条件**：
  - 读文档失败 → `docExists: false` 且 `missingSections` 为全部必填小节；
  - 读源文件失败 → `srcFunctions = 0`（不会因为读不到源码就误报覆盖不足）；
  - 纯类型文件（文档里含 `## 类型清单`）自动改用类型文件的必填小节集合。

### `main()`

- **签名**：`() => Promise<void>`
- **出参**：`Promise<void>`；**四重校验全通过时退出码 0**，否则打印失败清单并 `exit(1)`。
- **功能**：跑校验 → 打印逐条表格（状态/类别/函数数/条目数/文件）→ 汇总源文件数与条目总数 → 可选把统计表写回 `docs/static/README.md` → 反向校验未登记文档。
- **边缘条件**：
  - `--stats` 时若 README 里找不到 `<!-- STATS:START -->` / `<!-- STATS:END -->` 标记，只写 stderr 警告并继续（不失败）；
  - 标记区用 **`indexOf` + 切片**替换而不是正则替换：标记是固定的两行 HTML 注释，`indexOf` 更直白、出错时更好定位（历史教训：这一段最初用 `String.replace(正则, 模板)`，在 `test()` 为 true 的情况下仍写出「未找到标记」，排查成本远高于换实现）；
  - 反向校验的「已登记」集合 = 非跳过条目的文档路径 + `README.md` + `history.md`；因此**新增任何 `.md` 都必须先登记到 manifest**，否则会报「未登记在 manifest 的文档」；
  - 失败项累计后一次性输出，便于一轮修完。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| （无） | — | 只校验，打印表格与失败清单 |
| `--stats` | 关 | 额外把汇总统计写回 `docs/static/README.md` 的 STATS 标记区 |

## 边缘条件与设计约束

- 本脚本**只读源码与文档**，唯一会写的是 `--stats` 时的 `docs/static/README.md` 统计标记区。
- 校验口径全部来自 `manifest.txt`：因此「漏登记的新源文件」不会被发现（见「待办与隐患」）。
- 退出码：四重校验全通过为 0；任一失败为 1（便于接进 CI 或 `npm run verify:docs`）。
- 对 60+ 文件跑一次是毫秒级（只读文本、不启进程、不联网）。

## 待办与隐患

- [ ] 覆盖校验是**下界**校验：它只能发现「文档少写了函数」，发现不了「文档写错了函数行为」——后者靠人读。因此本脚本不替代 `code-static-documentation` 的 Phase 3（逐文件语义阅读）。
- [ ] 已知边界：`readManifest` 对格式错误行静默跳过，所以**漏登记的新源文件不会被自动发现**；结构性体现为「源文件数」统计比实际少。若要让漏登记变响，需要改成「目录枚举 → 与 manifest 求差集」，但那会引入 `.ignore` 的重复实现（当前刻意不做）。
- [ ] 已知边界：函数提取是正则粗筛，遇到新写法（例如 `export default function`、装饰器、生成器方法的特殊排版）可能漏算；漏算的后果是覆盖校验偏松，不会误报失败。
