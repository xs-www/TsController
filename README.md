# TsController

本机 **tailnet ↔ Docker 端口** 路由控制器。它把

```text
https://<机器名>.<tailnet>.ts.net/<路径>   →   http://127.0.0.1:<Docker 容器发布的端口>
```

这件事从「记住 `tailscale serve --set-path` 命令并手工敲」变成「在网页上点几下」。

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

> **为什么路由键是「路径」而不是 `dsh.xxx.ts.net` 这类独立主机名？**
> 因为在本机当前的 Tailscale 身份下拿不到这种主机名。完整实测证据与替代方案见 [§12](#12-附录为什么是路径路由而不是-dshxxtsnet)。

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
npm test              # 96 个单元/接口测试（全部使用假实现，不碰真实系统）
npm run verify:live   # 真实环境端到端验证（会临时增删一条 serve 路由，用完自动还原）
npm run verify:security  # 真实环境安全闸门验证（含非默认端口上的暴露）
npm run clean:verify  # 只清理 data/verify* 临时目录，绝不碰真实映射库
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
| `TSCONTROLLER_SERVE_PORT` | `443` | 对外 HTTPS 端口（仅用于拼界面上的完整 URL） |
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
3. **serve 配置层面**：启动闸门与每次 `apply` 都会扫描 serve 配置，**任何**指向管理端口的 handler 一律摘除（无论是不是本工具创建的），并写入审计日志。同时，通过 API 建立指向管理端口的映射会被直接拒绝（`409 exposes-admin`）。
4. **接管层面**：`import` 拒绝接管指向管理端口的路由。

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

**映射（Mapping）**：一条「路径 → 本机端口」的期望状态。

```ts
{
  path: "/worldforge",                      // 归一化后的挂载路径
  servePort: 443,                           // 对外 HTTPS 端口（路由身份的另一半）
  target: { kind: "container", hostPort: 4173, targetPath: "", containerName: "worldforge", containerPort: 8080 },
  enabled: true,
  ownedRoutes: [{ servePort: 443, path: "/worldforge" }]   // 它在 serve 中占用的全部位置（用于改名/改端口/删除时精准摘除）
}
```

**路由身份是「端口 + 路径」。** `/` 挂在 443 与 8443 上是两条互不干扰的独立入口，因此所有匹配、去重、归属判断都以 `(servePort, path)` 为单位。

**声明式收敛**：映射库是期望状态，`tailscale serve` 配置是实际状态。增删改都会自动触发一次收敛；收敛失败**不回滚映射库**，而是留下 `pending`／`errors` 让用户重试——用户意图不会因为一次 CLI 抖动而丢失。

**状态含义**：

| 状态 | 含义 |
| --- | --- |
| `active` | serve 配置与期望完全一致 |
| `pending` | 需要收敛（路径缺失、或指向别处、或写入失败） |
| `disabled` / `disabled-drift` | 已禁用；后者表示 serve 里还有残留 |
| `orphaned-target` | 目标容器不存在、未运行，或不再发布该端口 |
| `blocked` | 目标就是管理端口，被安全策略拒绝 |
| `conflict` | 同一路径被多条映射占用（防御性判定） |

**未托管路由**：serve 里存在、但映射库中没有对应记录的路由（例如你手工敲的 `tailscale serve --set-path`）。它们只读展示，可在界面上点「接管」纳入管理。

---

## 7. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针 |
| GET | `/api/system` | tailnet 基址、数据源、安全状态、收敛摘要 |
| GET | `/api/containers` | 容器清单 + 已发布端口 |
| GET | `/api/mappings` | 映射视图 + 未托管路由 + 计划摘要 + 状态计数 |
| POST | `/api/mappings` | 新建映射（可带 `servePort`，自动收敛并返回 `ApplyResult`） |
| PATCH | `/api/mappings/:id` | 局部更新（含 `servePort`，改端口会摘掉旧端口上的路由） |
| DELETE | `/api/mappings/:id` | 删除并摘除 serve 路由 |
| POST | `/api/mappings/:id/enabled` | 启用/禁用 |
| POST | `/api/mappings/import` | 接管未托管路由（`{ routes?: [{ servePort, path }] }`，省略即全部） |
| POST | `/api/apply` | 手动重新收敛 |
| GET | `/api/serve/routes` | serve 原始路由 + 托管标记（**含全部 HTTPS 端口**） |
| GET | `/api/audit?limit=N` | 审计事件 |

`ApplyResult.upserted` / `removed` 是**路由位置对象** `{ servePort, path }[]`，不是裸路径。

错误统一为 `{ error: string, code: string }`，常见 `code`：`exposes-admin`、`serve-port-is-admin`、`duplicate-path`、`takeover-required`、`invalid-path`、`invalid-port`、`invalid-serve-port`、`invalid-target-path`、`forbidden-host`、`not-found`。

---

## 8. 真实环境验证

沙箱里跑不了 Docker 与 Tailscale，因此有两个**真实环境**脚本（都在 `finally` 里做兜底还原，并逐条比对运行前的 serve 配置是否原样保留）：

```bash
node scripts/verify-live.ts              # 建映射 → 真实 HTTPS 请求 → 删映射
node scripts/verify-live.ts --port 8080  # 指定目标端口
node scripts/verify-security.ts          # 安全闸门：检测、摘除、不误伤、API 拒绝
```

`verify-live.ts` 的实际输出（本机）：

```text
[PASS] 读取 tailnet 身份 — https://my-laptop.example-tailnet.ts.net (100.101.102.103, ...)
[PASS] 读取 Docker 容器 — 5 个容器，5 个有已发布端口
[PASS] 创建映射并写入 serve — status=active upserted=[/__tscontroller-selftest] errors=[]
[PASS] 通过 ts.net 访问到容器 — HTTP 200，响应 626 字节
[PASS] 删除映射并摘除 serve 路由 — removed=[/__tscontroller-selftest] errors=[]
[PASS] 既有路由原样保留 — before=[/,/agent,/calendar,/calendar.ics,/dsh,/salecapitai,/worldforge] after=[同左]
=== 结果：9/9 通过 ===
```

`verify-security.ts`：10/10 通过（含「指向管理端口的路由被自动摘除且写入审计日志」「指向其它端口的路由不被误伤」「API 拒绝建立指向管理端口的映射」）。

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

### 9.3 端口也是路由身份

同一个路径可以同时挂在多个端口上，互不干扰：

| 端口 | 路径 | 目标 | 用途 |
| --- | --- | --- | --- |
| 443 | `/` | `127.0.0.1:8899` | 门户（根域名） |
| 8443 | `/` | `127.0.0.1:8899` | 同一门户的备用入口 |

因此：

- 在界面上「建立映射」与「编辑」都有**对外端口**字段，默认取配置里的 `TSCONTROLLER_SERVE_PORT`（通常是 443）。
- 访问地址会带上非 443 端口：`https://<主机>:8443/home`，界面上的「复制 URL」已经处理。
- 对外端口**不允许与管理端口同号**（会被 409 `serve-port-is-admin` 拒绝）——它不会泄露管理面（管理面只绑回环），但会让 `https://<主机>:<管理端口>` 看起来像管理界面。
- 安全闸门**跨全部端口**扫描（见 §5）。

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

数据新鲜度看 `generatedAt`。schema：

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-16T23:38:17.952Z",
  "generator": "tscontroller",
  "source": { "hostname": "…", "baseUrl": "…", "tailnetIps": ["100.x.y.z"], "adminPort": 8787 },
  "servePorts": [443, 8443],
  "routes": [
    {
      "servePort": 443,
      "path": "/worldforge",
      "url": "https://my-laptop.example-tailnet.ts.net/worldforge",  // 非 443 端口会带上端口号
      "proxy": "http://127.0.0.1:4173",
      "targetPath": "",
      "targetHostPort": 4173,
      "managed": true,              // 是否已被 TsController 接管
      "mappingId": "a7ae14c5-…",    // 未托管为 null
      "status": "active",          // 未托管为 null；取值见 §6
      "containerName": "worldforge",
      "containerPort": 8080,
      "containerSource": "mapping", // mapping = 来自映射库；port = 按宿主机端口反查；null = 未关联
      "note": "…",
      "enabled": true
    }
  ],
  "summary": { "total": 8, "managed": 7, "unmanaged": 1, "active": 7, "pending": 0, "disabled": 0, "orphanedTarget": 0, "blocked": 0 },
  "security": { "autoUnexpose": true, "exposures": [] }
}
```

**刻意不含**：数据目录路径、Docker 端点这类内部信息（消费方不需要）。文件里没有密钥——TsController 也不持有任何密钥。

`containerName` / `containerPort` 对**未托管**路由也会填：先查映射库，查不到就按宿主机端口在容器清单里反查（`containerSource` 标明来源）。门户因此能对每条路由都显示「背后是哪个容器」。

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
test/              96 个单元/接口测试（全部注入假实现）
scripts/           真实环境验证脚本 + 安全的清理脚本
docs/static/       静态函数文档
data/              运行时数据（映射库、审计日志），已 gitignore
```

