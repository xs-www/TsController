# 打包镜像并推送到 ghcr.io

> ## 本仓库的具体值
>
> | 项 | 值 |
> | --- | --- |
> | 仓库 | <https://github.com/xs-www/TsController> |
> | GitHub owner | `xs-www` |
> | 镜像路径 | **`ghcr.io/xs-www/tscontroller`** |
>
> ⚠️ **注意大小写**：仓库名是 `TsController`（含大写），但 **ghcr.io 的镜像路径必须全小写**。
> 所以镜像名是 `tscontroller` 而不是 `TsController`。写成大写会在 push 时直接报
> `invalid reference format`。
>
> `.github/workflows/docker-publish.yml` 里已经内置了转换为小写的步骤，走 Actions 不必操心。

两条路，**先看你要的是「现在就能用」还是「以后每次自动」**：

| | 手动构建推送（§2） | GitHub Actions（§3） |
| --- | --- | --- |
| 前提 | 只需要一个 PAT | 仓库已在 GitHub 上（✅ 已建，当前为空仓库） |
| 何时用 | 立刻要一个镜像去 NAS 上跑 | 以后打 tag 自动出镜像 |

仓库 `xs-www/TsController` 已经存在且是空的，两条路都能走。

---

## 0. 前置：创建 PAT 并登录

ghcr.io 的访问令牌和 GitHub 密码是分开的。

1. 打开 <https://github.com/settings/tokens>
2. **Classic token** 最省事：勾 `write:packages`（它会自动带上 `read:packages`）
   - 用 Fine-grained token 也可以，但要在 **Account permissions → Packages** 里给 `Read and write`
3. 生成后复制，**只显示一次**

```powershell
# 用户名填你的 GitHub 用户名（不是显示名）
docker login ghcr.io -u xs-www
# 提示 Password 时粘贴的是 PAT，不是账号密码
```

登录成功后凭据存在 `%USERPROFILE%\.docker\config.json`。

> ⚠️ **ghcr.io 的镜像路径必须全小写。** 用户名/仓库名含大写时直接 push 会报
> `invalid reference format`。下面所有命令都用小写形式。

---

## 1. 确认目标架构

镜像架构必须和 NAS 一致，否则拉下来跑不起来（`exec format error`）。

**在 NAS 上执行**：

```bash
uname -m
```

| 输出 | 平台参数 |
| --- | --- |
| `x86_64` | `linux/amd64` |
| `aarch64` / `arm64` | `linux/arm64` |

绿联 DX4600 Pro 及其同代机型基本是 Intel x86_64，但**以 `uname -m` 的实际输出为准**。

在开发机上确认 Docker 能构建该架构：

```powershell
docker buildx version          # 需要 buildx
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
```

---

## 2. 手动构建并推送（现在就能用）

在仓库根目录（`D:\apps\TsController`）执行：

```powershell
# ── 改这一个变量 ──────────────────────────────────────────
$tag = "0.1.0"
# ──────────────────────────────────────────────────────────

$image = "ghcr.io/xs-www/tscontroller"      # 必须全小写

# 构建（上下文是仓库根，Dockerfile 在 deploy/ 下）
docker build -f deploy/Dockerfile -t "${image}:${tag}" -t "${image}:latest" .

# 推送
docker push "${image}:${tag}"
docker push "${image}:latest"
```

一行版：

```powershell
docker build -f deploy/Dockerfile -t ghcr.io/xs-www/tscontroller:0.1.0 -t ghcr.io/xs-www/tscontroller:latest . ; `
docker push ghcr.io/xs-www/tscontroller:0.1.0 ; `
docker push ghcr.io/xs-www/tscontroller:latest
```

### 2.1 推之前先自检（推荐）

**最快的一条**：确认镜像里的 Node 版本与前端产物都在。

```powershell
docker run --rm "${image}:${tag}" node -v        # 应 >= v22.18
docker run --rm "${image}:${tag}" ls web/dist    # 前端产物在
```

**完整一条**：确认它在容器里真能起来、能读宿主 Docker、能把快照写到挂载卷。

```powershell
$vol = "$PWD\data-imagecheck"
New-Item -ItemType Directory -Force -Path $vol | Out-Null

docker run -d --name tsc-check `
  -v "${vol}:/data" `
  -v "/var/run/docker.sock:/var/run/docker.sock" `
  -e TSCONTROLLER_DATA_DIR=/data `
  -e TSCONTROLLER_DOCKER_PIPE=unix:///var/run/docker.sock `
  "${image}:${tag}"

Start-Sleep -Seconds 5
docker logs tsc-check 2>&1 | Select-Object -Last 8
Test-Path "$vol\public\serve-routes.json"        # 应为 True

