/**
 * 测试替身：内存版 serve 网关与容器清单。
 *
 * 有了它们，映射服务与 HTTP API 的全部行为都能在无 Docker、无 Tailscale 的
 * 沙箱里被完整覆盖。
 *
 * 路由身份是三元组 `(service, servePort, path)`，因此内部用 `serveRouteKey()`
 * 作键。为保持可读性，构造函数的键支持三种写法：
 * - `"/app"`              默认 Service 为节点级、端口 443；
 * - `":8443/app"`         指定端口；
 * - `"svc:dsh:443/"`      指定 Service 与端口（Service 名前缀写全 `svc:`）。
 */

import { serveRouteKey } from '../src/domain/route-path.ts';
import type {
  ContainerInfo,
  ServeRoute,
  ServeSnapshot,
  ServiceInfo,
  TailnetInfo,
} from '../src/domain/types.ts';
import type { ContainerSource } from '../src/docker/docker-service.ts';
import type { ServeGateway } from '../src/tailscale/tailscale-service.ts';

/** 测试里默认的对外端口；绝大多数用例只关心它。 */
export const TEST_SERVE_PORT = 443;

/** 测试里的默认 Service 名（用于 Service 相关用例）。 */
export const TEST_SERVICE = 'svc:dsh';

/**
 * 解析测试用的简写键。
 *
 * 三种写法：
 * - `"/app"`            → `{service: null, servePort: 443, path: '/app'}`
 * - `":8443/app"`       → `{service: null, servePort: 8443, path: '/app'}`
 * - `"svc:dsh:443/"`    → `{service: 'svc:dsh', servePort: 443, path: '/'}`
 *
 * 注意 `"svc:dsh:/"` 也是合法的（省略端口，用默认 443）。
 */
export function parseFakeRouteKey(key: string): { service: string | null; servePort: number; path: string } {
  let rest = key;
  let service: string | null = null;

  // Service 前缀是 `svc:<名字>:`，因此要匹配到**第二个**冒号为止。
  const svc = /^(svc:[a-z0-9._-]+):(.*)$/.exec(rest);
  if (svc) {
    service = svc[1]!;
    rest = svc[2]!;
  }

  const m = /^:(\d+)(\/.*)$/.exec(rest);
  if (m) return { service, servePort: Number(m[1]), path: m[2]! };
  return { service, servePort: TEST_SERVE_PORT, path: rest };
}

/** 内存 serve 网关：`handlers` 就是“真实”的 serve 配置。 */
export class FakeServeGateway implements ServeGateway {
  /** 键为 `serveRouteKey(service, servePort, path)`。 */
  readonly handlers = new Map<string, string>();
  /** serve 中已声明的 HTTPS 端口。 */
  readonly httpsPorts = new Set<number>([TEST_SERVE_PORT]);
  /** Service 状态；默认空，用例可自行注入。 */
  services: ServiceInfo[] = [];

  tailnetInfo: TailnetInfo = {
    dnsName: 'my-laptop.example-tailnet.ts.net',
    baseUrl: 'https://my-laptop.example-tailnet.ts.net',
    ips: ['100.101.102.103'],
    hostname: 'My-Laptop',
    backendState: 'Running',
    version: '1.102.4',
    magicDnsSuffix: 'example-tailnet.ts.net',
    tags: [],
    serviceHosts: {},
  };
  /** 让指定路由的写入失败，用于验证失败可重试。键同 `handlers`。 */
  readonly failUpsert = new Set<string>();
  readonly failRemove = new Set<string>();
  /** 记录调用轨迹。 */
  readonly calls: Array<{
    op: 'upsert' | 'remove';
    service: string | null;
    servePort: number;
    path: string;
    proxy?: string;
  }> = [];
  /** `clearService` 的调用轨迹（真实网关才有的可选能力）。 */
  readonly clearedServices: string[] = [];

  constructor(initial: Record<string, string> = {}, extraPorts: number[] = []) {
    for (const [k, v] of Object.entries(initial)) {
      const { service, servePort, path } = parseFakeRouteKey(k);
      this.handlers.set(serveRouteKey(service, servePort, path), v);
      this.httpsPorts.add(servePort);
    }
    for (const p of extraPorts) this.httpsPorts.add(p);
  }

  /* ------------------------- 便于断言的读写助手 ------------------------- */

  /** 取某条路由的代理地址；不存在返回 undefined。 */
  proxyOf(path: string, servePort: number = TEST_SERVE_PORT, service: string | null = null): string | undefined {
    return this.handlers.get(serveRouteKey(service, servePort, path));
  }

  /** 某条路由是否存在。 */
  has(path: string, servePort: number = TEST_SERVE_PORT, service: string | null = null): boolean {
    return this.handlers.has(serveRouteKey(service, servePort, path));
  }

  /** 直接设置一条路由（绕过调用轨迹，用于准备前置状态）。 */
  set(path: string, proxy: string, servePort: number = TEST_SERVE_PORT, service: string | null = null): void {
    this.handlers.set(serveRouteKey(service, servePort, path), proxy);
    this.httpsPorts.add(servePort);
  }

