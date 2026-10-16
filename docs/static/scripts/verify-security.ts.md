# `scripts/verify-security.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

安全闸门（「本应用禁止暴露在 tailnet 中」）的**真实环境**验证：用真 tailscale 复现六种情形，确认这条要求是在运行时被强制执行的，而不只是写在配置里。

它离线部分与单测重叠，但真实环境这一层无法替代：单测用的是假网关，证明不了「真实 `tailscale serve` 里的路由会被 `enforceExposureGuard()` 找出来并摘掉」。

副作用边界：会在真实 serve 配置里**临时增删 3～4 条 `__tsc-*` 路由**，写 `data/verify-security/` 下的映射库与审计；不启管理 HTTP 服务（`createRuntime` 只装配不 `listen`）、不改 Docker、不对外发请求。

## 依赖 / 引用

- 外部：`node:fs`（`promises`，读审计落盘文件）。
- 同项目文件：`../src/runtime.ts` 的 `createRuntime`；`../src/domain/route-path.ts` 的 `formatRouteRef`。
- 调用方：`package.json` 的 `npm run verify:security`（即 `node scripts/verify-security.ts`）；`README.md` §3 与 §12 记录了 `--service` 用法。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `check` | `(step: string, ok: boolean, detail?: string = '') => boolean` | `boolean` | 记录并即时打印一条断言 | 与 `verify-live.ts` 里同名函数同构（两文件各自持有一份，无共享模块）；跳过段不调用它 |
| `arg` | `(name: string, fallback: string) => string` | `string` | 读 `--name value` 形式的 CLI 参数 | 缺失或值为空串即回落 `fallback`；不支持 `--name=value` |
| `keyOf` | `(route: { service?: string \| null; servePort: number; path: string }) => string` | `string` | 路由身份键 `Service\|端口\|路径` | `service` 用 `?? 'node'` 占位，因此 `undefined` 与 `null` 都被当成节点级；**不排序** |
| `main` | `() => Promise<void>` | `Promise<void>` | 准备泄漏路由 → E 段 → A/D/E 断言 → B → 审计 → C/C2 → `finally` 清理 → 汇总退出 | Service 前提不满足时**只跳过 E 段**，其余照常执行；末尾无论通过与否先清理再汇总 |
| 顶层 `catch`（匿名） | `(err: unknown) => void` | `void` | `main()` 的失败出口：打印 stack 后 `process.exit(1)` | 非 `Error` 抛出物也能读（`String(err)`） |

## 函数详情

### `check(step, ok, detail?)`

- **签名**：`(step: string, ok: boolean, detail = '') => boolean`
- **入参**：`step`（`string`，必选）：断言名，**约定以段号开头**（`A.` / `B.` / `C.` / `C2.` / `D.` / `E.`），因为这份脚本的输出要能一眼对应到需求里的六段；`ok`（`boolean`，必选）；`detail`（`string`，可选，默认 `''`）：证据文本（暴露列表、`removed` 列表、错误码、审计事件种类）。
- **出参**：`boolean`（`ok` 原样返回，调用处不使用）。
- **功能**：推入模块级 `results` 并即时打印 `[PASS]` / `[FAIL]`；结尾的 `N/N` 统计只算真正执行过的断言。
- **边缘条件**：E 段的断言只在 `serviceLeakPort > 0` 时才调用——**跳过 E 段不会污染分母**，也不会让「E 段没验证」被误读成通过。

### `arg(name, fallback)`

- **签名**：`(name: string, fallback: string) => string`
- **入参**：`name`（`string`，必选）：不带 `--` 的参数名；`fallback`（`string`，必选）默认值。
- **出参**：`string`。
- **功能**：`process.argv.indexOf('--' + name)` + 取下一个非空元素。
- **边缘条件**：只支持 `--service svc:dsh` 这一种写法；末尾悬空、空串值、`--name=value` 都会回落默认值；重复传参取第一个。

