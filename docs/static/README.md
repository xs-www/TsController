# 静态文档索引

> 按 `code-static-documentation` 技能包的六阶段流程生成。
> **生成日期**：2026-10-17　**覆盖提交范围**：`d0e29cd` → 本次 Service 级路由改动。
> **维护约定**：文档目录树 = 源码目录树，一个源文件对一个 `.md`，函数/方法为最小粒度。

本文件取代了早期把全部内容写在一页的 `docs/static/function-index.md`（该文件已删除；历史形态可用 `git show <sha>:docs/static/function-index.md` 回看）。原先其中「当前代码的结构说明」已拆到下面镜像文档里，「变更归档」已搬到 `history.md`。

---

## 一、目录结构（= 源码目录树）

```text
docs/static/
├── README.md           ← 本文件：索引 / 阅读顺序 / 校验报告 / 维护约定
├── manifest.txt        ← 权威清单（Phase 1 一次性枚举，全流程唯一遍历依据）
├── history.md          ← 变更归档：每次改动的原因、取舍与实测证据（只增不改）
├── scripts/verify-docs.ts.md   ← 本套文档自己的校验脚本
│
├── src/                ← 后端控制面
│   ├── domain/         types.ts · route-path.ts
│   ├── docker/         docker-client.ts · docker-service.ts
│   ├── tailscale/      serve-config.ts · tailscale-cli.ts · tailscale-service.ts
│   ├── mappings/       store.ts · reconcile.ts · mapping-service.ts
│   └── config.ts · logger.ts · snapshot.ts · app.ts · runtime.ts · main.ts
├── web/src/            api.ts · utils.ts · App.tsx · main.tsx
│   └── components/     shared.ts · Toast · CopyButton · TopBar · Toolbar ·
│                       SecurityBanner · ServicePanel · ContainerPanel ·
│                       MappingPanel · ExternalRoutesPanel
├── scripts/            clean-verify.ts · verify-live.ts · verify-security.ts
├── test/               fakes.ts + 9 个 *.test.ts
├── deploy/             Dockerfile · docker-compose.yml
└── （根级配置）         package.json · tsconfig.json · vitest.config.ts ·
                        .gitignore · .gitattributes · .dockerignore ·
                        .github/workflows/docker-publish.yml · web/index.html · web/tsconfig.json · web/vite.config.ts
```

**定位规则**：任何源文件都能按「相对路径 + `.md`」直接找到文档。

```text
src/domain/route-path.ts      →  docs/static/src/domain/route-path.ts.md
web/src/components/Toast.tsx  →  docs/static/web/src/components/Toast.tsx.md
deploy/Dockerfile             →  docs/static/deploy/Dockerfile.md
```

---

## 二、第一次接手建议的阅读顺序

1. **仓库根的 `README.md`** —— 「这是什么、为什么这么设计」。它回答的是产品与部署问题，本套文档回答的是代码问题。
2. **`src/domain/types.ts.md` + `src/domain/route-path.ts.md`** —— 全部跨层类型与全部纯函数。**读完这两份，后面所有状态判定都能看懂。**
3. **`src/mappings/reconcile.ts.md`** —— 差异计算（纯函数，所有状态机在这里被穷举）。
4. **`src/mappings/mapping-service.ts.md`** —— 唯一的副作用集中点（校验顺序、串行队列、tombstone 删除）。
5. **`src/tailscale/serve-config.ts.md`** —— 两个数据源的解析。**最容易踩的一条**：节点级路由在 `serve status --json`，Service 级只在 `serve get-config --all`。
6. **`web/src/api.ts.md`** —— 前端契约层，与后端字段逐字对齐（后端改名会立刻编译失败）。

按角色分工的入口：

