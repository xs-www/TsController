/**
 * 容器清单归一化：把 Docker Engine 的原始结构压成路由所需的形状。
 */

import type { ContainerInfo, ContainerPort } from '../domain/types.ts';
import type { DockerTransport } from './docker-client.ts';

/** Docker `/containers/json` 中的端口项。 */
interface RawPort {
  IP?: string;
  PrivatePort?: number;
  PublicPort?: number;
  Type?: string;
}

/** Docker `/containers/json` 中的容器项（仅列出我们使用的字段）。 */
export interface RawContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Created?: number;
  Labels?: Record<string, string>;
  Ports?: RawPort[] | null;
}

export interface ContainerSource {
  listContainers(): Promise<ContainerInfo[]>;
  /** 数据来源描述，用于界面显示。 */
  describeSource(): string;
}

const KNOWN_PROTOCOLS = new Set(['tcp', 'udp', 'sctp']);

/** 把原始端口项归一化；`PublicPort` 缺失表示未发布到宿主机。 */
export function normalizePorts(raw: RawPort[] | null | undefined): ContainerPort[] {
  if (!raw) return [];
  const out: ContainerPort[] = [];
  for (const p of raw) {
    if (typeof p.PrivatePort !== 'number') continue;
    if (typeof p.PublicPort !== 'number') continue;
    const protocol = (p.Type ?? 'tcp').toLowerCase();
    out.push({
      hostIp: p.IP ?? '0.0.0.0',
      hostPort: p.PublicPort,
      containerPort: p.PrivatePort,
      protocol: (KNOWN_PROTOCOLS.has(protocol) ? protocol : 'tcp') as ContainerPort['protocol'],
    });
  }
  // 同一 hostPort 可能同时出现 IPv4/IPv6 两条记录，这里保留两者，
  // 因为「是否绑定到 0.0.0.0」对暴露风险判断有意义。
  return out.sort((a, b) => a.hostPort - b.hostPort || a.hostIp.localeCompare(b.hostIp));
}

/** 把一个原始容器对象归一化。 */
export function normalizeContainer(raw: RawContainer): ContainerInfo {
  const labels = raw.Labels ?? {};
  const name = (raw.Names?.[0] ?? '').replace(/^\//, '');
  return {
    id: raw.Id ?? '',
    name: name || (raw.Id ?? '').slice(0, 12),
    image: raw.Image ?? '',
    state: raw.State ?? 'unknown',
    status: raw.Status ?? '',
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
    createdAt: typeof raw.Created === 'number' ? raw.Created * 1000 : 0,
    ports: normalizePorts(raw.Ports),
  };
}

/** 基于 DockerTransport 的容器清单实现。 */
export class DockerContainerService implements ContainerSource {
  readonly #transport: DockerTransport;

  constructor(transport: DockerTransport) {
    this.#transport = transport;
  }

  describeSource(): string {
    return this.#transport.endpoint();
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const raw = await this.#transport.request<RawContainer[]>('/containers/json?all=1');
    return (raw ?? []).map(normalizeContainer).sort((a, b) => a.name.localeCompare(b.name));
  }
}
