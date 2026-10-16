# `deploy/docker-compose.yml`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

NAS/Linux 上部署 TsController 的 compose 定义：单个 `tscontroller` 服务，**必须使用 host 网络**、挂载数据目录与宿主 Docker/Tailscale 的 socket、并通过环境变量注入全部运行配置。

> 源码文件头明确写着：**未在真实 NAS 上验证过**；上线前需按文件内 `<<< 需要确认` 处核对宿主路径。

## 结构说明

### 服务定义

| 键 | 值 | 说明 |
| --- | --- | --- |
| `services.tscontroller.build.context` | `..` | 构建上下文是**仓库根**（compose 文件在 `deploy/` 下） |
| `services.tscontroller.build.dockerfile` | `deploy/Dockerfile` | 相对 context（即仓库根）解析 |
| `image` | `tscontroller:local` | 本地构建镜像名；不使用 ghcr 远端镜像（CI 推的是另一套标签） |
| `container_name` | `tscontroller` | 固定容器名，便于 logs/exec |
| `restart` | `unless-stopped` | 崩溃或宿主重启后自动拉起，手动停止后不自动重启 |
| `network_mode` | `host` | **硬要求，不是优化项**（见下节） |

### `environment`

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `TSCONTROLLER_DATA_DIR` | `/data` | **必设**。映射库与审计日志的落地目录；不设则默认为 `<项目根>/data`，在容器里就是 `/app/data`（可写层），**容器重建即丢库** |
| `TSCONTROLLER_SNAPSHOT_DIR` | 注释掉的 `/data/public` | 留空即 `<DATA_DIR>/public`；只有想把快照放到别处才取消注释 |
| `TSCONTROLLER_PORT` | `"8787"` | 管理界面监听端口 |
| `TSCONTROLLER_TAILSCALE_BIN` | `/usr/local/bin/tailscale` | **容器内路径**，对应 `volumes` 中 tailscale 的挂载点；不设时 Linux 默认值为 `tailscale`（依赖 PATH） |
| `TSCONTROLLER_DOCKER_PIPE` | `unix:///var/run/docker.sock` | Unix socket 形式的 Docker 端点（对应挂载进来的宿主 socket） |
| `TSCONTROLLER_SERVE_PORT` | `"443"` | 新建映射时默认的对外 HTTPS 端口 |
| `TSCONTROLLER_SNAPSHOT_INTERVAL_MS` | `"60000"` | 快照刷新间隔；`0` 表示只在启动与每次收敛后写 |
| `TSCONTROLLER_AUTO_UNEXPOSE` | `"true"` | 收敛时自动取消多余暴露 |
| `TSCONTROLLER_LOG_LEVEL` | `info` | 日志级别 |
| `TZ` | `Asia/Shanghai` | 容器时区，影响日志时间戳 |

> 注意：`TSCONTROLLER_HOST` **故意没有出现**——该变量只接受回环地址，任何试图改成非回环的值都会被应用拒绝并报错退出，写在 compose 里只会让容器起不来。

### `volumes`（三个挂载各自的作用）

| 宿主路径 → 容器路径 | 作用 | 关键约束 |
| --- | --- | --- |
| `../data:/data` | 数据卷：**映射库、审计日志**，以及供 HomePage 读取的快照（`public/`） | 必须是 `../data`，不能写 `./data`（见下节） |
| `/var/run/docker.sock:/var/run/docker.sock` | 宿主 Docker 守护进程 socket：用于读取容器清单与端口 | 相当于把宿主 Docker 控制权交给容器，是**必要且高权限**的挂载 |
| `/var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock` | 宿主 `tailscaled` 的 LocalAPI。Linux 上是 Unix socket，**可以**挂进容器 | Windows 上是命名管道，做不到——**所以本方案只在 Linux/NAS 上成立** |
| `/usr/bin/tailscale:/usr/local/bin/tailscale:ro` | 宿主 tailscale **可执行文件**，只读挂载到 `TSCONTROLLER_TAILSCALE_BIN` 指定的路径 | 路径标了 `<<< 需要确认`；群晖套件版通常在 `/var/packages/Tailscale/target/bin/tailscale`，先用 `which tailscale` 查 |