### `keyOf(route)`

- **签名**：`(route: { service?: string | null; servePort: number; path: string }) => string`
- **入参**：`route`（结构类型，必选）：只读 `service` / `servePort` / `path`。
- **出参**：`string`，如 `node:443:/__tsc-safe` 或 `svc:dsh:443:/__tsc-leak-svc`。
- **功能**：用于「某条既有路由是否仍在」的存在性比对（`after.routes.some(r => keyOf(r) === keyOf(p))`），比逐字段比较短且不会因字段顺序变化而误判。
- **边缘条件**：`service` 用 `?? 'node'`，因此快照里节点级路由的 `service: null` 与 `undefined` 等价；**大小写敏感**（这里的路由名来自 `svc:` 命名空间，不做折叠）。

### `main()`

- **签名**：`() => Promise<void>`
- **入参**：无（唯一参数 `--service` 经 `arg()` 读取）。
- **出参**：`Promise<void>`；结尾 `process.exit(0)` 或 `process.exit(1)`。
- **功能与六段职责**：
  - **准备**：以 `config: { dataDir: 'data/verify-security', port: TEST_ADMIN_PORT, host: '127.0.0.1' }` 调 `createRuntime()`（`port` 同时成为 `MappingService.adminPort`，也就是「什么算暴露」的判据），记下 `before`（运行前的路由集合，用 `formatRouteRef` 归一后排序）作为最终「原样保留」断言的基准；随后写入三条路由并断言它们真的进了 serve。
  - **E 段（准备）**：`--service` 非空且本节点上确有该 Service 且有端点端口时，在**该 Service 自己的命名空间**上再写一条 `SERVICE_LEAK_PATH` 泄漏路由（指向 `TEST_ADMIN_PORT`），并把它的位置 `push` 进 `toClean`；否则打印 `[跳过] E 段：…` 并**只跳过 E 段**。
  - **A 段（启动闸门，443 上的暴露）**：`mappings.enforceExposureGuard()` 必须①在 `exposures` 里报出 `(443, LEAK_PATH)`；②把它放进 `removed`；③重新读快照后该路由确实**消失**。守的是「闸门真的删配置，不只是报告」。
  - **D 段（非默认端口上的暴露）**：同一批 `guard` 结果里必须报出 `(8443, LEAK_PATH_ALT)`，且快照里它也被摘掉；再断言 8443 上**运行前就存在**的其它路由（用户自己的，例如挂在根路径的门户）一条都没被牵连。守的是「扫描范围覆盖全部 HTTPS 端口，不只 443」——早期实现只解析 443 那一组 Web 配置，挂在 8443 上的暴露对闸门完全不可见，这是一个**真实存在过的安全缺口**。
  - **E 段（断言）**：`guard.exposures` 里必须有 `(svc:<名>, SERVICE_LEAK_PATH)`、快照里它必须被摘掉、且该 Service 上运行前就有的端点一条都不能少。**E 段为什么必要**：`serve status --json` **不包含 Service**，只读它会让 Service 上的暴露对闸门完全不可见——这是 Service 支持引入的第二个同类缺口，与 D 段是同一类错误的两个面。
  - **B 段（不误伤）**：`SAFE_PATH`（指向 `DEAD_PORT`，不是管理端口）必须仍在 serve 里。与 A/D 配对，防止「把闸门写成清空所有路由」也算通过。
  - **审计**：`audit.tail(50)` 必须同时含 `exposure-detected` 与 `exposure-removed` 两类事件；再直接读 `data/verify-security/audit.jsonl` 文本，断言其中含 `exposure-removed` 且含 `:8443` —— 这一步守的是**落盘**（而不只是内存里的审计对象）与非默认端口标签。
  - **C 段（创建入口拒绝）**：`mappings.create({ path: '/__tsc-blocked', hostPort: TEST_ADMIN_PORT })` 必须抛错且 `code === 'exposes-admin'`（脚本直接调服务层，HTTP 409 的映射由 `test/api.test.ts` 覆盖）。
  - **C2 段（对外端口与管理端口同号）**：`mappings.create({ hostPort: 4173, servePort: TEST_ADMIN_PORT })` 必须抛错且 `code === 'serve-port-is-admin'`。
  - **C 段收尾**：再读一次快照，确认被拒绝的两条路径**一条都没写进 serve**（拒绝必须是「零写入」，不是「写了再回滚」）。
  - **`finally` 清理**：按 `toClean` 顺序逐项清理（详见下）；**清理完成后**才做「原有 serve 配置未被破坏」的最终比对与汇总，因此清理失败会体现为最终比对失败，而不是被静默吞掉。
