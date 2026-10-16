# TODO

> 当前优先级：**在真实浏览器里验收界面**，其次是「常驻化」与「自动收敛」，再次是**在一台真实 tagged 设备上验收 Service 级路由**。
>
> 状态快照（2026-10-17）：控制面 + 管理界面 + Service 级路由均已完成 ——
> `npm run lint` 0 错（后端 + 前端两套 tsconfig）、`npm test` **185/185 通过**、
> `npm run web:build` 产出 `web/dist` 且后端可正确托管、
> `scripts/verify-live.ts` **9/9 通过**（真实 HTTPS 打穿到容器，HTTP 200 / 674 字节）、
> `scripts/verify-security.ts` **14/14 通过**（含非默认端口上的暴露拦截）、
> serve 路由快照已落地（schema **v2**）并验证容器可只读读取。
>
> ⚠️ **已知未修缺陷**：同机 Docker 容器可伪造 `Host` 头完整读写管理 API（见第 7 项，实测证据在 `README.md` §5.1）。
> 因此**不要**把 `/api/*` 用于项目间集成，读路由请用快照文件。
>
> ⚠️ **Service 级路由尚未在真实 tagged 设备上跑过**：本机 `Self.Tags` 为空、tailnet 里也没有已 tagged 的对端，
> 因此那条链路的证据只有单测 + 解析层同构输入 + 真实 CLI 对未打 tag 节点的拒绝。补齐方式见第 9 项。
>
> **路由身份 = Service + 端口 + 路径**（Service 位为 `null` 即节点级）。同一个 `/` 可以同时挂在 443 与 8443
> 上互不干扰，也可以同时挂在节点级与某个 Service 上；需要根路径的应用（根绝对路径静态资源）应当给它
> 一个独立端口，而不是挂在路径前缀下（`README.md` §9.2）。
> Service 级路由的后端与前端支持均已于 2026-10-17 完成，配置步骤见 `README.md` §12 与下方第 9 项。

---

## 未完成（按建议顺序）

### 1. 管理界面的真实使用验收

- [x] Vite + React SPA（容器面板 / 映射面板 / 未托管路由 / 安全横幅 / serve 路由只读面板 / 审计面板）。
  - `npx tsc -p web/tsconfig.json --noEmit` 0 错；`npm run web:build` 产出 `web/dist`；后端已验证能正确托管 SPA、静态资源与深层路由回落。
- [ ] **在浏览器里真点一遍**：建映射 → 复制 URL → 用手机/另一台 tailnet 设备打开 → 改名 → 禁用 → 删除。
  - 位置：`web/`。
  - 说明：沙箱内无法打开浏览器。已用 jsdom + 真实 React 19 事件系统 + mock 后端跑过 70 项交互断言，但那不等同于真实浏览器。
  - 验收：一条真实容器映射能通过界面完整走完生命周期，且每一步 serve 配置都符合预期。

### 2. 常驻化：开机自启

- [ ] **注册为 Windows 服务或计划任务**，当前只能前台 `npm start`。
  - 位置：缺 `scripts/install-service.ps1`。
  - 注意：`tailscale serve` 需要与已登录用户相同的会话；用 `LocalSystem` 跑服务可能拿不到 tailscaled 的管道权限。计划任务（用户登录时触发）比 Windows 服务更稳妥，需要实测确认。
  - 验收：重启电脑后无需手工启动，`http://127.0.0.1:8787` 直接可用。

### 2.5 镜像发布（ghcr.io）

