/**
 * 期望状态 → 实际 serve 配置的差异计算。
 *
 * 这里是纯函数：不碰磁盘、不起进程，因此所有漂移检测逻辑都能在单测里穷举。
 * 真正的写入由 mapping-service 依据本模块产出的 plan 执行。
 *
 * **路由身份是三元组 `(service, servePort, path)`。**
 * - `/` 挂在 443 与 8443 上是两个互不干扰的独立入口；
 * - 节点级 `/dsh` 与 Service 级 `svc:dsh` 的 `/` 更是两个完全不同的对外名字
 *   （`laptop.ts.net/dsh` vs `dsh.ts.net`）。
 *
 * 因此本模块全部匹配/去重/归属判断都走 `serveRouteKey()`，而不是单纯的路径比较。
 */

import { buildBaseUrl, buildProxyUrl, parseProxyUrl, serveRouteKey } from '../domain/route-path.ts';
import type {
  ContainerInfo,
  Mapping,
  MappingStatus,
  MappingTarget,
  ServeSnapshot,
  TailnetInfo,
} from '../domain/types.ts';

/** 单条映射的评估结果。 */
export interface MappingEvaluation {
  status: MappingStatus;
  /** serve 中该位置当前实际指向的代理地址。 */
  actualProxy: string | null;
  /** 期望写入 serve 的代理地址。 */
  desiredProxy: string;
  /** 该映射对外的完整基址（不含路径）；无法确定时为 null。 */
  baseUrl: string | null;
  detail: string | null;
}

export interface PlannedUpsert {
  mappingId: string;
  service: string | null;
  servePort: number;
  path: string;
  proxy: string;
}

export interface PlannedRemoval {
  mappingId: string;
  service: string | null;
  servePort: number;
  path: string;
  currentProxy: string | null;
}

export interface ReconcilePlan {
  /** 需要写入/覆盖的 handler。 */
  upserts: PlannedUpsert[];
  /** 需要摘除的 handler（禁用、被阻止或改名/改端口前留下的旧位置）。 */
  removals: PlannedRemoval[];
  /** 因安全策略被拒绝、不会写入 serve 的映射。 */
  blocked: Array<{ mappingId: string; service: string | null; path: string; reason: string }>;
  /** 检测到的「管理端口被暴露在 tailnet 中」的路由（跨全部端口与全部命名空间）。 */
  exposures: Array<{ service: string | null; servePort: number; path: string; proxy: string }>;
  /** mappingId → 评估结果。 */
  evaluations: Map<string, MappingEvaluation>;
}

/** 由映射目标算出期望的代理地址（本机或远端）。 */
export function desiredProxyOf(target: MappingTarget): string {
  return buildProxyUrl({
    hostPort: target.hostPort,
    targetPath: target.targetPath,
    ...(target.remoteHost !== undefined ? { remoteHost: target.remoteHost } : {}),
    ...(target.scheme !== undefined ? { scheme: target.scheme } : {}),
  });
}

/**
 * 比较两个代理地址是否等价。
 *
 * serve 的 Proxy 字符串可能带或不带尾斜杠，因此先解析再比对主机、端口与目标路径；
 * 解析失败时退化为字符串比较（此时一律认为不相等，宁可多写一次）。
 */
export function isSameProxy(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseProxyUrl(a);
  const pb = parseProxyUrl(b);
  if (!pa || !pb) return false;
  return pa.hostPort === pb.hostPort && pa.targetPath === pb.targetPath && pa.host === pb.host;
}

/**
 * 判断容器型映射的目标是否仍然存在。
 *
 * **远端目标（`remoteHost`）不做孤儿检测**：那台机器上的容器清单不在本机
 * Docker daemon 里，凭空判定「容器不存在」只会误报。Service 场景下目标通不通
 * 属于 Service host 的网络可达性问题，由 `tailscale` 侧反馈，不由本工具猜。
 */
export function describeOrphan(mapping: Mapping, containers: ContainerInfo[]): string | null {
  if (mapping.target.kind !== 'container') return null;
  if (mapping.target.remoteHost !== undefined) return null;

  const byId = mapping.target.containerId
    ? containers.find((c) => c.id === mapping.target.containerId || c.id.startsWith(mapping.target.containerId!))
    : undefined;
  const byName =
    byId ??
    (mapping.target.containerName ? containers.find((c) => c.name === mapping.target.containerName) : undefined);

  if (!byName) {
    return `目标容器已不存在（${mapping.target.containerName ?? mapping.target.containerId ?? '未知'}）`;
  }
  if (byName.state !== 'running') {
    return `目标容器未运行（${byName.name}：${byName.status || byName.state}）`;
  }
  const published = byName.ports.some((p) => p.hostPort === mapping.target.hostPort && p.protocol === 'tcp');
  if (!published) {
    return `容器 ${byName.name} 当前未发布宿主机端口 ${mapping.target.hostPort}`;
  }
  return null;
}

