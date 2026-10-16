# TsController · NAS 部署指南

> **本文档的验证状态**
>
> | 部分 | 状态 |
> | --- | --- |
> | 快照路径的配置逻辑 | ✅ 已在 Windows 本机实测（含 `TSCONTROLLER_SNAPSHOT_DIR` 覆盖生效） |
> | 容器只读挂载读取快照 | ✅ 已实测 |
> | `deploy/Dockerfile` 镜像构建 | ✅ 已实测：镜像成功构建；镜像内 `node -v` = **v22.23.3**（满足 ≥22.18 要求） |
> | 容器内运行整条链路 | ✅ 已实测（用一个模拟 tailscale CLI 的桩替身，见 §5.6）：容器内读到宿主 Docker 的 7 个容器、生成 3 条路由的快照、前端正常托管、管理 API 正常响应 |
> | 宿主的**真实** tailscale 二进制与 socket | ⚠️ **未验证**（本机是 Windows，没有 Linux 版的这两样东西） |
> | tailscaled socket 的读写权限 | ⚠️ **未验证**，见 §7 |
>
> 也就是说：**镜像本身和整条软件链路已经验证过**；剩下没验证的是「NAS 上那个具体路径/权限对不对」。
> 因此 §3 的探路仍然是必要的，但它现在是「确认环境」而不是「赌能不能跑」。

---

## 1. 目标

在 NAS 上把 TsController 跑起来，让 HomePage 的门户能展示「tailnet 上到底有哪些路由、分别指向哪个容器」。

**架构（保持不变）**：

```text
HomePage（容器，只读）  ──只读挂载快照文件──▶  TsController（唯一持有 serve 写能力）
   门户 UI、账号体系                             serve 管理、映射库、收敛
```

HomePage 不吸收 TsController 的代码，只消费它产出的 JSON —— 这样门户保持只读设计，写能力只有一个持有者。

---

## 2. 最重要的问题：快照路径怎么决定

### 2.1 优先级链

```text
TSCONTROLLER_SNAPSHOT_DIR          ← 最高：显式给出，按当前工作目录解析
  └─ 未设置 → <TSCONTROLLER_DATA_DIR>/public
       └─ DATA_DIR 也未设置 → <项目根>/data/public
            （项目根由源码位置 import.meta.url 推导，容器里 = /app）
```

空字符串与纯空白视为「未设置」。

### 2.2 容器里为什么**必须**显式设置

容器内不设 `TSCONTROLLER_DATA_DIR` 时，`<项目根>` 推导为 `/app`，于是：

- 数据目录 = `/app/data` —— 落在容器的**可写层**里
- 容器一旦重建（`docker compose up --build`、镜像升级），**映射库与审计日志全部丢失**

所以必须：**挂一个卷 + 把 `TSCONTROLLER_DATA_DIR` 指向卷内的路径。**

### 2.3 推荐的 NAS 目录布局

```text
/volume1/docker/tscontroller/          ← 仓库根（git clone 到这里）
├── deploy/
│   ├── Dockerfile
│   └── docker-compose.yml
├── .dockerignore
├── src/  web/  test/  ...
└── data/                              ← 挂进容器成为 /data
    ├── mappings.json                  ← 映射库（TsController 写）
    ├── audit.jsonl                    ← 审计日志
    └── public/                        ← 挂进容器成为 /data/public
        └── serve-routes.json          ← 快照（HomePage 只读）
```

对应的三个路径：

| 角色 | 路径 |
| --- | --- |
| NAS 宿主 | `/volume1/docker/tscontroller/data/public/serve-routes.json` |
| TsController 容器内 | `/data/public/serve-routes.json` |
| HomePage 容器内 | `/tscontroller/serve-routes.json` |

**要让 HomePage 只挂 `public/` 而不是整个 `data/`** —— 这样它拿不到 `mappings.json` 与 `audit.jsonl`。（换句话说：不要用 Docker named volume 把整个 `/data` 挂给 HomePage，要用宿主目录的 bind mount 才能精确到子目录。）

---

## 3. 第一步：探路（不改任何东西）

在 NAS 上逐条执行，把结果记下来。**这一节全是只读操作。**

