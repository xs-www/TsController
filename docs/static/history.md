# 变更归档（历史取舍与实测证据）

> 本文件保留每次改动的**原因、取舍与实测数据**。当前代码的静态结构见 docs/static/README.md 索引的镜像文档。
> 归档原则：只增不改 —— 后来的改动如果推翻了早先的结论，在新条目里写明，并在旧条目标注「已被 xxx 取代」。

---


### 2026-10-15 · 首个可用版本（全量新增）

新增文件：`package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`、`src/**`（15 个 TS 文件）、`test/**`（6 个测试文件 + `fakes.ts`）、`scripts/verify-live.ts`、`scripts/verify-security.ts`。

**本次确立且后续不应推翻的决定**：

1. 采用**控制面**方案托管 `tailscale serve`，不接管数据面（用户在三个方案中选定）。
2. 读 serve 配置用 `serve status --json`，写用 `serve --set-path` CLI；**禁用 `set-config`**（见第 4 节实测原因）。
3. `Mapping.ownedPaths` 记账机制 + 「只删自己写过的路径」策略。
4. `TSCONTROLLER_HOST` 硬性只允许回环，无绕过开关。

**开发过程中修正的实质问题**（供后续排查参考）：

1. `tailscale serve set-config` 在本机版本上会以 legacy 格式警告并**静默忽略**节点级字段（`TCP`、`Web`），初次探测时退出码仍为 0 —— 只检查退出码会误判为成功。已改用 `--set-path` CLI。
2. `set-config` 的参数顺序要求 `--all` 在文件名之前，否则报 `must specify filename`。
3. Zod 校验失败原本落到 500；已在 `statusFor()` 中显式映射为 400。
4. `private async #method()` 同时使用 `private` 与 `#` 是 TS 错误（TS18010），已统一为 `#method()`。
5. `setEnabled()` 内部委托 `update()`，因此自身不能包 `#serialize()`，否则队列自等待死锁。
6. 启动日志中的 Docker 端点原本恒为 `(未连接)`（端点解析是惰性的），已在监听前增加一次预热调用。
7. 不得用 PowerShell 的 `Get-Content -Raw` + `Set-Content -Encoding utf8` 改这些源码：无 BOM 的 UTF-8 中文会被按 ANSI 读出再写回，直接损坏文件。改用编辑工具。

### 2026-10-15 · 首个版本交付前的自查修正

在首版代码写完、测试全绿之后，对四个「测试测不出来但真实使用会踩」的点做了修正：

1. **Docker 端点探测从串行改并发，并加负缓存**（`src/docker/docker-client.ts`）。
   - 问题：Windows 上 `dockerDesktopWindowsEngine` 管道存在但不响应，串行探测会被它单独拖满 3s 超时 —— 实测首次连接耗时 **2528ms**。
   - 改法：`#probe()` 改为「所有候选并发发起，最先成功者胜出」（手写 race，而不是 `Promise.allSettled` —— 后者会等全部结束，等于没并发）。新增 `PROBE_TIMEOUT_MS = 2500` 与 `PROBE_FAILURE_TTL_MS = 5000` 负缓存。
   - 结果：实测 **27ms** 完成连接；Docker 未运行时后续请求直接命中负缓存，界面不再每次卡一轮超时。

2. **显式 Docker 端点是权威的**（`resolveEndpoints`）。
   - 问题：原实现在显式配置之后**仍会追加平台默认候选**。把 `DOCKER_HOST` 指向远程 Engine 的用户，会在远程不可达时被静默回落到本机 Docker Desktop —— 最难排查的一类故障。
   - 改法：`out.length > 0` 时直接返回，不再追加默认值。测试从「显式配置优先」改为「显式配置是权威的」。

3. **`dataDir` 与 `webRoot` 锚定到项目根目录**（`src/config.ts`）。
   - 问题：原本相对 `process.cwd()` 解析。本工具最终会被注册为计划任务/服务，那时 cwd 往往是 `C:\Windows\System32`，数据目录与前端目录会双双指错。
   - 改法：新增 `PROJECT_ROOT`（由 `import.meta.url` 推导），默认值改为 `path.join(PROJECT_ROOT, ...)`；环境变量仍按 cwd 解析（显式给出就该按用户的意图来）。

4. **`overview()` 不再重复读取 serve 快照**（`src/mappings/mapping-service.ts`）。
   - 问题：它先调 `#evaluateAll()`（内部已取快照），又单独调了一次 `gateway.snapshot()`，一次界面刷新会对 `tailscale` CLI 发起两次进程调用。
   - 改法：`#evaluateAll()` 的返回值中加入 `snapshot`，`overview()` 复用之。

测试数从 68 增至 **70**（新增「显式配置是权威的」「未配置时才使用平台默认候选」「无法连接时抛出可读错误且被负缓存」）。

`scripts/verify-live.ts` 与 `verify-security.ts` 在本次修正后重新执行，结果仍为 **9/9** 与 **10/10** 通过。

### 2026-10-15 · 管理界面交付 + 路由模型复核

**新增**：`web/` 全量前端（14 个源文件 + `vite.config.ts` + `tsconfig.json` + `index.html`），详见第 9 节。

**路由模型复核（本次最重要的结论）**

需求方提出「可以配置 `dsh.xxx.ts.net` 这样的 ts 域名，不必挂在路径上」。该说法在 Tailscale 里成立，但在本机身份下**取不到**，三条实测证据：

| 探测 | 结果 |
| --- | --- |
| `tailscale cert dsh.example-tailnet.ts.net` | `invalid domain "dsh.example-tailnet.ts.net"; must be one of ["my-laptop.example-tailnet.ts.net"]` |
| `tailscale serve --bg --yes --service=svc:tsctest --https=443 http://127.0.0.1:8080` | `service hosts must be tagged nodes` |
| `tailscale status --json` → `Self.Tags` | 空（用户账号拥有的节点） |

根因：`<任意名字>.<tailnet>.ts.net` 只能由 Tailscale Services 提供，而 Services 要求**服务宿主机使用 tag 身份**，tag 身份与用户身份互斥。已在 `README.md` §12 完整记录代价（Taildrop 失效、不能 SSH 到用户身份的机器、不能被分享、ACL 语义变化、tag 粘性、key expiry 默认关闭、官方劝退笔记本）与替代方案（用另一台已 tagged 的常开设备当 service host，本机身份不动）。

**决策**：路由键保持**路径**。服务主机名模式作为可选项记录在 `todo.md` 第 9 项，并写明了届时需要的最小改动面（`MappingTarget.remoteHost` + service 维度的网关读写 + `services` 配置段解析 + 安全闸门扩展到 service 级）。

**验证（全部在最终代码上重跑）**

| 检查 | 结果 |
| --- | --- |
| `npm run lint`（后端 + 前端两套 tsconfig） | 0 错 |
| `npm test` | **70/70 通过** |
| `npm run web:build` | 成功，39 modules → `web/dist`（index 0.48 kB / js 261 kB / css 10.9 kB） |
| `scripts/verify-live.ts --port 8080` | **9/9 通过**（`HTTP 200`，626 字节来自容器） |
| `scripts/verify-security.ts` | **10/10 通过** |
| 后端托管前端 | `/` → SPA、`/assets/*` → 200、`/deep/spa/route` → 回落 index.html、`/api/nope` → 404 JSON |
| 最终 serve 配置 | 与开工前完全一致（原 7 条路由未被改动） |

**过程中修掉的实质性缺陷**