- **`toClean` 与 `finally` 的清理顺序**：
  - `toClean` 是模块级数组，初始 4 项：`(null,443,LEAK_PATH)`、`(null,443,SAFE_PATH)`、`(null,LEAK_PORT,LEAK_PATH_ALT)`、`(null,443,'/__tsc-blocked')`；E 段的 Service 泄漏路由在准备成功后**追加**到末尾。它记的是「**可能**需要清理的位置」，不是「已写入的位置」。
  - `finally` 遍历 `toClean`，**每一项都先重新 `gateway.snapshot()` 判断是否真的存在**：不存在就 `continue`（因此 A/D/E 已被闸门摘掉的路由不会被二次删除，`/__tsc-blocked` 因被拒绝也通常不存在）；存在才 `gateway.removeRoute(servePort, path, service)` 并打印 `[清理] 摘除 …`，抛错则打印 `[清理失败] …` 而**不中断**后续项。
  - 顺序即数组顺序：先 443 的两条泄漏/安全路由 → 8443 上的泄漏 → C 段被拒绝的路径 → 最后才是 Service 泄漏。这个顺序不承担语义，真正的保证来自「存在性判断 + 逐项 try/catch」：**任何一项清理失败都不会留下后续项不清的理由**。
- **边缘条件**：
  - 提前退出为 `exit(1)` 的情况：脚本异常（顶层 catch）。**没有**「前提不满足就终止」的分支——Service 不满足只是跳过 E 段；
  - `--service` 给的名称按 `toLowerCase()` 与 `before.services[].name` 字面比对（快照里带 `svc:` 前缀），传裸名会找不到并跳过 E 段；
  - E 段准备时**故意用另一条路径**（`SERVICE_LEAK_PATH`）而不是覆盖该 Service 上本该存在的 `/` 根路由，避免验证过程破坏用户的真实配置；
  - `original` 与 `final` 都是用 `formatRouteRef` 归一后 `sort()` 的字符串数组，比对方式是 `JSON.stringify` 相等——顺序无关，但**大小写与 Service 前缀敏感**。

### 顶层 `main().catch(...)` 处理器

- **签名**：`(err: unknown) => void`
- **入参**：`err`（`unknown`）：归一为 `Error.stack ?? Error.message`，否则 `String(err)`。
- **出参**：`void`（`process.exit(1)`）。
- **功能**：把 `验证脚本异常：<stack>` 写到 stderr 并退出码 1。
- **边缘条件**：若异常发生在 `try` 块内，`finally` 的清理**已经执行**；若发生在 `createRuntime`/`before` 读取阶段（还没写任何路由），则没有清理动作——此时也没有留下任何临时配置。被清理失败挡下的路由**不会**触发这个出口（清理失败只打印，不抛）。

