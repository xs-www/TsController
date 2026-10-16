# `test/service-config.test.ts`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

Tailscale **Service** 配置解析与 CLI 参数拼装的测试。这两层是 Service 支持的地基，也因此是最贵的一层：

- `parseServiceConfig` 读的是 `tailscale serve get-config --all`（`serve status --json` 里**根本没有 Service**，只读后者会让 Service 路由对本工具完全不可见，既管不了、安全闸门也扫不到）；
- `TailscaleCli` 必须把 `--service=svc:x` 放在 `--https` **之前**，否则会改错命名空间——这是把用户的配置写到别的 Service 上。

测试数据取自上游实现（`cmd/tailscale/cli/serve_v2.go` 的 `runServeGetConfig`）与官方文档的配置样例。

## 依赖 / 引用

- `vitest`：`describe` / `expect` / `it`。
- `../src/tailscale/serve-config.ts`：`mergeServeSnapshots`、`parseEndpointKey`、`parseServeStatus`、`parseServiceConfig`、`parseServiceTarget`、`serviceInfoOf`。
- `../src/tailscale/tailscale-service.ts`：`parseServiceHostCap`。
- `../src/tailscale/tailscale-cli.ts`：`TailscaleCli`（被测类）、`CommandRunner`（类型）、`RunResult`（类型）。
- `../src/logger.ts`：`silentLogger`。
- 不被任何其它文件引用。同族测试：`test/serve-config.test.ts`（节点级解析）、`test/reconcile.test.ts`（消费 `mergeServeSnapshots` 的结果做状态判定）。

## 函数清单

| 函数名 | 签名摘要 | 出参 | 功能 | 边缘条件 |
| --- | --- | --- | --- | --- |
| `RecordingRunner.constructor` | `(out?: string = '{}')` | `RecordingRunner` | 造一个假执行器，固定返回 `{ code: 0, stdout: out, stderr: '' }` | 不能用它模拟非 0 退出码或 IO 错误（`code` 恒为 0） |
| `RecordingRunner.run` | `(_bin: string, args: string[]) => Promise<RunResult>` | `Promise<RunResult>` | 记录参数并返回预置 stdout | 忽略 `_bin`（二进制名），只断言参数数组；参数按**引用**记进 `calls`，被测代码若复用同一个数组会被后续修改影响 |
| （其余为用例与常量） | — | — | 本文件没有其它函数或类；`it` 用例在下方「用例覆盖表」逐条列出 | — |

`RecordingRunner` 的私有字段 `#out`：构造时固定，`run()` 每次返回同一个字符串；`calls` 是「参数数组的轨迹」，是 `TailscaleCli` 拼参顺序的唯一证据。

## 函数详情

### `describe('parseEndpointKey')` — 端点键

- 两条用例：解析 `tcp:443` 与端口区间 `tcp:8000-8010`（取区间起点），协议大小写不敏感；拒绝没有端口或越界的形态（`tun` / `tcp:` / `tcp:0` / `tcp:70000`）。
- 守住的是「哪些端点属于本工具的托管范围」：只有带合法端口的 `tcp:` 端点才参与托管，`tun` 这类非端口端点直接跳过。

### `describe('parseServiceTarget')` — 端点目标

- 三条用例，把目标串分成三类：HTTP(S)（可托管代理，带 `fromServiceConfig: true` 标记与 `loopback` 判定）、`tcp:`/`unix:`（归 `other`，只读展示不托管）、无法解析（返回 `null`，由调用方归 `other`，**不让整次解析失败**）。

### `describe('parseServiceConfig')` — Service 端点配置

- 四条用例：把端点映射成带 Service 维度的路由、收集 Service 状态与「需要被安全检查盯住的 HTTP(S) 端口」、退化输入的容错、以及缺 MagicDNS 后缀时退回裸 Service 名。

### `describe('mergeServeSnapshots')` — 节点级与 Service 级合并

- 三条用例：两个命名空间共存且端口取并集、`service-host` 能力把 Service 标成已承认并带上 TailVIP、只在 `service-host` 里出现的「幽灵 Service」也要被列出。

### `describe('parseServiceHostCap')` — `service-host` 能力

- 三条用例：对象形态、数组形态（不同版本序列化差异）、以及忽略非 `svc:` 键与非法值时**退化为未承认**而不是抛错。

### `describe('TailscaleCli 的 Service 参数拼装')` — CLI 拼参

- 五条用例逐条锁定 CLI 参数数组的字面内容：服务级挂载、节点级挂载（保持既有行为）、服务级摘除、`serveGetConfig`、`serveClear`。

## 用例覆盖表