---

## 11. 已知边界

- 只做 HTTP(S) 路径路由，不转发裸 TCP；需要裸 TCP 请用 `tailscale serve --tcp` 自行配置。
- 不做响应改写，因此挂在路径前缀下的应用若使用**根绝对路径**引用静态资源（`/assets/app.js`），会打到兜底路由而非该应用。**解法是给这类应用一个独立端口**（见 §9.2），而不是改路径。
- 依赖 `tailscale serve status --json` 的输出结构；解析层已能处理多 HTTPS 端口，但 Tailscale 未来若彻底迁移到 services 格式，仍需同步更新（写入路径用的是稳定的 `--set-path` CLI，不受影响）。
- Docker 端口通过宿主机的**已发布端口**访问，不直接连容器网络 IP。

---

## 12. 附录：为什么是路径路由，而不是 `dsh.xxx.ts.net`

「用独立 ts.net 主机名代替路径前缀」在 Tailscale 里确实**存在**这种能力，但在本机当前的设备身份下**拿不到**。以下是在 `my-laptop` 上实测的结果（2026-10-15，Tailscale v1.102.4）：

| 探测命令 | 结果 |
| --- | --- |
| `tailscale cert dsh.example-tailnet.ts.net` | `500 Internal Server Error: invalid domain "dsh.example-tailnet.ts.net"; must be one of ["my-laptop.example-tailnet.ts.net"]` |
| `tailscale serve --bg --service=svc:tsctest --https=443 http://127.0.0.1:8080` | `service hosts must be tagged nodes` |
| `tailscale status --json` → `Self.Tags` | 空（该节点由用户账号拥有，`Self.UserID = 7934677520309298`） |
| `Resolve-DnsName dsh.example-tailnet.ts.net` | DNS name does not exist |

