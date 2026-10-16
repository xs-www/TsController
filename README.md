# TsController

本机 **tailnet ↔ Docker 端口** 路由控制器。它把下面**两种**对外形式统一管起来：

```text
节点级：https://<机器名>.<tailnet>.ts.net/<路径>   →   http://127.0.0.1:<Docker 容器发布的端口>
Service：https://<service 名>.<tailnet>.ts.net/<路径> →   http://<本机或远端主机>:<端口>
```

这件事从「记住 `tailscale serve --set-path` / `--service` 命令并手工敲」变成「在网页上点几下」。

**路由身份是三元组 `(Service, 端口, 路径)`**，两条命名空间互不干扰：同一个路径可以同时挂在节点级和某个 Service 上，是两个完全不同的对外名字（`<机器名>.ts.net/dsh` vs `dsh.ts.net`）。Service 级路由的完整说明见 [§12](#12-tailscale-service-级路由dshxxtsnet-1)。

以本机为例，本工具管理的正是这样一组映射：

| 对外路径 | 容器 / 服务 | 宿主机端口 |
| --- | --- | --- |
| `/worldforge` | `worldforge` | 4173 |
| `/salecapitai` | `cs22-web` | 8080 |
| `/calendar` | `sisi-calendar` | 443 |

---

## 1. 它是「控制面」，不是「数据面」

这是本项目最重要的一个设计决定。

```text
        ┌──────────────────────────────────────────────┐
        │              tailscaled (数据面)             │
        │   TLS 证书 · HTTPS 终结 · 反向代理 · 保活    │
        └───────────────▲──────────────────────────────┘
                        │ 读写 serve 配置
        ┌───────────────┴──────────────────────────────┐
        │      TsController (控制面，只监听 127.0.0.1) │
        │  Docker 容器清单 → 映射库 → 差异计算 → 应用  │
        └──────────────────────────────────────────────┘
```

- **流量不经过 TsController**。请求由 `tailscaled` 直接转发到容器端口。因此 TsController 崩溃、升级、被关掉，已经生效的路由**照常工作**。
- **HTTPS 证书由 Tailscale 负责**。不需要自己申请、续期、管理 ts.net 证书。
- **不做 HTML 重写**。前缀剥离由 `tailscale serve` 自己完成（`/xxx/foo` → 后端收到 `/foo`，见 [tailscale#7334](https://github.com/tailscale/tailscale/commit/7908b6d6166a31912d33507e006671575afaa616)），本工具不介入。
- **不接管你的既有配置**。用户手工用 `tailscale serve` 配的路由被视为「未托管」，永远不会被本工具删除；只有你自己创建（或显式「接管」）的映射才归它管。

代价：无法做响应改写、鉴权注入、健康检查。这些需求需要数据面方案（自建反向代理），本项目明确不做。

> **关于 `dsh.xxx.ts.net` 这类独立主机名**：这需要 [Tailscale Services](https://tailscale.com/docs/features/tailscale-services)，本工具已完整支持——但承载 Service 的节点**必须是 tag 身份**（用户账号拥有的设备不行），因此本机（`my-laptop`，无 tag）只能提供节点级路由。启用条件、步骤与已验证/未验证范围见 [§12](#12-tailscale-service-级路由dshxxtsnet-1)。

---

## 2. 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.18**（依赖原生 TypeScript 类型擦除，直接 `node src/main.ts`，无需编译） |
| Docker | Docker Desktop（Windows）或任意提供本地端点的 Docker Engine |
| Tailscale | 已登录，且 tailnet 已开启 **HTTPS Certificates** |
| 平台 | Windows 优先（`npipe` + `tailscale.exe` 路径自动探测）；Linux/macOS 可运行，端点需自行确认 |
| 容器化 | **不支持，且不建议**。详见 §13 |

> **不要把它跑在 Docker 里。** 它是宿主作用域的控制面：既要读本机 Docker daemon，又要写本机 tailscaled 的 serve 配置。Windows 上 tailscaled 的 LocalAPI **只走命名管道**、不监听任何回环 TCP，而 Docker Desktop 的 Linux 容器跨不过 WSL2 边界够到命名管道——容器化后它会"能列出容器、但所有 tailscale 操作全部失败"。完整证据链与 Linux 宿主机的可行条件见 §13。

---

## 3. 快速开始

```bash
npm install
npm run web:build     # 构建前端到 web/dist（首次必须执行）
npm start             # 启动，默认 http://127.0.0.1:8787
```

打开 <http://127.0.0.1:8787>。

开发模式（前端热更新 + 后端各自运行）：

```bash
npm run dev           # 终端 1：后端，node --watch
npm run web:dev       # 终端 2：Vite dev server，http://127.0.0.1:5273（/api 已代理到 8787）
```

其它命令：

```bash
npm run lint          # 后端 + 前端 tsc --noEmit
npm test              # 185 个单元/接口测试（全部使用假实现，不碰真实系统）
npm run web:build     # 构建前端
npm run verify:live   # 真实环境端到端验证（会临时增删一条 serve 路由，用完自动还原）
npm run verify:security  # 真实环境安全闸门验证（含非默认端口与 Service 命名空间上的暴露）
npm run clean:verify  # 只清理 data/verify* 临时目录，绝不碰真实映射库
```

验证 Service 级路由（需要本节点是**已打 tag 的 service host**，见 §12）：

```bash
node scripts/verify-live.ts --service svc:dsh                       # 在 service host 本机跑
node scripts/verify-live.ts --service svc:dsh --remote-host <本机 DNS 名>   # 资源在另一台机器上
node scripts/verify-security.ts --service svc:dsh                  # 追加 E 段：Service 上的暴露扫描
```

> ⚠️ **不要**用 `rm -rf data` 之类的方式清理验证残留：真实映射库就在 `data/mappings.json`，
> 与验证脚本的 `data/verify*` 子目录同级。用 `npm run clean:verify`——它逐个断言目录名前缀，
> 只删白名单内的验证目录，并在结束时报告真实映射库是否仍在。

---

## 4. 配置

全部通过环境变量，均有默认值。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TSCONTROLLER_HOST` | `127.0.0.1` | 管理界面监听地址。**只接受回环地址**，填 `0.0.0.0` / `100.x` 会直接启动失败 |
| `TSCONTROLLER_PORT` | `8787` | 管理界面端口 |
| `TSCONTROLLER_DATA_DIR` | `./data` | 映射库与审计日志目录 |
| `TSCONTROLLER_TAILSCALE_BIN` | `C:\Program Files\Tailscale\tailscale.exe` | tailscale 可执行文件 |
| `TSCONTROLLER_DOCKER_PIPE` | 自动探测 | Docker 端点；也可用 `DOCKER_HOST` |
| `TSCONTROLLER_SERVE_PORT` | `443` | 新建映射时的默认对外 HTTPS 端口。**Service 级路由的该端口必须与该 Service 在 admin console 里声明的 endpoint（`tcp:<port>`）一致**，否则写进去也不通 |
| `TSCONTROLLER_AUTO_UNEXPOSE` | `true` | 是否自动摘除指向管理端口的路由 |
| `TSCONTROLLER_SNAPSHOT_DIR` | `<DATA_DIR>/public` | serve 路由快照目录；消费方只读挂载它即可 |
| `TSCONTROLLER_SNAPSHOT_INTERVAL_MS` | `60000` | 快照定期刷新间隔；`0` 表示只在启动与每次收敛后写 |
| `TSCONTROLLER_WEB_ROOT` | `./web/dist` | 前端构建产物目录 |
| `TSCONTROLLER_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## 5. 安全模型：「本应用禁止暴露在 tailnet 中」

这条需求由**四层**独立机制保证，任何一层单独失效都不会导致管理面外泄。

1. **监听层面**：`config.loadConfig()` 硬性拒绝非回环的 `TSCONTROLLER_HOST`（没有开关可以绕过）。启动后再复核内核实际绑定的地址，不是回环就自行关闭。
2. **Host 头层面**：所有请求的 `Host` 必须是回环主机名，否则 403。这一层防的是 **DNS rebinding** —— 恶意网页把 `attacker.com` 解析到 `127.0.0.1` 后用浏览器打本 API。
3. **serve 配置层面**：启动闸门与每次 `apply` 都会扫描 serve 配置，**任何**指向管理端口的本机 handler 一律摘除（无论是不是本工具创建的），并写入审计日志。同时，通过 API 建立指向管理端口的映射会被直接拒绝（`409 exposes-admin`）。**扫描范围是全部 HTTPS 端口 × 两个命名空间**（节点级 + Service 级）——Service 路由只能从 `tailscale serve get-config --all` 读到，早期只读 `status --json` 的实现对它们完全瞎，这是与「只解析 443」同类的一个真实安全缺口，现已堵上（见 [§12](#12-tailscale-service-级路由dshxxtsnet-1)）。
4. **接管层面**：`import` 拒绝接管指向管理端口的路由（节点级与 Service 级同样适用）。

**这一层的两条已知边界**（写在这里以免被当成漏洞）：

- **只判回环目标。** 只有目标是 `127.0.0.1`/`localhost`/`::1` 且端口等于管理端口的路由才会被判定为暴露。Service host 代理到**远端**主机时，配置里只有那台主机的主机名，本工具无法判断它是不是就是本机——如果那台远端主机恰好是本机，这条暴露**检测不到**。这一层只能靠 ACL 与「不要在 service host 上写这种目标」保证。
- **远端目标不参与孤儿检测。** 道理同上：那台机器上的容器清单不在本机 Docker daemon 里，凭空判定「容器不存在」只会误报。

审计日志在 `<DATA_DIR>/audit.jsonl`，也可通过 `GET /api/audit` 查看。

> ⚠️ 注意：本项目保证**自己不暴露**，但它**无法阻止你映射别人的端口**。如果把一个监听 `0.0.0.0` 的容器端口映射出去，该容器同样会监听在 tailscale 接口上，tailnet 内设备可以绕过本工具直连 `100.x.x.x:<port>`。界面对这类端口会显示「已监听全部网卡」的黄色徽标。

### 5.1 这道边界挡得住谁、挡不住谁（实测，重要）

上面第 1、2 层**挡不住同机的 Docker 容器**。在本机（Windows + Docker Desktop）实测：

| 从容器发出的请求 | 结果 |
| --- | --- |
| `host.docker.internal:8787/api/health`（自然 Host） | `403 forbidden-host` ← Host 校验生效 |
| 同上但伪造 `Host: 127.0.0.1:8787` | `{"ok":true}` — **读接口通了** |
| 伪造 Host 读 `/api/system` | 完整数据（tailnet IP、DNS 名、数据目录） |
| 伪造 Host **POST** `/api/mappings` | `409 exposes-admin` — 这是**业务规则**拒绝，说明请求已通过鉴权到达处理函数 |

原因有两条，缺一不可：

1. **Docker Desktop 把 `host.docker.internal` 代理到宿主 loopback**，所以绑定 `127.0.0.1` 并不能把容器挡在外面；
2. **`Host` 头是客户端完全可控的**，容器可以自己设成 `127.0.0.1:8787`，于是第 2 层形同虚设。

而且**无法靠来源地址区分**——三种情况（本机直连、容器自然请求、容器伪造 Host）的 TCP 对端地址**都是 `127.0.0.1`**，Docker Desktop 的代理会把源地址改写成回环。

**结论：**

- 第 1、2 层对**网络对端**（LAN / tailnet 上的其它设备、被 DNS rebinding 利用的浏览器）有效，这正是它们的设计目标；
- 但对**本机容器**，目前的边界是**形同虚设**的。任何容器都能读写路由配置。
- 唯一可靠的判别手段是**让容器拿不到的东西**——即一个只存在于宿主文件系统上的令牌。这件事尚未实现，见 `todo.md`。

**因此：不要用 `/api/*` 给其它项目做集成。** 读路由请用 §9.4 的快照文件。

---

## 6. 概念与状态

**映射（Mapping）**：一条「`(Service, 端口, 路径)` → 目标端口」的期望状态。

```ts
{
  service: "svc:dsh",                       // 所属 Tailscale Service；null = 节点级路由
  path: "/worldforge",                      // 归一化后的挂载路径
  servePort: 443,                           // 对外 HTTPS 端口（路由身份的另一半）
  target: {
    kind: "container",
    hostPort: 4173,
    targetPath: "",
    containerName: "worldforge",
    containerPort: 8080,
    // remoteHost: "my-laptop.example-tailnet.ts.net",  // 只在 Service 级路由上允许：代理到远端主机
    // scheme: "https",                                 // 省略即 http
  },
  enabled: true,
  ownedRoutes: [{ service: "svc:dsh", servePort: 443, path: "/worldforge" }]   // 它在 serve 中占用的全部位置（用于改名/改端口/改 Service/删除时精准摘除）
}
```

**路由身份是「Service + 端口 + 路径」这个三元组。**

- `service === null` → **节点级**：`https://<机器名>.<tailnet>.ts.net/<路径>`，由 `tailscale serve --https=<port> --set-path=<path>` 写入。
- `service === 'svc:dsh'` → **Service 级**：`https://dsh.<tailnet>.ts.net/<路径>`，由 `tailscale serve --service=svc:dsh --https=<port> --set-path=<path>` 写入。界面与日志里的标签形如 `svc:dsh:/dsh`（只有非 443 端口才会写进标签，例如 `svc:dsh:8443/`）。

两个命名空间**互不干扰**：`/dsh` 可以同时挂在节点级和 `svc:dsh` 上，它们对外是两个完全不同的名字。同理，`/` 挂在 443 与 8443 上也是两条独立入口。因此所有匹配、去重、归属判断都以 `(service, servePort, path)` 为单位。

**Service 名**接受 `dsh` 与 `svc:dsh` 两种写法，内部统一归一化为带 `svc:` 前缀的形式；字符集限小写字母、数字、`.`、`_`、`-`，且必须字母或数字开头（大写直接拒绝而不是折叠——名字大小写不同就是不同的 Service，静默改写会指向一个不存在的名字）。

**声明式收敛**：映射库是期望状态，`tailscale serve` 配置是实际状态。增删改都会自动触发一次收敛；收敛失败**不回滚映射库**，而是留下 `pending`／`errors` 让用户重试——用户意图不会因为一次 CLI 抖动而丢失。

**状态含义**：

| 状态 | 含义 |
| --- | --- |
| `active` | serve 配置与期望完全一致（对外是否真的可达，见下一条） |
| `awaiting-approval` | **Service 级专有**：路由已正确写进 serve（`inSync` 也为真），但本节点还不是该 Service 被承认的 host，因此对外暂时不通。原因只有两个：管理员尚未批准这条广告（Services → 该 Service → Service hosts → Approve），或该 host 已被 drain。界面用**冷色**渲染它——它不是错误，用户也没有可点的「修复」按钮 |
| `pending` | 需要收敛（路径缺失、或指向别处、或写入失败） |
| `disabled` / `disabled-drift` | 已禁用；后者表示 serve 里还有残留 |
| `orphaned-target` | 目标容器不存在、未运行，或不再发布该端口。**带 `remoteHost` 的远端目标不做此判定**（那是另一台机器的容器清单） |
| `blocked` | 目标就是管理端口（仅判本机回环目标），被安全策略拒绝 |
| `conflict` | 同一 `(Service, 端口, 路径)` 被多条映射占用（防御性判定） |

`awaiting-approval` 与 `active` 的区别是刻意保留的两件事：前者说明「我们这边的配置写对了」，后者说明「这条路由对外真的通」。把它们合并会让人对着一个 `active` 却打不开的地址反复点「应用」。判定依据是 `ServiceInfo.advertised`，而它只认 `tailscale status --json` 的 `Self.CapMap["service-host"]` 能力——`get-config` 里那个 `advertised` 字段本身不算证据。

**未托管路由**：serve 里存在、但映射库中没有对应记录的路由（例如你手工敲的 `tailscale serve --set-path`）。它们只读展示，可在界面上点「接管」纳入管理。

---

## 7. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针 |
| GET | `/api/system` | tailnet 基址、数据源、安全状态、收敛摘要；含 `magicDnsSuffix`、`selfTags`、`canHostService`、`services` |
| GET | `/api/containers` | 容器清单 + 已发布端口 |
| GET | `/api/mappings` | 映射视图 + 未托管路由 + 计划摘要 + 状态计数；另返回 `services` 与 `selfTags` |
| POST | `/api/mappings` | 新建映射（可带 `servePort`、`service`、`remoteHost`、`scheme`，自动收敛并返回 `ApplyResult`） |
| PATCH | `/api/mappings/:id` | 局部更新（含 `servePort`；改端口/改 Service 会摘掉旧位置上的路由） |
| DELETE | `/api/mappings/:id` | 删除并摘除 serve 路由（含 Service 上的） |
| POST | `/api/mappings/:id/enabled` | 启用/禁用 |
| POST | `/api/mappings/import` | 接管未托管路由（`{ routes?: [{ service?, servePort, path }] }`，省略即全部） |
| POST | `/api/apply` | 手动重新收敛 |
| GET | `/api/serve/routes` | serve 原始路由 + 托管标记（**含全部 HTTPS 端口**）；另返回 `services` |
| GET | `/api/audit?limit=N` | 审计事件 |

请求体里的 Service 相关字段：

| 字段 | 取值 | 语义 |
| --- | --- | --- |
| `service` | `"dsh"` / `"svc:dsh"` / `null` / `""` | Service 名；`null` 与 `""` 都表示**节点级**；**字段省略 = 不改动**（PATCH 语义，沿用已有值） |
| `remoteHost` | 主机名或 IP（不含协议、不含端口） | 代理目标主机；省略即本机 `127.0.0.1`。**只在 Service 级路由上允许**。`127.0.0.1`/`localhost` 会被归一化为「未指定远端」 |
| `scheme` | `"http"` / `"https"` | 代理协议；省略即 `http`。`https+insecure` 这类需要跳过证书校验的目标不支持 |

`ApplyResult.upserted` / `removed` / `blocked` / `exposures` 都是 **Service 感知**的：前两者是路由位置对象 `{ service, servePort, path }[]`，不是裸路径。

错误统一为 `{ error: string, code: string }`，常见 `code`：`exposes-admin`、`serve-port-is-admin`、`duplicate-path`、`takeover-required`、`invalid-path`、`invalid-port`、`invalid-serve-port`、`invalid-target-path`、`invalid-service`、`invalid-remote-host`、`remote-host-requires-service`、`invalid-scheme`、`forbidden-host`、`not-found`。

---

## 8. 真实环境验证

沙箱里跑不了 Docker 与 Tailscale，因此有两个**真实环境**脚本（都在 `finally` 里做兜底还原，并逐条比对运行前的 serve 配置是否原样保留）：

```bash
node scripts/verify-live.ts                  # 建映射 → 真实 HTTPS 请求 → 删映射
node scripts/verify-live.ts --port 8080      # 指定目标端口
node scripts/verify-live.ts --serve-port 8443  # 指定对外 HTTPS 端口
node scripts/verify-live.ts --service svc:dsh  # 追加一轮 Service 级验证（需要真实的 service host）
node scripts/verify-live.ts --service svc:dsh --remote-host my-laptop.example-tailnet.ts.net
node scripts/verify-security.ts              # 安全闸门：检测、摘除、不误伤、API 拒绝
node scripts/verify-security.ts --service svc:dsh   # 追加 E 段：Service 命名空间上的暴露扫描
```

`verify-live.ts` 把节点级与 Service 级抽成同一个 `round()`（**建 → 真实请求 → 删 → 逐条比对**）。不带 `--service` 时只跑节点级；带了 `--service` 但前提不满足（本机无 tag、或该 Service 没有端点配置）时**跳过**并打印原因，而不是失败——本机是用户账号身份时，拿不到 Service 才是预期状态。

`verify-live.ts` 在本机的实际输出（2026-10-17 真实运行，`--port 8080`，节点级一轮）：

```text
[PASS] 读取 tailnet 身份 — https://sisi-laptop.tail921448.ts.net (100.72.255.29, ...)
[PASS] 读取 Docker 容器 — 6 个容器，6 个有已发布端口
[PASS] 选定目标端口 — cs22-web → 127.0.0.1:8080（容器端口 80）

--- 节点级 ---
[PASS] [节点级] 创建映射并写入 serve — status=active route=/__tscontroller-selftest upserted=[/__tscontroller-selftest] errors=[]
[PASS] [节点级] serve 中出现该路由 — /__tscontroller-selftest → http://127.0.0.1:8080
[PASS] [节点级] 通过 ts.net 访问到容器 — HTTP 200，响应 674 字节
[PASS] [节点级] 删除映射并摘除 serve 路由 — removed=[/__tscontroller-selftest] errors=[]
[PASS] [节点级] serve 中该路由已消失
[PASS] [节点级] 既有路由原样保留 — before=[node:443:/,node:443:/api/addSchedule,…] after=[同左]

=== 结果：9/9 通过 ===
```

脚本还会打印本节点 tag、`serve` 已声明的端口、以及每个 Service 的 `dnsName / ports / 已承认|等待审批 / TailVIP`；`before/after` 的键是 `service:端口:路径`，因此节点级与 Service 级不会被混为一谈。

`verify-security.ts`：**14/14 通过**（含「指向管理端口的路由被自动摘除且写入审计日志」「指向其它端口的路由不被误伤」「非默认端口（8443）上的暴露同样被摘除」「API 拒绝建立指向管理端口的映射」；带 `--service` 时追加 E 段——Service 命名空间上的暴露必须被检测并摘除，且该 Service 上的其它端点不被牵连）。

> ⚠️ **Service 那一轮没有在真实 tagged 设备上跑过。** 上面的 9/9 是**节点级**回归；`--service` 分支在本机被跳过（`Self.Tags` 为空，且撰写时 tailnet 里没有任何已 tagged 的对端设备）。Service 链路目前的证据只有：单元测试（假网关，20 + 22 个用例）、解析层对着上游实现与官方样例的同构输入、以及**真实 CLI 对未打 tag 节点给出的拒绝**（证明命令确实拼装正确并走到了真 CLI）。补齐方法见 [§12.6](#126-在-nas-上把这一轮真正跑起来)。

---

## 9. 一个必须知道的行为：`/` 是兜底

`tailscale serve` 按**最长前缀**匹配。本机现有配置里有 `/` → `127.0.0.1:3081`，因此**任何没有被映射接管的路径都会落到 `/` 上**。这意味着：

- 你不会因为拼错路径而看到 404，而是看到 `/` 那个服务的响应（例如 401）。
- 新建映射后，该路径立即从兜底切换到目标容器；删除映射后又会回落。

### 9.1 挂载路径会被剥掉（最容易踩的一个坑）

`tailscale serve` 把请求转发给目标时，**会先剥掉挂载路径这一段**，再拼到目标路径后面。设映射为：

```text
挂载 /api/addSchedule  →  目标 http://127.0.0.1:443/api/agent/events
```

那么实际转发是：

| 外部请求 | 后端收到 |
| --- | --- |
| `POST /api/addSchedule` | `POST /api/agent/events` |
| `GET /api/addSchedule/abc` | `GET /api/agent/events/abc` |

由此推出两条实用规则：

1. **「外部路径」只是别名，不代表后端有同名路由。** 决定打到后端哪条路由的是**目标路径**字段。上例中后端根本没有 `/api/addSchedule` 这个路由，别名随便取。
2. **请求路径正好等于挂载路径时，剥完是空串**，于是后端收到的是目标路径本身。这也是为什么 `/agent` → `/api/agent` 这种映射必须配合 `/agent/events` 这样的子路径调用才有意义 —— 直接请求 `/agent` 会打到后端的 `/api/agent`，而后端通常没有这个路由。

`/calendar.ics` → `http://127.0.0.1:443/calendar.ics` 是一个「挂载名与后端路径同名」的对照例子：请求 `/calendar.ics` 正好命中该路由。

### 9.2 根绝对路径的应用：换端口，不要换路径

有些应用（尤其是 Vite/SPA 构建产物）在 HTML 里用**根绝对路径**引用静态资源：

```html
<script src="/assets/index-CEaepkfb.js"></script>
```

把它们挂在 `/home` 这类前缀下必然坏掉——浏览器请求 `/assets/...` 时**不在 `/home` 前缀内**，于是落到 `/` 兜底上（打到 DSH 并返回 401），JS/CSS 全部加载失败，页面白屏。而本工具**不做响应改写**（见 §1），不会去重写 HTML 里的路径。

**正确解法是换一个端口，而不是换路径：**

```ts
{ path: "/", servePort: 8443, target: { hostPort: 8899, ... } }   // https://<主机>:8443/
```

不同端口就是**不同 origin**，该端口的 `/` 就是根路径，`/assets/...` 自然落在同一个 origin 内。零代码改动，也不需要碰应用本身。

判断一个应用属于哪一类：打开它的页面，看引用的资源是 `/assets/x.js`（根绝对路径 → 必须挂根路径）还是 `assets/x.js` / `./assets/x.js`（相对路径 → 挂前缀也行）。

### 9.3 路由身份是「Service + 端口 + 路径」

端口是路由身份的一半，Service 是另一半。下面四条路由**互不干扰**：

| Service | 端口 | 路径 | 对外地址 | 目标 |
| --- | --- | --- | --- | --- |
| 节点级 | 443 | `/` | `https://<机器名>.<tailnet>.ts.net/` | `127.0.0.1:8899` |
| 节点级 | 8443 | `/` | `https://<机器名>.<tailnet>.ts.net:8443/` | `127.0.0.1:8899` |
| `svc:dsh` | 443 | `/` | `https://dsh.<tailnet>.ts.net/` | `my-laptop.<tailnet>.ts.net:3081`（远端） |
| `svc:dsh` | 443 | `/dsh` | `https://dsh.<tailnet>.ts.net/dsh` | `127.0.0.1:3081` |

因此：

- 在界面上「建立映射」与「编辑」都有**对外端口**、**Tailscale Service**、**代理目标主机**三个字段。端口默认取配置里的 `TSCONTROLLER_SERVE_PORT`（通常是 443）；Service 留空即节点级路由。
- 访问地址会带上非 443 端口：`https://<主机>:8443/home`；Service 级则换成 Service 的 MagicDNS 名。界面上的「复制 URL」两种都已处理（主机名取不到时按钮禁用）。
- **节点级与 Service 级可以用同一个路径**：`/dsh` 挂两遍是两条合法且独立的路由。同理改名/改端口/改 Service 时，旧位置会被精准摘除（`ownedRoutes` 按三元组记账）。
- 对外端口**不允许与管理端口同号**（会被 409 `serve-port-is-admin` 拒绝）——它不会泄露管理面（管理面只绑回环），但会让 `https://<主机>:<管理端口>` 看起来像管理界面。
- 安全闸门**跨全部端口 × 两个命名空间**扫描（见 §5）。

### 9.4 给其它项目读的 serve 路由快照

其它项目（通常跑在容器里）**够不到宿主上的 tailscaled**——Windows 是命名管道、跨不过 WSL2，Linux 桥接网络也到不了宿主回环。因此 TsController 把路由状态落成一份 JSON 文件：

```text
<DATA_DIR>/public/serve-routes.json
```

消费方只需**只读挂载这一个目录**（不用挂整个 `data/`，也就不会顺带拿到 `mappings.json` 与 `audit.jsonl`）：

```yaml
volumes:
  - D:\apps\TsController\data\public:/tscontroller:ro
```

**为什么选文件而不是 HTTP 接口**：不需要网络端口、不需要令牌、不依赖「TsController 此刻是否在跑」（进程没在跑时数据仍在，只是旧的）、而且 Windows 与 Linux 行为完全一致。

写入时机：**启动时** + **每次收敛后** + **每 60 秒**（`TSCONTROLLER_SNAPSHOT_INTERVAL_MS`，设 0 关闭）。定期刷新的意义是：你手工执行 `tailscale serve` 改了配置时，快照会被纠正回来。**刷新只读不写——它绝不改动 serve 配置。**

数据新鲜度看 `generatedAt`。**当前 schemaVersion 是 `2`**（v1 的路由身份是 `(端口, 路径)`，已废弃）。样例：

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-10-17T09:12:41.318Z",
  "generator": "tscontroller",
  "source": {
    "hostname": "my-laptop.example-tailnet.ts.net",
    "baseUrl": "https://my-laptop.example-tailnet.ts.net",
    "magicDnsSuffix": "example-tailnet.ts.net",  // Service 的对外名字由它拼出
    "selfTags": [],                              // 空数组 = 本节点不可能充当 Service host
    "tailnetIps": ["100.x.y.z"],
    "adminPort": 8787
  },
  "servePorts": [443, 8443],
  "services": [                                   // 本节点上的 Tailscale Service
    {
      "name": "svc:dsh",
      "dnsName": "dsh.example-tailnet.ts.net",
      "servePorts": [443],
      "advertised": false,                        // false = 等待管理员审批 / 已被 drain
      "vipIps": []                                // 该 Service 的 TailVIP（非 100.x，只被动收连接）
    }
  ],
  "routes": [
    {
      "service": null,                            // null = 节点级；"svc:dsh" = Service 级
      "servePort": 443,
      "path": "/worldforge",
      "host": "my-laptop.example-tailnet.ts.net", // Service 级则是 dsh.example-tailnet.ts.net
      "url": "https://my-laptop.example-tailnet.ts.net/worldforge",  // 非 443 端口会带上端口号；取不到主机名时为 null
      "proxy": "http://127.0.0.1:4173",
      "targetPath": "",
      "targetHost": "127.0.0.1",                  // 远端目标会是那台主机的主机名
      "targetHostPort": 4173,
      "managed": true,              // 是否已被 TsController 接管
      "mappingId": "a7ae14c5-…",    // 未托管为 null
      "status": "active",          // 未托管为 null；取值见 §6
      "containerName": "worldforge",
      "containerPort": 8080,
      "containerSource": "mapping", // mapping = 来自映射库；port = 按宿主机端口反查；null = 未关联
      "note": "…",
      "enabled": true,
      "fromServiceConfig": false    // true = 这条是从 get-config --all 读出的，handler 树有损（见 §11）
    }
  ],
  "summary": { "total": 8, "managed": 7, "unmanaged": 1, "active": 6, "pending": 0, "disabled": 0, "orphanedTarget": 0, "blocked": 0, "awaitingApproval": 1 },
  "security": {
    "autoUnexpose": true,
    "exposures": [ { "service": null, "servePort": 443, "path": "/leak", "proxy": "http://127.0.0.1:8787" } ]
  }
}
```

**刻意不含**：数据目录路径、Docker 端点这类内部信息（消费方不需要）。文件里没有密钥——TsController 也不持有任何密钥。

`containerName` / `containerPort` 对**未托管**路由也会填：先查映射库，查不到就按宿主机端口在容器清单里反查（`containerSource` 标明来源）。门户因此能对每条路由都显示「背后是哪个容器」。**远端目标（service host 代理到另一台机器）不做这个反查**——那是别的机器的容器清单，`containerName` 会是 null。

`url` 只看快照自身能确定的主机名（节点级用节点 DNS 名，Service 级用 `<service 名>.<MagicDNS 后缀>`）；**刻意不用其它字段兜底**，因此「tailscale 未登录、读不到主机名」时它是 `null`，而不是一个看起来能点、实际不该点的链接。

`schemaVersion` 在字段语义变化时递增，消费方应据此判断兼容性。

> 界面顶部信息条会显示这个文件的完整路径，可一键复制。

> **NAS 部署**：完整步骤、路径怎么决定、以及哪些环节尚未验证，见 [`docs/nas-deployment.md`](docs/nas-deployment.md)。
> **打包镜像 / 推送到 ghcr.io**：见 [`docs/image-publishing.md`](docs/image-publishing.md)（含手动推送与 GitHub Actions 自动构建）。

> **注意**：`/api/*` 的 HTTP 接口**不**打算给其它项目调用。实测证明同机容器可以伪造 `Host` 头绕过回环校验，因此那个接口的写操作目前对所有容器都是可达的——这是一个已知待修的口子（见 §5.1），不要在上面叠加新的依赖。

---

## 10. 目录结构

```text
src/
  domain/          领域类型与纯函数（路径归一化、代理地址解析）
  docker/          Docker Engine API 客户端（npipe / unix / tcp）+ 容器归一化
  tailscale/       tailscale CLI 封装、serve 配置解析、网关接口
  mappings/        映射库、差异计算（reconcile）、映射服务、审计日志
  api/  app.ts     Fastify 路由与静态资源托管
  runtime.ts       依赖装配（真实实现）
  main.ts          进程入口：安全闸门 → 预热 → 监听 → 复核
web/               Vite + React 管理界面
test/              185 个单元/接口测试（全部注入假实现）
scripts/           真实环境验证脚本 + 安全的清理脚本
docs/static/       静态函数文档
data/              运行时数据（映射库、审计日志），已 gitignore
```

---

## 11. 已知边界

- 只做 HTTP(S) 路径路由，不转发裸 TCP；需要裸 TCP 请用 `tailscale serve --tcp` 自行配置（Service 的 `tcp://`、`unix:` 端点同样只读展示、不参与托管）。
- 不做响应改写，因此挂在路径前缀下的应用若使用**根绝对路径**引用静态资源（`/assets/app.js`），会打到兜底路由而非该应用。**解法是给这类应用一个独立端口**（见 §9.2），而不是改路径。
- **读路由要两个数据源，缺一不可。** `tailscale serve status --json` 里**只有节点级路由**；Service 端点只在 `tailscale serve get-config --all` 里（上游 [tailscale#18289](https://github.com/tailscale/tailscale/issues/18289) 明说这两个命令返回的信息不同）。因此 `get-config` 一旦读失败（老版本 CLI 不认识 `--all`、权限问题…），**Service 路由会整体不可见**——包括安全闸门的视野。实现上这条失败只降级为警告（否则连节点级路由都读不到），代价就是上面这条盲区。
- **`get-config` 的往返是有损的**，两个直接后果：
  1. **一个 Service 上的多条路径只读得到一部分。** 上游只序列化**根 handler**（`/`）与端点映射，额外用 `--set-path` 挂出来的子路径（例如 `svc:dsh` 上的 `/api`）不会出现在读回的结果里。所以「Service 上的路由」在我们这边是**部分可见**的视图，不是权威。
  2. **代理目标路径会丢。** 上游用 `net.SplitHostPort` 拆 Proxy，`http://host:3081/api` 里的 `/api` 不在输出模型里。因此 Service 路由的**目标路径以映射库为唯一权威**：`import` 接管一条 Service 端点时会以**空目标路径**纳入管理，第一次「应用」就会把它按映射库重写（界面对这类行有明确标注）。只读快照里的 `fromServiceConfig: true` 标的就是这批「handler 树不完整」的路由。
  - 写入路径**不受此影响**：实际写 serve 走的是 `tailscale serve --set-path` / `--service` 命令行，不走 `get-config` 往返。
- 依赖 `tailscale serve status --json` 与 `get-config --all` 的输出结构；解析层已能处理多 HTTPS 端口与两个命名空间，但 Tailscale 未来若改变任一格式，仍需同步更新（写入路径用的是稳定的 `--set-path` / `--service` CLI，不受影响）。
- 远端目标（`remoteHost`）不参与容器关联与孤儿检测：那台机器上的容器清单不在本机 Docker daemon 里。
- Docker 端口通过宿主机的**已发布端口**访问，不直接连容器网络 IP。
- `tailscale serve clear svc:<name>`（摘除某个 Service 在本节点上的全部端点配置）已在 CLI 封装里实现，但目前**没有任何代码路径调用它**——删除最后一条 Service 映射时只摘那条路由，不会顺手停掉 advertise。

---

## 12. Tailscale Service 级路由（`dsh.xxx.ts.net`）

「用独立 ts.net 主机名代替路径前缀」由 [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) 提供，TsController **已完整支持**：路由身份从 `(端口, 路径)` 扩展为 `(Service, 端口, 路径)`，目标也不再必须写死 `127.0.0.1:<port>`。这一节说明启用它需要什么、怎么配、以及**哪些部分还没有在真实设备上验证过**。

要点先说：**承载 Service 的节点必须是 tag 身份。** 用户账号拥有的设备（例如本机 `my-laptop`）拿不到这种名字——这不是本工具的限制，是 Tailscale 的。在 `my-laptop` 上的实测（2026-10-15，Tailscale v1.102.4）：

| 探测命令 | 结果 |
| --- | --- |
| `tailscale cert dsh.example-tailnet.ts.net` | `500 Internal Server Error: invalid domain "dsh.example-tailnet.ts.net"; must be one of ["my-laptop.example-tailnet.ts.net"]` |
| `tailscale serve --bg --service=svc:tsctest --https=443 http://127.0.0.1:8080` | `service hosts must be tagged nodes` |
| `tailscale status --json` → `Self.Tags` | 空（该节点由用户账号拥有，`Self.UserID = 7934677520309298`） |
| `Resolve-DnsName dsh.example-tailnet.ts.net` | DNS name does not exist |

依据是 tags 文档原文：*"Any device you want to use as a Service host must use a tag-based identity."*（[tags](https://tailscale.com/docs/features/tags)）。因此**在用户身份的笔记本上，Service 模式不可用是预期状态，不是故障**：`GET /api/system` 会返回 `selfTags: []` 与 `canHostService: false`，界面据此在 Service 输入框下直接给出原因，而不是让你对着一串 CLI 报错猜。

### 12.1 前提：tag 身份、Service 定义、端口一致

四件事必须同时成立，缺任何一件都会表现为「配置写进去了，但外面打不开」：

| # | 前提 | 谁来满足 | 怎么确认 |
| --- | --- | --- | --- |
| 1 | 承载节点是 **tagged node** | 在 admin console 给设备打 tag，并在设备上重新 `tailscale login` | `tailscale status --json` → `Self.Tags` 非空；TsController 里看 `selfTags` / `canHostService` |
| 2 | Service 已在 admin console **定义**（名字 + 至少一个 `tcp:<port>` endpoint） | 管理员 | `tailscale serve get-config --all` 里出现 `services."svc:<名字>"`；界面「Tailscale Service」面板列出它 |
| 3 | 本节点被**承认为该 Service 的 host**（广告已批准，或没有被 drain） | 管理员在 Services → 该 Service → Service hosts → **Approve**，或 ACL 里配 `autoApprovers.services` | `ServiceInfo.advertised` 为真（唯一证据是 `Self.CapMap["service-host"]`）；假则为 `awaiting-approval` |
| 4 | 映射的**对外端口与 Service 的 endpoint 端口一致** | 你 | 界面面板会列出该 Service 的 `servePorts`；路由写到别的端口上不会对外可用 |

客户端侧还需要一条 `grants` 规则才允许访问（否则连接会被 ACL 拦掉）：

```jsonc
{ "grants": [ { "src": ["autogroup:member"], "dst": ["svc:dsh"], "ip": ["443"] } ] }
```

Service 使用独立的 **TailVIP**（不属于 `100.64.0.0/10`，且只能**被动接受**连接），目前仅支持 TCP。

> 前提 3 没满足时，路由**已经**被正确写进 serve，只是外面不通。这正是 `awaiting-approval` 这个状态存在的理由：它不是错误，界面用冷色渲染，也没有可点的「修复」按钮——要做的是去管理后台点 Approve。

### 12.2 在 service host 上开启（资源就在这台机器上）

在**已打 tag 的常开设备**（NAS / 小主机 / VPS）上执行：

```bash
# 1. 确认身份与 Service 定义
tailscale status --json | jq '.Self.Tags'            # 必须非空，否则先打 tag 并重新登录
tailscale serve get-config --all                     # 应能看到 services."svc:dsh" 与它的 tcp:<port>

# 2. 确认要用的端口（必须与 Service 的 endpoint 一致），然后挂载（--service 必须写在 --https 之前）
tailscale serve --bg --yes --service=svc:dsh --https=443 --set-path=/ http://127.0.0.1:3081
```

得到 `https://dsh.<tailnet>.ts.net/`。用 TsController 做同一件事：安装并启动它（`npm start`，默认 <http://127.0.0.1:8787>）——**必须在 service host 本机跑**（它是宿主作用域的控制面，见 §13.4），然后在界面上新建映射：Service 填 `dsh`（或 `svc:dsh`）、对外端口填 443、路径填 `/`、目标端口填 3081。等价于：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/mappings \
  -H 'Host: 127.0.0.1:8787' -H 'Content-Type: application/json' \
  -d '{"service":"svc:dsh","servePort":443,"path":"/","hostPort":3081}'
```

摘除是同一维度的操作，`off` 放在最后：

```bash
tailscale serve --yes --service=svc:dsh --https=443 --set-path=/ off
```

### 12.3 资源在**另一台机器**上：`--remote-host`

Service host 不要求目标在本机——NAS 完全可以替笔记本对外提供 `dsh.<tailnet>.ts.net`，自己只做反向代理。这时目标写成远端主机（**不带协议、不带端口**），协议默认 `http`：

```bash
# 在 NAS（service host）上：把 dsh.<tailnet>.ts.net 指到笔记本的 3081
tailscale serve --bg --yes --service=svc:dsh --https=443 --set-path=/ \
  http://my-laptop.example-tailnet.ts.net:3081
```

TsController 里的对应字段是 **代理目标主机**（`remoteHost`，界面里只有填了 Service 才出现）：

```bash
curl -sS -X PATCH http://127.0.0.1:8787/api/mappings/<id> \
  -H 'Host: 127.0.0.1:8787' -H 'Content-Type: application/json' \
  -d '{"service":"svc:dsh","servePort":443,"path":"/","hostPort":3081,"remoteHost":"my-laptop.example-tailnet.ts.net"}'
```

规则与代价：

- **`remoteHost` 只在 Service 级路由上被接受**；节点级填它会得到 `409 remote-host-requires-service`（节点级的 serve 由本机 tailscaled 承载，混用两种模型只会制造歧义）。
- 取值只能是主机名或 IP（不含 `://`、不含端口）；`127.0.0.1` / `localhost` 被归一化为「未指定远端」，等价于留空。
- `scheme` 可选 `http`（默认）/ `https`；需要跳过证书校验的 `https+insecure` 明确不支持。
- 远端目标**不做容器关联与孤儿检测**（那是 NAS 拿不到的、笔记本上的容器清单），目标通不通由 Service host 的网络可达性决定；NAS 需要被 ACL 允许访问笔记本的这个端口。
- **安全闸门的盲点**：如果 `remoteHost` 恰好就是本机的管理端口，我们这边只看到「一个远端主机名 + 一个端口」，无法判定它是不是本机——这条暴露检测不到（见 §5、§11）。

### 12.4 TsController 怎么建模它

| 维度 | 节点级 | Service 级 |
| --- | --- | --- |
| 路由身份 | `(null, 端口, 路径)` | `("svc:dsh", 端口, 路径)` |
| 对外地址（`MappingView.baseUrl`） | `https://<机器名>.<tailnet>.ts.net` | `https://dsh.<tailnet>.ts.net` |
| serve 写入命令 | `serve --https=<port> --set-path=<path> <target>` | `serve --service=svc:dsh --https=<port> --set-path=<path> <target>` |
| 数据来源 | `tailscale serve status --json` | `tailscale serve get-config --all` |
| 目标 | 只允许本机 `127.0.0.1:<port>` | 本机或 `remoteHost` |

几个刻意的语义决定：

- **路径在同一 Service 内是挂载点，跨 Service 不影响。** `svc:dsh` 上最自然的用法是**根路径 `/`**：`https://dsh.<tailnet>.ts.net/` 直接就是那个应用，这正是「用独立主机名代替路径前缀」的目的。根路径下 §9.2 的「根绝对路径资源」问题自然消失——该 Service 的 `/` 就是根 origin。（一个 Service 上的多条路径我们在读回时只能看到根 handler 那条，见 §11。）
- **对外端口必须与 Service 的 endpoint 端口一致**（前提 4）。端口仍是 origin 的一部分：`svc:dsh` 的 443 与 8443 是两条独立入口。
- **`awaiting-approval` 与 `pending` 是两件事**：前者配置已写对（`ApplyResult.inSync === true`，不会产生任何多余写入），后者还没写进去。合并会让人对着一个「已经写对了」的路由反复点「应用」。
- **`advertised` 的缺省值不可信**：解析层只在配置里显式写了 `advertised: true` 时才认它，本节点是否真被承认为 host 的唯一证据是 `status --json` 的 `Self.CapMap["service-host"]`。否则一条本地半成品的配置会让界面误报 `active`。
- **删除最后一条 Service 映射时只摘那条路由**，不会顺手 `serve clear svc:<name>` 去停掉 advertise（CLI 封装里有这个能力，但没有代码路径调用它）。

### 12.5 把本机打成 tagged node 的代价（为什么没这么做）

tag 身份与用户身份**互斥**，打 tag 等于移除用户身份。除「不能被分享」外，还有：

| 影响 | 说明 | 出处 |
| --- | --- | --- |
| **Taildrop 失效** | 打 tag 后不能再收发 Taildrop 文件 | [Taildrop](https://tailscale.com/docs/features/taildrop)：*"You cannot use Taildrop to send files to and from nodes you have tagged."* |
| **Tailscale SSH 变单向** | tagged 设备只能 SSH 到其它 tagged 设备，**不能** SSH 到用户身份的机器 | [tags · Limitations](https://tailscale.com/docs/features/tags) |
| **不能被分享** | 只有用户能接受分享邀请 | [Sharing](https://tailscale.com/docs/features/sharing) |
| **ACL 语义改变** | 只能以 `tag:x` 指代该设备；且 tag 之间不是「与」关系，无法表达「同时具备两个 tag」 | [tags](https://tailscale.com/docs/features/tags) |
| **粘性** | 不能移除全部 tag；回到用户身份需在设备上重新 `tailscale login` | [tags](https://tailscale.com/docs/features/tags) |
| **换 node key** | 重新认证会生成新 node key（100.x IP 不变） | [tags](https://tailscale.com/docs/features/tags) |
| **key expiry 默认关闭** | 首次打 tag 认证后节点密钥不再定期过期 | [tags · Key expiry](https://tailscale.com/docs/features/tags) |
| 官方明确劝退 | *"Do not use tags to ... Authenticate end-user devices, such as laptops or mobile devices."* | [tags · Best practices](https://tailscale.com/docs/features/tags) |

这就是**本机保持用户身份、只提供节点级路由**的原因：对一台天天用的笔记本来说，Taildrop 与 SSH 的价值高于「路径变主机名」。**推荐做法是让 NAS 当 service host（§12.3），不改本机身份**——代价是多一台常开设备、多一跳，以及该设备需要被 ACL 允许访问本机端口。

### 12.6 在 NAS 上把这一轮真正跑起来

Service 链路的实现证据目前**只有单元测试（假网关）+ 解析层对着上游实现与官方样例的同构输入 + 真实 CLI 对未打 tag 节点的拒绝**。**「真实 `--service` 写入 + 经 `<svc>.<tailnet>.ts.net` 真实访问」这一轮没有跑过**：本机 `Self.Tags` 为空，且撰写时 `tailscale status` 里没有任何已 tagged 的对端设备。下面是在 NAS 上补齐它的确切步骤。

```bash
# 0. 在 NAS 上：打 tag 并重新登录（只做一次，见 §12.5 的代价表）
#    然后在 admin console 定义 Service（名字 dsh，endpoint tcp:443），
#    在 Services → dsh → Service hosts 里 Approve（或配 autoApprovers.services）
tailscale status --json          # 确认 Self.Tags 非空
tailscale serve get-config --all # 确认 services."svc:dsh" 与 tcp:443 都在

# 1. 把代码放到 NAS 上（TsController 必须跑在 service host 本机）
npm install && npm run web:build && npm test   # 期望 185/185
npm run lint                                   # 期望 0 错

# 2. 资源就在 NAS 本机时
node scripts/verify-live.ts --service svc:dsh

# 3. 资源在笔记本上时（在 NAS 上跑，目标是笔记本的 3081）
node scripts/verify-live.ts --service svc:dsh --remote-host my-laptop.example-tailnet.ts.net

# 4. Service 命名空间的安全闸门（E 段）
node scripts/verify-security.ts --service svc:dsh
```

预期输出（断言数 = 3 条共读断言 + 每一轮 6 条 × 2 轮 = **15/15**）：

```text
--- 节点级 ---
  [PASS] [节点级] 创建映射并写入 serve — status=active route=/__tscontroller-selftest upserted=[/__tscontroller-selftest] errors=[]
  [PASS] [节点级] serve 中出现该路由 — /__tscontroller-selftest → http://127.0.0.1:<port>
  [PASS] [节点级] 通过 ts.net 访问到容器 — HTTP 200，响应 … 字节
  [PASS] [节点级] 删除映射并摘除 serve 路由 — removed=[/__tscontroller-selftest] errors=[]
  [PASS] [节点级] serve 中该路由已消失
  [PASS] [节点级] 既有路由原样保留
--- Service svc:dsh ---
  [PASS] [Service svc:dsh] 创建映射并写入 serve — status=active route=svc:dsh:/__tscontroller-selftest upserted=[svc:dsh:/__tscontroller-selftest] errors=[]
  [PASS] [Service svc:dsh] serve 中出现该路由 — svc:dsh:/__tscontroller-selftest → http://my-laptop.example-tailnet.ts.net:<port>
  [PASS] [Service svc:dsh] 通过 ts.net 访问到容器 — HTTP 200，响应 … 字节
  [PASS] [Service svc:dsh] 删除映射并摘除 serve 路由 — removed=[svc:dsh:/__tscontroller-selftest] errors=[]
  [PASS] [Service svc:dsh] serve 中该路由已消失
  [PASS] [Service svc:dsh] 既有路由原样保留
=== 结果：15/15 通过 ===
```

读结果时注意两点：

- 若 Service 那一轮的创建步骤显示 `status=awaiting-approval`，脚本会额外打印「该 host 尚未被承认（等待管理员审批）；下面的真实请求预期会失败，这是预期状态」——此时「通过 ts.net 访问到容器」**会**失败，而这恰好说明前提 3 没满足，不是代码问题。先去 Approve。
- 前提不满足时脚本**跳过** Service 轮并打印原因（而不是报失败）。看到 `[跳过]` 说明这一轮并没有被验证，别把它读成通过。

---

## 13. 附录：为什么不能跑在 Docker 里

**结论：在 Windows 宿主上不可行；在 Linux 宿主上技术上可行，但明确不建议。** 已探明，不做（不提供 Dockerfile）。

### 13.1 它是宿主作用域的控制面

TsController 做两件事，两件都锚定在**本机**：

1. 读**本机** Docker daemon（Windows 走 `npipe:\\.\pipe\dockerDesktopLinuxEngine`）；
2. 读写**本机** tailscaled 的 serve 配置（`tailscale serve` CLI）。

因此容器化不是在"换个部署方式"，而是要容器去够到宿主的两个特权端点。

### 13.2 Windows 宿主：够不到 tailscaled

`tailscale serve` 通过 tailscaled 的 LocalAPI 生效，而 Windows 上它**只走命名管道**，没有任何回环 TCP 监听。本机实测：

```text
tailscaled (pid 7392 / 11848) 的监听端口
  100.101.102.103:443      ← serve 的 TLS 数据面
  100.101.102.103:38081    ← PeerAPI（Tailscale 内部）
  [fd7a:115c:a1e0::9999]:443 / :50559
```

管理 API 一个 TCP 端口都没有。CLI 连接目标的原文（取自一次权限不足的报错）：

```text
Get "http://local-tailscaled.sock/localapi/v0/status":
  open \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled: Access is denied.
```

而 Docker Desktop 的 Linux 容器跑在 WSL2 VM 内（本机 `OSType=linux`，`vmmemWSL` 进程在跑），只能通过 `host.docker.internal`（`192.168.65.254`）访问 Windows 宿主的 **TCP** 端口——**命名管道跨不过 WSL2 边界**。

后果：容器化的 TsController 会"能列出容器、但所有 tailscale 操作全部失败"，而后者正是它的全部意义。

### 13.3 Linux 宿主：可行，但有两个硬要求与三个反对理由

可行的最小配置：

```yaml
services:
  tscontroller:
    build: .                                    # 该 Dockerfile 目前不存在
    network_mode: host                          # 硬要求，不是优化项
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock
      - ./data:/app/data
    environment:
      TSCONTROLLER_DOCKER_PIPE: unix:///var/run/docker.sock
      TSCONTROLLER_TAILSCALE_BIN: tailscale
```

**硬要求 1：`network_mode: host`。** 「只允许监听回环」在代码里是没有开关可绕过的（`loadConfig()` 对非回环 `TSCONTROLLER_HOST` 直接抛错，`main.ts` 启动后还会复核内核实际绑定地址、非回环即自我关闭）。若改用 `-p 127.0.0.1:8787:8787`，容器内必须 bind `0.0.0.0` 才能被 publish，会被这条检查直接拒绝。只有 `network_mode: host` 能让容器里的 `127.0.0.1` 真的是宿主回环——此时该安全保证既成立又能通过检查。

**硬要求 2：镜像内的 tailscale CLI 版本需与宿主 tailscaled 大致匹配。**

**反对理由：**

1. **安全姿态变差而非变好。** 挂 `/var/run/docker.sock` 进容器 ≈ 给容器宿主机 root 等价权限。给一个卖点就是「禁止暴露在 tailnet 中」的工具增加容器逃逸面，方向是反的。
2. **零功能收益。** 单机单用户的控制面，不需要扩缩容；也谈不上隔离——它无论如何都要拿到两个特权 socket。
3. **给安全不变量加脚坑。** 现在「只监听回环」是代码层强制的；容器化后它退化为依赖「你有没有记得写 `network_mode: host`」，而忘写的后果会被 `-p` 掩盖成"好像能用"。

### 13.4 两个容易混淆的相邻方案

- **在 NAS 上跑 ≠ 管这台笔记本。** 该工具天生宿主作用域：在 NAS 上跑，它管的是 NAS 的容器与 NAS 的 serve 配置，与 `my-laptop` 上的路由毫无关系。要管两台就跑两个实例。
- **把 tailscaled 跑进容器**（官方 `tailscale/tailscale` 镜像）是另一个产品：容器成为独立 tailnet 节点，产出的地址是 `<容器节点名>.<tailnet>.ts.net`，`serve` 也从容器发出，本机现有路由一条都管不到。

### 13.5 常驻的正确做法

Windows 上用**计划任务**（登录时触发、以当前用户身份运行），见 `todo.md` 第 2 项。不要用 `LocalSystem`：`Tailscale` 那条命名管道位于 `ProtectedPrefix\Administrators` 下，服务账户会话拿不到它。