| 用例 | 守住什么回归 / 契约 |
| --- | --- |
| `parseEndpointKey > 解析 tcp:端口 与端口区间` | `tcp:443` → `{protocol:'tcp', port:443}`；区间 `tcp:8000-8010` 取起点 `8000`；`TCP:80` 协议归一化为小写。端口区间在上游会展开成多条监听，本工具只登记起点，避免一条端点被当成多条路由 |
| `parseEndpointKey > 拒绝没有端口或越界的形态（tun 之类不参与托管）` | `tun` / `tcp:` / `tcp:0` / `tcp:70000` 全部返回 `null`。`tun` 是四层隧道端点、没有可解析端口，必须被跳过而不是被当成 0 号端口 |
| `parseServiceTarget > HTTP(S) 目标是可托管的代理` | 远端 `http://…:3081` 解析出 `host` + `hostPort: 3081` + `loopback: false` + `fromServiceConfig: true`；本机 `http://127.0.0.1:3081` 为 `loopback: true`；`https://…:8443` 同样可托管。`fromServiceConfig` 标记是「这条 handler 来自 Service 配置」的唯一凭据，界面与状态判定都依赖它区分来源 |
| `parseServiceTarget > tcp / unix 目标是「其它」，只读展示不参与托管` | `tcp://127.0.0.1:5432` 与 `unix:/var/run/app.sock` 归 `other`。工具不接管 L4 转发与 unix socket，但必须看得见它们 |
| `parseServiceTarget > 无法解析的目标也归为「其它」，而不是让整次解析失败` | `'nonsense'` 目标仍产生**一条** `kind: 'other'` 且 `raw` 保留原串的路由，`httpsPorts` 为空。破掉这条会导致「本节点上还有一条我没看见的端点」——安全闸门据此漏扫 |
| `parseServiceConfig > 把端点映射成带 Service 维度的路由` | `svc:dsh` 的 `tcp:443` → 路由 `{service:'svc:dsh', servePort:443, path:'/', host:'dsh.example-tailnet.ts.net', managed:false, mappingId:null}`；`svc:db` 的 4 个端点里空目标被丢弃（`tcp:9999: ''`）、`tcp:5432` 与 `tcp:9000` 归 `other`、`tcp:8080` 解析出远端 `nas…:8443`——合计 4 条路由。空目标必须丢弃（它是一条无效端点），而 `tcp`/`unix` **不能**丢弃 |
| `parseServiceConfig > 收集 Service 状态与「需要被安全检查盯住」的 HTTP(S) 端口` | `httpsPorts` 是 `[443, 8080]`：判定看**目标协议**（`http(s)://`）而不是端点键（`tcp:`）——`tcp:5432` 的纯 L4 转发不进、`8080` 的 https 目标进。`serviceInfoOf(snap,'svc:dsh')` 给出去掉前缀的 `dnsName`、`servePorts: [443]`、`advertised: true`；**`svc:db` 没有显式 `advertised` → `false`**（缺省值不可信） |
| `parseServiceConfig > 未知/空输入返回空快照而不是抛错` | `{}` 与 `null` 都给空快照；`{ 'svc:x': {} }` 仍产出一条 `ServiceInfo`（`servePorts: []`、`advertised: false`）。没有端点的 Service 也要出现，否则「配置里声明了但没写端点」这种中间态在界面上不可见 |
| `parseServiceConfig > 没有 MagicDNS 后缀时退回裸 Service 名（不报错）` | 缺后缀时路由 `host` 是裸名 `'dsh'`。写入配置不依赖这个地址，只有界面链接受影响，因此必须降级而不是失败 |
| `mergeServeSnapshots > 节点级与 Service 级路由共存，端口取并集` | 合并后 `httpsPorts` 是 `[443, 8443]`（节点级两个端口的并集）、`hostname` 取节点级值、路由列表为 `['node/dsh', 'svc:dsh/']`。两个命名空间的路由键不会撞车，因此只做拼接——但拼接顺序必须稳定（先端口、再 service 名、再路径） |
| `mergeServeSnapshots > service-host 能力把 Service 标成已承认并带上 TailVIP` | `serviceHosts: { 'svc:dsh': ['100.65.32.1','fd7a::1'] }` 把 `advertised` 翻成 `true` 并填入 `vipIps`。**本节点是否真的被承认为 host，唯一证据就是 `Self.CapMap["service-host"]`**，配置里的 `advertised` 字段不可信 |
| `mergeServeSnapshots > 只在 service-host 里出现（配置里没有端点）的 Service 也会被列出` | 得到 `{ name:'svc:ghost', dnsName:null, servePorts:[], advertised:true, vipIps:['100.65.32.9'] }`。这是「已被承认但还没配 endpoint」的中间态，必须让用户看见 |
| `parseServiceHostCap > 解析对象形态的 CapMap` | `{ 'service-host': { 'svc:dsh': [...] } }` → `{ 'svc:dsh': [...] }` |
| `parseServiceHostCap > 解析数组形态的 CapMap（不同版本的序列化差异）` | `[{ 'service-host': {...} }]` → 同上。不同 Tailscale 版本序列化形态不同，只支持一种会让升级后「Service 突然都变成未承认」 |
| `parseServiceHostCap > 忽略非 svc: 的键与非法值，并容忍完全缺失` | 非 `svc:` 的键不出现；值为非数组（`'not-an-array'`）时该 Service 以空数组出现（不是漏项、也不是抛错）；`undefined` / `null` / `{}` 都返回 `{}`。解析失败只会退化成「未承认」，比抛错安全 |
| `TailscaleCli 的 Service 参数拼装 > 服务级挂载把 --service 放在 --https 之前` | 参数数组严格等于 `['serve','--bg','--yes','--service=svc:dsh','--https=443','--set-path=/','http://my-laptop.example-tailnet.ts.net:3081']`。**顺序即正确性**：`--service` 若排在 `--https` 之后，这条挂载会落到节点级命名空间（或直接报错），用户的 Service 配置就被写到了别处 |
| `TailscaleCli 的 Service 参数拼装 > 节点级挂载不带 --service（保持既有行为）` | 节点级挂载的参数里**没有** `--service`，其余顺序不变（`--https=8443` / `--set-path=/home`）。这条是「加 Service 支持不改变原有行为」的回归锚点 |
| `TailscaleCli 的 Service 参数拼装 > 服务级摘除同样带 --service，且 off 在最后` | `['serve','--yes','--service=svc:dsh','--https=443','--set-path=/','off']`：摘除同样要带 Service，`off` 必须排在最后，且**不带** `--bg` |
| `TailscaleCli 的 Service 参数拼装 > serveGetConfig 走 get-config --all，空输出归一化为 {}` | 命令是 `['serve','get-config','--all']`，且**纯空白输出被归一化成 `{}`** 而不是抛 JSON 解析错误。上游在无配置时会输出空白，这条守住「工具能启动」 |
| `TailscaleCli 的 Service 参数拼装 > serveClear 走 clear，不接受 --yes` | `['serve','clear','svc:dsh']`，**不带 `--yes`**（与挂载/摘除不同）。多带 `--yes` 会改变上游命令的语义，是容易被顺手「统一」掉的细节 |