1. **前端白屏风险**：写操作成功回调假设响应必有 `{ mapping }`，形状不符时会在 `result.data.mapping.path` 抛 TypeError 白屏。已改为可选链 + 「响应异常」内联提示。真后端确实返回 `{ mapping, apply }`，属防御性加固，但该分支在验证中被真实触发过。
2. **PATCH 请求体会丢容器关联**：编辑映射时若只发 `path/hostPort/targetPath/note`，后端会按端口反查容器；当容器已停止时反查失败，`kind` 会被降级为 `host`。前端因此把 `kind` / `containerId` / `containerName` / `containerPort` 一并回传（后端忽略未声明字段）。
3. **构建产物污染仓库根目录**：前端验证期有两个临时产物（`__smoke.css` / `__smoke.mjs`）落到项目根并被 `git add`。文件已删除，索引中的 `AD` 幽灵条目已用 `git reset` + 重新 `git add -A` 清理；新增 `.gitattributes`（`* text=auto eol=lf`）统一换行符，避免 Windows 上 `core.autocrlf` 造成的整文件 diff。

### 2026-10-15 · 首次真实使用反馈：目标路径与挂载前缀的对应关系

首次由真实使用暴露的问题（非代码缺陷，是**语义理解成本**）：

用户把映射的挂载路径由 `/agent` 改成 `/api/addSchedule`，但**目标路径仍是 `/api/agent`**，随后 `POST https://…/api/addSchedule` 返回 404。

根因链条：

1. `tailscale serve` 转发时会**剥掉挂载前缀**，因此「挂载 `/api/addSchedule` + 目标 `/api/agent`」意味着——请求正好命中挂载路径时剥完是空串，后端收到 `/api/agent`；
2. 而 SisiCalendar 的后端只有 `POST /api/agent/events` 与 `GET /api/agent/events/{event_id}`（`app/routers/api_agent.py`），**没有** `/api/agent` 这个路由 → 404。

诊断证据（区分「路由没生效」与「后端没这个路由」的关键）：404 响应体是 FastAPI 形状 `{"error":{"code":"not_found","message":"Not Found","fields":null}}`，说明流量确实打到了日历容器；而已改名前的 `/agent` 摘除后，`POST /agent/events` 返回的是 `{"error":"unauthorized"}` —— 与 `/dsh/agent/events` 的响应逐字相同，即落到了 `/` 兜底上的 DSH，而非日历。

**结论与改动**：映射的「外部路径」只是别名，决定命中后端哪条路由的是**目标路径**。将目标路径改为 `/api/agent/events` 后，`POST /api/addSchedule` 与 `GET /api/addSchedule/{id}` 均正确命中后端并返回日历的 401（缺 Bearer 令牌），链路打通。**代码零改动**，只通过 `PATCH /api/mappings/:id` 调整了映射数据。

**归档的文档增量**：`README.md` 新增 §9.1「挂载路径会被剥掉（最容易踩的一个坑）」，写明两条规则（别名 ≠ 后端路由名；请求正好等于挂载路径时后端收到目标路径本身），并给出 `/calendar.ics` 这个同名对照例子。

**两项已决策不做**（记录以免日后重复评估）：

1. **界面内联表单提示不加强前缀剥离说明。** 该规则已写入 `README.md` §9.1，文档足够；不值得为一句提示引入前端改动 + 重新构建。若第二次踩同一个坑再回来做。
2. **不把 `/agent` 加回为第二条映射。** 需求方明确只要新地址 `/api/addSchedule`，接受旧地址退役；因此 `/agent` 目前落到 `/` 兜底（DSH）返回 401 属于预期状态，不是缺陷。

> 附带确认了一条 serve 行为：**请求路径正好等于挂载路径时，目标路径被原样使用，不会追加尾斜杠**。证据是 `/calendar.ics → http://127.0.0.1:443/calendar.ics` 这个既有映射——它是 exact match，且返回的是应用层的 404 文案而非 FastAPI 的 307 重定向，说明路径按原样到达后端。这正是 `POST /api/addSchedule → POST /api/agent/events` 能成立的前提。

### 2026-10-15 · 容器化可行性调研（结论：不做）

被问到「能不能挂在 Docker 里」，做了实测调研。**代码零改动，不新增 Dockerfile**，结论归档为 `README.md` §13 与 `todo.md`「已探明、决定不做」A 项。

**决定性实测数据**（本机 Windows + Docker Desktop）：

| 观察 | 结果 |
| --- | --- |
| tailscaled（pid 7392/11848）监听端口 | 仅 `100.101.102.103:443`（serve 数据面）、`100.101.102.103:38081`（PeerAPI）、`[fd7a:…]:443/:50559`。**无任何回环 TCP** |
| tailscale CLI 的连接目标 | `open \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`（取自一次权限不足的报错原文） |
| `docker info --format {{.OSType}}` | `linux`（Docker Desktop，WSL2 后端；`vmmemWSL` 进程存在） |
| 容器内的 `host.docker.internal` | `192.168.65.254` —— 只能访问 Windows 宿主的 **TCP** 端口 |

**推理链**：`serve` 配置只能经 tailscaled LocalAPI 修改 → Windows 上该 API 只有命名管道这一条传输 → 命名管道跨不过 WSL2 边界（容器是 WSL2 内的 Linux）→ 容器化的 TsController 能列容器但所有 tailscale 操作失败，而后者是其全部意义。

**Linux 宿主的可行条件**（记录下来备查）：`network_mode: host` 是硬要求而非优化项——因为「只允许监听回环」在代码里无绕过开关（`loadConfig()` 抛错 + `main.ts` 监听后复核内核绑定地址），若用 `-p 127.0.0.1:8787:8787` 则容器内必须 bind `0.0.0.0`，会被直接拒绝；只有 host 网络能让容器内的 `127.0.0.1` 真为宿主回环，该安全保证才既成立又通过检查。另需挂 `/var/run/docker.sock` 与 `/var/run/tailscale/tailscaled.sock`，并保持镜像内 CLI 版本与宿主 daemon 大致匹配。

**明确不做的理由**：挂 `docker.sock` 进容器 ≈ 容器获得宿主 root 等价权限，给一个设计目标为「禁止暴露在 tailnet 中」的工具增加容器逃逸面，方向相反；且单机单用户控制面无扩缩容需求，零功能收益；同时会把「只监听回环」这条代码层强制的安全不变量，退化为依赖部署者记得写 `network_mode: host`。

**顺带澄清的两个相邻模型**（易混淆，一并归档）：

1. **在 NAS 上跑 ≠ 管这台笔记本。** 该工具天生宿主作用域（读本机 Docker daemon、写本机 tailscaled），在 NAS 上运行得到的是 NAS 控制器，与 `my-laptop` 上的路由无关。要管两台就跑两个实例。
2. **把 tailscaled 跑进容器**（官方 `tailscale/tailscale` 镜像）是另一个产品：容器成为独立 tailnet 节点，产出 `<容器节点名>.<tailnet>.ts.net`，`serve` 从容器发出，本机现有路由一条都管不到。

**常驻的正确路径**：Windows 计划任务（登录时触发、以当前用户身份运行）。不可用 `LocalSystem`——`Tailscale` 命名管道位于 `ProtectedPrefix\Administrators` 下，服务账户会话拿不到。见 `todo.md` 第 2 项。

### 2026-10-16 · 多端口支持（修复安全缺口）+ 一次数据误删事故

#### 起因

需求方把 `homepage-portal` 挂到 `/home`，页面 200 但白屏。诊断结论：该应用用**根绝对路径**引用静态资源（`/assets/index-CEaepkfb.js`），而 `/assets/**` 不在 `/home` 前缀内 → 落到 `/` 兜底 → 打到 DSH 返回 401（实测响应体 `{"error":"unauthorized"}`，与 `/dsh/agent/events` 逐字相同，可据此区分「路由没生效」与「打到兜底」）。同一诊断也确认了 `POST /api/addSchedule → POST /api/agent/events` 的映射正确性（响应体是日历的 FastAPI 形状，证明命中了后端路由，只差 Bearer 令牌）。

