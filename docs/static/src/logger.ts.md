# `src/logger.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

极简结构化日志。本工具是常驻的本地进程，日志以**单行 JSON** 写 stderr/stdout，便于 grep 与日志采集；不引入任何日志库。

## 依赖 / 引用

- 无外部依赖（只用 `process.stdout` / `process.stderr` / `Date`）。
- 被全项目引用：`src/runtime.ts` 构造根 logger 并逐层 `child()`；测试用 `silentLogger` 静默。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `emit` | `(scope: string, level: LogLevel, message: string, detail?: Record<string, unknown>) => void` | `void` | 组装单行 JSON 并按级别选择输出流 | `detail` 为空对象时不写入该字段；模块私有 |
| `createLogger` | `(minLevel?: LogLevel = 'info', scope?: string = 'app') => Logger` | `Logger` | 创建根 logger，低于阈值的事件被直接丢弃 | 未知 `minLevel` 会被 `ORDER[...]` 求值为 `undefined`，比较恒为 false（全部静默），不抛错 |
| `Logger.child` | `(scope: string) => Logger` | `Logger` | 派生子作用域，名字用 `:` 连接 | 可无限嵌套；每层都是新对象，无共享可变状态 |
| `silentLogger` | 常量对象 | `Logger` | 全部方法为空操作的 logger | 它的 `child()` 返回**自身**（不是新对象），因此可以无成本地反复调用 |

## 函数详情

### `emit(scope, level, message, detail?)`

- **签名**：`(scope: string, level: LogLevel, message: string, detail?: Record<string, unknown>) => void`
- **入参**：
  - `scope`（`string`，必选）：作用域，形如 `app:mappings`；
  - `level`（`LogLevel`，必选）：`debug` / `info` / `warn` / `error`；
  - `message`（`string`，必选）：人类可读消息（中文）；
  - `detail`（`Record<string, unknown>`，可选）：结构化附加字段，作为 `detail` 键嵌入。
- **出参**：`void`。
- **功能**：把 `{ t, level, scope, msg, detail? }` 序列化成一行 JSON，`error`/`warn` 写 **stderr**，其余写 **stdout**。分流的理由是：常驻进程的 stderr 常被单独采集为告警流。
- **边缘条件**：
  - `detail` 为 `undefined` 或空对象 → 不输出 `detail` 键（保持日志行紧凑）；
  - `detail` 含循环引用 → `JSON.stringify` 抛 `TypeError`，**未被捕获**（调用方不要传循环结构）；
  - 输出不含换行符转义处理：`message` 内的换行会被 JSON 转义，因此始终一行。

### `createLogger(minLevel?, scope?)`

- **签名**：`(minLevel: LogLevel = 'info', scope: string = 'app') => Logger`
- **入参**：
  - `minLevel`（`LogLevel`，可选，默认 `'info'`）：阈值，低于它的调用被丢弃（`ORDER` 比较，`warn` 不抑制 `error` 的反向关系）；
  - `scope`（`string`，可选，默认 `'app'`）：根作用域名。
- **出参**：`Logger`，四个级别方法与一个 `child()`。
- **功能**：闭包持有 `threshold` 与当前 `scope`；`child('docker')` 得到 `app:docker`，再 `child('probe')` 得到 `app:docker:probe`。
- **边缘条件**：
  - 传入非法 `minLevel`（例如运行期字符串）→ `threshold` 为 `undefined`，所有 `ORDER.x >= undefined` 为 `false`，结果是**全静默**而不报错；调用方应传字面量类型。
  - 日志级别比较是「数值 ≥ 阈值」，因此 `minLevel='error'` 时只剩 error。

### `silentLogger`

- **签名**：`Logger`（常量）
- **出参**：不适用。
- **功能**：测试与不需要日志的场景使用；全部方法为空操作。
- **边缘条件**：`silentLogger.child('x')` 返回同一个对象（非新实例），因此不产生分配；不要依赖 `child()` 返回新对象的身份语义。

## 全局常量 / 变量

- `ORDER`：`Record<LogLevel, number>`，`debug:10 / info:20 / warn:30 / error:40`。模块私有，是级别比较的唯一依据。

## 待办与隐患

- [ ] 无 TODO 标记。已知取舍：不做日志轮转、不写文件（常驻场景由计划任务重定向，见项目 `README.md` §13.5）。
