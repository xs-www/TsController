# `test/route-path.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

`src/domain/route-path.ts` 的纯函数契约测试。这个模块是**映射校验的唯一入口**：API 入参、持久化数据、以及从 `tailscale serve` 读回的配置都要先经过这里归一化，因此它的每一条规则背后都对应一类真实事故——路径里的 `..` 让 serve 的匹配语义不可预测、Service 名被静默折叠大小写会指向一个不存在的 Service、把 8443 上的 `/` 与 443 上的 `/` 当成同一条路由会让用户拿到指向错误服务的链接。本文件就是这些规则的可执行说明书。

## 依赖 / 引用

- `vitest`：`describe` / `expect` / `it`。
- `../src/domain/route-path.ts`（全部 15 个导出符号）：`buildBaseUrl`、`buildProxyUrl`、`buildServiceDnsName`、`formatRouteRef`、`isLoopbackHost`、`isValidPort`、`normalizeRemoteHost`、`normalizeRoutePath`、`normalizeServiceName`、`normalizeTargetPath`、`parseProxyUrl`、`routePathKey`、`sameRoutePath`、`serveRouteKey`、`serviceShortName`、`suffixFromNodeDnsName`。
- 不被任何其它文件引用（测试文件是叶子）。同族测试：`test/serve-config.test.ts`（读回配置时的 Service 解析）、`test/reconcile.test.ts`（把这里的结果用于冲突判定与摘除）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| （无自定义函数） | — | — | 本文件只有 7 个 `describe`、19 个 `it`，没有声明任何函数、类或辅助构造器 | 测试数据全部**内联**在断言里，没有夹具函数 |

> 说明：按「函数清单枚举文件里全部函数」的要求，本文件提取到的函数数为 **0**；被它覆盖的 15 个被测函数已在「依赖」中列出，其契约由下方「用例覆盖表」逐条守住。

## 函数详情

### `describe('normalizeRoutePath')` — 路径归一化

- 该分组守的是「用户输入怎么变成合法挂载路径」这一层。归一化规则是：折叠重复斜杠、去尾斜杠、保留根路径、去首尾空白；拒绝不以 `/` 开头、含空白/`?`/`#`、含反斜杠、含 `.`/`..` 段的输入。
- 两个用例分工明确：**接受**一组常见写法（含 `//calendar//ics//` 这种从别处粘来的路径），**拒绝**一组危险或不可表达的路径。

### `describe('normalizeTargetPath')` — 目标路径归一化

- 只有一条用例，守的是「空串与 `/` 都等价于不追加路径」：目标路径是可选追加项，若让 `'/'` 原样进入 `buildProxyUrl()`，会得到 `http://127.0.0.1:8080/` 这种与 `http://127.0.0.1:8080` 不等价的字符串，进而让 `isSameProxy()` 的比较退化。

### `describe('buildProxyUrl / parseProxyUrl')` — 代理地址往返

- 一条用例覆盖两个方向的往返一致性：构造出的地址能被解析回同样的 `hostPort` / `targetPath` / `loopback`。这是 `MappingService` 判断「serve 里现在写的是不是我心里想的那条」的基础。

### `describe('辅助判断')` — 端口、回环与大小写

- 三条用例分别守住三个独立判断：`isValidPort`（端口区间与整数性，含类型防御 `'80'`）、`isLoopbackHost`（含 `localhost` 大小写与 IPv6 `::1`）、`sameRoutePath` / `routePathKey`（大小写不敏感）。

### `describe('路由身份：Service + 端口 + 路径')` — 三元组身份

- 这是本文件里**最贵**的一组，四条用例专盯「什么算同一条路由」：端口进身份、Service 进身份、`buildBaseUrl` 只在非 443 带端口、`buildBaseUrl` 对 Service 级换用 Service 的 MagicDNS 名并给出空串兜底、`formatRouteRef` 的展示格式。同名路径在不同命名空间/端口下必须是不同条目——这条属性一旦破掉，`planReconcile()` 会把两条独立映射判成冲突，或把其中一条误删。

### `describe('Service 名')` — Service 名的接受与拒绝

- 四条用例守住 Service 名的归一化（裸名与 `svc:` 前缀都接受、统一成 `svc:` 形式）、字符集收窄、以及**大小写不折叠**这一刻意取舍。最后一条尤其重要：`'DSH'` 被拒绝而不是被改写成 `svc:dsh`，因为「静默改写成另一个已存在的 Service」比「报错」危险得多。

### `describe('远端代理目标')` — Service host 的远端目标