## 全局常量 / 变量

- `REAL_SERVICE_CONFIG`：模块级常量。`version: '0.0.1'`，`services` 有两项：`svc:dsh` 只有 `advertised: true` 与端点 `tcp:443 → http://my-laptop.example-tailnet.ts.net:3081`；`svc:db` 有 4 个端点（`tcp:5432 → tcp://127.0.0.1:5432`、`tcp:8080 → https://nas.example-tailnet.ts.net:8443`、`tcp:9000 → unix:/var/run/app.sock`、`tcp:9999 → ''`）。这份数据刻意把「可托管代理 / L4 转发 / unix socket / 空目标」四种形态放进同一个夹具，供「合计 4 条路由」这条用例使用。
- `RecordingRunner.#out`：私有只读字段，构造时固定为 `'{}'`（或用例传入的串），决定每次 `run()` 的 stdout。

## 待办与隐患

- [ ] 无 TODO 标记。真实观察：`parseServiceConfig` 的**有损性**（只有根 handler、目标路径可能被丢弃）在源码注释里写得很明确，本文件也只用 `/` 作为路径，因此「Service 上的子路径 handler 读不回来」这一已知限制没有被断言——它现在是文档级约定，不是可执行约束。
- [ ] `parseServiceTarget` 对 `tls-terminated-tcp` 的处理（源码里与 `tcp` 一同归 `other`）没有用例。
- [ ] `RecordingRunner` 恒返回 `code: 0`，因此 `TailscaleCli` 在非 0 退出码/坏 JSON 时的错误路径完全没有覆盖。
- [ ] `serveUpsert` / `serveRemove` 对 `service` 参数的判定是**真值判断**（`service ? [...] : []`），因此空串会被当作节点级处理；`''` 与 `null` 的等价性没有用例，而 `MappingService` 确实会把空串归一化为 `null`（见 `test/service-routing.test.ts`）——两处约定目前是靠代码而非断言对齐的。
- [ ] `RecordingRunner` 只断言参数数组，没有断言 `run()` 收到的 `_bin`；`TailscaleCli` 的二进制名（构造参数 `'tailscale'`）因此不受回归保护。
