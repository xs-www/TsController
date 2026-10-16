/**
 * Tailscale 网关：把 CLI 输出整理成领域模型，并向映射层暴露最小接口。
 */

import { suffixFromNodeDnsName } from '../domain/route-path.ts';
import type { ServeSnapshot, TailnetInfo } from '../domain/types.ts';
import { mergeServeSnapshots, parseServiceConfig, parseServeStatus } from './serve-config.ts';
import type { TailscaleCli } from './tailscale-cli.ts';
import type { Logger } from '../logger.ts';

/**
 * 映射层依赖的网关接口。
 *
 * 刻意不暴露 CLI 细节：测试可以用内存假实现替换，无需真实 Tailscale。
 */
export interface ServeGateway {
  /** 读取 serve 配置快照（**全部** HTTPS 端口 + 节点级与 Service 级两个命名空间）。 */
  snapshot(): Promise<ServeSnapshot>;
  /** 读取本机 tailnet 身份。 */
  tailnet(): Promise<TailnetInfo>;
  /** 挂载/覆盖一条路径。`service` 为空表示节点级。 */
  upsertRoute(servePort: number, path: string, proxyUrl: string, service?: string | null): Promise<void>;
  /** 摘除一条路径。`service` 为空表示节点级。 */
  removeRoute(servePort: number, path: string, service?: string | null): Promise<void>;
  /**
   * 摘除某个 Service 在本节点上的全部端点配置（可选能力）。
   *
   * 只有真实网关实现它；假实现可以省略，调用方必须容忍 `undefined`。
   */
  clearService?(service: string): Promise<void>;
  /** 数据来源描述。 */
  describeSource(): string;
}

interface RawSelf {
  DNSName?: string;
  TailscaleIPs?: string[];
  HostName?: string;
  Tags?: unknown;
  CapMap?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 `Self.CapMap` 里的 `service-host` 能力解析成 `{ svc:名 → TailVIP[] }`。
 *
 * 该能力的值形如 `{ "svc:samba": ["100.65.32.1", "fd7a:..."] }`。不同版本的
 * 序列化形态不一致（既可能是对象，也可能是 `[{...}]` 数组），因此这里做
 * 双形态解析，并**静默忽略**解析不出来的部分——它的唯一用途是把 Service
 * 标成「已被承认」，解析失败退化成「未承认」不会造成危险，只是界面提示更保守。
 */
export function parseServiceHostCap(capMap: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  const collect = (value: unknown): void => {
    if (!isRecord(value)) return;
    for (const [name, ips] of Object.entries(value)) {
      if (!name.startsWith('svc:')) continue;
      const list = Array.isArray(ips) ? ips.filter((v): v is string => typeof v === 'string') : [];
      out[name] = list;
    }
  };

  const find = (container: unknown): unknown => {
    if (!isRecord(container)) return undefined;
    return container['service-host'] ?? container['tailscale.com/cap/service-host'];
  };

  if (Array.isArray(capMap)) {
    for (const entry of capMap) collect(find(entry));
    if (Object.keys(out).length === 0) {
      // 形态二：[{ "service-host": {...} }, ...] 之外，也可能是裸的映射数组。
      for (const entry of capMap) collect(entry);
    }
  } else {
    collect(find(capMap));
  }
  return out;
}

/** 解析 `tailscale status --json`，容忍字段缺失。 */
export function parseTailnetInfo(raw: unknown): TailnetInfo {
  const root = isRecord(raw) ? raw : {};
  const self = (isRecord(root['Self']) ? root['Self'] : {}) as RawSelf;
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null;
  const currentTailnet = isRecord(root['CurrentTailnet']) ? root['CurrentTailnet'] : {};
  const magicDnsSuffix =
    (typeof currentTailnet['MagicDNSSuffix'] === 'string' && currentTailnet['MagicDNSSuffix'] !== ''
      ? currentTailnet['MagicDNSSuffix']
      : null) ?? suffixFromNodeDnsName(dnsName);

  return {
    dnsName,
    baseUrl: dnsName ? `https://${dnsName}` : null,
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((v): v is string => typeof v === 'string') : [],
    hostname: typeof self.HostName === 'string' ? self.HostName : null,
    backendState: typeof root['BackendState'] === 'string' ? root['BackendState'] : null,
    version: typeof root['Version'] === 'string' ? root['Version'] : null,
    magicDnsSuffix: magicDnsSuffix ? magicDnsSuffix.replace(/^\.+|\.+$/g, '') : null,
    tags: Array.isArray(self.Tags) ? self.Tags.filter((v): v is string => typeof v === 'string') : [],
    serviceHosts: parseServiceHostCap(self.CapMap),
  };
}

export class TailscaleServeGateway implements ServeGateway {
  readonly #cli: TailscaleCli;
  readonly #logger: Logger | undefined;

  constructor(cli: TailscaleCli, logger?: Logger) {
    this.#cli = cli;
    this.#logger = logger;
  }

  describeSource(): string {
    return this.#cli.bin;
  }

  /**
   * 合并两个数据源成一份快照。
   *
   * `serve get-config --all` 是 Service 路由的**唯一**来源。它在两种情况下会失败：
   * 老版本 CLI 不认识 `--all`、或本节点不是任何 Service 的 host。前者只降级（记警告），
   * **绝不**让整个快照失败——否则界面会因为「读不到 Service」而连节点级路由都看不见。
   */
  async snapshot(): Promise<ServeSnapshot> {
    const [statusRaw, statusJson] = await Promise.all([this.#cli.serveStatusJson(), this.#cli.statusJson()]);
    const nodeLevel = parseServeStatus(statusRaw);
    const tailnet = parseTailnetInfo(statusJson);

    let serviceLevel: ServeSnapshot = { httpsPorts: [], hostname: null, routes: [], services: [] };
    try {
      serviceLevel = parseServiceConfig(await this.#cli.serveGetConfig(), tailnet.magicDnsSuffix);
    } catch (err) {
      this.#logger?.warn('无法读取 Service 配置（serve get-config --all）；Service 路由将不可见', {
        error: (err as Error).message,
      });
    }

    return mergeServeSnapshots(nodeLevel, serviceLevel, tailnet.serviceHosts);
  }

  async tailnet(): Promise<TailnetInfo> {
    return parseTailnetInfo(await this.#cli.statusJson());
  }

  async upsertRoute(servePort: number, path: string, proxyUrl: string, service?: string | null): Promise<void> {
    await this.#cli.serveUpsert(servePort, path, proxyUrl, service);
  }

  async removeRoute(servePort: number, path: string, service?: string | null): Promise<void> {
    await this.#cli.serveRemove(servePort, path, service);
  }

  async clearService(service: string): Promise<void> {
    await this.#cli.serveClear(service);
  }
}