解法是**换端口而非换路径**：`https://<主机>:8443/` 是独立 origin，根路径天然正确。实测 `:8443/`、`:8443/assets/index-*.js`、`:8443/assets/index-*.css` 全部 200，且 TLS 证书有效（证书绑主机名，与端口无关）。

但由此暴露了本次修复的真正对象：**`parseServeStatus` 只取一组 `Web` 配置，因此挂在非 443 端口上的路由对 TsController 完全不可见——安全闸门也扫不到。** 这是一处真实的安全缺口（`README.md` §5 曾承诺「任何指向管理端口的 handler 一律摘除」，对非 443 端口当时并不成立）。

#### 改动清单（路由身份从「路径」升级为「端口 + 路径」）

| 文件 | 改动 |
| --- | --- |
| `src/domain/types.ts` | `Mapping` 新增 `servePort`；`ownedPaths: string[]` → `ownedRoutes: OwnedRoute[]`（`{servePort, path}`）；`ServeRoute` 新增 `servePort`/`host`；`ServeSnapshot` 的 `webHost`/`httpsPort` → `httpsPorts: number[]`/`hostname`；新增 `RouteRef` |
| `src/domain/route-path.ts` | 新增 `serveRouteKey(port, path)`（唯一键）、`buildBaseUrl(hostname, port)`、`formatRouteRef(route)`（443 省略端口以免日志噪音） |
| `src/tailscale/serve-config.ts` | **`parseServeStatus` 遍历全部 `Web` 组**，路由扁平存放并各自带 `servePort`；`snapshotHostname` 改为直接返回 `snapshot.hostname` |
| `src/tailscale/tailscale-cli.ts` | `serveUpsert`/`serveRemove` 显式带 `--https=<port>` |
| `src/tailscale/tailscale-service.ts` | `ServeGateway.upsertRoute`/`removeRoute` 签名加端口 |
| `src/mappings/store.ts` | `reviveMapping(raw, defaultServePort, logger)`；新增 `reviveOwnedRoutes`；**迁移旧格式** `ownedPaths` → `ownedRoutes`（旧格式无端口维度，归属到该映射自身端口）；`FileMappingStore` 接收默认端口 |
| `src/mappings/reconcile.ts` | 全部匹配/去重/归属改用 `serveRouteKey`；`PlannedUpsert`/`PlannedRemoval`/`exposures` 均带 `servePort`；新增「对外端口 == 管理端口」判定；暴露扫描覆盖全部端口 |
| `src/mappings/mapping-service.ts` | `MappingInput.servePort`；`#buildMapping` 校验端口并新增 `serve-port-is-admin`；`#ownedKeysOf`/`#ownedKeys` 辅助；`importExternal(selection: {servePort,path}[])`；`ApplyResult.upserted`/`removed` 改为 `RouteRef[]`；`enforceExposureGuard` 跨端口扫描 |
| `src/app.ts` | 请求体加 `servePort`；`/api/system` 的 `webHost` → `serveHost` + `servePorts`；`/api/serve/routes` 同步；import 请求体 `paths` → `routes` |
| `web/src/**` | 类型同步；新增 `formatRouteLabel`；`joinUrl(serveHost, servePort, path)`；创建表单与编辑行新增「对外端口」字段；serve 路由表与未托管路由表新增端口列；**顺手补上了 README §9.1 那套「前缀会被剥掉」的表单内提示**（此前评估过不做，本次因为改动已经落到同一个文件而一并完成） |

**CLI 行为实测**（改动的地基，先验证再动手）：`serve --bg --yes --https=8443 --set-path=/x <url>` 只作用于 8443 组；`serve --yes --https=8443 --set-path=/x off` 精确摘除该条；`--https=443` 显式给出与省略等价；`serve status --json` 中每个端口是一个独立的 `Web` 键（`host:443`、`host:8443`）。

#### 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 0 错 |
| `npm test` | **96/96 通过**（自 70 增加 26 个：多端口 reconcile / 映射服务 / API / 迁移用例） |
| `npm run web:build` | 成功 |
| `scripts/verify-live.ts --port 8080`（443 回归） | **9/9** |
| `scripts/verify-live.ts --port 8899 --serve-port 8443` | **9/9**（真实请求 `https://…:8443/__tscontroller-selftest` → HTTP 200） |
| `scripts/verify-security.ts` | **14/14**，含新增的 D 组断言：**8443 上的暴露被检测并摘除**，且该端口上的既有路由未被牵连 |
| 通过 API 在 8443 建/删映射 | `:8443/__api8443` 真实访问 HTTP 200，删除后 `inSync: true` |
| 旧格式 `ownedPaths` 迁移 | `reviveMapping` 单测覆盖 + 真实映射库迁移后 7 条全 `active`、`inSync: true` |

#### 事故：误删真实映射库（`data/mappings.json`）

**经过**：连续执行验证脚本后，用 `Remove-Item -Recurse -Force data` 清理临时数据，但真实映射库 `data/mappings.json` 与验证脚本的 `data/verify*` 子目录同级，**一并被删除**（审计日志 `data/audit.jsonl` 同样丢失）。

**为什么没有造成实际故障**：serve 配置从未被破坏，且「只删自己写过的路径」策略意味着**映射库丢失后 TsController 只会不再认领路由，而不会删除它们**。失效表现仅为所有路由显示为「未托管」、备注与归属记账丢失。

**恢复方式**：按会话中此前读到的 `mappings.json` 原文 + 审计日志逐条重建 7 条映射（5 条原始导入 + `/home` + 8443 上的 `/`）。重建后 `inSync: true`、`upserts: 0`、`removals: 0` —— 即重建结果与 serve 现状完全一致，证明恢复无损。

**防复发措施**：

1. 新增 `scripts/clean-verify.ts`（`npm run clean:verify`）：**只删白名单内的验证子目录**（`data/verify*`、`data/smoke`），对每个路径做两次断言——必须落在 `data/` 之下，且目录名必须以 `verify`/`smoke` 开头；结束时报告真实映射库是否仍在。
2. `README.md` §3 增加显式警告：不要 `rm -rf data`，用 `npm run clean:verify`。

**教训（写给下一次的自己）**：临时数据与真实数据同级存放时，清理命令必须按**已知的白名单子目录**逐个删除，绝不对父目录做递归删除。这一条已固化进清理脚本的断言里，而不是只写在文档中。

### 2026-10-16 · serve 路由快照 + 一处安全论断被实测推翻

#### 起因

需求方提出：其它项目也需要读 tailscale serve 路由，但它们跑在容器里（够不到宿主 tailscaled）；而 TsController 从终端启动，因此考虑由它暴露一个 HTTP 接口供调用。

调研这个问题时先做了一次连通性实测，结果推翻了本文件此前写下的一个安全论断。

#### 实测证据链（Windows + Docker Desktop）

| 探针 | 结果 | 含义 |
| --- | --- | --- |
| 容器内 `tailscale serve` / named pipe | 不可达 | 既有结论，容器够不到宿主 tailscaled |
| `docker run ... wget host.docker.internal:8787/api/health` | `403 forbidden-host` | Host 校验拦住了「天真客户端」 |
| 同上 + 伪造 `Host: 127.0.0.1:8787` | `200 {"ok":true}` | **Host 校验可被绕过** |
| 伪造 Host `GET /api/system` | 完整数据返回 | 读接口对容器完全开放 |
| 伪造 Host `POST /api/mappings`（指向管理端口） | `409 exposes-admin` | 请求**已通过鉴权**，仅被业务规则拒绝 → 写权限同样开放 |
| 临时探针打印 `req.socket.remoteAddress` | 本机直连 / 容器自然请求 / 容器伪造 Host **三者都是 `127.0.0.1`** | **无法靠来源地址区分** |

