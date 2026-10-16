# TsController 容器镜像
#
# 构建上下文是**仓库根目录**（不是 deploy/），因此：
#   docker build -f deploy/Dockerfile .
# 或在 compose 里用 context: ..
#
# ⚠️ 本文件未在真实 Linux/NAS 上构建验证过，只依据平台行为编写。
#
# 后端不需要编译：Node 22.18+ 的原生 TypeScript 类型擦除直接运行 src/main.ts。
# 只有前端需要构建步骤。

# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- 构建前端
FROM node:22-bookworm-slim AS web

WORKDIR /app

# 先只拷清单，让依赖层可缓存。
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY web ./web
RUN npm run web:build

# ---------------------------------------------------------------- 运行时
# 选 Debian(glibc) 而不是 Alpine(musl)：宿主上的 tailscale 二进制会被 bind-mount
# 进来，glibc 版本能最大化兼容性，避免 cannot execute binary file。
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && node -e "const [maj,min]=process.versions.node.split('.').map(Number); \
      if (maj < 22 || (maj === 22 && min < 18)) { \
        console.error('Node ' + process.versions.node + ' 过旧：需要 >=22.18 才有原生 TypeScript 类型擦除'); \
        process.exit(1); \
      } \
      console.log('Node ' + process.versions.node + ' 满足要求');"

# 后端源码（直接运行，无需构建产物）与运维脚本。
COPY src ./src
COPY scripts ./scripts

# 前端构建产物。
COPY --from=web /app/web/dist ./web/dist

# 数据目录：务必在 compose 里挂卷并把 TSCONTROLLER_DATA_DIR 指向它，
# 否则映射库会落在容器可写层，容器一重建就丢。详见 docs/nas-deployment.md §2.2。
VOLUME ["/data"]

# 管理界面端口。注意：本应用**只允许绑定回环地址**（无绕过开关），
# 因此必须用 network_mode: host，见 deploy/docker-compose.yml 的注释。
EXPOSE 8787

CMD ["node", "src/main.ts"]
