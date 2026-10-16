/**
 * serve 路由快照。
 *
 * 动机：容器**够不到**宿主上的 tailscaled（Windows 是命名管道，跨不过 WSL2；
 * Linux 桥接网络也到不了宿主回环），因此其他项目无法自行读取 serve 配置。
 * 本模块把路由状态落成一份 JSON 文件，消费方只需只读挂载一个目录即可读取——
 * 不需要网络端口、不需要令牌、也不依赖「TsController 此刻是否在跑」。
 *
 * 这里是纯函数 + 一层薄 IO：`buildSnapshot()` 不碰磁盘，所有字段都能在单测里穷举。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildBaseUrl } from './domain/route-path.ts';
import type {
  ContainerInfo,
  Mapping,
  MappingStatus,
  ServeSnapshot,
  ServiceInfo,
  TailnetInfo,
} from './domain/types.ts';
import type { ReconcilePlan } from './mappings/reconcile.ts';

/**
 * 快照 schema 版本；字段语义变化时递增，消费方据此判断兼容性。
 *
 * - v1：路由身份 = (端口, 路径)
 * - v2：路由身份 = (Service, 端口, 路径)；新增 `service`/`host`/`services`/`selfTags`
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** 快照里的单条路由。 */
export interface SnapshotRoute {
  /**
   * 所属 Tailscale Service（`svc:dsh`）；`null` 表示节点级路由。
   *
   * 这是 v2 新增的字段：v1 的 `url` 只能表达节点级地址，Service 路由的对外
   * 主机名完全不同（`dsh.<tailnet>.ts.net`）。
   */
  service: string | null;
  /** 对外 HTTPS 端口。 */
  servePort: number;
  /** 挂载路径。 */
  path: string;
  /** 该路由所属的对外主机名（节点名或 Service 名）。 */
  host: string | null;
  /** 可直接点击的完整地址；无法确定主机名时为 null。 */
  url: string | null;
  /** serve 中实际的代理地址原文；非代理 handler 为 null。 */
  proxy: string | null;
  /** 代理目标上追加的路径。 */
  targetPath: string;
  /** 代理目标的主机；本机回环也为 "127.0.0.1"。 */
  targetHost: string | null;
  /** 代理目标端口。 */
  targetHostPort: number | null;
  /** 是否已被 TsController 接管。 */
  managed: boolean;
  /** 被接管时对应的映射 id。 */
  mappingId: string | null;
  /** 受管路由的健康状态；未托管路由为 null。 */
  status: MappingStatus | null;
  /** 受管且关联到容器时的容器名。 */
  containerName: string | null;
  /** 容器内端口。 */
  containerPort: number | null;
  /** 容器关联的来源：`mapping` = 来自映射库，`port` = 按宿主机端口反查，`null` = 未关联。 */
  containerSource: 'mapping' | 'port' | null;
  /** 映射备注。 */
  note: string | null;
  /** 映射是否启用；未托管路由为 null。 */
  enabled: boolean | null;
  /**
   * Service 端点配置来源（`tailscale serve get-config --all`）。
   *
   * 这类路由的 handler 树是**有损**读出的（只有根 handler、目标路径丢失），
   * 消费方不要据此重建配置。
   */
  fromServiceConfig: boolean;
}

export interface SnapshotSummary {
  total: number;
  managed: number;
  unmanaged: number;
  active: number;
  pending: number;
  disabled: number;
  orphanedTarget: number;
  blocked: number;
  /** 配置写对了但对外还不可用（等待 Service 审批 / 已被 drain）。 */
  awaitingApproval: number;
}

