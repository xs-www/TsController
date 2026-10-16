# `test/serve-config.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

「从 Tailscale 读回来的东西怎么变成领域模型」这一层的解析测试，覆盖两个不同来源：`tailscale serve status --json`（节点级，`{ TCP, Web }` 旧结构，`parseServeStatus`）与 `tailscale status --json`（本机身份与 tag，`parseTailnetInfo`）。测试数据是**真实 CLI 输出的同构体**（文件里保留了 `Web` 上有 443 与 8443 两个键、共 9 条 handler 的那份配置）。存在的理由是两类事故：解析要多容错（配置为空、字段缺失时不能抛错，否则工具自己起不来），但**保留全部端口**这一点绝不能省（早期实现只取一组 `Web`，导致挂在非 443 端口上的路由对工具完全不可见，既管不了、安全闸门也扫不到）。

## 依赖 / 引用

- `vitest`：`describe` / `expect` / `it`。
- `../src/tailscale/serve-config.ts`：`parseServeStatus`、`proxiedRoutes`、`snapshotHostname`、`splitHostPort`。
- `../src/tailscale/tailscale-service.ts`：`parseTailnetInfo`。
- 不被任何其它文件引用。同族测试：`test/service-config.test.ts`（同一模块的 Service 侧解析与 `mergeServeSnapshots`）、`test/reconcile.test.ts`（消费这里产出的快照）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| （无自定义函数） | — | — | 本文件只有 2 个 `describe`、10 个 `it` 与模块级常量 `REAL_STATUS`，没有声明任何函数、类或辅助构造器 | 全部输入内联或来自 `REAL_STATUS` 常量，没有夹具函数 |

> 说明：本文件提取到的函数数为 **0**；被覆盖的 6 个被测函数（`parseServeStatus` / `proxiedRoutes` / `snapshotHostname` / `splitHostPort` / `parseTailnetInfo`，以及间接依赖的 `parseHandler`、`parseProxyUrl`）的契约由下方「用例覆盖表」逐条守住。

## 函数详情

### `describe('parseServeStatus')` — 节点级 serve 配置

- 九条用例，覆盖「正常读回一份真实配置」与六种退化输入。核心不变式有两个：`httpsPorts` 必须保留 **全部** 声明为 HTTPS 的端口；`routes` 必须做到「同路径不同端口 = 两条独立路由」，且排序确定（先端口、再路径）。
- 另外两条用例守住解析的容错边界：非代理 handler（`Text` / `Path`）要归成 `text` / `file` 而不是被丢掉，以及工具函数 `proxiedRoutes` / `snapshotHostname` / `splitHostPort` 的基础行为。

### `describe('parseTailnetInfo')` — 本机 tailnet 身份

- 两条用例：正常字段的清洗（去掉 `DNSName` 尾点、拼出 `baseUrl`）与「字段全缺时不抛错」。

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `parseServeStatus > 解析真实配置，且保留全部 HTTPS 端口` | `httpsPorts` 是 `[443, 8443]` 而不是只留一组；`hostname` 从 `Web` 键推导；9 条 handler 全部成路由；`/agent` 的 `servePort` 是 443 且 `handler` 解析出 `hostPort: 443` / `targetPath: '/api/agent'` / `loopback: true`。**这是「所有端口都可见」这条不变式的正面锚点** |
| `parseServeStatus > 同一路径出现在不同端口时是两条独立路由` | 两个 `Web` 键里都有 `/`，必须得到 2 条路由（端口 443 与 8443），且各自的目标端口分别是 3081 与 8899。若这里退化成「按路径去重」，8443 上的配置会被 443 上的覆盖，工具会去改一个不相干的 origin |
| `parseServeStatus > 路由按端口再按路径排序` | 快照顺序确定（`${servePort}${path}` 已有序）。界面列表、快照文件与测试断言都依赖这个稳定顺序，避免「同一次状态输出两次 diff 不同」 |
| `parseServeStatus > 无配置时返回空快照而不是报错` | `{}` → `{ httpsPorts: [], hostname: null, routes: [], services: [] }`，`null` 输入也不抛错。**这是工具的启动前置条件**：机器上从没用过 `serve` 时 tailscale 就返回 `{}` |
| `parseServeStatus > 只声明了 TCP 没有 Web 时不报错` | 只有端口声明、没有路由时：`httpsPorts` 仍是 `[443]`、`hostname` 为 `null`、`routes` 为空。区分「端口已声明」与「端口上有路由」——前者必须保留，否则后续安全闸门看不到这个端口 |
| `parseServeStatus > 忽略非 HTTPS 的 TCP 声明` | `80: { HTTP: true }` 不进 `httpsPorts`。判定条件是 `cfg.HTTPS === true`（严格布尔），不是「有 TCP 键就算」 |
| `parseServeStatus > 识别非代理 handler` | `{ Text: 'hi' }` → `kind: 'text'`，`{ Path: 'C:\\www' }` → `kind: 'file'`。非代理 handler 必须**如实展示**而不是被静默丢弃，否则界面会以为这个路径是空闲的，进而允许用户覆盖它 |
| `parseServeStatus > proxiedRoutes 过滤掉无法解析端口的条目` | `proxiedRoutes()` 只留 `kind === 'proxy'` 且 `hostPort !== null` 的条目（`/b` 是 `Text`，被滤掉）；`snapshotHostname()` 返回节点级主机名；`splitHostPort('h:443')` 拆成 `{ host: 'h', port: 443 }`。这三个是「可被接管的候选路由」与地址拼装的入口 |
| `parseTailnetInfo > 去掉 DNSName 的尾点并拼出 baseUrl` | `'…ts.net.'` → 无尾点；`baseUrl` 由它拼出；`ips` / `backendState` 原样带上。如果尾点没去掉，Service 的 MagicDNS 名会拼成 `dsh.example-tailnet.ts.net.`，界面链接就不可点了 |
| `parseTailnetInfo > 字段缺失时不抛错` | `{}` → `{ dnsName: null, baseUrl: null, ips: [] }`。`status --json` 在未登录/未运行时字段大量缺失，解析器必须自身可存活 |

## 全局常量 / 变量

- `REAL_STATUS`：模块级常量，取自本机 `tailscale serve status --json` 的真实输出同构体。含 `TCP`：`443` 与 `8443` 都声明 `HTTPS: true`；`Web`：`my-laptop.example-tailnet.ts.net:443` 下有 8 条 handler（`/`→3081、`/agent`→443/api/agent、`/calendar`、`/calendar.ics`、`/dsh`→3081、`/home`→8899、`/salecapitai`→8080、`/worldforge`→4173），`…:8443` 下有 1 条（`/`→8899）。**合计 9 条路由**——两个端口上都出现 `/` 是刻意安排的（它同时验证端口维度与「9 条」这个总数）。

## 待办与隐患

- [ ] 无 TODO 标记。真实观察：`splitHostPort` 只用一条 `'h:443'` 用例覆盖，**没有**覆盖「键里没有端口」（返回 `{ port: null }`，源码里对应「回落到最小已声明端口」的兜底分支）与「端口段不是整数」两条路径，而后者在生产里会决定路由落在哪个端口上。
- [ ] `parseHandler` 的兜底分支（既非 `Proxy` 也非 `Path`/`Text` 时归 `other`，`raw` 为 `JSON.stringify` 结果）没有被本文件覆盖。
- [ ] `Web` 项的 `Handlers` 缺失/非对象时按空对象处理这条退化路径没有用例。