## 命令行参数 / 环境

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--service <Service 名>` | `''`（不跑 E 段） | 追加 E 段：在该 Service 的命名空间上造一条泄漏路由，验证闸门能检出并摘除。必须是本节点 serve 配置里**已存在**且带端点端口的 Service（快照名带 `svc:` 前缀，传裸名会被判为不存在而跳过 E 段） |
| 位置参数 / 未知参数 | 忽略 | `arg()` 只做精确查找 |
| `config.dataDir`（写死） | `data/verify-security` | 真实映射库、审计、快照的落点；由 `npm run clean:verify` 清理 |
| `config.port`（写死） | `TEST_ADMIN_PORT = 8789` | 同时是 `MappingService.adminPort` —— **决定了哪条路由会被判定为「暴露」**。选它的用意是「零暴露窗口」：泄漏路由必须指向一个**无人监听**的端口，而 `createRuntime()` 只装配 Fastify 实例、**从不 `listen`**，所以 8789 全程没有服务在跑；于是「路由已写入、闸门还没摘」的那一瞬间也不会有任何数据外泄。源码注释写明「确认空闲后才会使用」 |
| `DEAD_PORT = 9` | — | `SAFE_PATH` 的代理目标端口。① 它必须**不等于**管理端口，否则 B 段的路由会被闸门判为暴露而误伤断言；② 选 discard 端口（9）意味着即使这条被保留的路由真的被访问到，也没有任何服务在听——B 段既证明「不误伤」，又不制造新的泄漏面 |
| `LEAK_PORT = 8443` | — | D 段的非默认 HTTPS 端口。真实环境需已声明该端口（`tailscale serve --https=8443`），否则准备阶段的断言会失败 |
| `LEAK_PATH` / `SAFE_PATH` / `LEAK_PATH_ALT` / `SERVICE_LEAK_PATH` | `/__tsc-leak` / `/__tsc-safe` / `/__tsc-leak-alt` / `/__tsc-leak-svc` | 四条临时路径，全部带 `__tsc-` 前缀以便与用户配置区分 |
| 审计文件 | `data/verify-security/audit.jsonl` | C/审计段直接 `fs.readFile` 该文件；文件缺失时按空串处理（断言会失败，从而暴露「审计没落盘」） |
| 真实环境前提 | — | 可读写的真实 `tailscale serve` 配置；D 段要求 8443 已被声明；E 段要求 `--service` 指定的 Service 已存在 |
| 退出码 | `0` / `1` | 有 FAIL 或脚本异常均 1 |

## 待办与隐患

- [ ] **零暴露窗口依赖「8789 真的没人监听」，而脚本并不校验这一点。** 源码注释写的是「确认空闲后才会使用」，但代码里没有探测；如果恰好有别的程序占用 8789，从写入泄漏路由到闸门摘除之间的窗口就不是零暴露。E 段同理依赖 Service 端口上原本的配置。
- [ ] `TEST_ADMIN_PORT` 是**编译期常量**：若本机 8789 已被 TsController 自己（或别的实例）占用，脚本不会报错，但「零暴露」的推理不再成立——应该改成启动前探测端口是否空闲。
- [ ] 脚本调的是 `MappingService.create()`（服务层）而非 HTTP 接口，因此 C/C2 段只证明**服务层**拒绝；HTTP 状态码 409 的映射由 `test/api.test.ts` 覆盖。文件名里的「API 层拒绝」指的是这个语义层，不是 HTTP 层。
- [ ] D 段依赖 8443 在真实 serve 里已被声明。未声明时准备阶段就会 FAIL（不是跳过），可能被误读成「闸门漏检」——读输出时要先看准备阶段的 `httpsPorts=[…]`。
- [ ] 与 `verify-live.ts` 一样存在「中途被强杀则 `finally` 来不及跑」的残留风险（`/__tsc-leak*`、`/__tsc-safe`）。残留不会造成暴露（目标分别指向无人监听的 8789 与 discard 端口 9），但会污染下一次的 `before` 基准。
- [ ] 未覆盖：**远端目标**形式的暴露（Service host 代理到另一台主机时，配置里只有那台主机名，本工具无法判断它是不是本机）——这一层只能靠 ACL 保证，`README.md` §4 有同样结论。