```bash
# 3.1 Docker 与 compose 可用吗
docker version --format '{{.Server.Version}}'
docker compose version

# 3.2 Tailscale 装了吗、二进制在哪
which tailscale || ls -l /var/packages/Tailscale/target/bin/tailscale 2>/dev/null
tailscale version

# 3.3 LocalAPI socket 在哪、权限如何
ls -l /var/run/tailscale/tailscaled.sock

# 3.4 ★ 备份现有 serve 配置（后面的回滚全靠它）
mkdir -p ~/tsc-backup
tailscale serve status --json > ~/tsc-backup/serve-$(date +%Y%m%d-%H%M%S).json
cat ~/tsc-backup/serve-*.json

# 3.5 tailscale 二进制是静态还是动态链接（决定能不能挂进容器）
file "$(which tailscale)"
ldd "$(which tailscale)" 2>&1 | head -5

# 3.6 8787 端口是否已被占用（TsController 要用）
ss -ltnp 2>/dev/null | grep 8787 || echo "8787 空闲"

# 3.7 这台机器在 tailnet 里的名字
tailscale status --json | grep -m1 DNSName
```

**把 3.2 / 3.3 / 3.5 / 3.6 的结果记下来**，它们决定后面能不能按默认配置走。

---

## 4. 第二步：部署 TsController

> **镜像已经发布好了，不需要你自己构建。**
>
> ```bash
> uname -m                                            # 必须是 x86_64
> docker pull ghcr.io/xs-www/tscontroller:latest      # 包是公开的，无需登录
> ```
>
> 当前状态：标签 `latest` / `sha-6d99f07`，平台 `linux/amd64`，已实测能从容器内读到宿主 Docker 并生成快照。
> 重新发布或换版本见 [`image-publishing.md`](./image-publishing.md)。

```bash
cd /volume1/docker
git clone https://github.com/xs-www/TsController.git tscontroller
cd tscontroller
mkdir -p data/public
```

**用 ghcr 镜像的话**，`deploy/docker-compose.yml` 里这样改：

```yaml
services:
  tscontroller:
    # build:
    #   context: ..
    #   dockerfile: deploy/Dockerfile
    image: ghcr.io/xs-www/tscontroller:latest
```

之后 `up -d` 不用带 `--build`。想锁定版本就用 `:sha-6d99f07` 代替 `:latest`，避免 `latest` 漂移。

### 4.1 先按 §3 的结果调整 `deploy/docker-compose.yml`

打开 `deploy/docker-compose.yml`，重点看这三行：

```yaml
environment:
  TSCONTROLLER_DATA_DIR: /data                     # 必须，见 §2.2
  TSCONTROLLER_TAILSCALE_BIN: /usr/local/bin/tailscale
volumes:
  # 这一行的宿主侧路径必须换成 §3.2 查到的那一个：
  - /var/packages/Tailscale/target/bin/tailscale:/usr/local/bin/tailscale:ro
```

> ⚠️ **挂单个文件时如果宿主路径不存在，Docker 会创建一个同名目录**，容器里的 `tailscale` 就成了目录，调用必然失败。挂载前先 `ls -l` 确认。挂错了就 `rm -rf` 掉那个误建的目录再来。

### 4.2 启动

```bash
cd /volume1/docker/tscontroller
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f --tail=50
```

启动日志里应当出现（中文可能因终端编码显示为乱码，看 JSON 字段即可）：

```json
{"msg":"serve 路由快照已发布","detail":{"file":"/data/public/serve-routes.json","routes":N,"managed":M}}
```

横幅里会打印：

```
  管理界面： http://127.0.0.1:8787   （仅本机可访问）
  路由快照： /data/public/serve-routes.json
```

### 4.2.1 如果 tailscale 或 docker socket 还没配好

**不会崩。** 已经实测过这两种情况的降级路径：应用照常启动、管理界面照常可用，只在日志里给 warn：

```json
{"level":"warn","msg":"启动安全检查未能完成（Tailscale 不可用？）",
 "detail":{"error":"无法执行 /usr/local/bin/tailscale：spawn ... ENOENT"}}
{"level":"warn","msg":"serve 路由快照发布失败（其它项目的只读消费会受影响）"}
```

所以你可以**先让容器跑起来看到界面，再逐个解决 socket 与二进制路径**，不用一次配齐。

### 4.3 环境变量一览（NAS 上会改到的）

| 变量 | 建议值 | 说明 |
| --- | --- | --- |
| `TSCONTROLLER_DATA_DIR` | `/data` | **必设**，否则容器重建即丢库 |
| `TSCONTROLLER_SNAPSHOT_DIR` | （留空） | 留空即 `/data/public`；只有想放到别处才设 |
| `TSCONTROLLER_PORT` | `8787` | 管理界面端口 |
| `TSCONTROLLER_TAILSCALE_BIN` | `/usr/local/bin/tailscale` | 容器内路径，配合 §4.1 的挂载 |
| `TSCONTROLLER_DOCKER_PIPE` | `unix:///var/run/docker.sock` | |
| `TSCONTROLLER_SERVE_PORT` | `443` | 新建映射的默认对外端口 |
| `TSCONTROLLER_SNAPSHOT_INTERVAL_MS` | `60000` | 快照刷新间隔；`0` = 只在启动与收敛后写 |
| `TSCONTROLLER_AUTO_UNEXPOSE` | `true` | 自动摘除指向管理端口的路由 |

