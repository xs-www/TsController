/**
 * Tailscale 网关：把 CLI 输出整理成领域模型，并向映射层暴露最小接口。
 */

import type { ServeSnapshot, TailnetInfo } from '../domain/types.ts';
import { parseServeStatus } from './serve-config.ts';
import type { TailscaleCli } from './tailscale-cli.ts';

/**
 * 映射层依赖的网关接口。
 *
 * 刻意不暴露 CLI 细节：测试可以用内存假实现替换，无需真实 Tailscale。
 */
export interface ServeGateway {
  /** 读取 serve 配置快照（**全部** HTTPS 端口）。 */
  snapshot(): Promise<ServeSnapshot>;
  /** 读取本机 tailnet 身份。 */
  tailnet(): Promise<TailnetInfo>;
  /** 在指定 HTTPS 端口上挂载/覆盖一条路径。 */
  upsertRoute(servePort: number, path: string, proxyUrl: string): Promise<void>;
  /** 从指定 HTTPS 端口上摘除一条路径。 */
  removeRoute(servePort: number, path: string): Promise<void>;
  /** 数据来源描述。 */
  describeSource(): string;
}

interface RawSelf {
  DNSName?: string;
  TailscaleIPs?: string[];
  HostName?: string;
}

/** 解析 `tailscale status --json`，容忍字段缺失。 */
export function parseTailnetInfo(raw: unknown): TailnetInfo {
  const root = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const self = (typeof root.Self === 'object' && root.Self !== null ? root.Self : {}) as RawSelf;
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null;
  return {
    dnsName,
    baseUrl: dnsName ? `https://${dnsName}` : null,
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((v): v is string => typeof v === 'string') : [],
    hostname: typeof self.HostName === 'string' ? self.HostName : null,
    backendState: typeof root.BackendState === 'string' ? root.BackendState : null,
    version: typeof root.Version === 'string' ? root.Version : null,
  };
}

export class TailscaleServeGateway implements ServeGateway {
  readonly #cli: TailscaleCli;

  constructor(cli: TailscaleCli) {
    this.#cli = cli;
  }

  describeSource(): string {
    return this.#cli.bin;
  }

  async snapshot(): Promise<ServeSnapshot> {
    return parseServeStatus(await this.#cli.serveStatusJson());
  }

  async tailnet(): Promise<TailnetInfo> {
    return parseTailnetInfo(await this.#cli.statusJson());
  }

  async upsertRoute(servePort: number, path: string, proxyUrl: string): Promise<void> {
    await this.#cli.serveUpsert(servePort, path, proxyUrl);
  }

  async removeRoute(servePort: number, path: string): Promise<void> {
    await this.#cli.serveRemove(servePort, path);
  }
}