根因两条，缺一不可：Docker Desktop 把 `host.docker.internal` 代理到宿主 loopback（**绑回环 ≠ 隔离容器**）；`Host` 头由客户端完全可控。

**被推翻的论断**：本文件与 `README.md` §5 曾称「只监听回环 → 其它设备无法直连 + Host 白名单」构成有效的管理面边界。**该结论对网络对端成立，对同机容器不成立。**

需要注意的边界差异：Linux 桥接网络下容器**到不了**宿主回环（`docker0` 网关上没有该监听），所以这个问题在当前平台（Docker Desktop）上更严重。这一点也影响了「将来容器化到 NAS」的评估——届时把 TsController 放进专用 compose 网络、绑容器内 `0.0.0.0` 但不 publish，可达范围反而**比绑宿主回环更窄**。

**未修**：可靠判别只能依赖「容器拿不到的东西」——宿主文件系统上的令牌。已记入 `todo.md`（写接口令牌）。

#### 本次实现：serve 路由快照

新增 `src/snapshot.ts`：

| 符号 | 说明 |
| --- | --- |
| `SNAPSHOT_SCHEMA_VERSION` | schema 版本，字段语义变化时递增。**当前 = 2**（v2 = 路由身份三元组 + Service 列表；v1 = 端口 + 路径） |
| `Snapshot` / `SnapshotRoute` / `SnapshotSummary` | 快照结构。v2 起每条路由含 `service`/`host`/`path`/`url`/`proxy`/`targetPath`/`targetHost`/`targetHostPort`/`fromServiceConfig`/`managed`/`mappingId`/`status`/`containerName`/`containerPort`/`note`/`enabled`；顶层含 `services: ServiceInfo[]`；`source` 含 `magicDnsSuffix`/`selfTags`；`summary` 含 `awaitingApproval` |
| `buildSnapshot(input): Snapshot` | **纯函数**。相同输入必得相同输出（`generatedAt` 由调用方注入），因此可穷举测试 |
| `SnapshotWriter` | 写出器接口，便于注入内存实现 |
| `FileSnapshotWriter` | 写 `<dir>/serve-routes.json`，**临时文件 + rename** 原子替换，消费方永远读不到半截 JSON |
| `MemorySnapshotWriter` | 测试用 |

**v2 的两处语义收缩（改动时不要回退）**：

1. 路由的对外地址只看**快照自身的 `host`**（Service 级则用 Service 的 MagicDNS 名），不再拿 `tailnet.dnsName` 兜底——后者会在「读不到主机名」时产出一个看似可用、实际不该点开的链接。
2. 远端目标（`handler.loopback === false`）**不做**容器端口反查，`containerSource` 保持 `null`（那是别的机器的容器清单）。

**接线的关键决定**：

1. **位置** `<DATA_DIR>/public/`，不是 `<DATA_DIR>` 根下——消费方只挂这一个目录，不必顺带暴露 `mappings.json` 与 `audit.jsonl`。
2. **刷新时机**：`MappingService.applyInternal()` 收敛之后写一次（消费方读到的应是收敛后的真实状态）；`main.ts` 启动时写一次（必须在可供调用之前存在）；另有定期定时器。
3. **定期刷新只读不写**：`publishSnapshot()` 只做 `snapshot()` 读取 + 写文件，**绝不改 serve 配置**。实测确认定时器推进时 `tailscale serve status` 逐字节不变。
4. **失败不影响收敛**：快照写失败只 `logger.warn`，`apply` 的返回值与错误列表不受影响（有单测覆盖）。
5. **刻意不含**：数据目录路径、Docker 端点等内部信息；文件内无任何密钥。
6. 定时器 `unref()`，不阻止进程退出。

新增配置：`TSCONTROLLER_SNAPSHOT_DIR`（默认 `<DATA_DIR>/public`）、`TSCONTROLLER_SNAPSHOT_INTERVAL_MS`（默认 60000，0 关闭）。
`/api/system` 的 `sources` 新增 `snapshotFile`，界面顶部信息条展示并可一键复制。

#### 验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 0 错 |
| `npm test` | **112/112**（自 96 增加 16：12 个快照单测 + 4 个收敛集成断言） |
| `npm run web:build` | 成功 |
| 启动后快照生成 | `data/public/serve-routes.json`，4616B，8 条路由 / 7 受管 / 1 未托管 |
| **容器只读挂载读取** | `docker run -v "...\data\public:/tscontroller:ro" cat /tscontroller/serve-routes.json` → 正常读出 |
| 写穿透 | 通过 API 建映射后文件 `LastWriteTime` 与路由数同步更新；删除后回落 |
| 定期刷新 | `generatedAt` 在一个周期后推进（23:38:34 → 23:39:18） |
| 定期刷新不改 serve | 前后 `tailscale serve status --json` 逐字节相同 |

### 2026-10-16 · NAS 部署准备 + 容器化实测

#### 起因

最终目标是 NAS 部署，需求方要一份能带到 NAS 上照着做的文档，并问「快照文件路径在 NAS 上怎么决定」。

#### 修掉的一个「文档承诺了但代码没实现」

`README.md` 早已写明 `TSCONTROLLER_SNAPSHOT_DIR` 可覆盖快照目录，但 `loadConfig()` **从未读取它**（与其他路径型配置不同，只写了 `path.join(dataDir, 'public')`）。已按 `TSCONTROLLER_DATA_DIR` / `TSCONTROLLER_WEB_ROOT` 的同一模式接通（显式值按 cwd 解析，空串视为未设置），并补了 4 个单测覆盖默认值、覆盖值、空串回落、间隔参数校验。**本机实测确认文件确实落在指定目录。**

#### 快照新增：未托管路由的容器关联

原先 `containerName` / `containerPort` 只来自映射库，因此**未托管**路由在快照里是空的。但门户恰恰需要知道每条路由背后是哪个容器。

`buildSnapshot()` 的输入因此新增 `containers: ContainerInfo[]`，并新增 `containerSource` 字段（`'mapping' | 'port' | null`）标明来源：

- 优先用映射库的归属（人工确认过）；
- 没有映射时按 `targetHostPort` 在容器清单里反查，**优先运行中的容器**；
- 都查不到就保持 `null`，不猜。

实测效果（容器内跑真实 docker.sock）：

| path | targetHostPort | containerName | containerSource |
| --- | --- | --- | --- |
| `/` | 8080 | cs22-web | port |
| `/calendar` | 443 | sisi-calendar | port |
| `/portal` | 8899 | homepage-portal | port |

#### 新增部署资产

| 文件 | 说明 |
| --- | --- |
| `deploy/Dockerfile` | 多阶段：`node:22-bookworm-slim` 构建前端 → 运行阶段用 `npm ci --omit=dev`。**选 Debian 而非 Alpine**，因为宿主的 tailscale 二进制会被 bind-mount 进来，glibc 兼容性更好。构建时断言 Node ≥ 22.18（原生类型擦除）。 |
| `deploy/docker-compose.yml` | `network_mode: host`（硬要求，见下）、三个挂载（data / docker.sock / tailscaled.sock）、healthcheck |
| `.dockerignore` | 排除 `node_modules`、`data`、`web/dist`（镜像内重建）等 |
| `docs/nas-deployment.md` | 部署指南：路径决定逻辑、探路清单、逐步部署、验证、回滚、故障排查表 |

**`network_mode: host` 是硬要求而非优化项**：本应用硬性拒绝绑定非回环地址且无绕过开关，若用 `ports: ["127.0.0.1:8787:8787"]`，容器内必须 bind `0.0.0.0` 才能被 publish，会被直接拒绝。host 网络让容器内的 `127.0.0.1` 就是宿主回环，该约束既成立又能通过检查。