---

## 5. 第三步：验证 TsController

```bash
C="docker compose -f /volume1/docker/tscontroller/deploy/docker-compose.yml"

# 5.1 容器在跑吗
$C ps

# 5.2 容器能看到宿主 Docker 吗（这决定界面里有没有容器清单）
$C exec tscontroller node -e "
  const http=require('http');
  http.get({socketPath:'/var/run/docker.sock',path:'/containers/json?all=1'},r=>{
    let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log('HTTP',r.statusCode,'containers',JSON.parse(b).length));
  }).on('error',e=>console.log('ERR',e.message));
"

# 5.3 容器能读写 tailscaled 吗（这决定它有没有用）
$C exec tscontroller tailscale serve status

# 5.4 快照生成了吗
ls -l /volume1/docker/tscontroller/data/public/serve-routes.json
head -30 /volume1/docker/tscontroller/data/public/serve-routes.json

# 5.5 管理界面通吗（在 NAS 本机执行）
curl -s http://127.0.0.1:8787/api/system | head -c 300
```

**5.3 是最关键的一条。** 如果它报 `Access is denied` / `permission denied` / `dial unix ... connect: permission denied`，说明容器里的进程没有 LocalAPI 的访问权 —— 见 §7。

### 5.6 已在本机验证过的等价流程（供对照）

在没有 NAS 的情况下，用一个模拟 tailscale CLI 的桩替身在本机的 Linux 容器里跑通了整条链路。结果是：

```
{"msg":"Docker 容器清单已就绪","detail":{"count":7,"endpoint":"unix:/var/run/docker.sock"}}
{"msg":"serve 路由快照已发布","detail":{"file":"/data/public/serve-routes.json","routes":3,"managed":0}}
{"msg":"TsController 已启动","detail":{"admin":"http://127.0.0.1:8787","dataDir":"/data", ...}}
```

宿主挂载卷里读出的快照：

| path | targetHostPort | containerName | containerPort | containerSource |
| --- | --- | --- | --- | --- |
| `/` | 8080 | cs22-web | 80 | port |
| `/calendar` | 443 | sisi-calendar | 8000 | port |
| `/portal` | 8899 | homepage-portal | 8899 | port |

这证明：容器内能读到宿主 Docker、能调用（桩）tailscale CLI、能算出派生视图、能把快照写到挂载卷、前端与管理 API 都正常。**NAS 上没有验证过的只有「真实 tailscale 二进制能否执行」与「socket 权限」。**

---

## 6. 第四步：让 HomePage 读快照

### 6.1 改 HomePage 的 compose

在 HomePage 的 compose 里给 `homepage` 服务加一行只读挂载：

```yaml
services:
  homepage:
    volumes:
      # ……它原有的挂载保持不动……
      - /volume1/docker/tscontroller/data/public:/tscontroller:ro
```

### 6.2 验证

```bash
docker compose -f <HomePage 的 compose> up -d
docker compose -f <HomePage 的 compose> exec homepage \
  node -e "console.log(require('fs').readFileSync('/tscontroller/serve-routes.json','utf8').slice(0,400))"
```

能打印出 JSON 就说明链路通了。

### 6.3 ⚠️ 门户里的「路由板块」**还没写**

到目前为止，能做的只是**把文件读进容器**。HomePage 的代码里还没有消费它的模块。

也就是说 NAS 侧可以先把这个挂载配好、验证可读，但要看到门户上真的出现路由列表，还需要在 HomePage 项目里加一个只读数据源（按它的 `modules/*/provider.ts` 模式）与一个页面。**那部分代码尚未实现。**

---

## 7. 写能力的前置条件（想做「在门户里改路由」时才需要）

`tailscale serve status`（读）与 `tailscale serve --set-path ...`（写）都要经过 tailscaled 的 LocalAPI。读通常够用，写需要额外权限。

Linux 上 `/var/run/tailscale/tailscaled.sock` 一般归 root 所有。三种解法：

| 解法 | 做法 | 代价 |
| --- | --- | --- |
| operator | 宿主上执行 `sudo tailscale set --operator=<容器运行用户>` | 需要知道容器内的 uid |
| 容器以 root 跑 | compose 里加 `user: "0:0"` | 破坏 TsController 的最小权限姿态 |
| socket 组权限 | 把容器用户加进 `tailscale` 组 | 依发行版而定，群晖上不一定有该组 |