export interface Snapshot {
  schemaVersion: number;
  generatedAt: string;
  /** 生成者标识，便于消费方判断数据来源。 */
  generator: string;
  source: {
    /** tailnet 主机名（不含端口）。 */
    hostname: string | null;
    /** 默认端口的基址，例如 `https://my-laptop.example-tailnet.ts.net`。 */
    baseUrl: string | null;
    /** MagicDNS 后缀，例如 `example-tailnet.ts.net`；Service 地址靠它拼出。 */
    magicDnsSuffix: string | null;
    /** 本节点的 tag（空数组意味着本节点不可能作为 Service host）。 */
    selfTags: string[];
    tailnetIps: string[];
    /** TsController 管理端口，供消费方识别「这个端口不是业务端口」。 */
    adminPort: number;
  };
  /** serve 中已声明的全部 HTTPS 端口（节点级 + Service 级），升序。 */
  servePorts: number[];
  /** 当前节点上的 Tailscale Service 及其状态。 */
  services: ServiceInfo[];
  routes: SnapshotRoute[];
  summary: SnapshotSummary;
  security: {
    autoUnexpose: boolean;
    /** 指向管理端口的路由；正常情况下应为空。 */
    exposures: Array<{ service: string | null; servePort: number; path: string; proxy: string }>;
  };
}

export interface BuildSnapshotInput {
  generatedAt: string;
  generator: string;
  tailnet: TailnetInfo;
  serve: ServeSnapshot;
  mappings: Mapping[];
  plan: ReconcilePlan;
  /**
   * 当前容器清单。
   *
   * 用途是给**未托管**路由按宿主机端口反查容器：消费方（门户）想知道每条路由
   * 背后是哪个容器，而映射库只覆盖已被接管的那部分。
   */
  containers: ContainerInfo[];
  adminPort: number;
  autoUnexpose: boolean;
}

/** 按宿主机端口反查容器；同一端口有多个绑定时取第一个运行中的。 */
function findByHostPort(
  containers: ContainerInfo[],
  hostPort: number | null,
): { name: string; port: number } | null {
  if (hostPort === null) return null;
  const running = containers.filter((c) => c.state === 'running');
  const pool = running.length > 0 ? running : containers;
  for (const c of pool) {
    const p = c.ports.find((x) => x.hostPort === hostPort && x.protocol === 'tcp');
    if (p) return { name: c.name, port: p.containerPort };
  }
  return null;
}

