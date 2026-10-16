/**
 * 测试替身：内存版 serve 网关与容器清单。
 *
 * 有了它们，映射服务与 HTTP API 的全部行为都能在无 Docker、无 Tailscale 的
 * 沙箱里被完整覆盖。
 *
 * 路由身份是「端口 + 路径」，因此内部用 `serveRouteKey()` 作键。为保持可读性，
 * 构造函数的键支持两种写法：`"/app"`（默认 443）与 `":8443/app"`（指定端口）。
 */

import { serveRouteKey } from '../src/domain/route-path.ts';
import type { ContainerInfo, ServeRoute, ServeSnapshot, TailnetInfo } from '../src/domain/types.ts';
import type { ContainerSource } from '../src/docker/docker-service.ts';
import type { ServeGateway } from '../src/tailscale/tailscale-service.ts';

/** 测试里默认的对外端口；绝大多数用例只关心它。 */
export const TEST_SERVE_PORT = 443;

/** 解析测试用的简写键：`"/app"` → (443, "/app")；`":8443/app"` → (8443, "/app")。 */
export function parseFakeRouteKey(key: string): { servePort: number; path: string } {
  const m = /^:(\d+)(\/.*)$/.exec(key);
  if (m) return { servePort: Number(m[1]), path: m[2]! };
  return { servePort: TEST_SERVE_PORT, path: key };
}

/** 内存 serve 网关：`handlers` 就是“真实”的 serve 配置。 */
export class FakeServeGateway implements ServeGateway {
  /** 键为 `serveRouteKey(port, path)`。 */
  readonly handlers = new Map<string, string>();
  /** serve 中已声明的 HTTPS 端口。 */
  readonly httpsPorts = new Set<number>([TEST_SERVE_PORT]);

  tailnetInfo: TailnetInfo = {
    dnsName: 'my-laptop.example-tailnet.ts.net',
    baseUrl: 'https://my-laptop.example-tailnet.ts.net',
    ips: ['100.101.102.103'],
    hostname: 'My-Laptop',
    backendState: 'Running',
    version: '1.102.4',
  };
  /** 让指定路由的写入失败，用于验证失败可重试。键同 `handlers`。 */
  readonly failUpsert = new Set<string>();
  readonly failRemove = new Set<string>();
  /** 记录调用轨迹。 */
  readonly calls: Array<{ op: 'upsert' | 'remove'; servePort: number; path: string; proxy?: string }> = [];

  constructor(initial: Record<string, string> = {}, extraPorts: number[] = []) {
    for (const [k, v] of Object.entries(initial)) {
      const { servePort, path } = parseFakeRouteKey(k);
      this.handlers.set(serveRouteKey(servePort, path), v);
      this.httpsPorts.add(servePort);
    }
    for (const p of extraPorts) this.httpsPorts.add(p);
  }

  /* ------------------------- 便于断言的读写助手 ------------------------- */

  /** 取某条路由的代理地址；不存在返回 undefined。 */
  proxyOf(path: string, servePort: number = TEST_SERVE_PORT): string | undefined {
    return this.handlers.get(serveRouteKey(servePort, path));
  }

  /** 某条路由是否存在。 */
  has(path: string, servePort: number = TEST_SERVE_PORT): boolean {
    return this.handlers.has(serveRouteKey(servePort, path));
  }

  /** 直接设置一条路由（绕过调用轨迹，用于准备前置状态）。 */
  set(path: string, proxy: string, servePort: number = TEST_SERVE_PORT): void {
    this.handlers.set(serveRouteKey(servePort, path), proxy);
    this.httpsPorts.add(servePort);
  }

  /** 让某条路由的挂载失败。 */
  fail(path: string, servePort: number = TEST_SERVE_PORT): void {
    this.failUpsert.add(serveRouteKey(servePort, path));
  }

  /** 让某条路由的摘除失败。 */
  failDeletion(path: string, servePort: number = TEST_SERVE_PORT): void {
    this.failRemove.add(serveRouteKey(servePort, path));
  }

  /** 全部路由位置，便于断言。 */
  routes(): Array<{ servePort: number; path: string; proxy: string }> {
    return [...this.handlers.entries()].map(([k, proxy]) => {
      const { servePort, path } = unkey(k);
      return { servePort, path, proxy };
    });
  }

  /* ------------------------------ 网关实现 ------------------------------ */

  describeSource(): string {
    return 'fake-tailscale';
  }

  async snapshot(): Promise<ServeSnapshot> {
    const routes: ServeRoute[] = this.routes()
      .map(({ servePort, path, proxy }) => {
        const url = new URL(proxy);
        return {
          servePort,
          host: 'my-laptop.example-tailnet.ts.net',
          path,
          handler: {
            kind: 'proxy' as const,
            raw: proxy,
            hostPort: Number(url.port),
            targetPath: url.pathname === '/' ? '' : url.pathname,
            loopback: true,
          },
          managed: false,
          mappingId: null,
        };
      })
      .sort((a, b) => a.servePort - b.servePort || a.path.localeCompare(b.path));
    return { httpsPorts: [...this.httpsPorts].sort((a, b) => a - b), hostname: 'my-laptop.example-tailnet.ts.net', routes };
  }

  async tailnet(): Promise<TailnetInfo> {
    return this.tailnetInfo;
  }

  async upsertRoute(servePort: number, path: string, proxyUrl: string): Promise<void> {
    this.calls.push({ op: 'upsert', servePort, path, proxy: proxyUrl });
    const key = serveRouteKey(servePort, path);
    if (this.failUpsert.has(key)) throw new Error(`模拟失败：无法挂载 ${servePort}:${path}`);
    this.handlers.set(key, proxyUrl);
    this.httpsPorts.add(servePort);
  }

  async removeRoute(servePort: number, path: string): Promise<void> {
    this.calls.push({ op: 'remove', servePort, path });
    const key = serveRouteKey(servePort, path);
    if (this.failRemove.has(key)) throw new Error(`模拟失败：无法摘除 ${servePort}:${path}`);
    this.handlers.delete(key);
  }
}

/** 把内部键拆回端口与路径。 */
function unkey(key: string): { servePort: number; path: string } {
  const idx = key.indexOf('|');
  return { servePort: Number(key.slice(0, idx)), path: key.slice(idx + 1) };
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