**先在 NAS 上跑 §5.3 确认读通不通，再决定要不要为写能力付代价。** 如果只是想让门户**展示**路由，读就够了，这一节可以完全跳过。

---

## 8. 回滚

```bash
# 8.1 停掉 TsController
docker compose -f /volume1/docker/tscontroller/deploy/docker-compose.yml down

# 8.2 如果 serve 配置被改乱了，用 §3.4 的备份恢复
cat ~/tsc-backup/serve-<时间戳>.json
# 用 Tailscale 管理后台或逐条 tailscale serve 命令还原；
# 也可以直接把备份内容喂给 `tailscale serve set-config`（注意参数顺序：文件在 --all 之后）
tailscale serve set-config --all ~/tsc-backup/serve-<时间戳>.json
```

> **重要**：TsController 的设计原则是「只删自己写过的路径」。它在 NAS 上第一次启动时，你原先手工配的路由会显示为「未托管」，**不会被自动删除**。所以只要不主动「接管」，回滚成本很低。

---

## 9. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 容器起来就退出，日志说 `只允许监听本机回环地址` | 用了 `-p` 端口映射而不是 `network_mode: host` | 见 `deploy/docker-compose.yml` 里的注释；必须 host 网络 |
| 日志 `无法读取 Docker 容器清单` | `docker.sock` 没挂或路径不对 | 检查 compose 的 volumes |
| `tailscale serve status` 在容器里报 permission denied | socket 权限不足 | 见 §7 |
| 容器里 `tailscale: not found` 或 `Is a directory` | 宿主 tailscale 路径写错，Docker 误建了同名目录 | `ls -l` 确认；`rm -rf` 误建目录后改对路径重来 |
| `tailscale: cannot execute binary file` | 宿主二进制与镜像 libc 不兼容 | 镜像已用 Debian（glibc）；若仍失败，改用官方静态二进制装进镜像 |
| 快照文件不生成 | 数据卷没挂 / 无写权限 | `docker compose exec tscontroller ls -ld /data` |
| 快照 `generatedAt` 一直不变 | 定时器被 `TSCONTROLLER_SNAPSHOT_INTERVAL_MS=0` 关了 | 设回 `60000`；0 时只在启动与收敛后写 |
| 容器重建后映射库没了 | 没设 `TSCONTROLLER_DATA_DIR` | 见 §2.2 |
| 8787 被占用 | NAS 上已有服务用这个端口 | 改 `TSCONTROLLER_PORT` 并同步改 compose 的注释 |

---

## 10. 与 Windows 本机的关系

这台笔记本上**不需要**改成容器。原因：Windows 的 tailscaled LocalAPI 只走命名管道，Docker Desktop 的 Linux 容器跨不过 WSL2 边界，容器化的 TsController 做不了任何 tailscale 操作。

所以最终形态是**两个独立实例**：

| | Windows 笔记本 | NAS |
| --- | --- | --- |
| TsController | 原生运行（计划任务开机自启） | 容器 |
| 管理的对象 | 笔记本的 serve 配置 + 笔记本的容器 | NAS 的 serve 配置 + NAS 的容器 |
| HomePage | 容器（读笔记本上的快照） | 容器（读 NAS 上的快照） |

**它们互不管理对方的机器。** 快照文件里 `source.hostname` 会标明数据来自哪台机器 —— 消费方应当据此区分，别把两台机器的路由混在一起显示。

---

## 11. 这份文档里没做的事

诚实列出，避免误以为已经完成：

- [x] ~~`deploy/Dockerfile` 未构建验证~~ → **已在本机 Linux 容器构建并运行验证**（镜像内 Node v22.23.3）
- [x] ~~容器内整条链路未验证~~ → **已用 tailscale 桩替身跑通**（见 §5.6）
- [ ] 宿主的**真实** tailscale 二进制能否在镜像里执行（本机是 Windows，没有 Linux 版可测）。镜像已选 Debian(glibc) 而非 Alpine(musl) 来最大化兼容性
- [ ] `tailscaled.sock` 的**读/写**权限（见 §7）
- [ ] `deploy/docker-compose.yml` 里的宿主路径（tailscale 二进制）需按 §3.2 的实际结果替换
- [ ] HomePage 侧消费快照的代码**尚未实现**（目前只能验证文件可读）
- [ ] TsController 的管理 API **没有鉴权**。实测确认同机容器可伪造 `Host` 头读写它（见主 `README.md` §5.1）。读路由请用快照文件，不要用 `/api/*` 做集成
- [ ] 「在门户里改路由」需要：写权限 + 令牌鉴权 + HomePage 代理写请求。均未实现