- [x] `deploy/Dockerfile` + `deploy/docker-compose.yml` + `.dockerignore`；镜像已在本机 Linux 容器构建并跑通（含容器内读宿主 Docker、生成快照、写挂载卷）。
- [x] `.github/workflows/docker-publish.yml`：tag 推送或手动触发；先跑 `lint` + `test` 再构建；显式把镜像名转小写（ghcr 要求全小写）。
- [x] `docs/image-publishing.md`：手动推送与 Actions 两条路径、PAT 权限、架构确认、NAS 侧拉取与排查。
- [x] 首次推送到 <https://github.com/xs-www/TsController>（`main` = `d0e29cd`，59 文件）。
- [x] **工作流已真实跑通（2026-10-17）**：`git tag v0.2.0 && git push origin v0.2.0` 触发
  <https://github.com/xs-www/TsController/actions/runs/38980923115> —— `verify`（lint + test）与
  `build-and-push` 两个 job **全部成功**，镜像已推送到 GHCR。
  - 产物标签：`ghcr.io/xs-www/tscontroller:0.2.0` / `:0.2` / `:latest` / `:sha-9b21c36`，平台 `linux/amd64`。
  - **包默认私有**：NAS 上拉取前需 `docker login ghcr.io`（用户名 + PAT，`read:packages` 即可）；
    想公开去 Package 设置里改可见性。
  - 上游前提：`v0.2.0` 之前的镜像来自一次手动 dispatch（2026-10-16，同样成功）。
- [ ] NAS 架构确认：`uname -m`。绿联 DX4600 Pro 及其同代机型应为 x86_64，但**以实际输出为准**——架构错了镜像拉下来会 `exec format error`。

### 2.6 公开仓库里的个人信息（待你决定收尾）

- [x] 已把文档示例与测试夹具里的真实 tailnet 名称、IP、主机名全部替换为占位值（`my-laptop.example-tailnet.ts.net` / `100.101.102.103`），并**改写提交后强推**（`415c65e` → `d0e29cd`），当前 `main` 内容已确认干净。
- [ ] **旧提交 `415c65e` 仍可按 SHA 访问**：<https://github.com/xs-www/TsController/commit/415c65ecf1d06e2fd27e73fac41a948a2f40a2af>。强推只让它从分支不可达，GitHub 不会立即回收未引用的对象。
  - 风险定级**低**：泄漏物是 tailnet 名称（公网 NXDOMAIN，经 Cloudflare DoH 核实）与 CGNAT 段 IP（`100.64.0.0/10`，公网不可达），**不含任何凭据**。要进 tailnet 靠成员身份与 ACL，知道名字无用。
  - 若要**彻底**清除，唯一可靠做法是**删库重建**（仓库刚建、零 fork、零 star，代价为零，URL 不变）：Settings → Danger Zone → Delete this repository → 用同名重建 → `git push -u origin main` 重新推。
  - 或者接受现状。两种都合理，取决于你对「tailnet 名称公开」的容忍度。

### 3. 自动收敛循环

- [ ] **周期性 reconcile**：容器重建后端口变化、或用户手工改坏了 serve 配置，目前只能靠手动「重新同步」。
  - 位置：`src/mappings/mapping-service.ts`（新增 `startReconcileLoop(intervalMs)`），`src/main.ts` 挂载。
  - 设计约束：默认关闭或长间隔（≥60s），且**只补写期望状态、不主动删除**，避免与用户手工调试 `tailscale serve` 冲突。
  - 验收：手工 `tailscale serve --set-path=/x off` 删掉一条已激活映射后，≤ 一个周期内自动恢复，并留下审计记录。

### 4. 裸 TCP 转发

- [ ] 支持 `tailscale serve --tcp=<port>` 形式的端口转发（数据库、SSH 之类），当前只做 HTTP 路径路由。
  - 位置：`src/tailscale/tailscale-cli.ts`（新增 `serveTcpUpsert` / `serveTcpRemove`），`src/domain/types.ts`（`Mapping` 增加 `mode: 'http' | 'tcp'`）。
  - 影响面：`parseServeStatus` 需要额外解析 `TCPForward` / `AllowFunnel`；冲突检测从「同路径」变为「同端口」；`planReconcile` 的 `upserts`/`removals` 需要区分两种模式。
  - 验收：能建立 `100.x.y.z:5432 → 容器 5432` 的映射，且与 HTTP 映射互不干扰。

### 5. 未发布端口的容器

