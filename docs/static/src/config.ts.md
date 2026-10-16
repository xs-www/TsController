# `src/config.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

运行配置。全部来自环境变量，缺省值面向「Windows 本机常驻小工具」。

**核心安全约束**：`TSCONTROLLER_HOST` 只允许回环地址，**没有开关可以绕过**。这不是可配置策略，而是本应用的硬性需求——管理面一旦监听在 tailscale 接口或 `0.0.0.0` 上，就等于把「查看/改写整机路由」的能力暴露给整个 tailnet。

## 依赖 / 引用

- `node:path`、`node:url`（`fileURLToPath`）、`./domain/route-path.ts`（`isLoopbackHost`）。
- 被 `src/runtime.ts`（唯一调用方）与 `test/config-and-docker.test.ts` 使用；`AppConfig` 类型被 `app.ts`、`runtime.ts` 引用。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `readInt` | `(name, fallback, min, max) => number` | `number` | 读整数环境变量 | 未设置/空白 → 默认值；非整数或越界 → **抛错** |
| `readBool` | `(name, fallback) => boolean` | `boolean` | 读布尔环境变量 | 接受 `1/true/yes/on` 与 `0/false/no/off`（大小写不敏感）；其它值 → **抛错** |
| `readStr` | `(name, fallback) => string` | `string` | 读字符串环境变量 | 未设置/空白 → 默认值（不做 trim 后回写） |
| `loadConfig` | `(overrides?: Partial<AppConfig>) => AppConfig` | `AppConfig` | 读取并校验全部配置 | 非回环 `host` → **抛错**；`overrides` 优先于环境变量 |

## 函数详情

### `readInt(name, fallback, min, max)`

- **签名**：`(name: string, fallback: number, min: number, max: number) => number`
- **入参**：`name` 是环境变量名（用于报错）；`min`/`max` 含端点。
- **出参**：`number`。
- **功能**：`Number(raw)` 后要求 `Number.isInteger` 且在范围内。
- **边缘条件**：未设置或纯空白 → `fallback`；**非法值直接抛错**——宁可启动失败，也不要带着一个悄悄回退的默认值运行（否则「我明明设了端口」会变成最难查的一类故障）。

### `readBool(name, fallback)`

- **签名**：`(name: string, fallback: boolean) => boolean`
- **出参**：`boolean`。
- **功能**：白名单解析，`trim().toLowerCase()` 后比较。
- **边缘条件**：`''`/`' '` → `fallback`；无法识别 → **抛错**（不猜）。

### `readStr(name, fallback)`

- **签名**：`(name: string, fallback: string) => string`
- **出参**：`string`（已 trim）。
- **功能**：空串视为未设置。
- **边缘条件**：返回的是 `raw.trim()`；路径型配置的解析由 `loadConfig` 负责（显式值按 cwd 解析、默认值锚定项目根）。

### `loadConfig(overrides?)`

- **签名**：`(overrides: Partial<AppConfig> = {}) => AppConfig`
- **入参**：`overrides` 优先于环境变量（测试与验证脚本靠它构造隔离实例）。
- **出参**：`AppConfig`。
- **功能**：逐项读取，并对路径型配置做「显式值按 cwd 解析 / 默认值锚定 `PROJECT_ROOT`」的分流。
- **边缘条件与关键约定**：
  - **`host` 非回环 → 抛错**，消息里明确写出「本应用禁止暴露在 tailnet 中」；
  - **`dataDir`**：显式 `TSCONTROLLER_DATA_DIR` 用 `path.resolve`（按 cwd）；未给出时锚定 `PROJECT_ROOT/data`。锚定的理由是：本工具会被注册为计划任务/服务，那时 cwd 往往是 `C:\Windows\System32`，相对路径会指错位置；
  - **`snapshotDir`**：同理，默认 `<DATA_DIR>/public`（不是 `<DATA_DIR>` 根下——消费方只需挂载这一个目录，不必顺带暴露 `mappings.json` 与 `audit.jsonl`）；
  - **`webRoot`**：默认 `<PROJECT_ROOT>/web/dist`；
  - `dockerPipe`：空串归一化为 `null`（表示自动探测）。

## 配置项一览（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TSCONTROLLER_HOST` | `127.0.0.1` | 监听地址。**只接受回环**，填 `0.0.0.0` / `100.x` 直接启动失败 |
| `TSCONTROLLER_PORT` | `8787` | 管理端口（1–65535） |
| `TSCONTROLLER_DATA_DIR` | `<项目根>/data` | 映射库与审计日志目录 |
| `TSCONTROLLER_TAILSCALE_BIN` | Windows: `C:\Program Files\Tailscale\tailscale.exe`；其它平台: `tailscale` | CLI 路径 |
| `TSCONTROLLER_DOCKER_PIPE` | 自动探测 | Docker 端点（也可用 `DOCKER_HOST`） |
| `TSCONTROLLER_SERVE_PORT` | `443` | 新建映射的默认对外端口（Service 级还须与 admin console 的 `tcp:<port>` 一致） |
| `TSCONTROLLER_AUTO_UNEXPOSE` | `true` | 是否自动摘除指向管理端口的 serve 路由 |
| `TSCONTROLLER_SNAPSHOT_DIR` | `<DATA_DIR>/public` | 快照目录 |
| `TSCONTROLLER_SNAPSHOT_INTERVAL_MS` | `60000` | 定期刷新间隔；`0` 表示只在启动与每次收敛后写 |
| `TSCONTROLLER_WEB_ROOT` | `<项目根>/web/dist` | 前端构建产物目录 |
| `TSCONTROLLER_LOG_LEVEL` | `info` | 在 `runtime.ts` 里读取（不在本文件） |

## 全局常量 / 变量

- `PROJECT_ROOT`：由 `import.meta.url` 推导的项目根绝对路径；路径型默认值的锚点。
- `DEFAULT_TAILSCALE_BIN`：按 `process.platform` 选择。

## 待办与隐患

- [ ] 无 TODO 标记。**改动提醒**：`isLoopbackHost` 是本文件与 `app.ts`（Host 头校验）共用的判定，放宽它会同时削弱两层防护。
- [ ] 已知取舍：`overrides.dataDir` 不走 `path.resolve`（假定调用方已给绝对路径或在 cwd 下有意为之），验证脚本据此把数据写到 `data/verify*` 隔离目录。
