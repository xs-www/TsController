/**
 * 映射服务：把「用户意图（映射库）」收敛到「系统状态（tailscale serve 配置）」。
 *
 * 模型是声明式的：
 *   映射库 = 期望状态；serve 配置 = 实际状态；apply() = 收敛动作。
 * 每次增删改都会自动触发一次 apply，失败也不会回滚映射库，而是留下一个
 * `pending` 状态让用户重试——这样「用户意图」永远不会因为一次 CLI 抖动而丢失。
 *
 * 路由身份是 `(service, servePort, path)`：节点级与 Service 级是两个命名空间。
 */

import { randomUUID } from 'node:crypto';
import {
  normalizeRoutePath,
  normalizeTargetPath,
  normalizeServiceName,
  normalizeRemoteHost,
  buildBaseUrl,
  isValidPort,
  serveRouteKey,
  formatRouteRef,
} from '../domain/route-path.ts';
import type {
  AuditEvent,
  ContainerInfo,
  Mapping,
  MappingStatus,
  MappingTarget,
  MappingView,
  OwnedRoute,
  RouteRef,
  ServeRoute,
  ServeSnapshot,
  ServiceInfo,
  TailnetInfo,
} from '../domain/types.ts';
import type { Logger } from '../logger.ts';
import type { ContainerSource } from '../docker/docker-service.ts';
import type { ServeGateway } from '../tailscale/tailscale-service.ts';
import { desiredProxyOf, isInSync, planReconcile, type ReconcilePlan } from './reconcile.ts';
import type { AuditLog, MappingStore } from './store.ts';
import { buildSnapshot, type Snapshot, type SnapshotWriter } from '../snapshot.ts';

export interface MappingServiceDeps {
  store: MappingStore;
  gateway: ServeGateway;
  containers: ContainerSource;
  audit: AuditLog;
  logger: Logger;
  /** 管理界面端口，用于安全判定。 */
  adminPort: number;
  /** 新建映射时的默认对外 HTTPS 端口。 */
  servePort: number;
  /** 是否自动摘除指向管理端口的 serve 路由。 */
  autoUnexpose: boolean;
  /**
   * serve 路由快照写出器。
   *
   * 每次收敛后都会刷新它，使其它项目（容器）能通过只读挂载的文件读取路由状态，
   * 而无需访问 TsController 的 HTTP 接口。
   */
  snapshot: SnapshotWriter;
}

export interface ApplyResult {
  /** 本次真正写入的路由位置（Service + 端口 + 路径）。 */
  upserted: RouteRef[];
  /** 本次真正摘除的路由位置。 */
  removed: RouteRef[];
  /** 因安全策略被拒绝的映射。 */
  blocked: ReconcilePlan['blocked'];
  /** 检测到并（若开启自动修复）清理掉的管理端口暴露。 */
  exposures: ReconcilePlan['exposures'];
  errors: string[];
  /** 应用完成后是否已完全同步。 */
  inSync: boolean;
}

/** 创建/更新映射的入参（已由 API 层做过 zod 校验）。 */
export interface MappingInput {
  path: string;
  hostPort: number;
  /** 对外 HTTPS 端口；省略时用配置里的默认端口。 */
  servePort?: number;
  targetPath?: string;
  /**
   * 关联的 Tailscale Service，接受 `dsh` 或 `svc:dsh` 两种写法。
   *
   * 传 `''`/`null` 表示节点级路由；省略则沿用已有值（更新时）。
   */
  service?: string | null;
  /** 代理目标主机；省略即本机。 */
  remoteHost?: string | null;
  scheme?: 'http' | 'https';
  kind?: MappingTarget['kind'];
  containerId?: string;
  containerName?: string;
  containerPort?: number;
  note?: string;
  enabled?: boolean;
  /** 当目标位置已被一条「未托管」的 serve 路由占用时，需要显式确认接管。 */
  confirmTakeover?: boolean;
}

export class MappingConflictError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MappingConflictError';
    this.code = code;
  }
}

export class MappingService {
  readonly #deps: MappingServiceDeps;
  /** 串行化所有「读-改-写」，避免并发请求互相覆盖。 */
  #queue: Promise<unknown> = Promise.resolve();
  /** 最近一次成功读取的 tailnet 身份，供界面拼 Service 地址；读失败时为 null。 */
  #tailnet: TailnetInfo | null = null;

  constructor(deps: MappingServiceDeps) {
    this.#deps = deps;
  }