/** 组装快照。纯函数：相同输入必得相同输出（除 `generatedAt` 由调用方注入）。 */
export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const { tailnet, serve, mappings, plan, containers, adminPort, autoUnexpose } = input;
  const mappingById = new Map(mappings.map((m) => [m.id, m]));

  const routes: SnapshotRoute[] = serve.routes.map((route) => {
    const owner = route.mappingId ? mappingById.get(route.mappingId) : undefined;
    // 未托管路由没有映射记录；用 (Service, 端口, 路径) 反查一次，兼容 serveRoutes() 未标注归属的调用方。
    const fallbackOwner =
      owner ??
      mappings.find(
        (m) =>
          (m.service ?? null) === (route.service ?? null) &&
          m.servePort === route.servePort &&
          m.path.toLowerCase() === route.path.toLowerCase(),
      );
    const evaluation = fallbackOwner ? plan.evaluations.get(fallbackOwner.id) : undefined;
    // 对外地址只看**快照主机名**（节点级）或 Service 的 DNS 名（Service 级）。
    // 刻意不拿 tailnet.dnsName 兜底：那会让「tailscale 未登录、读不到主机名」这种情况
    // 产出一个看似可用、实际不该点开的链接。
    const origin = buildBaseUrl(route.host || null, route.servePort, route.service, tailnet.magicDnsSuffix);
    const handler = route.handler;
    const isProxy = handler.kind === 'proxy';
    const targetHostPort = isProxy ? handler.hostPort : null;
    const targetHost = isProxy ? (handler.host ?? null) : null;

    // 容器关联优先取映射库（它带人工确认过的归属）；没有映射时按宿主机端口反查，
    // 这样未托管路由在门户里也能显示「背后是哪个容器」。
    // 远端目标（service host 代理到另一台机器）不做反查：那是别的机器的容器清单。
    const isRemote = isProxy && !handler.loopback;
    const fromMapping =
      fallbackOwner?.target.containerName !== undefined
        ? { name: fallbackOwner.target.containerName, port: fallbackOwner.target.containerPort ?? null }
        : null;
    const guessed = isRemote ? null : (fromMapping ?? findByHostPort(containers, targetHostPort));

    return {
      service: route.service,
      servePort: route.servePort,
      path: route.path,
      host: route.host || null,
      url: origin === '' ? null : `${origin}${route.path}`,
      proxy: isProxy ? handler.raw : null,
      targetPath: isProxy ? handler.targetPath : '',
      targetHost,
      targetHostPort,
      managed: fallbackOwner !== undefined,
      mappingId: fallbackOwner?.id ?? null,
      status: evaluation?.status ?? null,
      containerName: guessed?.name ?? null,
      containerPort: guessed?.port ?? null,
      containerSource: guessed === null ? null : fromMapping !== null ? 'mapping' : 'port',
      note: fallbackOwner?.note ?? null,
      enabled: fallbackOwner?.enabled ?? null,
      fromServiceConfig: isProxy && handler.fromServiceConfig === true,
    };
  });

  routes.sort(
    (a, b) =>
      a.servePort - b.servePort ||
      (a.service ?? '').localeCompare(b.service ?? '') ||
      a.path.localeCompare(b.path),
  );

  const summary: SnapshotSummary = {
    total: routes.length,
    managed: 0,
    unmanaged: 0,
    active: 0,
    pending: 0,
    disabled: 0,
    orphanedTarget: 0,
    blocked: 0,
    awaitingApproval: 0,
  };
  for (const r of routes) {
    if (r.managed) summary.managed += 1;
    else summary.unmanaged += 1;
    if (r.status === 'active') summary.active += 1;
    else if (r.status === 'pending') summary.pending += 1;
    else if (r.status === 'disabled' || r.status === 'disabled-drift') summary.disabled += 1;
    else if (r.status === 'orphaned-target') summary.orphanedTarget += 1;
    else if (r.status === 'blocked' || r.status === 'conflict') summary.blocked += 1;
    else if (r.status === 'awaiting-approval') summary.awaitingApproval += 1;
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    generator: input.generator,
    source: {
      hostname: tailnet.dnsName,
      baseUrl: tailnet.baseUrl,
      magicDnsSuffix: tailnet.magicDnsSuffix,
      selfTags: tailnet.tags,
      tailnetIps: tailnet.ips,
      adminPort,
    },
    servePorts: serve.httpsPorts,
    services: serve.services,
    routes,
    summary,
    security: {
      autoUnexpose,
      exposures: plan.exposures.map((e) => ({
        service: e.service,
        servePort: e.servePort,
        path: e.path,
        proxy: e.proxy,
      })),
    },
  };
}

/** 快照写出器。抽成接口是为了让单测不必碰磁盘。 */
export interface SnapshotWriter {
  /** 写出快照，返回实际写入的绝对路径。 */
  write(snapshot: Snapshot): Promise<string>;
  /** 目标路径，用于日志与界面展示。 */
  readonly filePath: string;
}

/**
 * 写入 `<dir>/serve-routes.json`。
 *
 * 采用「临时文件 + rename」原子替换：消费方随时打开这个文件都不会读到半截 JSON。
 */
export class FileSnapshotWriter implements SnapshotWriter {
  readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, 'serve-routes.json');
  }

  async write(snapshot: Snapshot): Promise<string> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.filePath);
    return this.filePath;
  }
}

/** 内存写出器，供测试使用。 */
export class MemorySnapshotWriter implements SnapshotWriter {
  readonly filePath = '(memory)';
  readonly writes: Snapshot[] = [];

  async write(snapshot: Snapshot): Promise<string> {
    this.writes.push(structuredClone(snapshot));
    return this.filePath;
  }

  get last(): Snapshot | undefined {
    return this.writes.at(-1);
  }
}