- [ ] 目前只能映射**已发布到宿主机**的端口。容器内网端口（`docker network` 内可达但未 `-p`）无法映射。
  - 位置：`src/docker/docker-service.ts`（需要额外调 `/containers/{id}/json` 拿 `NetworkSettings.Networks[*].IPAddress`），`src/mappings/mapping-service.ts`。
  - 说明：当前设计依赖「serve 代理到 `http://127.0.0.1:<port>`」，若改用容器 IP，则需要确认 Windows 上 Docker 网络从宿主机可达（Docker Desktop 的 WSL2 后端通常可达，Linux 上 `172.17.0.0/16` 也可达）。
  - 验收：能对未发布端口的容器建立映射；界面上明确区分「宿主机端口」与「容器网络地址」两类目标。

### 6. 放弃接管

- [ ] 导入（接管）之后的映射无法「还原为未托管」—— 删除它会连带摘除 serve 路由，用户只能重新手工敲一遍 `tailscale serve --set-path`。
  - 位置：`src/mappings/mapping-service.ts`（新增 `release(id)`：清空 `ownedPaths` 后从映射库移除，不写 serve）。
  - 验收：接管 `/worldforge` 后点「放弃接管」，映射记录消失但 serve 路由原样保留。

### 7. 管理面鉴权 —— 写接口令牌（已实测确认存在真实暴露，优先级**高**）

- [ ] **同机 Docker 容器可以完整读写管理 API。** 实测（证据链见 `README.md` §5.1 与静态文档对应条目）：伪造 `Host: 127.0.0.1:8787` 后，容器能读到 `/api/system` 全部内容，并且 POST 请求会**通过鉴权到达处理函数**（返回的是业务规则错误 `409 exposes-admin`，而不是 403）。
  - 三条根因，缺一不可：Docker Desktop 把 `host.docker.internal` 代理到宿主 loopback（**绑回环 ≠ 隔离容器**）；`Host` 头客户端完全可控；三种来源（本机直连 / 容器自然请求 / 容器伪造 Host）的 TCP 对端地址**都被改写成 `127.0.0.1`**，无法靠 IP 区分。
  - 修法：唯一可靠的判别是「容器拿不到的东西」——随机令牌落在 `<DATA_DIR>/api-token`，所有非 GET 请求要求 `Authorization: Bearer <token>`。容器读不到宿主文件系统，因此这条边界有效。
  - 顺带要改：`README.md` §5/§5.1 的措辞已更正，但「四层防护」的表述应在令牌落地后重新组织为「对网络对端有效 + 对同机容器由令牌兜底」。
  - 界面影响：UI 需能带上令牌（存 localStorage，或首次访问时输入一次）。
  - 验收：从容器伪造 Host 发 POST → 401；从本机浏览器发 POST → 正常。
  - 备注：本机多用户场景（同一台电脑的另一个 Windows 账号）同样适用这个令牌。
- [ ] **可选加固**：管理面额外绑一个 Unix domain socket / Windows 命名管道。容器无法挂载宿主命名管道，这是比令牌更强的隔离；代价是浏览器访问不了 UDS，因此它只能作为程序化写操作的通道，不能替代 TCP 监听。

### 7.6 与其它项目的集成（读路由）

- [x] **serve 路由快照文件**（已完成，2026-10-16）：`<DATA_DIR>/public/serve-routes.json`，启动时 + 每次收敛后 + 每 60s 刷新；容器只读挂载该目录即可读取；定期刷新**只读不写**、绝不动 serve 配置。
  - 选文件而非 HTTP 的理由：不需要端口、不需要令牌、不依赖「TsController 此刻在跑」、Windows/Linux 行为一致。
  - 已实测：容器 `-v "...\data\public:/tscontroller:ro"` 能正常读出；写穿透与定期刷新均已验证。
- [ ] **常驻化是这条集成路径的前提**：TsController 没在跑时快照会陈旧（文件仍在，但 `generatedAt` 会显旧）。见第 2 项。
- [ ] **只读 HTTP 接口（暂不做）**：仅当确实需要实时查询时再加。若加，只暴露 `GET /api/readonly/serve-routes` 一个端点，且**不要**把 `/api/system`、`/api/containers` 一起放开——它们包含数据目录路径、Docker 端点与全部容器端口。

