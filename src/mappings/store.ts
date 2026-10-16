/**
 * 映射库与审计日志的持久化。
 *
 * 数据量极小（几十条），因此用单文件 JSON + 原子替换，避免引入原生依赖。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeRoutePath,
  normalizeServiceName,
  isValidPort,
  serveRouteKey,
  normalizeRemoteHost,
} from '../domain/route-path.ts';
import type { AuditEvent, Mapping, MappingTarget, OwnedRoute } from '../domain/types.ts';
import type { Logger } from '../logger.ts';

export interface MappingStore {
  read(): Promise<Mapping[]>;
  write(mappings: Mapping[]): Promise<void>;
}

interface StoredShape {
  version: number;
  mappings: Mapping[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验并归一化一条「已占用路由」记录。 */
function reviveOwnedRoutes(
  raw: unknown,
  fallbackPort: number,
  fallbackService: string | null = null,
): OwnedRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: OwnedRoute[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const pathCheck = normalizeRoutePath(typeof item.path === 'string' ? item.path : '');
    if (!pathCheck.ok) continue;
    const port = isValidPort(Number(item.servePort)) ? Number(item.servePort) : fallbackPort;
    // Service 维度缺失（旧格式）时归属到该映射自身的 Service。
    const serviceCheck = item.service === undefined
      ? { ok: true, service: fallbackService }
      : normalizeServiceName(typeof item.service === 'string' ? item.service : null);
    if (!serviceCheck.ok) continue;
    const key = serveRouteKey(serviceCheck.service, port, pathCheck.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ service: serviceCheck.service, servePort: port, path: pathCheck.path });
  }
  return out;
}

/**
 * 反序列化时做一次严格校验。
 *
 * 磁盘上的文件可能被手工编辑或来自旧版本，任何非法条目都应被丢弃而不是让
 * 整个进程在后续流程中带着脏数据崩溃。
 *
 * `defaultServePort` 用于补全缺失端口（旧格式没有该字段），以及迁移旧的
 * `ownedPaths: string[]`——那时路径没有端口维度，只能归属到映射自己的端口。
 * Service 维度同理：旧记录一律视为节点级（`service: null`）。
 */