/** 单条映射的状态评估（不含跨映射冲突）。 */
export function evaluateMapping(
  mapping: Mapping,
  snapshot: ServeSnapshot,
  containers: ContainerInfo[],
  adminPort: number,
  tailnet?: TailnetInfo | null,
): MappingEvaluation {
  const desiredProxy = desiredProxyOf(mapping.target);
  const key = serveRouteKey(mapping.service, mapping.servePort, mapping.path);
  const existing = snapshot.routes.find((r) => serveRouteKey(r.service, r.servePort, r.path) === key);
  const actualProxy = existing && existing.handler.kind === 'proxy' ? existing.handler.raw : null;
  const baseUrl =
    buildBaseUrl(snapshot.hostname, mapping.servePort, mapping.service, tailnet?.magicDnsSuffix ?? null) || null;

  // 安全判定优先级最高：先于 enabled、先于孤儿检测。
  // 只对**本机回环**目标判暴露——远端主机上的同名端口与本进程无关，
  // 把它判成 blocked 会让 NAS 上的正常服务无法映射。
  if (mapping.target.remoteHost === undefined && mapping.target.hostPort === adminPort) {
    return {
      status: 'blocked',
      actualProxy,
      desiredProxy,
      baseUrl,
      detail: `目标端口 ${adminPort} 是 TsController 管理端口，禁止暴露在 tailnet 中`,
    };
  }
  if (mapping.servePort === adminPort) {
    return {
      status: 'blocked',
      actualProxy,
      desiredProxy,
      baseUrl,
      detail:
        `对外端口 ${adminPort} 与 TsController 管理端口同号。它不会泄露管理面` +
        `（管理面只绑回环），但会让 https://<主机>:${adminPort} 看起来像管理界面，故一并拒绝。`,
    };
  }

  if (!mapping.enabled) {
    return {
      status: actualProxy ? 'disabled-drift' : 'disabled',
      actualProxy,
      desiredProxy,
      baseUrl,
      detail: actualProxy ? '已禁用，但 serve 配置中仍有该路由，需要「应用」以清理' : null,
    };
  }

  const orphan = describeOrphan(mapping, containers);
  if (orphan) {
    return { status: 'orphaned-target', actualProxy, desiredProxy, baseUrl, detail: orphan };
  }

  if (actualProxy === null) {
    return {
      status: 'pending',
      actualProxy,
      desiredProxy,
      baseUrl,
      detail: `serve 配置中尚无该路由（${mapping.service ?? '节点级'} ${mapping.servePort} 端口），需要「应用」`,
    };
  }
  if (!isSameProxy(actualProxy, desiredProxy)) {
    return {
      status: 'pending',
      actualProxy,
      desiredProxy,
      baseUrl,
      detail: `serve 中该路由指向 ${actualProxy}，与期望不一致，需要「应用」`,
    };
  }
  return { status: 'active', actualProxy, desiredProxy, baseUrl, detail: null };
}

/**
 * Service 级路由的「等待审批」判定。
 *
 * 三种情况会落到这里：
 * 1. Serve 配置里已有该端点，但本节点还没有 `service-host` 能力 —— 即广告尚未
 *    被管理员批准（官方流程要求 approve，除非配了 `autoApprovers.services`）；
 * 2. 该 Service 的配置被标记为 `advertised: false`（曾被 drain）；
 * 3. 本节点根本不在该 Service 的 host 列表里。
 *
 * 判定只对「期望位置在 serve 中确实存在」的映射生效 —— 否则应该报 `pending`
 * （还没写进去），那才是用户能直接处理的下一步。
 */
export function awaitingApprovalOf(mapping: Mapping, snapshot: ServeSnapshot): string | null {
  if (mapping.service === null) return null;
  const info = snapshot.services.find((s) => s.name.toLowerCase() === mapping.service!.toLowerCase());
  if (!info) {
    // 配置里没有这个 Service：可能尚未写入，交给 pending 分支处理。
    return null;
  }
  if (!info.advertised) {
    return `Service ${mapping.service} 在本节点上的广告已停止（可能被 drain），当前不接收新连接`;
  }
  return null;
}

export interface PlanInput {
  mappings: Mapping[];
  snapshot: ServeSnapshot;
  containers: ContainerInfo[];
  /** 管理界面端口；任何指向它的 serve 路由都会被判定为暴露。 */
  adminPort: number;
  /** tailnet 身份，用于拼出 Service 的对外地址；缺失时只影响界面链接。 */
  tailnet?: TailnetInfo | null;
}

/**
 * 计算需要执行的 serve 变更。
 *
 * 删除策略：只删除「曾被某个映射占用过」（`ownedRoutes`，含当前位置）
 * 且当前不在期望集合中的位置。这样用户手工用 `tailscale serve` 配的路由永远不会被误删。
 */