### 8. 前端测试与体验补强

- [x] ~~内联表单要把「前缀会被剥掉」讲清楚~~ —— **已在多端口改动中一并完成**（2026-10-16）。
  - 起因：首次真实使用即踩到（见静态文档对应条目）。
  - 结果：`ContainerMappingForm` 的提示下方补了一行说明 + 一个具体例子（路径 `/api/addSchedule` + 目标路径 `/api/agent/events` ⟹ 请求 `/api/addSchedule` 到达后端 `/api/agent/events`）。原先评估「不值得为一句提示引入前端改动 + 重新构建」，本次因为多端口改动已经落到同一个文件，顺带完成。
- [ ] 前端没有自动化测试。至少补一个 Playwright 冒烟：打开页面 → 断言容器列表非空 → 建一条映射 → 删除。
- [ ] 路径冲突时给出改名建议（例如 `/cs22-web-api` 已被占用时推荐 `/cs22-web-api-2`）。
- [ ] 容器端口为 `0.0.0.0` 时，除了黄色徽标，再提供一键提示「如何改成只绑定 127.0.0.1」（`docker run -p 127.0.0.1:8080:80`）。

### 9. 独立主机名路由（`dsh.xxx.ts.net`）与 Tailscale Services

**背景（已实测，证据见 `README.md` §12）**：`<任意名字>.<tailnet>.ts.net` 只能由 Tailscale Services 提供，而 Services 要求宿主机使用 **tag 身份**。本机是用户账号拥有的设备，因此：

- `tailscale cert dsh.example-tailnet.ts.net` → `invalid domain ...; must be one of ["my-laptop.example-tailnet.ts.net"]`
- `tailscale serve --service=svc:...` → `service hosts must be tagged nodes`