**挂载路径写错的陷阱**：若 tailscale 那行指向一个**不存在**的路径，Docker 会在宿主机上**创建一个同名目录**并挂载，容器内 `/usr/local/bin/tailscale` 于是成了目录，调用必然失败。挂载前先 `ls -l` 确认。

### `healthcheck`

| 键 | 值 | 说明 |
| --- | --- | --- |
| `test` | `node -e "require('http').get({host:'127.0.0.1',port:process.env.TSCONTROLLER_PORT||8787,path:'/api/health'}, r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"` | 只探管理面的 `/api/health` |
| `interval` | `30s` | 探测间隔 |
| `timeout` | `5s` | 单次超时 |
| `retries` | `3` | 连续失败阈值 |
| `start_period` | `20s` | 启动宽限期 |

探测目标写 `127.0.0.1` 之所以成立，也正是 `network_mode: host` 的副产品：容器内的回环**就是宿主的回环**。健康检查**不**验证 tailscale/docker 可用性，那由界面与快照体现。

### 文件末尾的注释（不是配置，但是约束）

文件刻意**不**定义 HomePage 所需的挂载，并给出在 HomePage 自己的 compose 里加一行只读挂载的做法：

```yaml
volumes:
  - /volume1/docker/tscontroller/data/public:/tscontroller:ro
```

只挂 `public/` 而不是整个 `data/`，这样门户拿不到 `mappings.json` 与 `audit.jsonl`。

## 关键点：`network_mode: host` 是硬要求而非优化项

`network_mode: host` 在本项目里**没有替代方案**，原因链如下：

1. 应用**硬性拒绝绑定非回环地址**，且**没有绕过开关**。`src/main.ts` 在 `listen` 之后还会复核内核实际绑定的地址，非回环则记录错误并抛错关闭（纵深防御）。
2. 若改用 `ports: ["127.0.0.1:8787:8787"]`，容器内进程必须 bind `0.0.0.0` 才能被 publish；而本应用会拒绝 `0.0.0.0` 并**直接退出**。所以端口映射不是“更安全的等价做法”，而是根本跑不起来。
3. `network_mode: host` 让容器里的 `127.0.0.1` **就是宿主的回环**，于是：
   - 「只监听回环」这条安全约束成立，启动检查能通过；
   - 管理界面仍然**只从宿主本机可达**（SSH 隧道或 NAS 本机浏览器），tailnet 内其他设备直连不到；
   - `healthcheck` 里探 `127.0.0.1:8787` 也才有意义。

同样地，`EXPOSE 8787`（见 `deploy/Dockerfile`）只是元数据，不改变上述结论。

## 关键点：相对路径是相对 compose 文件目录解析的

compose 中**所有相对路径（`build.context`、`volumes` 的宿主侧）都以 compose 文件所在目录为基准**，不是以执行命令时的 `cwd` 为基准。因此：

- 数据卷写 `./data` 会解析成 `deploy/data`，与 `docs/nas-deployment.md` §2.3 的目录布局（仓库根的 `data/`）不符；
- 所以文件里用的是 `../data:/data`；
- 同理 `build.context` 用 `..`（仓库根），而不是默认的 `deploy/`——否则 `COPY package.json` 等路径全部失效。

这条与「在仓库根执行 `docker compose -f deploy/docker-compose.yml up -d --build`」并不矛盾：无论从哪里执行，解析基准都是 compose 文件位置。

## 引用方

- **`docker compose -f deploy/docker-compose.yml up -d --build`**（文件头给出的用法，在仓库根执行）。
- **`deploy/Dockerfile`**：被本文件的 `build.context`/`dockerfile` 指向；其 `VOLUME ["/data"]` 与这里的 `../data:/data` 配对。
- **`src/config.ts`**：逐个读取 `environment` 段中的 `TSCONTROLLER_*` 变量并提供缺省值；`TSCONTROLLER_DATA_DIR` 的缺省值正是「不设就会落到容器可写层」的那个坑。
- **`.dockerignore`**：与本文件无直接引用关系，但排除 `data` / `vol` 是「运行期数据不进镜像」这一约定的另一半。
