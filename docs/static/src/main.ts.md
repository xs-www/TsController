# `src/main.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

进程入口。**启动顺序本身是设计的一部分**：安全检查（serve 配置里没有任何指向管理端口的路由）放在监听之前，Docker 预热放在监听之前（让启动日志显示真实数据源），快照发布放在监听之前（其它项目靠这个文件读路由，它必须先存在）。

## 依赖 / 引用

- `./runtime.ts` 的 `createRuntime`；`./domain/route-path.ts` 的 `isLoopbackHost`。
- 被 `npm start`（`node src/main.ts`）与 `npm run dev`（`node --watch src/main.ts`）直接执行；`deploy/Dockerfile` 的容器入口也是它。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `main` | `() => Promise<void>` | `Promise<void>` | 完整启动流程 + 优雅退出 | 任一安全步骤失败即退出；见下文逐步 |
| `shutdown` | `(signal: string) => Promise<void>` | `Promise<void>` | 关闭 Fastify 后 `process.exit(0)` | 内部定义；`app.close()` 抛错也会退出（`finally`） |
| 顶层 `main().catch(...)` | 表达式 | — | 启动失败时写 stderr 并 `exit(1)` | 打印 `err.message`（不是堆栈） |

## 函数详情

### `main()`

- **签名**：`() => Promise<void>`
- **出参**：`Promise<void>`（进程不返回，监听中）。
- **功能**：按固定顺序执行 6 步：

  ```text
  1. createRuntime()                 读配置、建目录、装配
  2. enforceExposureGuard()          安全闸门 —— 先于监听
  3. containers.listContainers()     Docker 预热，让启动日志显示真实数据源
  4. publishSnapshot()               发布首份 serve 路由快照
  5. app.listen()                    此时才开始对外提供管理接口
  6. 复核 server.address()           非回环则自我关闭
     → 打印横幅 + 注册 SIGINT/SIGTERM 优雅退出 + 启动快照定期刷新定时器
  ```

- **边缘条件**：
  - **第 2 步失败只警告不退出**（`logger.warn('启动安全检查未能完成（Tailscale 不可用？）')`）：tailscale 暂时不可用不应该让管理界面起不来；
  - 第 2 步检测到暴露时记 `logger.error`，摘除动作已由 `enforceExposureGuard` 完成（受 `TSCONTROLLER_AUTO_UNEXPOSE` 控制）；
  - 第 3 步失败只警告，界面仍可打开（只显示 tailscale 侧状态）；
  - 第 4 步失败只警告（其它项目的只读消费会受影响，但进程可用）；
  - **第 6 步是纵深防御**：`app.server.address()` 不是回环地址时立刻 `app.close()` 并抛错——即使 `config` 与 `listen` 之间出现任何偏差（例如被中间件改写），进程也会自行退出而不是静默暴露；
  - 横幅打印的 `baseUrl` 读失败时回落 `'(未知)'`，不影响启动；
  - 快照定时器 `unref()`，**不阻止进程退出**；`TSCONTROLLER_SNAPSHOT_INTERVAL_MS = 0` 时完全不装定时器。

### `shutdown(signal)`

- **签名**：`(signal: string) => Promise<void>`（`main` 内部定义）
- **入参**：信号名（`SIGINT` / `SIGTERM`）。
- **出参**：`Promise<void>`。
- **功能**：记一条 info 日志 → `await app.close()` → `process.exit(0)`。
- **边缘条件**：`app.close()` 抛错也会退出（`try/finally`），避免挂死；不显式清理定时器（`unref` 已保证它不阻塞）。

### 顶层 `main().catch(...)`

- **功能**：启动失败时向 **stderr** 写 `启动失败：<message>` 并 `process.exit(1)`。
- **边缘条件**：只打印 `message`（不打堆栈，保持常驻日志整洁）；非 Error 抛出物用 `String(err)`。

## 启动产物（供排查用）

| 产物 | 位置 | 说明 |
| --- | --- | --- |
| 管理界面 | `http://<host>:<port>`（默认 `127.0.0.1:8787`） | 仅本机可访问 |
| 路由快照 | `<DATA_DIR>/public/serve-routes.json` | 首份在监听前写出；之后每次收敛后与定期刷新 |
| 映射库 / 审计 | `<DATA_DIR>/mappings.json` / `<DATA_DIR>/audit.jsonl` | 由 `MappingService` 写入 |
| 启动横幅 | stdout | 管理界面地址、对外基址、数据目录、快照路径 |

## 待办与隐患

- [ ] **常驻化未完成**：目前只能前台 `npm start`。正确做法是 Windows 计划任务（登录时触发、**以当前用户身份**运行）——不能用 `LocalSystem`，因为 `Tailscale` 那条命名管道位于 `ProtectedPrefix\Administrators` 下，服务账户会话拿不到它。见项目 `todo.md` 第 2 项。
- [ ] 已知边界：进程没有做「单实例」保护；两个实例指向同一 `dataDir` 会互相覆盖映射库（设计前提是单机单实例）。
