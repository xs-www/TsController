# `scripts/clean-verify.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

清理验证脚本留下的临时数据目录。它存在的理由是一类**真实事故**：验证脚本把数据写在 `<DATA_DIR>/verify*` 下，而真实映射库就在同级的 `<DATA_DIR>/mappings.json`；此前有人直接 `rm -rf data` 清理，把用户的真实映射库一并删掉了。

本脚本的边界是刻意收窄的：**只删写死的白名单子目录，逐个做双重断言，不做任何通配或递归搜索，也不接受用户输入**。副作用仅限「删除 `data/` 下的五个已知验证目录」，外加两行 stdout 报告；从不触碰 `data/mappings.json`。

## 依赖 / 引用

- 外部：`node:fs`（`promises`）、`node:path`、`node:url`（`fileURLToPath`）。
- 同项目文件：无（刻意不引用 `src/`，避免为了清理而加载配置、日志或 Docker 依赖）。
- 调用方：`package.json` 的 `npm run clean:verify`（即 `node scripts/clean-verify.ts`）；`README.md` §3 的警告与 `docs/static/history.md` 的事故归档都指向它。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `main` | `() => Promise<void>` | `Promise<void>` | 遍历白名单，逐个断言后删除，并报告真实映射库是否仍在 | 目录不存在时 `fs.rm` 因 `force: true` 不抛错，但**仍计入已清理数**；断言失败只打印拒绝原因并 `continue` |
| 顶层 `catch`（匿名） | `(err: unknown) => void` | `void` | `main()` 的失败出口：写 stderr 后 `process.exit(1)` | 未捕获的异常不会静默——退出码为 1；同步写 stderr，不依赖任何 logger |

## 函数详情

### `main()`

- **签名**：`() => Promise<void>`
- **入参**：无（**不接受任何 CLI 参数**，这是刻意的：拒绝用户输入是防误删的第一道设计）。
- **出参**：`Promise<void>`；正常结束时进程退出码为 0（不显式调用 `process.exit`）。
- **功能**：按 `ALLOWED` 顺序逐个处理 —— 拼出绝对路径 `dataRoot` 与 `target`；先做两条断言，通过后 `fs.rm(normalized, { recursive: true, force: true })`，成功则打 `已清理 <相对路径>` 并把 `removed` 加一；最后检查 `data/mappings.json` 是否存在并打印对应提示，再输出清理总数。
- **边缘条件**：
  - **双重断言**（防误删的核心）：① `path.resolve(target)` 必须以 `path.resolve(dataRoot) + path.sep` 开头 —— 必须真的落在 `data/` 之下；② `path.basename(normalized)` 必须以 `verify` 或 `smoke` 开头。任一条不满足 → 写 stderr 拒绝并 `continue`，不删。
  - 断言用的是 `path.sep` 结尾前缀，因此 `data/verify-evil` 这类**同前缀兄弟目录**不会被误判为 `data/` 之下（前缀比较不会跨目录边界）。
  - `force: true` 使**不存在的目录不报错**，但它会走完整个 `try` 体：于是 `已清理` 照样打印、`removed` 照样 +1。也就是说这个计数是「本次成功处理的白名单项数」，**不是**「实际删掉的目录数」。
  - `fs.rm` 抛错（权限、被占用）→ 写 stderr `清理 <路径> 失败：<message>`，`continue` 到下一项；**不会**因此让脚本失败，其它目录仍会被清理。
  - 真实映射库检查是 `fs.access` + `catch`：存在则打印 `真实映射库仍在：data/mappings.json`（相对项目根的路径），不存在则打印 `注意：未找到真实映射库 data/mappings.json。`。**它只读不写**，绝不触碰该文件。
  - 全程不删除 `data/` 本身，也不删除任何不在 `ALLOWED` 里的路径。

### 顶层 `main().catch(...)` 处理器

- **签名**：`(err: unknown) => void`
- **入参**：`err`（`unknown`）：`main()` 拒绝的原因；用 `err instanceof Error ? err.message : String(err)` 归一成字符串——因此抛出非 `Error` 值（字符串、对象）也不会打印成 `[object Object]`。
- **出参**：`void`（但会终止进程）。
- **功能**：把失败原因写成一行 `清理失败：<message>` 到 **stderr**，然后 `process.exit(1)`。它是本脚本唯一的失败出口：没有任何一条路径会让异常被静默吞掉。
- **边缘条件**：
  - 该处理器**不**参与清理：`main()` 中途抛错时已经处理过的目录保持已删除状态，未处理的保持原样，不存在回滚；
  - 只输出 `message`（不含 stack），这是有意的——清理脚本的输出会被用户直接读，栈信息对定位「哪个目录删不掉」没有帮助（具体失败已经在 `main()` 内部逐项报告）。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| （无 CLI 参数） | — | 刻意不支持参数/通配：删除集合是编译期常量，不可从外部扩大 |
| 环境变量 | 不读取 | 不读 `TSCONTROLLER_*`，也不读 `NODE_ENV`；行为只由项目根位置决定 |
| `PROJECT_ROOT`（模块常量） | `path.dirname(path.dirname(fileURLToPath(import.meta.url)))` | 由脚本自身位置推导的项目根（`scripts/` 的上一级），因此从任意 cwd 运行结果一致 |
| `ALLOWED`（模块常量） | `['data/verify', 'data/verify-security', 'data/verify-api', 'data/verify-web', 'data/smoke']` | 唯一的删除白名单，相对项目根。前四项与 `scripts/verify-*.ts` 的 `dataDir`、以及测试/冒烟脚本的目录一一对应 |
| 退出码 | `0` | 正常完成即 0（即使某个目录清理失败，也只在 stderr 报告，不改变退出码） |
| 退出码（异常） | `1` | `main()` 抛出未捕获异常时由顶层 `catch` 置 1 |

## 待办与隐患

- [ ] `removed` 是「处理成功数」而非「实际删除数」（`force: true` 让不存在的目录也算成功）。读输出时不要把 `共清理 N 个验证数据目录` 当成磁盘上真的少了 N 个目录。
- [ ] 白名单是**编译期常量**：将来新增验证脚本（例如 `data/verify-xxx`）必须同步在这里加一行，否则残留目录只能手工清。这是有意用「多一步维护」换「不可能误删」的取舍。
- [ ] 只覆盖 `data/` 下的目录。若某个验证脚本把数据写到了项目根或 `os.tmpdir()`，本脚本不会清理，也不该清理。
- [ ] 没有 `--dry-run`：误删与否全靠两条断言。断言本身在 `docs/static/history.md` 中有事故背景记录，但没有自动化测试守着这两条断言（本文件是脚本，不在 `test/` 覆盖范围内）。