docker rm -f tsc-check | Out-Null
Remove-Item -Recurse -Force $vol
```

没有 tailscale 二进制时，日志里会有两条 warn（启动安全检查、快照发布），
**这是预期的**——它只 warn 不崩，管理界面照常可用。这两条降级路径都已实测过。

> 完整链路（容器内读宿主 Docker、生成快照、写挂载卷、前端托管）已在本机验证，
> 见 `docs/nas-deployment.md` §5.6。

### 2.2 架构不匹配时

若 NAS 是 arm64 而你在 amd64 机器上构建：

```powershell
docker buildx build --platform linux/arm64 `
  -f deploy/Dockerfile `
  -t "${image}:${tag}" -t "${image}:latest" `
  --push .
```

`--push` 与 `--load` 不能同时用；跨架构构建直接用 `--push` 推到 registry 最省事。

---

## 3. GitHub Actions 自动构建（以后每次打 tag 自动出镜像）

工作流已经写好在 `.github/workflows/docker-publish.yml`。它会：

1. 跑 `npm ci` → `npm run lint` → `npm test`（**测试不过就不构建镜像**）
2. 构建并推送到 `ghcr.io/xs-www/tscontroller`（自动转小写）
3. 自动打标签：`v0.1.0` → `0.1.0`、`0.1`、`latest`、`sha-xxxxxxx`

### 3.1 前提：把仓库推到 GitHub

仓库当前状态是**有 57 个文件在索引里、零提交、无远端**。需要先落一次提交：

```powershell
# 在仓库根
git commit -m "feat: 本机 tailnet ↔ Docker 路由控制器（控制面）"

# 在 GitHub 上新建一个**空仓库**（不要勾 README / .gitignore / license），
# 假设叫 tscontroller，然后：
git remote add origin https://github.com/xs-www/TsController.git
git branch -M main
git push -u origin main
```

> 提交前确认过：待提交内容里没有 `.env`、token、密钥类文件；
> `data/`（映射库、审计日志、快照）同时被 `.gitignore` 与 `.dockerignore` 排除，
> 不会进仓库也不会进镜像。

### 3.2 之后怎么发版

```powershell
git tag v0.1.0
git push origin v0.1.0
```

推送后到仓库的 **Actions** 页看进度；完成后镜像出现在仓库首页右下角的 **Packages**。

也可以手动触发：**Actions → Build and push image → Run workflow**。

### 3.3 权限

工作流用内置的 `GITHUB_TOKEN`，只需在文件里声明：

```yaml
permissions:
  contents: read
  packages: write
```

**不需要**额外配置 secret。如果 push 报 `denied: permission_denied`，去
**仓库 Settings → Actions → General → Workflow permissions** 确认没有把默认权限设成只读。

---

## 4. 在 NAS 上拉取

```bash
# 私有包需要先登录（同一个 PAT，或另建一个只读的）
echo "<PAT>" | docker login ghcr.io -u xs-www --password-stdin

docker pull ghcr.io/xs-www/tscontroller:0.1.0
```

### 4.1 如果不想在 NAS 上配 PAT

在 GitHub 上把包设为公开：
**仓库 → Packages → tscontroller → Package settings → Change visibility → Public**

私有包和公开包的拉取都不需要额外费用。**但这个镜像是内网工具，建议保持私有。**

### 4.2 拉不到时的排查

| 现象 | 原因 |
| --- | --- |
| `denied` / `unauthorized` | 没登录，或 PAT 缺 `read:packages` |
| `manifest unknown` | 标签名写错，或镜像还没推成功 |
| `no matching manifest for linux/arm64` | 镜像只建了 amd64，NAS 是 arm64 → 按 §2.2 重建 |
| `exec format error`（拉到了但起不来） | 同上，架构不匹配 |

---

## 5. 拉取后怎么用

拿到镜像后，NAS 上的 compose 把 `build:` 换成 `image:`：

```yaml
services:
  tscontroller:
    image: ghcr.io/xs-www/tscontroller:0.1.0   # ← 替代 build: 段
    # 其余不变，见 deploy/docker-compose.yml
```

其余步骤（挂载、环境变量、`network_mode: host`、HomePage 只读挂载快照）见
[`nas-deployment.md`](./nas-deployment.md)。

---

## 6. 一件事先说清楚：这个镜像必须 `network_mode: host`

不是可选优化。本应用硬性拒绝绑定非回环地址且**没有绕过开关**，若用
`ports: ["127.0.0.1:8787:8787"]`，容器内必须 bind `0.0.0.0` 才能被 publish，
会被直接拒绝并退出。host 网络让容器里的 `127.0.0.1` 就是宿主回环，
该约束既成立又能通过检查。

拉下来发现「容器起来就退出、日志说不允许非回环」时，先看这条。
