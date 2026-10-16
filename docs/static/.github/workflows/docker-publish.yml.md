# `.github/workflows/docker-publish.yml`

> 生成于 2026-10-17，对应源码版本：随本次提交（Service 级路由改动）。

## 文件概述

GitHub Actions 工作流：**先跑类型检查与测试（`verify`），通过后才构建并推送镜像到 ghcr.io（`build-and-push`）**，产物为 `linux/amd64` 单平台镜像。

## 结构说明

### 顶层

| 键 | 值 | 说明 |
| --- | --- | --- |
| `name` | `Build and push image` | Actions 页面显示的工作流名 |
| `on.push.tags` | `['v*']` | 打 `v` 开头的 tag 并推送时触发（如 `git tag v0.1.0 && git push origin v0.1.0`）——**推荐方式** |
| `on.workflow_dispatch` | （空） | 允许在 Actions 页面手动 Run workflow |
| `on.push.branches` | **未配置** | 普通分支推送**不会**触发；`pull_request` 也未配置，故本工作流不进 PR 检查 |
| `permissions.contents` | `read` | 只需读仓库（checkout） |
| `permissions.packages` | `write` | **推送镜像必需**；`GITHUB_TOKEN` 缺此权限会在 push 阶段失败 |

### job 1：`verify`

| 步骤 | 内容 | 说明 |
| --- | --- | --- |
| `actions/checkout@v4` | 拉取仓库 | |
| `actions/setup-node@v4` | `node-version: '22'`、`cache: npm` | 缓存键依赖 `package-lock.json` |
| `Install dependencies` | `npm ci` | 按锁文件安装，含 devDependencies（类型检查与测试都需要） |
| `Typecheck (backend + web)` | `npm run lint` | 等价 `tsc -p tsconfig.json --noEmit && tsc -p web/tsconfig.json --noEmit`，后端与前端各查一遍 |
| `Unit / API tests` | `npm test` | `vitest run`，单次执行后退出 |

未使用 `matrix`，未上传覆盖率，未跑 `verify:live` / `verify:security`（那两个脚本打真实运行中的服务，CI 里没有可用实例）。

### job 2：`build-and-push`

| 步骤 | 内容 | 说明 |
| --- | --- | --- |
| `needs: verify` | 依赖关系 | **verify 失败则本 job 不启动**（见下节） |
| `actions/checkout@v4` | 拉取仓库 | 与 `verify` 各自 checkout（两个 job 彼此独立） |
| `docker/setup-buildx-action@v3` | 启用 Buildx | |
| `docker/login-action@v3` | `registry: ghcr.io`、`username: github.actor`、`password: secrets.GITHUB_TOKEN` | 用内置 `GITHUB_TOKEN` 登录，无需额外 secret |
| `Compute lowercase image name` | `echo "IMAGE_NAME=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"` | **镜像名转小写**（见下节） |
| `Derive tags and labels`（`id: meta`） | `docker/metadata-action@v5`，`images: ${{ env.IMAGE_NAME }}` | 生成标签与 OCI labels |
| `docker/build-push-action@v6` | `context: .`、`file: deploy/Dockerfile`、`push: true` | 用 `steps.meta.outputs.tags` / `.labels` |

### 标签规则（`metadata-action` 的 `tags:`）

| 规则 | 产出示例 | 触发条件 |
| --- | --- | --- |
| `type=semver,pattern={{version}}` | `1.2.3` | 仅当触发是形如 `v1.2.3` 的 tag |
| `type=semver,pattern={{major}}.{{minor}}` | `1.2` | 同上 |
| `type=raw,value=latest` | `latest` | **总是**产出 |
| `type=sha,format=short` | `sha-<短 sha>` | **总是**产出 |

> 注意 `type=raw,value=latest` 没有 `enable=` 条件，因此**手动触发（`workflow_dispatch`）与 tag 触发都会移动 `latest`**。这是配置本身表达的行为。

### 平台与缓存