- 三条用例守住对象式 `buildProxyUrl`（远端主机 + 协议）、`normalizeRemoteHost` 的语义（**回环等同未指定**，且拒绝带协议/端口的写法）、以及 `parseProxyUrl` 对 `https+insecure://` 伪协议的显式拒绝。

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `normalizeRoutePath > 接受并归一化常见写法` | 折叠重复斜杠（`//calendar//ics//` → `/calendar/ics`）、去尾斜杠、保留根路径 `/`、去首尾空白；同时锁定 `'worldforge'`（无前导斜杠）必须是 `ok: false`——若这里放宽，serve 会收到一个自己会改写的路径，映射库与实际配置就此分叉 |
| `normalizeRoutePath > 拒绝危险或不可表达的路径` | 空串、空白、查询串 `?`、片段 `#`、反斜杠、`..` 段、`.` 段一律拒绝。`..` 与 `.` 是**安全项**：serve 匹配前会先解码请求路径，含 `..` 的挂载点语义不可预测 |
| `normalizeTargetPath > 把空串与根路径都归一化为空` | `undefined` / `''` / `'/'` 三者等价（都归为 `''`），且 `/api/agent/` 去尾斜杠。守住 `buildProxyUrl()` 不会产出带尾斜杠的代理地址，从而让 `isSameProxy()` 的比较稳定 |
| `buildProxyUrl / parseProxyUrl > 往返一致` | 构造与解析往返一致；`loopback` 按主机判定（`192.168.1.10` 为 false）；IPv6 `https://[::1]:8443` 能解析出 `8443` 且方括号被去掉；`'not-a-url'` 返回 `null` 而不是抛错 |
| `辅助判断 > isValidPort` | 边界 `1` / `65535` 合法，`0` / `65536` / `1.5` / 字符串 `'80'` 非法。守住「端口必须是 1-65535 的整数」，防止 `NaN` 或字符串端口流进 serve 参数 |
| `辅助判断 > isLoopbackHost` | `127.0.0.1` / `localhost` / `LOCALHOST` / `::1` 为回环；`0.0.0.0` / tailnet IP / MagicDNS 名**不是**。这条直接决定「容器是否绕开本工具直接监听 tailnet」的显示与安全判定 |
| `辅助判断 > sameRoutePath 忽略大小写` | 冲突检测按大小写不敏感（`/App` 与 `/app` 视为同一路由），但路径本身仍按原样保存（见上一条用例里的 `/Calendar`） |
| `路由身份：Service + 端口 + 路径 > serveRouteKey 把端口纳入身份` | 键的字面格式 `-\|443\|/app`（节点级占位符为 `-`、路径小写化），且**同路径不同端口必须是不同的键**。这是「443 与 8443 是两个独立 origin」在数据结构上的落地 |
| `路由身份：Service + 端口 + 路径 > serveRouteKey 把 Service 纳入身份` | 节点级 `/x` 与 `svc:dsh` 的 `/x`、以及不同 Service 的同路径，必须是三个不同的键；Service 名比较大小写不敏感（`svc:DSH` 与 `svc:dsh` 同键）。若破掉，`planReconcile()` 会把节点级与 Service 级路由互相覆盖或误删 |
| `路由身份：Service + 端口 + 路径 > buildBaseUrl 只在非 443 时带端口` | 443 省略端口、8443 带端口；`hostname` 为 `null` 时返回空串（界面据此隐藏链接，而不是给一个错地址） |
| `路由身份：Service + 端口 + 路径 > buildBaseUrl 对 Service 级路由改用 Service 的 MagicDNS 名` | Service 级地址是 `https://dsh.<suffix>`（而不是节点名）；MagicDNS 后缀缺失时从节点 DNS 名推导；两者都拿不到时返回空串 |
| `路由身份：Service + 端口 + 路径 > formatRouteRef 省略 443 并在 Service 级带上前缀` | 展示格式：443 省略端口、非 443 写 `:8443/`、Service 级写 `svc:dsh:/`。日志与审计事件里的路由标签依赖它 |
| `Service 名 > 接受裸名与 svc: 前缀，并统一归一化为 svc: 形式` | `dsh` / `svc:dsh` / 带空白的 `  svc:dsh  ` / 含 `.` `_` 的 `my-app_1.web` 都归一化为带前缀形式，全系统只保留一种表示 |
| `Service 名 > 拒绝空名、只有前缀、以及非法字符` | 空串、`null`、只有前缀 `svc:`、以 `-` 开头、含 `/` 与 `..` 一律拒绝；**`'DSH'` 被拒绝而不是折叠成 `svc:dsh`**——静默改写会指向一个不存在的 Service |
| `Service 名 > serviceShortName 去掉前缀` | 裸名与带前缀都得到裸名，供拼 MagicDNS 名与界面展示使用 |
| `Service 名 > buildServiceDnsName / suffixFromNodeDnsName` | 后缀显式给出时直接用；缺省时从节点 DNS 名推导；两者都缺返回 `null`；`'laptop'`（只有一段）推导失败返回 `null` |
| `远端代理目标 > buildProxyUrl 支持远端主机与协议` | 数字式与对象式两种签名等价；`remoteHost` 存在时替换 `127.0.0.1`；`targetPath` 与 `scheme: 'https'` 都生效。Service host 代理远端资源时写的就是这个地址 |
| `远端代理目标 > normalizeRemoteHost 把回环视为「未指定远端」，并拒绝带协议/端口的写法` | `undefined` / `''` / `127.0.0.1` / `localhost` 都归为 `host: null`（回环的语义就是「非远端」）；带协议前缀 `http://nas.ts.net` 与含空格的 `nas ts.net` 被拒绝 |
| `远端代理目标 > parseProxyUrl 拒绝 https+insecure 这类伪协议` | `https+insecure://` 必须返回 `null`。`new URL()` 会接受它，若不显式排除，本工具会把一个「跳过证书校验」的目标当成可托管代理导入并原样写回 |

## 全局常量 / 变量

- 无模块级常量或变量。所有期望值都内联在断言里（文件刻意不建夹具函数，避免「夹具本身有 bug 却在测夹具」）。

## 待办与隐患

- [ ] 无 TODO 标记。真实观察：`normalizeRoutePath` 对路径里的 `|`（内部键分隔符）与 `%`（编码序列）都没有断言，而它们会分别影响测试替身的 `unkey()` 与真实 serve 的解码匹配——属于未覆盖的边界。
- [ ] 控制字符分支（`/[\u0000-\u001f]/`）在源码里存在，但本文件没有对应用例。
- [ ] `normalizeRemoteHost` 的「主机名过长（> 253）」分支没有用例。
- [ ] `parseProxyUrl` 对省略端口的地址（`http://host` → 80 / `https://host` → 443 回落）没有用例，而 `test/fakes.ts` 的替身在这点上与真实解析器**行为不同**（替身得到 `NaN`）。