- [x] **方案 B 的代码支持已完成（后端 + 前端，2026-10-17）** —— 原先列的四条改动全部落地，另外补了三处原先没预见到的：
  1. `MappingTarget.remoteHost?` + `scheme?`；`buildProxyUrl` 改为对象入参；**约束**：远端目标只允许挂在 Service 级路由上（`remote-host-requires-service`）。
  2. `ServeGateway` / `TailscaleCli` 增加 service 维度读写（`--service=svc:<name>` **必须在 `--https` 之前**）；新增 `serveGetConfig()` 与 `serveClear()`。
  3. **读 Service 配置不能只改 `parseServeStatus`**：`serve status --json` 里根本没有 Service（上游 [tailscale#18289](https://github.com/tailscale/tailscale/issues/18289)），必须新增 `parseServiceConfig()` 解析 `serve get-config --all`，再由 `mergeServeSnapshots()` 合并——这也是本项最初低估的地方。**只读 `status --json` 会让安全闸门对 Service 路由完全瞎**，与「只解析 443」是同一类缺口。
  4. 安全闸门覆盖两个命名空间；**只判 loopback 目标**（远端同名端口与本进程无关），见下方已知盲点。
  5. 新增状态 `awaiting-approval`（配置已写对、只差管理员批准广告；`inSync` 为真，不产生写入）。
  6. `advertised` 的缺省值不可信：唯一证据是 `status --json` 的 `Self.CapMap["service-host"]`。
  7. **`get-config` 的读取是有损的**：只有根 handler、**目标路径会丢**。因此 Service 路由的目标路径以映射库为唯一权威，接管时按空路径纳入并在备注里写明。
- [x] **前端已跟进 Service 级路由**（2026-10-17，仅 `web/**`）：`api.ts` 契约逐字对齐（`MappingStatus` 加 `awaiting-approval`、`RouteRef`/`Exposure`/`ServeRouteView` 加 `service`、`MappingView` 加 `baseUrl`、新增 `ServiceInfo`）；`utils.ts` 加 `normalizeServiceInput` / `serviceShortName` / `isRemoteTarget` / `formatTarget` / `mappingUrl`，`formatRouteLabel` 加可选 `service` 参数；新建 `ServicePanel`（MagicDNS 名 / 端口 / TailVIP 徽标 + 批准指引）；创建表单与编辑行支持 Service + 远端目标主机；未托管路由面板加 Service 列与「Service 配置读出的目标路径不可恢复」说明，接管改为发送 `{service, servePort, path}`；安全横幅与计划摘要带上 Service 与 `awaiting-approval` 计数。
  - 验证：`npx tsc -p web/tsconfig.json --noEmit` 0 错；`npm run web:build` 成功。
  - `awaiting-approval` 的界面语义：**不是错误**，是「serve 配置已写对、只差管理员批准广告」，因此用冷色而不是红/黄 —— 后续改动不要把它改回警示色。
- [ ] **验收（唯一剩下的活）**：在真实 tagged 设备上端到端跑一遍。
  - 位置：NAS（或任何已打 tag 的常开设备）。
  - 步骤：① admin console 定义 Service（名字 `dsh`、endpoint `tcp:443`）；② 在 NAS 上 `tailscale serve --service=svc:dsh --https=443 http://<本机 DNS 名>:3081`；③ 批准广告（或配 `autoApprovers.services`）；④ 在 NAS 上跑 TsController 并执行 `node scripts/verify-live.ts --service svc:dsh --remote-host <本机 DNS 名>` 与 `node scripts/verify-security.ts --service svc:dsh`。
  - 验收：`https://<svc>.<tailnet>.ts.net` 直达容器；`awaiting-approval` 在批准后自动转 `active`；Service 上的暴露被 E 段检测并摘除；原有 7 条节点级路由不受影响。
  - 已实测的前置拒绝（证明命令拼装与错误翻译确实走到了真 CLI）：在本机（无 tag）执行 Service 写入 → tailscale 报 `service hosts must be tagged nodes`，TsController 译为中文可读提示。
- [ ] **已知盲点（已登记，未修）**：Service host 反向代理到**本机**的管理端口时，配置里只有远端主机名（`http://my-laptop.<tailnet>.ts.net:8787`），本工具无法判断那台主机就是本机，因此暴露闸门只判 loopback 目标。
  - 影响面：需要有人在 service host 上主动写下这种目标才会发生；这是「配置者自己把管理面绕出去」，不是本工具的默认行为。
  - 可选加固：新增一个「本机自识别主机名」集合（tailnet DNS 名 + 100.x + IPv6），把远端目标里命中该集合的也纳入扫描。触发条件：真的出现这种配置，或安全要求提高。
- [ ] **方案 C（改本机身份）：把本机打成 tagged node。**
  - 代价已在 `README.md` §12.1 列全：Taildrop 失效、不能 SSH 到用户身份的机器、不能被分享、ACL 语义改变、tag 不可全部移除、key expiry 默认关闭，且官方明确劝退笔记本类设备。
  - 另需在 admin console 定义 Service + 管理员审批（或配 `autoApprovers.services`）+ 给客户端配 `grants`；Service 用独立 TailVIP 且目前仅支持 TCP。
  - 结论：**暂不采纳**，除非将来这台机器专职当服务器。
- [ ] **解析层迁移风险**：`parseServeStatus` 依赖 `serve status --json` 的 legacy raw 格式；`parseServiceConfig` 依赖 `get-config --all` 的 `{version, services}` 格式。Tailscale 1.102 已引入 services 格式，未来若这两者再变，解析层需要同步。
  - 位置：`src/tailscale/serve-config.ts`。
  - 缓解：写入路径用的是稳定的 `--set-path` / `--service` CLI，即使解析层失效，已生效的路由也不会被误删（删除依赖解析结果，解析失败时 `planReconcile` 只会认为「位置不存在」而跳过删除）。另外 `get-config` 失败**只降级不致命**（记警告），否则一次读不到 Service 会连带让节点级路由都看不见。

---

## 本会话已完成（供对照）

### 环境可行性探测（决定了整个架构）

- [x] 确认 `tailscale serve status --json` 可读、`serve --set-path` 可写（无需管理员），并实测 `--set-path=/x off` 精确摘除单条而不影响其它 7 条既有路由。
- [x] 确认 Node 22 可直接经 `//./pipe/dockerDesktopLinuxEngine` 走 Docker Engine API（旧写法 `\\.\pipe\...` 同样可解析）。
- [x] 确认 Node 22.23 原生 TypeScript 类型擦除可用 → **后端无构建步骤**。
- [x] 探测本机现状：tailnet `my-laptop.example-tailnet.ts.net`，5 个运行中容器，serve 已有 7 条手工路由。

### 架构决定

- [x] 在「控制面 / 数据面 / 混合」三方案中选定**控制面**：TsController 不在数据链路上，HTTPS 由 tailscale 提供，本进程挂掉不影响既有路由。
- [x] 读用 `serve status --json`、写用 `serve --set-path` CLI，**放弃 `set-config`**（实测会静默忽略节点级字段）。
- [x] 路由键定为**路径前缀**（节点级）；独立主机名 `dsh.xxx.ts.net` 当时因设备身份取不到 —— **2026-10-17 已改为支持 Service 级路由**（路由身份升级为 `(service, 端口, 路径)`），见第 9 项与 `README.md` §12。

### 管理界面（前端）

- [x] Vite 6 + React 19 + TS SPA，零 UI 框架依赖；`web/src/api.ts` 把后端契约逐字类型化，后端改名会立刻编译失败。
- [x] 五个数据切片（system / containers / mappings / serve / audit）+ 顶部信息条 + 安全横幅 + 容器面板 + 映射面板 + 未托管路由面板 + 只读 serve 路由 + 审计面板。
- [x] 交互细节：端口映射内联表单、`409 takeover-required` 就地二次确认、编辑、删除二次确认、启用开关、错误码中文提示、复制 URL、toast（error 常驻）。
- [x] 防御性加固：写操作响应形状不符时不再因 `result.data.mapping` 抛 TypeError 白屏。
- [x] 前端并发控制：请求序号丢弃过期响应（防竞态）+ `AbortController` 仅用于卸载取消（兼容 React 19 StrictMode 双挂载）。

### 安全需求「本应用禁止暴露在 tailnet 中」

- [x] 四层防护：监听地址只允许回环（无绕过开关）→ Host 头白名单（防 DNS rebinding）→ 启动闸门与每次 apply 全量扫描并摘除指向管理端口的路由 → API 层拒绝建立该类映射。
- [x] 全部写入 `audit.jsonl`，并可通过 `GET /api/audit` 查看。
- [x] 真实环境验证 10/10 通过，含「不误伤指向其它端口的路由」与「原有 serve 配置原样保留」。

### 后端实现与测试

- [x] Docker Engine 客户端（惰性端点探测 + 失败重探测）、容器端口归一化（保留 IPv4/IPv6 双记录用于暴露面判断）。
- [x] serve 配置解析、CLI 封装、错误信息中文化。
- [x] 映射库（原子写 + 反序列化严格校验）、审计日志、`reviveMapping` 脏数据丢弃。
- [x] 纯函数差异计算 `planReconcile`，含 `ownedPaths` 记账与「永不删除未托管路由」。
- [x] `MappingService`：声明式收敛、失败不回滚、串行化队列（并修掉 `setEnabled` 的队列死锁）。
- [x] Fastify 管理 API 与静态资源托管。
- [x] 70 个单元/接口测试全绿（多端口改动后增至 **96** 个，快照改动后 **119**，Service 级路由改动后 **185** 个）。

### 多端口支持（修复安全缺口）

- [x] **`parseServeStatus` 遍历全部 `Web` 组**：原先只取与默认端口一致的那一组，导致挂在非 443 端口上的路由对 TsController 完全不可见——**安全闸门也扫不到**，`README.md` §5 承诺的「任何指向管理端口的 handler 一律摘除」对非 443 端口当时并不成立。
- [x] 路由身份升级为 `(servePort, path)`：`Mapping.servePort`、`ownedPaths` → `ownedRoutes`、reconcile 的全部匹配/去重/归属改用 `serveRouteKey`。
- [x] CLI 显式带 `--https=<port>`；`ServeGateway` 签名加端口；旧格式 `ownedPaths` 自动迁移。
- [x] 新错误码 `serve-port-is-admin`（对外端口与管理端口同号）；`ApplyResult.upserted`/`removed` 改为 `RouteRef[]`。
- [x] 前端：创建表单与编辑行加「对外端口」字段，表格加端口列，`joinUrl` 带上非 443 端口。
- [x] 真实验证：`verify-live` 在 443 与 8443 各 9/9；`verify-security` 14/14，含「8443 上的暴露被检测并摘除且不牵连既有路由」。

### 事故与防复发

- [x] **误删真实映射库**：清理验证残留时执行 `Remove-Item -Recurse -Force data`，把与 `data/verify*` 同级的真实映射库 `data/mappings.json`（及审计日志）一并删除。
  - 未造成故障：serve 配置未动，且「只删自己写过的路径」策略保证映射库丢失后**只会不再认领、不会删除**路由。
  - 已按会话中读到的原文 + 审计日志逐条重建 7 条映射，重建后 `inSync: true`、`upserts/removals = 0`，证明无损。
  - 防复发：新增 `scripts/clean-verify.ts`（`npm run clean:verify`），**只删白名单验证子目录**，双重断言（必须在 `data/` 下 + 目录名前缀必须是 `verify`/`smoke`），并在结束时报告真实映射库是否仍在；`README.md` §3 增加显式警告。
  - 教训：临时数据与真实数据同级时，清理必须按已知白名单子目录逐个删，绝不递归删父目录。

---

## 已探明、决定不做（避免重复调研）

以下三项都已调研到底并做出结论，**不要再当成待办重新推进**；若触发条件变了再回来。

### A. 容器化部署（Docker）

**结论修正（2026-10-16）**：原先写的是「不建议、不提供 Dockerfile」。但**最终目标是 NAS 部署**，前提变了，所以已提供 `deploy/Dockerfile` + `deploy/docker-compose.yml` + `docs/nas-deployment.md`。

- Windows 宿主上仍然**不可行**（tailscaled LocalAPI 只走命名管道，容器跨不过 WSL2）—— 这一条不变。
- Linux 宿主上**可行**，且镜像与整条软件链路已在本机 Linux 容器里用桩替身验证通过（容器内读到宿主 Docker、生成快照、写进挂载卷、前端正常）。
- **仍未验证**：宿主真实 tailscale 二进制能否在镜像内执行、`tailscaled.sock` 的读/写权限。到 NAS 上按 `docs/nas-deployment.md` §3 探路后确认。
- 当初的三条反对理由仍然成立，只是被「最终要上 NAS」这个前提压过去了：挂 `docker.sock` ≈ 容器获得宿主 root 等价权限；零功能收益；把「只监听回环」这条硬约束退化为「依赖部署者记得写 `network_mode: host`」。**最后一条已在 compose 与文档里显式标注。**

完整证据链见 `README.md` §13 与 `docs/nas-deployment.md`。

### B. 独立主机名路由 `dsh.xxx.ts.net`

**已实现（2026-10-17），不再是「决定不做」项**：代码支持（后端 + 前端）已完整落地，只剩真实 tagged 设备上的端到端验收——见上方第 9 项。当时列出的四条改动全部完成，并额外发现了三处原先没预见到的（`status --json` 里没有 Service、`get-config` 读取有损、`advertised` 缺省值不可信），也记在第 9 项。

### C. 界面内联提示加强前缀剥离说明

已决策不做，理由见第 8 项。**触发条件**：第二次有人踩「目标路径 ≠ 挂载路径」这个坑。