原因是 `<任意名字>.<tailnet>.ts.net` 只能由 [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) 提供，而 Services **要求服务宿主机使用 tag 身份**（[tags 文档](https://tailscale.com/docs/features/tags)：*"Any device you want to use as a Service host must use a tag-based identity."*）。用户账号拥有的设备拿不到这种名字。

### 12.1 把本机打成 tagged node 的代价（为什么没这么做）

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

即便打了 tag，仍需在 admin console 定义 Service、通过管理员审批（或配 `autoApprovers.services`）、为客户端配 `grants`；Service 使用独立 **TailVIP**（非 `100.x`）且只能被动接受连接，目前仅支持 TCP。

### 12.2 替代方案：用另一台已 tagged 的常开设备当 service host

不需要改动本机身份：

```bash
# 在一台已经打了 tag 的常开设备（NAS / 小主机 / VPS）上执行
tailscale serve --service=svc:dsh --https=443 http://my-laptop.example-tailnet.ts.net:3081
```

这样即可得到 `https://dsh.<tailnet>.ts.net`，而本机的 Taildrop / SSH / 分享都不受影响。代价是多一台常开设备、多一跳，且该设备需要被 ACL 允许访问本机的这些端口。

**若将来启用这条路，TsController 需要的改动是有限的**：映射目标从 `127.0.0.1:<port>` 扩展为 `<host>:<port>`，路由键从「路径」扩展为「service 名 + 可选路径」。现有的容器发现、映射库、漂移检测、安全闸门、审计日志都可以直接复用。相关条目已记录在 `todo.md`。

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