| 你要做的事 | 先读 |
| --- | --- |
| 改路由模型 / 加状态 | `domain/types.ts` → `mappings/reconcile.ts` → `mappings/mapping-service.ts` |
| 改 serve 读写 | `tailscale/serve-config.ts` → `tailscale/tailscale-cli.ts` → `tailscale/tailscale-service.ts` |
| 改界面 | `web/src/api.ts` → `web/src/utils.ts` → 对应 `web/src/components/*` |
| 加安全约束 | `src/app.ts`（Host 校验）→ `mappings/mapping-service.ts`（`enforceExposureGuard`）→ `config.ts`（回环硬约束） |
| 排查 Docker 连不上 | `docker/docker-client.ts`（并发探测 + 负缓存） |
| 排查快照消费方读不到 | `snapshot.ts`（schema v2）→ `main.ts`（发布时机） |

---

## 三、被排除的目录与文件（为什么没有对应文档）

全部登记在 `manifest.txt` 的 `skip` 行：

| 排除对象 | 原因 |
| --- | --- |
| `.git/` | 版本控制元数据，不是项目内容 |
| `node_modules/`、`package-lock.json` | 第三方依赖与锁文件：体积大、无本项目语义，可由 `package.json` 重建 |
| `web/dist/` | 构建产物，由 `web/src/**` 重建（每次 `npm run web:build` 覆盖） |
| `data/` | **运行时数据**：真实映射库、审计日志、快照。含个人环境信息（本机端口、备注）且随时变化 |
| `README.md`、`todo.md`、`docs/*.md` | 本就是给人读的文档，重复归档只会造成两份真相（它们直接维护在仓库根/`docs/`） |
| `docs/static/**` | 本文档树自身 |
| `*.png/jpg/ico/svg/zip/so/dll/exe` | 二进制资源，无函数语义 |

---

## 四、校验报告（Phase 5 四重校验）

由 `node scripts/verify-docs.ts` 执行；加 `--stats` 会把下面的表写回本文件。四项标准：**数量**（源文件数 = 文档数 + 跳过数）、**结构**（文档目录树与源码一致）、**覆盖**（文档函数条目数 ≥ 源码函数数）、**格式**（代码文档四要素、配置文档两要素）。

<!-- STATS:START -->
| 校验项 | 结果 |
| --- | --- |
| 数量校验 | 待归档源文件 **57** = 已生成文档 **57** + 跳过 **0**（被 skip 的是 9 条非项目内容） |
| 结构校验 | 全部 57 条按 `docs/static/<相对路径>.md` 命中 |
| 覆盖校验 | 文档函数条目总数 **300** ≥ 源码粗筛函数总数 **199** |
| 格式校验 | 代码文件含四要素、配置文件含两要素，全部通过 |

明细：57 个文件（代码 44 · 配置 13），逐条结果见 `node scripts/verify-docs.ts` 输出。
<!-- STATS:END -->

---

## 五、维护约定

1. **改代码就要改文档。** 与业务代码在同一个提交里更新对应 `.md`；新增源文件时在 `manifest.txt` 加一行（`pending` → 生成后改 `done`）。
2. **文档头的 commit 是过期判定依据。** 每个文件文档头部记录生成时的版本；发现不一致即以**代码为准**并增量重跑该文件。
3. **`history.md` 只增不改。** 每次改动追加一条；推翻早先结论时在新条目里写明，并在旧条目上加「已被 xxx 取代」。
4. **归档过程只读源码。** 生成/更新文档时绝不回写 `src/`、`web/`、`test/`、`scripts/`。
5. **不要贴整段源码。** 只写结构化摘要与关键逻辑；函数详情写清语义与边界，不复制实现。

## 六、本次生成的已知遗留

- 文档头统一记为「随本次提交」，因为生成与源码改动在同一提交入库（没有可引用的历史 sha）。
- 4 个前端组件与 3 个脚本的文档由并行子任务生成，风格以 `src/logger.ts.md` / `src/docker/docker-service.ts.md` 为范本；若发现某份文档的详细程度明显偏离，按范本补齐。
- 校验脚本的函数提取是**正则粗筛**（本项目用 Node 原生类型擦除，没有可用的 TS AST 依赖）。它的方向是「宁少算不多算」：只认顶层 `function`/`export const = (` 与缩进的类方法，刻意不收集内联回调——否则会制造假失败。