**排查到的一个真实错误**：compose 里的相对路径是**相对 compose 文件所在目录**解析的，`./data` 会得到 `deploy/data`，与文档写的 `/volume1/docker/tscontroller/data` 不符。已改为 `../data`，并用 `docker compose config` 验证解析结果落到仓库根。

#### 容器化实测（本机 Linux 容器，用 tailscale 桩替身）

没有 NAS，但镜像与整条软件链路可以在本机 Docker 里验证：

| 检查 | 结果 |
| --- | --- |
| `docker build -f deploy/Dockerfile .` | ✅ 成功；镜像内 `node -v` = **v22.23.3** |
| 容器内读宿主 Docker | ✅ `7` 个容器，`unix:/var/run/docker.sock` |
| 容器内调用 tailscale CLI | ✅ 通过桩替身，生成 3 条路由的快照 |
| 快照写入宿主挂载卷 | ✅ `data/public/serve-routes.json` |
| 管理 API / 前端在容器内 | ✅ `/api/system` 返回正确字段、`/` 返回 SPA |
| tailscale 缺失时的降级 | ✅ 只 warn 不崩；管理界面照常可用，日志给出可读原因 |
| `npm test` | **119/119** |
| `docker compose config` | ✅ 解析通过 |

**仍未验证**（已在文档中明确标注）：宿主的**真实** tailscale 二进制能否在镜像内执行、`tailscaled.sock` 的读/写权限。这两项本机是 Windows，无对应物可测。

### 2026-10-16 · 镜像发布链路（ghcr.io）

需求方已能远程访问绿联 DX4600 Pro（管理员权限），问如何打包镜像并推送到 ghcr.io。

#### 新增文件

| 文件 | 说明 |
| --- | --- |
| `.github/workflows/docker-publish.yml` | 两段式：`verify`（`npm ci` → `npm run lint` → `npm test`）→ `build-and-push`。**测试不过就不构建镜像**。触发方式为 tag 推送（`v*`）或手动 `workflow_dispatch`。 |
| `docs/image-publishing.md` | 手动推送与 Actions 两条路径、PAT 权限要求、架构确认、NAS 侧拉取与排查、以及 `network_mode: host` 的提醒 |

#### 工作流里三个刻意的处理

1. **显式把镜像名转小写。** ghcr.io 的镜像路径必须全小写，而 GitHub 的用户名/仓库名可以含大写；直接用 `${{ github.repository }}` 会在 push 时报 `invalid reference format`。用了一个独立步骤 `echo "IMAGE_NAME=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"`（bash 的 `${VAR,,}` 小写展开）消除这个坑。
2. **先跑 verify 再构建。** 推到 registry 的镜像应当是通过验证的——NAS 上拉到坏镜像的排查成本远高于 CI 里多跑一分钟。测试全部使用假实现、不需要 Docker 与 Tailscale，因此在 GitHub runner 上可直接跑。
3. **只建 `linux/amd64`。** 绿联 DX4600 Pro 及同代 NAS 基本是 Intel x86_64。文件中注明了改多架构的方法（`platforms: linux/amd64,linux/arm64`）与代价（arm64 走 QEMU，`npm ci` 明显变慢）。

#### 前置事实核查

- 本机 `docker buildx` = v0.37.1；`docker version` 平台 = `linux/amd64`
- 仓库状态：**57 个文件在索引里、零提交、无 remote**、当前分支 `master`。因此 `image-publishing.md` 明确区分了「手动推送（不需要 Git 远端）」与「Actions（需要先推仓库）」两条路
- 排查确认待提交内容里没有 `.env` / token / 密钥类文件；`data/` 同时被 `.gitignore` 与 `.dockerignore` 排除，不进仓库也不进镜像

#### 验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 0 错 |
| `npm test` | **119/119** |
| `npm run web:build` | 成功 |
| `docker build -f deploy/Dockerfile .` | ✅ 成功；镜像内 `node -v` = v22.23.3 |
| 镜像自检（`ls web/dist`） | ✅ `assets` + `index.html` 都在 |
| workflow YAML 解析（pyyaml） | ✅ `jobs: [verify, build-and-push]`、`triggers: [push, workflow_dispatch]` |

**未验证**：工作流本身未在 GitHub 上真实运行过（需要先把仓库推上去）。

### 2026-10-16 · 首次发布到 GitHub + 公开仓库的个人信息清理

#### 发布

仓库 <https://github.com/xs-www/TsController>（空仓库）→ 首次提交 → `main` 分支。当前 `main` = `d0e29cd`，59 个文件。

- `git remote add origin https://github.com/xs-www/TsController.git`，分支 `master` → `main`
- 提交前核查：待提交内容里无 `.env` / token / 密钥类文件；`data/` 同时被 `.gitignore` 与 `.dockerignore` 排除
- `.gitignore` 补充 `vol/`（与 `.dockerignore` 保持一致）

#### 清理（这是本节的重点）

发布后发现**仓库是公开的**，而文档示例与测试夹具里含真实的 tailnet 名称、tailnet IP 与主机名。运行时设计本身没有问题——tailnet 名称是从 `tailscale status --json` 现读的（`parseTailnetInfo`），TsController **不持久化它**，`data/` 里只有映射（路径 + 端口）。泄露纯粹来自「为了写实测证据链而把真实值抄进了文档和夹具」。

处理方式：13 个文件、约 90 处替换，**改写提交后强推**（`415c65e` → `d0e29cd`），而不是补一个提交把旧值留在历史里。

替换覆盖四类：**主机名**、**tailnet 标识**、**tailnet IPv4/IPv6**、**开发机绝对路径**，分别换成占位值 `my-laptop` / `example-tailnet` / `100.101.102.103`（IPv6 用 `fd7a:115c:a1e0::9999`）/ `D:\apps\TsController`。

> 本文件**刻意不列出被替换的原值**——在公开仓库里记录「原值 → 占位值」的对照表，等于把刚抹掉的东西又写回去。
> 第一次提交这份归档时就是这么干的，随后被自己的残留扫描逮到。归档只描述类别，不复现内容。

注意：`git grep -l <pattern> HEAD` 会给每条路径加 `HEAD:` 前缀，直接拿去 `Resolve-Path` 会全部失败——第一次尝试因此一个字都没改。要用不带 revision 的 `git grep -l` 搜工作区。

**未被强推解决的部分**：旧提交仍可按 SHA 直接访问（GitHub 不立即回收未引用对象）。彻底清除只能删库重建。风险定级**低**——泄漏物是 tailnet 名称（经 Cloudflare DoH 核实公网 NXDOMAIN；注意本机 `Resolve-DnsName -Server 1.1.1.1` 会被 Tailscale 的 DNS 拦截给出假阳性）与 CGNAT 段 IP（不可公网路由），**不含凭据**。决策记在 `todo.md` 2.6。

#### 验证

| 检查 | 结果 |
| --- | --- |
| 残留扫描（tailnet 名/IP/主机名/个人路径/邮箱） | ✅ 0 处 |
| 远端 `main` 抽查（README / function-index / fakes） | ✅ 无个人信息 |
| 中文编码完好性 | ✅（用 .NET `UTF8Encoding($false)` 显式无 BOM 写入） |
| `npm run lint` | 0 错 |
| `npm test` | **119/119**（替换保持了夹具自洽性） |

### 2026-10-17 · 静态文档从「单页」重构为「镜像目录树」（并接进校验）

**起因**：需求方要求按 `code-static-documentation` 技能包重构静态文档。原先是**单个大文件** `docs/static/function-index.md`（992 行），不满足技能包的核心约定：**目录即索引**（文档目录树 = 源码目录树）、**一文件一文档**、函数级粒度。

**做法（对应技能包六阶段）**：