  /** 声明一个 Service（默认已承认）。 */
  addService(name: string, ports: number[], advertised = true, vipIps: string[] = []): ServiceInfo {
    const info: ServiceInfo = {
      name,
      dnsName: `${name.replace(/^svc:/, '')}.example-tailnet.ts.net`,
      servePorts: [...ports].sort((a, b) => a - b),
      advertised,
      vipIps,
    };
    this.services = [...this.services.filter((s) => s.name !== name), info];
    for (const p of ports) this.httpsPorts.add(p);
    return info;
  }

  /** 让某条路由的挂载失败。 */
  fail(path: string, servePort: number = TEST_SERVE_PORT, service: string | null = null): void {
    this.failUpsert.add(serveRouteKey(service, servePort, path));
  }

  /** 让某条路由的摘除失败。 */
  failDeletion(path: string, servePort: number = TEST_SERVE_PORT, service: string | null = null): void {
    this.failRemove.add(serveRouteKey(service, servePort, path));
  }

  /** 全部路由位置，便于断言。 */
  routes(): Array<{ service: string | null; servePort: number; path: string; proxy: string }> {
    return [...this.handlers.entries()].map(([k, proxy]) => {
      const { service, servePort, path } = unkey(k);
      return { service, servePort, path, proxy };
    });
  }

  /* ------------------------------ 网关实现 ------------------------------ */

  describeSource(): string {
    return 'fake-tailscale';
  }

  async snapshot(): Promise<ServeSnapshot> {
    const routes: ServeRoute[] = this.routes()
      .map(({ service, servePort, path, proxy }) => {
        const parsed = new URL(proxy);
        const host = parsed.hostname;
        const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
        return {
          service,
          servePort,
          host: service
            ? `${service.replace(/^svc:/, '')}.example-tailnet.ts.net`
            : 'my-laptop.example-tailnet.ts.net',
          path,
          handler: {
            kind: 'proxy' as const,
            raw: proxy,
            hostPort: Number(parsed.port),
            host,
            targetPath: parsed.pathname === '/' ? '' : parsed.pathname,
            loopback,
            // 与真实网关一致：Service 配置读回来的端点带这个标记。
            ...(service ? { fromServiceConfig: true } : {}),
          },
          managed: false,
          mappingId: null,
        };
      })
      .sort(
        (a, b) =>
          a.servePort - b.servePort ||
          (a.service ?? '').localeCompare(b.service ?? '') ||
          a.path.localeCompare(b.path),
      );
    return {
      httpsPorts: [...this.httpsPorts].sort((a, b) => a - b),
      hostname: 'my-laptop.example-tailnet.ts.net',
      routes,
      services: structuredClone(this.services),
    };
  }

  async tailnet(): Promise<TailnetInfo> {
    return structuredClone(this.tailnetInfo);
  }

  async upsertRoute(
    servePort: number,
    path: string,
    proxyUrl: string,
    service: string | null = null,
  ): Promise<void> {
    this.calls.push({ op: 'upsert', service, servePort, path, proxy: proxyUrl });
    const key = serveRouteKey(service, servePort, path);
    if (this.failUpsert.has(key)) throw new Error(`模拟失败：无法挂载 ${servePort}:${path}`);
    this.handlers.set(key, proxyUrl);
    this.httpsPorts.add(servePort);
  }

  async removeRoute(servePort: number, path: string, service: string | null = null): Promise<void> {
    this.calls.push({ op: 'remove', service, servePort, path });
    const key = serveRouteKey(service, servePort, path);
    if (this.failRemove.has(key)) throw new Error(`模拟失败：无法摘除 ${servePort}:${path}`);
    this.handlers.delete(key);
  }

  async clearService(service: string): Promise<void> {
    this.clearedServices.push(service);
    for (const [k] of [...this.handlers.entries()]) {
      const route = unkey(k);
      if ((route.service ?? '') === service) this.handlers.delete(k);
    }
    this.services = this.services.filter((s) => s.name !== service);
  }
}

/** 把内部键拆回 Service、端口与路径。 */
function unkey(key: string): { service: string | null; servePort: number; path: string } {
  const parts = key.split('|');
  const service = parts[0] === '-' ? null : parts[0]!;
  return { service, servePort: Number(parts[1]), path: parts[2]! };
}

/** 内存容器清单。 */
export class FakeContainerSource implements ContainerSource {
  containers: ContainerInfo[];

  constructor(containers: ContainerInfo[] = []) {
    this.containers = containers;
  }

  describeSource(): string {
    return 'fake-docker';
  }

  async listContainers(): Promise<ContainerInfo[]> {
    return structuredClone(this.containers);
  }
}

/** 构造一个容器。 */
export function makeContainer(
  name: string,
  ports: Array<{ hostPort: number; containerPort: number; hostIp?: string }>,
  state = 'running',
): ContainerInfo {
  return {
    id: `id-${name}`.padEnd(64, '0'),
    name,
    image: `${name}:local`,
    state,
    status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 5 minutes ago',
    composeProject: name,
    composeService: name,
    createdAt: 1_700_000_000_000,
    ports: ports.map((p) => ({
      hostIp: p.hostIp ?? '127.0.0.1',
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      protocol: 'tcp' as const,
    })),
  };
}