export function planReconcile(input: PlanInput): ReconcilePlan {
  const { mappings, snapshot, containers, adminPort, tailnet } = input;

  const evaluations = new Map<string, MappingEvaluation>();
  const upserts: PlannedUpsert[] = [];
  const removals: PlannedRemoval[] = [];
  const blocked: ReconcilePlan['blocked'] = [];

  const routeByKey = new Map<string, (typeof snapshot.routes)[number]>();
  for (const r of snapshot.routes) routeByKey.set(serveRouteKey(r.service, r.servePort, r.path), r);

  // 期望位置去重：同键重复视为冲突，参与写入的条目会被跳过。
  const desiredKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const m of mappings) {
    const key = serveRouteKey(m.service, m.servePort, m.path);
    if (desiredKeys.has(key)) duplicateKeys.add(key);
    desiredKeys.add(key);
  }

  for (const m of mappings) {
    const ev = evaluateMapping(m, snapshot, containers, adminPort, tailnet);
    if (duplicateKeys.has(serveRouteKey(m.service, m.servePort, m.path))) {
      evaluations.set(m.id, {
        ...ev,
        status: 'conflict',
        detail: `${m.service ?? '节点级'} 端口 ${m.servePort} 上的路径 ${m.path} 被多条映射同时占用，已跳过写入`,
      });
      continue;
    }
    // 「等待审批」只在期望位置确实已在 serve 中时才覆盖 active —— 配置写对了
    // 但对外还不可用，是两件事，必须分开告诉用户。
    const approval = ev.status === 'active' ? awaitingApprovalOf(m, snapshot) : null;
    if (approval) {
      evaluations.set(m.id, { ...ev, status: 'awaiting-approval', detail: approval });
      continue;
    }
    evaluations.set(m.id, ev);
    if (ev.status === 'blocked') {
      blocked.push({ mappingId: m.id, service: m.service, path: m.path, reason: ev.detail ?? '被安全策略拒绝' });
    }
  }

  // 需要保留的位置：已启用且未被阻止的映射（含 awaiting-approval —— 配置已经写对了）。
  const keepKeys = new Set<string>();
  for (const m of mappings) {
    const ev = evaluations.get(m.id);
    if (!ev || ev.status === 'blocked' || ev.status === 'conflict') continue;
    if (!m.enabled) continue;
    const key = serveRouteKey(m.service, m.servePort, m.path);
    keepKeys.add(key);
    const existing = routeByKey.get(key);
    const actual = existing && existing.handler.kind === 'proxy' ? existing.handler.raw : null;
    if (actual === null || !isSameProxy(actual, ev.desiredProxy)) {
      upserts.push({
        mappingId: m.id,
        service: m.service,
        servePort: m.servePort,
        path: m.path,
        proxy: ev.desiredProxy,
      });
    }
  }

  // 需要摘除的位置：曾被本工具占用、但不在保留集合中。
  const removalSeen = new Set<string>();
  const addRemoval = (
    mappingId: string,
    service: string | null,
    servePort: number,
    path: string,
    currentProxy: string | null,
  ): void => {
    const key = serveRouteKey(service, servePort, path);
    if (keepKeys.has(key) || removalSeen.has(key)) return;
    removalSeen.add(key);
    removals.push({ mappingId, service, servePort, path, currentProxy });
  };

  for (const m of mappings) {
    const candidates = [...m.ownedRoutes, { service: m.service, servePort: m.servePort, path: m.path }];
    for (const c of candidates) {
      const key = serveRouteKey(c.service, c.servePort, c.path);
      if (keepKeys.has(key)) continue;
      const route = routeByKey.get(key);
      if (!route) continue;
      addRemoval(m.id, route.service, route.servePort, route.path, route.handler.kind === 'proxy' ? route.handler.raw : null);
    }
  }

  // 安全扫描：任何指向管理端口的**本机** serve 路由都必须被摘除，
  // 无论端口、无论命名空间（节点级或 Service 级）、无论是否由本工具创建。
  const exposures: ReconcilePlan['exposures'] = [];
  for (const r of snapshot.routes) {
    if (r.handler.kind !== 'proxy') continue;
    if (r.handler.hostPort !== adminPort) continue;
    if (!r.handler.loopback) continue; // 远端主机上的同名端口与本进程无关
    exposures.push({ service: r.service, servePort: r.servePort, path: r.path, proxy: r.handler.raw });
    addRemoval('', r.service, r.servePort, r.path, r.handler.raw);
  }

  // 被阻止的映射若已经在 serve 中存在，同样需要摘除。
  for (const m of mappings) {
    const ev = evaluations.get(m.id);
    if (ev?.status !== 'blocked') continue;
    for (const c of [...m.ownedRoutes, { service: m.service, servePort: m.servePort, path: m.path }]) {
      const route = routeByKey.get(serveRouteKey(c.service, c.servePort, c.path));
      if (!route) continue;
      addRemoval(m.id, route.service, route.servePort, route.path, route.handler.kind === 'proxy' ? route.handler.raw : null);
    }
  }

  const byRoute = (
    a: { service: string | null; servePort: number; path: string },
    b: { service: string | null; servePort: number; path: string },
  ): number => a.servePort - b.servePort || (a.service ?? '').localeCompare(b.service ?? '') || a.path.localeCompare(b.path);
  upserts.sort(byRoute);
  removals.sort(byRoute);

  return { upserts, removals, blocked, exposures, evaluations };
}

/** 判断 serve 配置是否已经与期望完全一致（即无需 apply）。 */
export function isInSync(plan: ReconcilePlan): boolean {
  return plan.upserts.length === 0 && plan.removals.length === 0;
}