| 阶段 | 落地物 |
| --- | --- |
| Phase 0 准备 | `docs/static/.ignore`：显式登记忽略规则（版本控制 / 依赖 / 构建产物 / **运行时数据 `data/`** / 锁文件 / 二进制 / 本就是给人读的文档） |
| Phase 1 枚举 | `docs/static/manifest.txt`：**一次性完整枚举**出的权威清单，带「状态 + 类别 + 相对路径」三列，是全流程唯一遍历依据 |
| Phase 2 分类 | 57 条待归档（代码 43 / 配置 13 …）+ 9 条显式跳过；`docs/*.md` 与仓库根 `README.md`/`todo.md` 归为 `doc` 类**不生成镜像**（避免两份真相） |
| Phase 3 生成 | 镜像文档 **57 份**，路径 = 源码相对路径 + `.md`；每份含「文件概述 / 依赖·引用 / 函数清单 / 函数详情（签名·入参·出参·功能·边缘条件）/ 全局常量 / 待办与隐患」 |
| Phase 4 边缘条件 | 逐函数写清空值、默认值、异常分支、并发与资源释放；重点记录本项目特有的边界（命名空间不串味、远端目标不判孤儿、暴露只判回环、`awaiting-approval` 不算 pending、`get-config` 有损读取…） |
| Phase 5 校验 | 新增 `scripts/verify-docs.ts`（`npm run verify:docs`），落地**四重校验**：数量 / 结构 / 覆盖 / 格式，外加一次「反向校验」防漏登记 |
| Phase 6 交付 | `docs/static/README.md`（索引 + 阅读顺序 + 排除清单 + 校验报告 + 维护约定）；`history.md`（本文件，原 `function-index.md` 的 §11 迁入） |

**删除了什么以及为什么**：`docs/static/function-index.md` 已删除——它的「当前代码结构」部分拆进了镜像文档，「变更归档」搬到了 `history.md`，索引职责由 `README.md` 承接。要回看旧形态：`git show <sha>:docs/static/function-index.md`。

**过程中修掉的两个实质问题**（都不是业务代码，而是新写的校验脚本自己暴露的）：

1. **校验脚本的跳过判定写错**：`manifest.txt` 里「状态」与「类别」是两列，最初的过滤条件把 `category === 'doc'` 的条目当成了待生成，于是 `README.md`/`todo.md` 一直报「缺少镜像文档」，并把「源文件数」算成 61（含依赖与运行时数据）。改为 `isSkipped()` 同时认 `category === 'skip' | 'doc'` 与显式 `skipped`。
2. **函数提取口径过宽 → 制造假失败**：最初的正则把接口成员、对象字面量方法、`.then((res) => …)` 这类内联回调都算成「函数」，导致 `src/domain/types.ts`（纯类型，0 个函数）被判「按源码 4 个函数：property、method…」而失败。改成**只认三类形态**（顶层 `function`、`export const = (`、行尾带 `{` 的缩进类方法），并把方向定为「**宁可少算，不可多算**」——覆盖校验是下界校验，高估只会制造假失败。