| 键 | 值 | 说明 |
| --- | --- | --- |
| `platforms` | `linux/amd64` | 注释说明：绿联 DX4600 Pro 及同代 NAS 基本是 Intel x86_64，故只建 amd64；要跑 ARM NAS 时改成 `linux/amd64,linux/arm64`（注意 arm64 走 QEMU 模拟，`npm ci` 会明显变慢） |
| `cache-from` / `cache-to` | `type=gha` / `type=gha,mode=max` | 使用 GitHub Actions 缓存后端；`mode=max` 缓存全部中间层 |

### 未配置项

| 未出现 | 含义 |
| --- | --- |
| `secrets` 引用（除内置 `GITHUB_TOKEN`） | 不需要任何自定义 secret |
| `provenance` / `sbom` | 使用 Buildx 默认行为，未显式开启 |
| `concurrency` | 并发触发时不会互相取消，多个 tag 可并行 |
| `timeout-minutes` | 使用平台默认上限 |

## 关键点：两段式（先 verify 后 build-and-push）

`build-and-push` 声明了 `needs: verify`，因此：

1. `verify` 里的 `npm run lint`（后端 + 前端类型检查）或 `npm test`（Vitest）任一失败，**`build-and-push` 根本不会启动**——不会产生任何镜像，也不会推送到 ghcr.io。
2. 两个 job 都用默认的 `ubuntu-latest` runner，环境与本地 Windows 不同；`forceConsistentCasingInFileNames`（两份 tsconfig 都开了）正是为了让 Linux 上的大小写敏感路径问题在本地就暴露。
3. 源码注释写明动机：推到 ghcr.io 的镜像应当是通过验证的，否则 NAS 上拉到坏镜像的排查成本远高于这里多跑一分钟。

**改了会坏**：删掉 `needs: verify`（或把两个 job 合并 / 让 `build-and-push` 依赖自己）会让「未通过测试的提交也能产出镜像」，而这套流程的价值恰好在于此——NAS 是消费端，坏镜像进入 NAS 后排查链路很长。

## 关键点：镜像名必须全小写

ghcr.io 的镜像路径**必须全小写**，而 GitHub 的仓库名/用户名**可以含大写**。直接使用 `github.repository`（形如 `Owner/Repo`）会在 push 时报 `invalid reference format`。

处理方式是一步 shell 展开：

```bash
echo "IMAGE_NAME=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"
```

| 要点 | 说明 |
| --- | --- |
| `${VAR,,}` | Bash 的**小写展开**语法（4.0+）；`ubuntu-latest` runner 的默认 shell 是 bash，因此可用 |
| 后续步骤 | 通过 `${{ env.IMAGE_NAME }}` 传给 `metadata-action` 的 `images:`——`GITHUB_ENV` 写入的变量在同一 job 的**后续步骤**可见 |
| 为什么单独一步 | 注释说明是为了「显式转小写，避免那个坑」；若把 `${GITHUB_REPOSITORY,,}` 直接内联到 `with:` 里，GitHub 表达式的字符串函数无法可靠完成小写化，所以走 shell |
| 仓库实际名 | 本仓库名全小写时该步骤仍无害，属于对未来改名/转移的保护 |

**改了会坏**：把 `images:` 换成 `${{ github.repository }}`（或删掉这一步）→ 只要 owner/repo 含大写字符，`docker/build-push-action` 在 push 阶段就会失败；而前缀 `ghcr.io/` 也一并丢失。

## 引用方

- **GitHub Actions**：tag 推送或手动触发时执行。
- **`package.json`**：`verify` job 调用其中的 `lint` 与 `test` 脚本；`cache: npm` 依赖 `package-lock.json` 存在。
- **`deploy/Dockerfile`**：`build-and-push` 通过 `file: deploy/Dockerfile` + `context: .` 构建它。
- **`.dockerignore`**：构建上下文过滤规则同样生效。
- **消费端**：NAS 上按 `docs/image-publishing.md` 的说明从 ghcr.io 拉取（该文档不在本文档范围内）。首次运行后镜像出现在仓库 Packages 中，**默认私有**，NAS 拉取需要 `docker login`；想公开需在 Package 设置里改可见性。