  get adminPort(): number {
    return this.#deps.adminPort;
  }

  /** 把操作排入串行队列。 */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #audit(kind: AuditEvent['kind'], message: string, detail?: Record<string, unknown>): Promise<void> {
    await this.#deps.audit.append({ at: new Date().toISOString(), kind, message, ...(detail ? { detail } : {}) });
  }

  /** 读取 tailnet 身份；失败不影响主干流程（只影响界面上的地址显示）。 */
  async #readTailnet(): Promise<TailnetInfo | null> {
    try {
      this.#tailnet = await this.#deps.gateway.tailnet();
      return this.#tailnet;
    } catch (err) {
      this.#deps.logger.warn('读取 tailnet 身份失败（界面上的访问地址可能不完整）', {
        error: (err as Error).message,
      });
      return this.#tailnet;
    }
  }

  /** 读取全部映射并计算实时状态。 */
  async #evaluateAll(): Promise<{
    mappings: Mapping[];
    plan: ReconcilePlan;
    containers: ContainerInfo[];
    snapshot: ServeSnapshot;
    tailnet: TailnetInfo | null;
  }> {
    const [mappings, snapshot, containers, tailnet] = await Promise.all([
      this.#deps.store.read(),
      this.#deps.gateway.snapshot(),
      this.#deps.containers.listContainers(),
      this.#readTailnet(),
    ]);
    const plan = planReconcile({
      mappings,
      snapshot,
      containers,
      adminPort: this.#deps.adminPort,
      tailnet,
    });
    return { mappings, plan, containers, snapshot, tailnet };
  }

  #toView(m: Mapping, plan: ReconcilePlan): MappingView {
    const ev = plan.evaluations.get(m.id);
    return {
      ...m,
      status: ev?.status ?? 'pending',
      desiredProxy: ev?.desiredProxy ?? desiredProxyOf(m.target),
      actualProxy: ev?.actualProxy ?? null,
      baseUrl: ev?.baseUrl ?? null,
      detail: ev?.detail ?? null,
    };
  }

  /** 供 API 使用的整体视图。 */
  async overview(): Promise<{
    mappings: MappingView[];
    externalRoutes: Array<{
      service: string | null;
      servePort: number;
      path: string;
      proxy: string | null;
      hostPort: number | null;
      host: string | null;
      kind: string;
      /** 从 Service 配置读到的端点（其 handler 树不完整，只能读不能据此重建）。 */
      fromServiceConfig: boolean;
      /** Service 级路由对应的 Service 状态；非 Service 路由为 null。 */
      serviceInfo: ServiceInfo | null;
    }>;
    services: ServiceInfo[];
    /** 当前节点是否有 tag 身份（Service host 的前提）。 */
    selfTags: string[];
    planSummary: { upserts: number; removals: number; blocked: number; exposures: number; inSync: boolean };
    counts: Record<MappingStatus, number>;
  }> {
    const { mappings, plan, snapshot, tailnet } = await this.#evaluateAll();
    const managedKeys = this.#ownedKeys(mappings);

    const externalRoutes: Array<{
      service: string | null;
      servePort: number;
      path: string;
      proxy: string | null;
      hostPort: number | null;
      host: string | null;
      kind: string;
      fromServiceConfig: boolean;
      serviceInfo: ServiceInfo | null;
    }> = [];
    for (const r of snapshot.routes) {
      if (managedKeys.has(serveRouteKey(r.service, r.servePort, r.path))) continue;
      externalRoutes.push({
        service: r.service,
        servePort: r.servePort,
        path: r.path,
        proxy: r.handler.kind === 'proxy' ? r.handler.raw : null,
        hostPort: r.handler.kind === 'proxy' ? r.handler.hostPort : null,
        host: r.handler.kind === 'proxy' ? (r.handler.host ?? null) : null,
        kind: r.handler.kind,
        fromServiceConfig: r.handler.kind === 'proxy' && r.handler.fromServiceConfig === true,
        serviceInfo: r.service
          ? (snapshot.services.find((s) => s.name.toLowerCase() === r.service!.toLowerCase()) ?? null)
          : null,
      });
    }
    externalRoutes.sort(
      (a, b) =>
        a.servePort - b.servePort ||
        (a.service ?? '').localeCompare(b.service ?? '') ||
        a.path.localeCompare(b.path),
    );

    const views = mappings.map((m) => this.#toView(m, plan));
    const counts: Record<MappingStatus, number> = {
      active: 0,
      pending: 0,
      disabled: 0,
      'disabled-drift': 0,
      'orphaned-target': 0,
      blocked: 0,
      conflict: 0,
      'awaiting-approval': 0,
    };
    for (const v of views) counts[v.status] += 1;

    return {
      mappings: views,
      externalRoutes,
      services: snapshot.services,
      selfTags: tailnet?.tags ?? [],
      planSummary: {
        upserts: plan.upserts.length,
        removals: plan.removals.length,
        blocked: plan.blocked.length,
        exposures: plan.exposures.length,
        inSync: isInSync(plan) && plan.exposures.length === 0,
      },
      counts,
    };
  }

  /** 某条映射当前声明占用的全部位置键（含当前 service+servePort+path）。 */
  #ownedKeysOf(m: Mapping): string[] {
    return [...m.ownedRoutes, { service: m.service, servePort: m.servePort, path: m.path }].map((r) =>
      serveRouteKey(r.service, r.servePort, r.path),
    );
  }

  /** 全部映射声明占用的位置键集合。 */
  #ownedKeys(mappings: Mapping[]): Set<string> {
    const keys = new Set<string>();
    for (const m of mappings) for (const k of this.#ownedKeysOf(m)) keys.add(k);
    return keys;
  }

  /** 在容器清单里按宿主机端口反查容器，用于自动建立关联。 */
  async #matchContainer(hostPort: number, containerId?: string): Promise<Partial<MappingTarget>> {
    const containers = await this.#deps.containers.listContainers();
    const pool = containerId ? containers.filter((c) => c.id === containerId || c.id.startsWith(containerId)) : containers;
    for (const c of pool) {
      const port = c.ports.find((p) => p.hostPort === hostPort && p.protocol === 'tcp');
      if (port) {
        return { containerId: c.id, containerName: c.name, containerPort: port.containerPort };
      }
    }
    return {};
  }

  /** 校验入参并构造一条映射记录。 */
  async #buildMapping(input: MappingInput, existing?: Mapping): Promise<Mapping> {
    const pathCheck = normalizeRoutePath(input.path);
    if (!pathCheck.ok) throw new MappingConflictError('invalid-path', `路径非法：${pathCheck.reason}`);

    const targetCheck = normalizeTargetPath(input.targetPath);
    if (!targetCheck.ok) throw new MappingConflictError('invalid-target-path', `目标路径非法：${targetCheck.reason}`);

    if (!isValidPort(input.hostPort)) {
      throw new MappingConflictError('invalid-port', `宿主机端口必须是 1-65535 的整数，当前为 ${String(input.hostPort)}`);
    }

    // Service：空串/null 一律归一化为「节点级」；非法名直接拒绝（静默改写会指向不存在的 Service）。
    const hasServiceInput = input.service !== undefined;
    const serviceCheck = normalizeServiceName(input.service ?? null);
    let service: string | null;
    if (input.service === undefined) {
      service = existing?.service ?? null;
    } else if (input.service === null || input.service === '') {
      service = null;
    } else if (!serviceCheck.ok) {
      throw new MappingConflictError('invalid-service', `Service 名非法：${serviceCheck.reason}`);
    } else {
      service = serviceCheck.service;
    }

    const remoteCheck = normalizeRemoteHost(
      input.remoteHost !== undefined ? input.remoteHost : (existing?.target.remoteHost ?? null),
    );
    if (!remoteCheck.ok) {
      throw new MappingConflictError('invalid-remote-host', `代理目标主机非法：${remoteCheck.reason}`);
    }
    const remoteHost = remoteCheck.host;

    // 远端目标只在 Service 场景下有意义：节点级的 serve 由本机 tailscaled 承载，
    // 语义上也可以代理远端，但本工具把它限定在 Service 上，避免两种模型混用。
    if (remoteHost !== null && service === null) {
      throw new MappingConflictError(
        'remote-host-requires-service',
        `代理到远端主机（${remoteHost}）只在 Service 级路由上支持；节点级路由请使用本机端口。`,
      );
    }

    const scheme = input.scheme ?? existing?.target.scheme;
    if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
      throw new MappingConflictError('invalid-scheme', `代理协议只能是 http 或 https，当前为 ${String(scheme)}`);
    }

    const servePort = input.servePort ?? existing?.servePort ?? this.#deps.servePort;
    if (!isValidPort(servePort)) {
      throw new MappingConflictError(
        'invalid-serve-port',
        `对外端口必须是 1-65535 的整数，当前为 ${String(input.servePort)}`,
      );
    }

    // 目标端口就是管理端口 → 直接拒绝，避免把管理面写进 tailnet（仅对本机目标）。
    if (remoteHost === null && input.hostPort === this.#deps.adminPort) {
      throw new MappingConflictError(
        'exposes-admin',
        `端口 ${this.#deps.adminPort} 是 TsController 管理端口，禁止建立任何指向它的映射。`,
      );
    }

    // 对外端口与管理端口同号 → 拒绝，避免 https://<主机>:<管理端口> 被误认成管理界面。
    if (servePort === this.#deps.adminPort) {
      throw new MappingConflictError(
        'serve-port-is-admin',
        `对外端口 ${this.#deps.adminPort} 与 TsController 管理端口同号，会造成混淆，请换一个端口。`,
      );
    }

    const mappings = await this.#deps.store.read();
    const key = serveRouteKey(service, servePort, pathCheck.path);
    const duplicate = mappings.find(
      (m) => m.id !== existing?.id && serveRouteKey(m.service, m.servePort, m.path) === key,
    );
    if (duplicate) {
      throw new MappingConflictError(
        'duplicate-path',
        `${service ?? '节点级'} 端口 ${servePort} 上的路径 ${pathCheck.path} 已被映射 ${duplicate.id} 占用`,
      );
    }

    // 目标位置被「未托管」的 serve 路由占用时，必须显式确认接管。
    const snapshot = await this.#deps.gateway.snapshot();
    const managedKeys = this.#ownedKeys(mappings);
    const occupant = snapshot.routes.find((r) => serveRouteKey(r.service, r.servePort, r.path) === key);
    if (occupant && !managedKeys.has(key) && !input.confirmTakeover) {
      throw new MappingConflictError(
        'takeover-required',
        `${service ?? '节点级'} 端口 ${servePort} 上的路径 ${pathCheck.path} 已被 serve 中的未托管路由占用` +
          `（${occupant.handler.raw}）。若确认接管，请附加 confirmTakeover=true。`,
      );
    }

    // 远端目标不可能是本机容器的已发布端口。
    const matched =
      input.kind === 'host' || remoteHost !== null
        ? {}
        : await this.#matchContainer(input.hostPort, input.containerId);
    const kind: MappingTarget['kind'] =
      input.kind ?? (remoteHost !== null ? 'host' : matched.containerId ? 'container' : 'host');
    const now = new Date().toISOString();

    const target: MappingTarget = {
      kind,
      hostPort: input.hostPort,
      targetPath: targetCheck.path,
    };
    if (remoteHost !== null) target.remoteHost = remoteHost;
    if (scheme !== undefined) target.scheme = scheme;
    if (remoteHost === null) {
      const containerId = input.containerId ?? matched.containerId;
      const containerName = input.containerName ?? matched.containerName;
      const containerPort = input.containerPort ?? matched.containerPort;
      if (kind === 'container' && containerId) target.containerId = containerId;
      if (kind === 'container' && containerName) target.containerName = containerName;
      if (kind === 'container' && containerPort !== undefined) target.containerPort = containerPort;
    }

    return {
      id: existing?.id ?? randomUUID(),
      service,
      path: pathCheck.path,
      servePort,
      target,
      note: input.note ?? existing?.note ?? '',
      enabled: input.enabled ?? existing?.enabled ?? true,
      ownedRoutes: existing?.ownedRoutes ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  /** 新建映射，并立即尝试收敛。 */
  async create(input: MappingInput): Promise<{ mapping: MappingView; apply: ApplyResult }> {
    return this.#serialize(async () => {
      const mapping = await this.#buildMapping(input);
      const mappings = await this.#deps.store.read();
      mappings.push(mapping);
      await this.#deps.store.write(mappings);
      await this.#audit('apply', `创建映射 ${formatRouteRef(mapping)} → ${desiredProxyOf(mapping.target)}`, {
        mappingId: mapping.id,
        service: mapping.service,
      });
      const apply = await this.applyInternal();
      const view = await this.#viewOf(mapping.id);
      return { mapping: view, apply };
    });
  }

  /** 更新映射（路径、目标、备注、启用状态）。 */
  async update(id: string, input: MappingInput): Promise<{ mapping: MappingView; apply: ApplyResult }> {
    return this.#serialize(async () => {
      const mappings = await this.#deps.store.read();
      const index = mappings.findIndex((m) => m.id === id);
      if (index === -1) throw new MappingConflictError('not-found', `映射 ${id} 不存在`);
      const existing = mappings[index]!;

      const merged: MappingInput = {
        path: input.path,
        hostPort: input.hostPort,
        servePort: input.servePort ?? existing.servePort,
        targetPath: input.targetPath ?? existing.target.targetPath,
        note: input.note ?? existing.note,
        enabled: input.enabled ?? existing.enabled,
        ...(input.service !== undefined ? { service: input.service } : {}),
        ...(input.remoteHost !== undefined ? { remoteHost: input.remoteHost } : {}),
        ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.containerId !== undefined ? { containerId: input.containerId } : {}),
        ...(input.containerName !== undefined ? { containerName: input.containerName } : {}),
        ...(input.containerPort !== undefined ? { containerPort: input.containerPort } : {}),
        ...(input.confirmTakeover !== undefined ? { confirmTakeover: input.confirmTakeover } : {}),
      };
      const updated = await this.#buildMapping(merged, existing);
      mappings[index] = updated;
      await this.#deps.store.write(mappings);
      await this.#audit('apply', `更新映射 ${formatRouteRef(updated)}`, { mappingId: updated.id });
      const apply = await this.applyInternal();
      const view = await this.#viewOf(updated.id);
      return { mapping: view, apply };
    });
  }

  /** 删除映射：先从映射库移除，再摘除 serve 中它占用过的位置。 */
  async remove(id: string): Promise<{ removed: Mapping | null; apply: ApplyResult }> {
    return this.#serialize(async () => {
      const mappings = await this.#deps.store.read();
      const found = mappings.find((m) => m.id === id);
      if (!found) throw new MappingConflictError('not-found', `映射 ${id} 不存在`);
      const rest = mappings.filter((m) => m.id !== id);
      await this.#deps.store.write(rest);
      // 记录已从映射库消失，但仍需要把它在 serve 中占用过的位置摘掉，
      // 因此用一条「墓碑」记录参与本次收敛计算。
      const tombstone: Mapping = {
        ...found,
        enabled: false,
        ownedRoutes: [
          ...found.ownedRoutes.filter(
            (r) =>
              !(
                (r.service ?? null) === (found.service ?? null) &&
                r.servePort === found.servePort &&
                r.path.toLowerCase() === found.path.toLowerCase()
              ),
          ),
          { service: found.service, servePort: found.servePort, path: found.path },
        ],
      };
      const apply = await this.applyInternal([...rest, tombstone]);
      await this.#deps.store.write(rest);
      await this.#audit('apply', `删除映射 ${formatRouteRef(found)}`, { mappingId: found.id });
      return { removed: found, apply };
    });
  }

  /** 切换启用状态。 */
  async setEnabled(id: string, enabled: boolean): Promise<{ mapping: MappingView; apply: ApplyResult }> {
    const current = (await this.#deps.store.read()).find((m) => m.id === id);
    if (!current) throw new MappingConflictError('not-found', `映射 ${id} 不存在`);
    return this.update(id, {
      path: current.path,
      hostPort: current.target.hostPort,
      servePort: current.servePort,
      targetPath: current.target.targetPath,
      note: current.note,
      enabled,
    });
  }

  /**
   * 把 serve 中已有的未托管路由导入为受管映射。
   *
   * 两个来源都会被导入（这正是「接管」的价值所在——手工敲的命令行也能进映射库）：
   * - 节点级：`tailscale serve --set-path` 写下的路由；
   * - Service 级：`get-config --all` 读到的 Service 端点。
   *
   * Service 级路由的目标路径**无法从 `get-config` 读回**（上游实现只序列化主机与
   * 端口），因此导入时 `targetPath` 一律为空串——如果原本带路径，第一次 apply
   * 会按空路径重写。这是已知的有损点，界面上会标注。
   */
  async importExternal(
    selection?: Array<{ service?: string | null; servePort: number; path: string }>,
  ): Promise<{
    imported: Mapping[];
    skipped: Array<{ service: string | null; servePort: number; path: string; reason: string }>;
  }> {
    return this.#serialize(async () => {
      const [mappings, snapshot] = await Promise.all([this.#deps.store.read(), this.#deps.gateway.snapshot()]);
      const managedKeys = this.#ownedKeys(mappings);
      const imported: Mapping[] = [];
      const skipped: Array<{ service: string | null; servePort: number; path: string; reason: string }> = [];
      const wanted = selection
        ? new Set(selection.map((s) => serveRouteKey(s.service ?? null, s.servePort, s.path)))
        : null;

      for (const route of snapshot.routes) {
        const key = serveRouteKey(route.service, route.servePort, route.path);
        if (managedKeys.has(key)) continue;
        if (wanted && !wanted.has(key)) continue;
        const skip = (reason: string): void => {
          skipped.push({ service: route.service, servePort: route.servePort, path: route.path, reason });
        };
        if (route.handler.kind !== 'proxy' || route.handler.hostPort === null) {
          skip('不是可接管的 HTTP(S) 代理路由（tcp/unix/text 等形态本工具不托管）');
          continue;
        }
        if (route.handler.loopback && route.handler.hostPort === this.#deps.adminPort) {
          skip('指向 TsController 管理端口，禁止接管');
          continue;
        }
        if (route.servePort === this.#deps.adminPort) {
          skip('对外端口与 TsController 管理端口同号，禁止接管');
          continue;
        }

        const remoteHost = route.handler.loopback ? null : (route.handler.host ?? null);
        const matched = remoteHost === null ? await this.#matchContainer(route.handler.hostPort) : {};
        const now = new Date().toISOString();
        const target: MappingTarget = {
          kind: remoteHost !== null ? 'host' : matched.containerId ? 'container' : 'host',
          hostPort: route.handler.hostPort,
          // Service 端点的目标路径无法从 get-config 读回，只能按空路径接管。
          targetPath: route.handler.fromServiceConfig === true ? '' : route.handler.targetPath,
        };
        if (remoteHost !== null) target.remoteHost = remoteHost;
        if (matched.containerId) target.containerId = matched.containerId;
        if (matched.containerName) target.containerName = matched.containerName;
        if (matched.containerPort !== undefined && remoteHost === null) target.containerPort = matched.containerPort;

        imported.push({
          id: randomUUID(),
          service: route.service,
          path: route.path,
          servePort: route.servePort,
          target,
          note:
            route.handler.fromServiceConfig === true
              ? '从现有 Tailscale Service 端点导入（目标路径以空路径接管，apply 后会按映射库重写）'
              : '从现有 tailscale serve 配置导入',
          enabled: true,
          ownedRoutes: [{ service: route.service, servePort: route.servePort, path: route.path }],
          createdAt: now,
          updatedAt: now,
        });
        managedKeys.add(key);
      }

      if (imported.length > 0) {
        await this.#deps.store.write([...mappings, ...imported]);
        await this.#audit('import', `接管 ${imported.length} 条既有 serve 路由`, {
          routes: imported.map(formatRouteRef),
        });
      }
      return { imported, skipped };
    });
  }

  /** 对外暴露的 apply：读取当前状态并收敛。 */
  async apply(): Promise<ApplyResult> {
    return this.#serialize(() => this.applyInternal());
  }

  /**
   * 收敛核心。
   *
   * `overrideMappings` 用于删除流程：映射库里已经没有这条记录了，但仍需把
   * 它在 serve 中占用的路径摘掉。
   */
  private async applyInternal(overrideMappings?: Mapping[]): Promise<ApplyResult> {
    const { plan } = overrideMappings
      ? await this.#planFor(overrideMappings)
      : await this.#evaluateAll();

    const upserted: RouteRef[] = [];
    const removed: RouteRef[] = [];
    const errors: string[] = [];

    for (const u of plan.upserts) {
      try {
        await this.#deps.gateway.upsertRoute(u.servePort, u.path, u.proxy, u.service);
        upserted.push({ service: u.service, servePort: u.servePort, path: u.path });
      } catch (err) {
        errors.push(`挂载 ${formatRouteRef(u)} 失败：${(err as Error).message}`);
      }
    }
    for (const r of plan.removals) {
      try {
        await this.#deps.gateway.removeRoute(r.servePort, r.path, r.service);
        removed.push({ service: r.service, servePort: r.servePort, path: r.path });
      } catch (err) {
        errors.push(`摘除 ${formatRouteRef(r)} 失败：${(err as Error).message}`);
      }
    }

    if (upserted.length > 0 || removed.length > 0) {
      await this.#audit('apply', '收敛 serve 配置', {
        upserted: upserted.map(formatRouteRef),
        removed: removed.map(formatRouteRef),
      });
    }

    // 写回 ownedRoutes：把「仍然存在于 serve 中、且曾由本映射占用」的位置继续记账，
    // 这样摘除失败或用户手工回滚都能在下次 apply 时被重试。
    const current = await this.#deps.store.read();
    const after = await this.#deps.gateway.snapshot();
    const presentKeys = new Set(after.routes.map((r) => serveRouteKey(r.service, r.servePort, r.path)));
    const refreshed = current.map((m) => {
      const candidates: OwnedRoute[] = m.enabled
        ? [...m.ownedRoutes, { service: m.service, servePort: m.servePort, path: m.path }]
        : [...m.ownedRoutes];
      const owns: OwnedRoute[] = [];
      const seen = new Set<string>();
      for (const c of candidates) {
        const k = serveRouteKey(c.service, c.servePort, c.path);
        if (!presentKeys.has(k) || seen.has(k)) continue;
        seen.add(k);
        owns.push({ service: c.service, servePort: c.servePort, path: c.path });
      }
      return { ...m, ownedRoutes: owns };
    });
    await this.#deps.store.write(refreshed);

    if (plan.exposures.length > 0) {
      await this.#audit('exposure-detected', `检测到 ${plan.exposures.length} 条指向管理端口的路由`, {
        exposures: plan.exposures.map((e) => ({ route: formatRouteRef(e), proxy: e.proxy })),
        autoRemove: this.#deps.autoUnexpose,
      });
      const removedKeys = new Set(removed.map((r) => serveRouteKey(r.service, r.servePort, r.path)));
      for (const e of plan.exposures) {
        if (removedKeys.has(serveRouteKey(e.service, e.servePort, e.path))) {
          await this.#audit('exposure-removed', `已摘除暴露管理端口的 serve 路由 ${formatRouteRef(e)}`, {
            proxy: e.proxy,
          });
        } else {
          this.#deps.logger.error('指向管理端口的路由未能摘除', {
            route: formatRouteRef(e),
            proxy: e.proxy,
          });
        }
      }
    }

    const finalState = await this.#evaluateAll();

    // 快照刷新放在收敛之后：消费方读到的应当是「收敛后的真实状态」。
    // 写失败绝不能影响收敛结果，因此只记警告。
    await this.#publishSnapshot(finalState).catch((err: unknown) => {
      this.#deps.logger.warn('快照写入失败，收敛结果不受影响', { error: (err as Error).message });
    });

    return {
      upserted,
      removed,
      blocked: plan.blocked,
      exposures: plan.exposures,
      errors,
      inSync: isInSync(finalState.plan) && finalState.plan.exposures.length === 0,
    };
  }

  /**
   * 对外发布一份 serve 路由快照。
   *
   * 供其它项目（通常跑在容器里、够不到宿主 tailscaled）通过只读挂载的文件读取路由状态。
   * 除收敛后自动触发外，启动时与定期也会调用，以便反映手工改动。
   */
  async publishSnapshot(): Promise<Snapshot> {
    const state = await this.#evaluateAll();
    return this.#publishSnapshot(state);
  }

  /** 快照文件路径，供界面展示与文档引用。 */
  get snapshotFilePath(): string {
    return this.#deps.snapshot.filePath;
  }

  async #publishSnapshot(state: {
    mappings: Mapping[];
    plan: ReconcilePlan;
    snapshot: ServeSnapshot;
    containers: ContainerInfo[];
    tailnet: TailnetInfo | null;
  }): Promise<Snapshot> {
    const tailnet = state.tailnet ?? (await this.#deps.gateway.tailnet());
    const snapshot = buildSnapshot({
      generatedAt: new Date().toISOString(),
      generator: 'tscontroller',
      tailnet,
      serve: state.snapshot,
      mappings: state.mappings,
      plan: state.plan,
      containers: state.containers,
      adminPort: this.#deps.adminPort,
      autoUnexpose: this.#deps.autoUnexpose,
    });
    await this.#deps.snapshot.write(snapshot);
    return snapshot;
  }

  async #planFor(mappings: Mapping[]): Promise<{
    mappings: Mapping[];
    plan: ReconcilePlan;
    containers: ContainerInfo[];
  }> {
    const [snapshot, containers, tailnet] = await Promise.all([
      this.#deps.gateway.snapshot(),
      this.#deps.containers.listContainers(),
      this.#readTailnet(),
    ]);
    return {
      mappings,
      plan: planReconcile({ mappings, snapshot, containers, adminPort: this.#deps.adminPort, tailnet }),
      containers,
    };
  }

  async #viewOf(id: string): Promise<MappingView> {
    const { mappings, plan } = await this.#evaluateAll();
    const found = mappings.find((m) => m.id === id);
    if (!found) throw new MappingConflictError('not-found', `映射 ${id} 在写入后消失`);
    return this.#toView(found, plan);
  }

  /**
   * 启动时的安全闸门。
   *
   * 无论映射库内容如何，只要 serve 中存在指向管理端口的**本机**路由，就必须处理：
   * - 开启自动修复时立即摘除并记录审计；
   * - 否则只告警，交由界面提示用户手动处理。
   *
   * **扫描范围是全部 HTTPS 端口 × 全部命名空间**（节点级 + Service 级）。
   * 早期实现只解析一个端口组，后来又漏掉了 Service 命名空间——两者都是真实的
   * 安全缺口，`get-config` 的接入正是为了堵上后者。
   *
   * **已知无法覆盖**：Service host 代理到**远端**本机（例如 NAS 上的 service host
   * 反过来指向本机的管理端口）时，配置里只有远端主机名，本工具无法判断那台主机
   * 是否就是本机。这一层需要靠 ACL 与「不要在 service host 上写这种目标」来保证。
   */
  async enforceExposureGuard(): Promise<{ exposures: ReconcilePlan['exposures']; removed: RouteRef[] }> {
    const snapshot = await this.#deps.gateway.snapshot();
    const exposures = snapshot.routes
      .filter((r) => r.handler.kind === 'proxy' && r.handler.hostPort === this.#deps.adminPort && r.handler.loopback)
      .map((r) => ({
        service: r.service,
        servePort: r.servePort,
        path: r.path,
        proxy: (r.handler as { raw: string }).raw,
      }));

    if (exposures.length === 0) return { exposures: [], removed: [] };

    await this.#audit('exposure-detected', `启动扫描发现 ${exposures.length} 条路由指向管理端口 ${this.#deps.adminPort}`, {
      exposures: exposures.map((e) => ({ route: formatRouteRef(e), proxy: e.proxy })),
    });

    if (!this.#deps.autoUnexpose) {
      this.#deps.logger.error('检测到管理端口被暴露在 tailnet 中，且自动修复已关闭', {
        exposures: exposures.map(formatRouteRef),
      });
      return { exposures, removed: [] };
    }

    const removed: RouteRef[] = [];
    for (const e of exposures) {
      try {
        await this.#deps.gateway.removeRoute(e.servePort, e.path, e.service);
        removed.push({ service: e.service, servePort: e.servePort, path: e.path });
        await this.#audit('exposure-removed', `已摘除暴露管理端口的 serve 路由 ${formatRouteRef(e)}`, {
          proxy: e.proxy,
        });
      } catch (err) {
        this.#deps.logger.error('摘除暴露路由失败', {
          route: formatRouteRef(e),
          error: (err as Error).message,
        });
      }
    }
    return { exposures, removed };
  }

  /** 只读的 serve 路由视图（含托管标记），用于界面「系统路由」面板。 */
  async serveRoutes(): Promise<ServeRoute[]> {
    const [snapshot, mappings] = await Promise.all([this.#deps.gateway.snapshot(), this.#deps.store.read()]);
    const owner = new Map<string, string>();
    for (const m of mappings) {
      for (const k of this.#ownedKeysOf(m)) owner.set(k, m.id);
    }
    return snapshot.routes.map((r) => {
      const id = owner.get(serveRouteKey(r.service, r.servePort, r.path));
      return { ...r, managed: id !== undefined, mappingId: id ?? null };
    });
  }

  /** Service 状态视图（供界面展示「已承认 / 等待审批」与 TailVIP）。 */
  async services(): Promise<ServiceInfo[]> {
    const snapshot = await this.#deps.gateway.snapshot();
    return snapshot.services;
  }

  /** 本节点是否有 tag 身份（Service host 的前提条件）；无法读取 tailnet 时为 null。 */
  async canHostService(): Promise<{ tags: string[]; canHostService: boolean } | null> {
    const tailnet = await this.#readTailnet();
    if (!tailnet) return null;
    return { tags: tailnet.tags, canHostService: tailnet.tags.length > 0 };
  }
}