**验证**：

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify-docs.ts` | **四重校验全部通过**：待归档 57 = 已生成 57；文档函数条目 **300** ≥ 源码粗筛 **191**；结构/格式全部命中 |
| `npm test` | **185/185**（重构未触碰业务代码；顺带修了 `test/fakes.ts` 里 `parseFakeRouteKey` 的文档注释与实现不一致——三个冒号的 Service 键写法现已明确支持） |
| `npm run lint` | 0 错 |
| `npm run web:build` | 成功 |

**新增的 npm script**：`verify:docs`（校验）、`docs:stats`（校验并把统计表写回 `README.md` 的 STATS 标记区）。

**已知遗留**：文档头统一记为「随本次提交」（生成与源码同一提交入库，没有可引用的历史 sha）；4 个前端组件与 3 个脚本的文档由并行子任务生成，风格以 `src/logger.ts.md` / `src/docker/docker-service.ts.md` 为范本。

**顺带发现的既有问题（未在本提交修，仅登记）**：

1. `web/src/components/shared.ts` 是**死代码**：全仓检索 `MutationHooks` / `ReportApply` / `DEFAULT_APPLY_OPTIONS` 只命中它自己；`App.tsx` 自带同形状的 `reportApply` 并把提示文案内联成字面量，形成两份同值真相。
2. `SecurityBannerProps.onCopied` 是必选 prop 但函数体内完全未使用；且危险分支只看 `security.safe`，`safe === false` 且 `exposures` 为空时会渲染「检测到 0 条」+ 空 `<ul>`。
3. `Toolbar` 的 `adminUrl` 只当可见性开关（`href` 硬编码 `/api/system`）。
4. `App.pushToast` 头插截断到 6 条时不取消被丢弃 toast 的定时器；`applyNow` 调 `api.apply()` 未传 `AbortSignal`。
5. 三处口径不一致：`App.managedKeys` 折叠 path 大小写而 `ExternalRoutesPanel.routeKey` 敏感；`EditRow` 的 path 只 `trim()` 而创建表单用 `normalizePathInput`；`StatusBadge` 的 `detail ?? meta.hint` 不兜空串。
6. `scripts/verify-security.ts` 的 `TEST_ADMIN_PORT=8789` **未被校验是否空闲**（若被占用，「零暴露窗口」的推理不成立）；`verify-live.ts --service` 按名字字面比对，传裸名 `dsh` 会整个跳过 Service 轮。


### 2026-10-17 · 前端跟进 Tailscale Service 级路由（路由身份升级为三元组）

**范围**：仅 `web/**`（`src/` 与 `test/` 由并行的后端改动负责，本次未触碰）。后端把路由身份从 `(servePort, path)` 升级为 `(service, servePort, path)`、代理目标从固定 `127.0.0.1` 扩展为任意主机，本节的改动就是让界面与那份契约对齐。

#### 契约层：`web/src/api.ts`（逐字镜像后端，仍是唯一真相入口）

| 类型 | 改动 |
| --- | --- |
| `MappingStatus` | 新增 `'awaiting-approval'` |
| `RouteRef` | 新增 `service: string \| null`（`null` = 节点级） |
| `MappingTarget` | 新增 `remoteHost?` / `scheme?`；`hostPort` 的语义注释改为「`remoteHost` 省略时是本机端口」 |
| `MappingView` | 新增 `service` / `baseUrl`；**`baseUrl` 是完整基址（不含路径），非 443 端口已带端口** |
| `ServiceInfo` | 新增：`name` / `dnsName` / `servePorts` / `advertised` / `vipIps` |
| `ExternalRoute` | 新增 `service` / `host` / `fromServiceConfig` / `serviceInfo` |
| `SystemInfo` | 新增 `magicDnsSuffix` / `selfTags` / `canHostService` / `services` |
| `MappingsResponse` | 新增 `services` / `selfTags` |
| `ServeRoutesResponse` | 新增 `services` |
| `ApplyResult.blocked` / `ImportResponse.skipped` | 均带上 `service` |
| `Exposure` | 新增 `service` |
| `ServeRouteView` | 新增 `service`；`ProxyHandler` 新增 `host` 与可选 `fromServiceConfig` |
| `MappingInput` | 新增 `service?` / `remoteHost?` / `scheme?` |
| `KNOWN_ERROR_CODES` / `ERROR_CODE_LABEL` | 新增 `invalid-service` / `invalid-remote-host` / `remote-host-requires-service` / `invalid-scheme` |

#### `web/src/utils.ts`（新增 6 个纯函数，全部留在这一层）

| 符号 | 说明与边缘条件 |
| --- | --- |
| `SERVICE_PREFIX` | 常量 `'svc:'`，与后端 `route-path.ts` 的同名常量对齐 |
| `MAPPING_STATUS_ORDER` | `awaiting-approval` 插在 `pending` 与 `active` 之间（顺序 = 严重度：配置已写对，只差管理员点一下） |
| `groupByStatus` | 组内排序由「仅路径」改为 `(service ?? '')` 再 `path`，避免节点级与 Service 级的路由交替出现 |
| `normalizeServiceInput(input)` | 去空白、去掉裸 `svc:` 前缀、统一小写前缀为 `svc:dsh`；空串与「只有前缀」→ `""`（即节点级）。**刻意不做完整校验**，非法名交给后端按 `^[a-z0-9][a-z0-9._-]*$` 拒绝并回显原因（与 `normalizePathInput` 同一哲学）。注意 `svc:DSH` 会得到 `svc:DSH`（不折叠大写），后端会拒绝——这正是想要的行为，静默改写会指向另一个 Service |
| `serviceShortName(service)` | `"svc:dsh"` → `"dsh"` |
| `isRemoteTarget(target)` | `remoteHost` 非空且不是 `127.0.0.1`/`localhost` |
| `formatTarget(target)` | `127.0.0.1:4173` / `my-laptop.example-tailnet.ts.net:3081`；**不含目标路径**，由调用方按需追加 |
| `formatRouteLabel(servePort, path, service?)` | 新增可选第三参：`svc:dsh:443/`，即「`service:` + 非 443 端口 + 路径」。两个参数的老调用点行为逐字不变 |
| `mappingUrl(mapping)` | `baseUrl + path`；`baseUrl` 为 `null`/`''` 时返回 `null`（复制按钮据此禁用） |
| `formatScopedLabel(service, path)` | 只带 Service 没有端口时的标签，用于 `ApplyResult.blocked`（那里不含 `servePort`） |
| `joinUrl(serveHost, servePort, path)` | **保留**（契约要求服务那些只有 `serveHost` 的节点级调用点）。本次改动后界面里已无调用者：映射行改用 `baseUrl`，只读路由表把主机名单独成列 |

#### 组件改动

| 组件 | 改动 |
| --- | --- |
| `ContainerMappingForm`（在 `ContainerPanel.tsx` 内） | 新增「Tailscale Service（可选）」输入（`留空 = 节点级路由；填 dsh 或 svc:dsh`）；填了 Service 才出现「代理目标主机」（`留空 = 本机 127.0.0.1；Service host 可代理远端主机`），端口字段相应改名为「目标主机端口」，否则叫「本机端口」。`system.services` 非空时挂 `<datalist>` 快速选择（未承认的会标「（等待审批）」）。`canHostService === false` 时在 Service 字段下方给 `warn-inline` 提示并给出两条出路（换 tagged 设备 / 给本机打 tag 后重新登录）。预览行按 Service 拼 `https://<short>.<tailnet>`，`takeover-required` 的就地二次确认流程与「挂载路径会被剥掉」提示原样保留 |
| `MappingPanel` | 状态表补 `awaiting-approval`（文案「等待审批」、冷色 `status-approval`，**刻意不用红/黄**）；目标列改用 `formatTarget`；路由列加 Service 徽标（`节点级` 灰 / 短名蓝）；复制 URL 改为 `mappingUrl(mapping)`（`baseUrl` 为 null 时按钮自动禁用）；编辑行加 Service + 目标主机输入（非 Service 模式时目标主机禁用并给出「只在 Service 级支持」的原因），保存时显式下发 `service`（含 `null` = 切回节点级）以保证 PATCH 语义正确；本地校验「非 Service 模式填了远端主机」直接拦下 |
| `ServicePanel.tsx`（**新增**） | 逐个列出 `ServiceInfo`：MagicDNS 名（可复制 `https://` 地址）、对外端口、TailVIP，以及 `已承认` / `等待审批` 徽标；未承认时给出管理后台批准路径与 `autoApprovers.services` 两个选项。无 tag 时在顶部解释本节点不可能充当 Service host。既无 Service 又无 tag 时只渲染一行提示 |
| `ExternalRoutesPanel` | 新增 Service 列与「代理目标主机」列；接管改为发送 `{ service, servePort, path }`（**漏掉 service 会去接管另一条同名路由**）；`fromServiceConfig === true` 的行下方单独一行说明「目标路径不可恢复、接管后以空路径纳入管理、第一次 apply 会重写」——不藏在 tooltip 里 |
| `SecurityBanner` | 暴露条目改用 `formatRouteLabel(servePort, path, service)`，节点级渲染结果与之前逐字相同 |
| `Toolbar` | 新增 `counts` 入参；`awaiting-approval` 非零时在计划摘要里以冷色显示「· 等待审批 N 条」，hover 给出批准位置 |
| `App` | 新增 `ServicePanel` 挂载点；`Toolbar` 传 `counts`；只读 serve 路由表新增 Service / 主机名列并把 `serveHost` 列语义写明为「节点级」；`reportApply` 的 upserted/removed/exposures/blocked 全部带上 Service；`managedKeys` 的键由 `port|path` 升级为 `service|port|path` |
| `styles.css` | 新增 `.pill-calm` / `.status-approval` / `.badge-calm` / `.plan-calm` / `.detail-calm`（冷色，表达「不是错误」）、`.lossy-row`、`.edit-stack`、`.service-list` / `.service-card` / `.service-head` / `.service-grid` / `.service-vip` / `.service-help` |

#### 验证

| 检查 | 结果 |
| --- | --- |
| `npx tsc -p web/tsconfig.json --noEmit` | **0 错** |
| `npm run web:build` | 成功，40 modules → `web/dist`（css 12.10 kB / js 275.79 kB） |

**未验证 / 已知边界**：

1. 沙箱内无法打开浏览器，因此「界面真点一遍」仍需人工验收（`todo.md` 第 1 项）。本次只做到类型级 + 构建级验证。
2. `npm run lint` 会连带跑后端 `tsc -p tsconfig.json --noEmit`，该处当时在 `test/**` 上有并行改动中的失败，因此未作为本次验收项；前端 `web/tsconfig.json` 单独跑是干净的。
3. 表单里的 `<datalist>` 用 `useId()` 生成 id（形如 `«r1»`，含全角书名号）。HTML5 与 React 均合法，但如需兼容上古浏览器自测时注意。

### 2026-10-17 · 后端实现 Tailscale Service 级路由（路由身份 = Service + 端口 + 路径）

**起因**：需求方要的是 `dsh.<tailnet>.ts.net`，而不是 `<节点>.<tailnet>.ts.net/dsh`。此前（2026-10-15、2026-10-16 两节）的结论是「本机是用户账号身份，拿不到这种名字」，因此模型停在路径路由。本次把 Service 支持真正做进代码。

#### 先做的三个事实核查（决定了整份设计）

1. **`tailscale serve status --json` 里没有 Service**，本机 1.102.4 实测只有 `TCP` + `Web` 两段；Service 端点只在 `tailscale serve get-config --all`（`{"version":"0.0.1","services":{...}}`）里。上游 [tailscale#18289](https://github.com/tailscale/tailscale/issues/18289) 明说这两个命令返回的信息不同。
   → **这是一个与「只解析 443」同类的安全缺口**：只读 `status --json` 的闸门对 Service 路由完全瞎。所以读路径改成「两个源合并」。
2. **Service host 只能代理本机**的假设不成立。上游 `ipn/serve.go` 的 `ExpandProxyTargetValue` 注释写着 *"If it's for a service, remote addresses are allowed"*，并且对非 localhost 目标要求带 scheme、允许不带端口。官方文档亦写 host *"can advertise both local and remote resources"*。
   → 目标模型必须支持远端主机，否则 NAS 当 host、应用在笔记本上的用法根本表达不出来。
3. **Service 端点配置的读取是有损的**。上游 `runServeGetConfig` 只序列化根 handler（`Handlers["/"]`）与端点映射，且用 `net.SplitHostPort` 拆 Proxy —— **目标路径会丢**。
   → 所以 Service 路由的目标路径以**映射库为唯一权威**；读回来的值只用于状态判定，绝不用于重建配置。

#### 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/types.ts` | `Mapping.service`、`OwnedRoute.service`、`ServeRoute.service`、`RouteRef.service`；`MappingTarget.remoteHost?`/`scheme?`；新增 `ServiceInfo`；`MappingStatus` 新增 `awaiting-approval`；`MappingView.baseUrl`；`ServeSnapshot.services`；`TailnetInfo.magicDnsSuffix`/`tags`/`serviceHosts`；`ServeHandler['proxy']` 新增 `host`/`fromServiceConfig?` |
| `src/domain/route-path.ts` | 新增 `normalizeServiceName`（接受 `dsh`/`svc:dsh`，统一为 `svc:dsh`；**大写直接拒绝而不是折叠**——静默改写会指向另一个不存在的 Service）、`serviceShortName`、`buildServiceDnsName`/`suffixFromNodeDnsName`、`normalizeRemoteHost`（回环视为「未指定远端」）；`serveRouteKey(service, port, path)`（节点级用 `-` 占位）；`buildProxyUrl` 改为对象入参并保留旧的两参重载；`parseProxyUrl` 显式拒绝 `https+insecure://` |
| `src/tailscale/serve-config.ts` | 新增 `parseEndpointKey` / `parseServiceTarget` / `parseServiceConfig` / `mergeServeSnapshots` / `serviceInfoOf`；`parseServeStatus` 的路由补 `service: null` 与 `handler.host` |
| `src/tailscale/tailscale-cli.ts` | `serveUpsert`/`serveRemove` 加可选 `service`（`--service` 必须在 `--https` 之前）；新增 `serveGetConfig()`（`get-config --all`，空输出归一化为 `{}`）与 `serveClear()`（`serve clear svc:x`，该命令**不接受** `--yes`）；`explain()` 增加 tagged node 的可读中文解释 |
| `src/tailscale/tailscale-service.ts` | 新增 `parseServiceHostCap()`（`Self.CapMap["service-host"]`，兼容对象与数组两种序列化形态）；`snapshot()` 合并两个来源，`get-config` 失败**只降级不致命** |
| `src/mappings/reconcile.ts` | 全部匹配/去重/归属改用三元组键；`desiredProxyOf()`；`awaitingApprovalOf()`；暴露扫描加 `loopback` 条件；`blocked`/`exposures`/`upserts`/`removals` 全部带 `service` |
| `src/mappings/mapping-service.ts` | `MappingInput.service`/`remoteHost`/`scheme`；校验顺序新增 `invalid-service` / `invalid-remote-host` / `remote-host-requires-service` / `invalid-scheme`；远端目标不参与容器反查与孤儿检测；`importExternal` 支持 Service 端点（远端→`remoteHost`，目标路径按空串接管并在备注里写明）；`services()` / `canHostService()` |
| `src/mappings/store.ts` | `reviveMapping` 迁移 `service`（缺失=节点级）、`remoteHost`/`scheme`；`reviveOwnedRoutes` 的键改用 `serveRouteKey` |
| `src/snapshot.ts` | `SNAPSHOT_SCHEMA_VERSION` **1 → 2**；路由加 `service`/`host`/`targetHost`/`fromServiceConfig`；顶层加 `services`；`source` 加 `magicDnsSuffix`/`selfTags`；`summary` 加 `awaitingApproval`；暴露条目加 `service` |
| `src/app.ts` | 请求体加 `service`/`remoteHost`/`scheme`；`/api/system` 加 `magicDnsSuffix`/`selfTags`/`canHostService`/`services`，暴露判定加 `loopback` 条件；`/api/serve/routes` 加 `services`；import 请求体加 `service` |
| `scripts/verify-live.ts` | 抽出 `round()`，节点级与 Service 级共用「建→真实请求→删→比对」；新增 `--service` / `--remote-host`；前提不满足时**跳过**而不是失败 |
| `scripts/verify-security.ts` | 新增 E 段：Service 命名空间里的暴露必须被检测并摘除，且该 Service 上的既有端点不被牵连 |

#### 三个新决策（后续不应推翻）

1. **`advertised` 的缺省值不可信。** 解析层只在配置里**显式**写了 `advertised: true` 时才认；本节点是否真被承认为 host，唯一证据是 `status --json` 的 `Self.CapMap["service-host"]`。否则一条本地写坏或半成品的配置会让界面误报 `active`。
2. **暴露闸门只判 loopback 目标。** `remoteHost` 上的同名端口与本进程无关，把它判成 `blocked` 会让 NAS 上的正常服务无法映射。代价是一个**已登记的盲点**：Service host 反向代理到**本机**的管理端口时，配置里只有远端主机名，本工具无法判断那台主机就是本机——这一层只能靠 ACL 与「不要在 host 上写这种目标」保证。
3. **`awaiting-approval` 是独立状态，不是 `pending`。** 配置已经写对了、`inSync` 也为真，缺的是管理员批准广告；把它混进 `pending` 会让用户反复点「应用」却毫无变化。

#### 验证

| 检查 | 结果 |
| --- | --- |
| `npm run lint`（后端 + 前端两套 tsconfig） | 0 错 |
| `npm test` | **185/185**（自 136 增加 49：`test/service-config.test.ts` 20 个 + `test/service-routing.test.ts` 22 个 + 既有用例的 v2 契约更新） |
| `npm run web:build` | 成功（40 modules） |
| `node scripts/verify-live.ts --port 8080` | **9/9**（真实 HTTPS → HTTP 200 / 674 字节；7 条既有路由逐字保留） |
| `node scripts/verify-security.ts` | **14/14**（含非默认端口暴露的回归断言） |
| 真实进程 + 真 CLI 冒烟 | 临时实例 8799：`/api/system` 返回 `magicDnsSuffix`/`selfTags`/`canHostService`/`services`；快照落盘为 `schemaVersion=2`；`POST /api/mappings` 建节点级映射 → `status=active`；`PATCH` 改成 `service=svc:smoketest` + `remoteHost` → 映射库正确留存、`desiredProxy` 为远端地址、`baseUrl` 为 `https://smoketest.tail921448.ts.net`，写入失败原因回显为中文的「Service host 必须使用 tag 身份…」 |

**未验证（重要，不要当成已验证）**：Service 那一轮端到端（真实 `--service` 写入 + 经 `<svc>.<tailnet>.ts.net` 真实访问）**没有跑过**——本机 `Self.Tags` 为空，且撰写时 `tailscale status` 里没有任何已 tagged 的对端设备。目前 Service 链路的证据只有三条：单元测试（假网关，覆盖写维度、远端目标、审批状态、导入、闸门）、解析层对着上游实现与官方样例的同构输入、以及**真实 CLI 对未打 tag 节点给出的拒绝**（证明命令拼装与错误翻译确实走到了真 CLI）。补齐方式：在 NAS 上打 tag 并跑 `node scripts/verify-live.ts --service svc:<名字> --remote-host <本机 DNS 名>`。

**过程中修掉的实质问题**：

1. `LocalBackend`/`serve` 上游把 Service 端点目标写成 `tcp://host:port`，最初把它当成错误丢弃，导致一条**存在但看不见**的端点从界面上消失。改为归为 `other` 只读展示——与本工具对节点级非代理 handler 的既有处理保持一致。
2. `httpsPorts` 最初的判定用的是端点键协议（`tcp:443`），于是 `tcp:8080 → https://nas:8443` 这种「L4 监听 + HTTPS 目标」的端点不被计入安全扫描范围。改为按**目标**协议判定。
3. `buildSnapshot` 的 URL 曾用 `tailnet.dnsName` 兜底，导致「读不到快照主机名」时产出一个看似可用、实际不该点开的链接。改为只用快照自身的 `host`（Service 级则用 Service 的 MagicDNS 名）。