export function reviveMapping(raw: unknown, defaultServePort: number, logger?: Logger): Mapping | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id === '') return null;

  const pathCheck = normalizeRoutePath(typeof raw.path === 'string' ? raw.path : '');
  if (!pathCheck.ok) {
    logger?.warn('丢弃映射：路径非法', { id, path: raw.path, reason: pathCheck.reason });
    return null;
  }

  const t = isRecord(raw.target) ? raw.target : {};
  const hostPort = Number(t.hostPort);
  if (!isValidPort(hostPort)) {
    logger?.warn('丢弃映射：宿主机端口非法', { id, hostPort: t.hostPort });
    return null;
  }

  const kind: MappingTarget['kind'] = t.kind === 'host' ? 'host' : 'container';
  const targetPath = typeof t.targetPath === 'string' && t.targetPath !== '/' ? t.targetPath : '';
  const target: MappingTarget = { kind, hostPort, targetPath };
  const remote = normalizeRemoteHost(typeof t.remoteHost === 'string' ? t.remoteHost : null);
  if (!remote.ok) {
    logger?.warn('丢弃映射：远端主机名非法', { id, remoteHost: t.remoteHost, reason: remote.reason });
    return null;
  }
  if (remote.host !== null) target.remoteHost = remote.host;
  if (t.scheme === 'https') target.scheme = 'https';
  if (typeof t.containerId === 'string') target.containerId = t.containerId;
  if (typeof t.containerName === 'string') target.containerName = t.containerName;
  if (Number.isInteger(t.containerPort)) target.containerPort = Number(t.containerPort);

  // 远端目标不可能是本机容器的已发布端口，避免脏数据把两类目标混在一起。
  if (target.remoteHost !== undefined) delete target.containerId;

  const rawPort = Number(raw.servePort);
  const servePort = isValidPort(rawPort) ? rawPort : defaultServePort;

  const serviceCheck = normalizeServiceName(typeof raw.service === 'string' ? raw.service : null);
  const service = serviceCheck.ok ? serviceCheck.service : null;
  if (!serviceCheck.ok && raw.service !== undefined && raw.service !== null) {
    logger?.warn('映射的 Service 名非法，按节点级处理', { id, service: raw.service, reason: serviceCheck.reason });
  }

  // 新格式优先；旧格式的 ownedPaths 没有端口维度，按本映射的端口迁移。
  const ownedRoutes =
    raw.ownedRoutes !== undefined
      ? reviveOwnedRoutes(raw.ownedRoutes, servePort, service)
      : reviveOwnedRoutes(
          Array.isArray(raw.ownedPaths)
            ? raw.ownedPaths.map((p) => ({ path: p, servePort }))
            : [],
          servePort,
          service,
        );

  return {
    id,
    service,
    path: pathCheck.path,
    servePort,
    target,
    note: typeof raw.note === 'string' ? raw.note : '',
    enabled: raw.enabled !== false,
    ownedRoutes,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

/** 基于文件的映射库。写入采用「临时文件 + rename」，避免半截文件。 */
export class FileMappingStore implements MappingStore {
  readonly #file: string;
  readonly #logger: Logger;
  readonly #defaultServePort: number;

  constructor(dataDir: string, logger: Logger, defaultServePort: number) {
    this.#file = path.join(dataDir, 'mappings.json');
    this.#logger = logger;
    this.#defaultServePort = defaultServePort;
  }

  get filePath(): string {
    return this.#file;
  }

  async read(): Promise<Mapping[]> {
    let text: string;
    try {
      text = await fs.readFile(this.#file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#logger.error('mappings.json 解析失败，按空库启动', { file: this.#file });
      return [];
    }
    const rawList = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.mappings)
        ? parsed.mappings
        : [];
    return rawList
      .map((r) => reviveMapping(r, this.#defaultServePort, this.#logger))
      .filter((m): m is Mapping => m !== null);
  }

  async write(mappings: Mapping[]): Promise<void> {
    const payload: StoredShape = { version: 1, mappings };
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, this.#file);
  }
}

/** 内存实现，供单元测试使用。 */
export class MemoryMappingStore implements MappingStore {
  #items: Mapping[];

  constructor(initial: Mapping[] = []) {
    this.#items = structuredClone(initial);
  }

  async read(): Promise<Mapping[]> {
    return structuredClone(this.#items);
  }

  async write(mappings: Mapping[]): Promise<void> {
    this.#items = structuredClone(mappings);
  }
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
  tail(limit: number): Promise<AuditEvent[]>;
}

/** 追加式审计日志（JSONL）。用于追踪安全策略的实际执行情况。 */
export class FileAuditLog implements AuditLog {
  readonly #file: string;
  readonly #logger: Logger;
  #cache: AuditEvent[] = [];
  #loaded = false;

  constructor(dataDir: string, logger: Logger) {
    this.#file = path.join(dataDir, 'audit.jsonl');
    this.#logger = logger;
  }

  get filePath(): string {
    return this.#file;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const text = await fs.readFile(this.#file, 'utf8');
      this.#cache = text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try {
            return JSON.parse(l) as AuditEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEvent => e !== null);
    } catch {
      this.#cache = [];
    }
  }

  async append(event: AuditEvent): Promise<void> {
    await this.#load();
    this.#cache.push(event);
    if (this.#cache.length > 1000) this.#cache = this.#cache.slice(-1000);
    try {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.appendFile(this.#file, JSON.stringify(event) + '\n', 'utf8');
    } catch (err) {
      this.#logger.warn('审计日志写入失败', { error: (err as Error).message });
    }
  }

  async tail(limit: number): Promise<AuditEvent[]> {
    await this.#load();
    return this.#cache.slice(-limit).reverse();
  }
}

/** 内存审计日志，供测试使用。 */
export class MemoryAuditLog implements AuditLog {
  #items: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.#items.push(event);
  }

  async tail(limit: number): Promise<AuditEvent[]> {
    return this.#items.slice(-limit).reverse();
  }
}
