/**
 * 期望状态 → 实际 serve 配置的差异计算。
 *
 * 这里是纯函数：不碰磁盘、不起进程，因此所有漂移检测逻辑都能在单测里穷举。
 * 真正的写入由 mapping-service 依据本模块产出的 plan 执行。
 *
 * **路由身份是「端口 + 路径」的组合。** `/` 挂在 443 与 8443 上是两个互不干扰
 * 的独立入口，因此本模块全部匹配/去重/归属判断都走 `serveRouteKey()`，
 * 而不是单纯的路径比较。
 */

import { buildProxyUrl, parseProxyUrl, serveRouteKey } from '../domain/route-path.ts';
import type { ContainerInfo, Mapping, MappingStatus, ServeSnapshot } from '../domain/types.ts';

/** 单条映射的评估结果。 */
export interface MappingEvaluation {
  status: MappingStatus;
  /** serve 中该（端口,路径）当前实际指向的代理地址。 */
  actualProxy: string | null;
  /** 期望写入 serve 的代理地址。 */
  desiredProxy: string;
  detail: string | null;
}

export interface PlannedUpsert {
  mappingId: string;
  servePort: number;
  path: string;
  proxy: string;
}

export interface PlannedRemoval {
  mappingId: string;
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
  blocked: Array<{ mappingId: string; path: string; reason: string }>;
  /** 检测到的「管理端口被暴露在 tailnet 中」的路由（跨全部端口扫描）。 */
  exposures: Array<{ servePort: number; path: string; proxy: string }>;
  /** mappingId → 评估结果。 */
  evaluations: Map<string, MappingEvaluation>;
}

/**
 * 比较两个代理地址是否等价。
 *
 * serve 的 Proxy 字符串可能带或不带尾斜杠，因此先解析再比对端口与目标路径；
 * 解析失败时退化为字符串比较（此时一律认为不相等，宁可多写一次）。
 */
export function isSameProxy(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseProxyUrl(a);
  const pb = parseProxyUrl(b);
  if (!pa || !pb) return false;
  return pa.hostPort === pb.hostPort && pa.targetPath === pb.targetPath && pa.host === pb.host;
}

/** 判断容器型映射的目标是否仍然存在。 */
export function describeOrphan(mapping: Mapping, containers: ContainerInfo[]): string | null {
  if (mapping.target.kind !== 'container') return null;

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
): MappingEvaluation {
  const desiredProxy = buildProxyUrl(mapping.target.hostPort, mapping.target.targetPath);
  const key = serveRouteKey(mapping.servePort, mapping.path);
  const existing = snapshot.routes.find((r) => serveRouteKey(r.servePort, r.path) === key);
  const actualProxy = existing && existing.handler.kind === 'proxy' ? existing.handler.raw : null;

  // 安全判定优先级最高：先于 enabled、先于孤儿检测。
  if (mapping.target.hostPort === adminPort) {
    return {
      status: 'blocked',
      actualProxy,
      desiredProxy,
      detail: `目标端口 ${adminPort} 是 TsController 管理端口，禁止暴露在 tailnet 中`,
    };
  }
  if (mapping.servePort === adminPort) {
    return {
      status: 'blocked',
      actualProxy,
      desiredProxy,
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
      detail: actualProxy ? '已禁用，但 serve 配置中仍有该路由，需要「应用」以清理' : null,
    };
  }

  const orphan = describeOrphan(mapping, containers);
  if (orphan) {
    return { status: 'orphaned-target', actualProxy, desiredProxy, detail: orphan };
  }

  if (actualProxy === null) {
    return {
      status: 'pending',
      actualProxy,
      desiredProxy,
      detail: `serve 配置中尚无该路由（${mapping.servePort} 端口），需要「应用」`,
    };
  }
  if (!isSameProxy(actualProxy, desiredProxy)) {
    return {
      status: 'pending',
      actualProxy,
      desiredProxy,
      detail: `serve 中该路由指向 ${actualProxy}，与期望不一致，需要「应用」`,
    };
  }
  return { status: 'active', actualProxy, desiredProxy, detail: null };
}

export interface PlanInput {
  mappings: Mapping[];
  snapshot: ServeSnapshot;
  containers: ContainerInfo[];
  /** 管理界面端口；任何指向它的 serve 路由都会被判定为暴露。 */
  adminPort: number;
}

/**
 * 计算需要执行的 serve 变更。
 *
 * 删除策略：只删除「曾被某个映射占用过」（`ownedRoutes`，含当前 `servePort`+`path`）
 * 且当前不在期望集合中的位置。这样用户手工用 `tailscale serve` 配的路由永远不会被误删。
 */
export function planReconcile(input: PlanInput): ReconcilePlan {
  const { mappings, snapshot, containers, adminPort } = input;

  const evaluations = new Map<string, MappingEvaluation>();
  const upserts: PlannedUpsert[] = [];
  const removals: PlannedRemoval[] = [];
  const blocked: ReconcilePlan['blocked'] = [];

  const routeByKey = new Map<string, (typeof snapshot.routes)[number]>();
  for (const r of snapshot.routes) routeByKey.set(serveRouteKey(r.servePort, r.path), r);

  // 期望位置去重：同键重复视为冲突，参与写入的条目会被跳过。
  const desiredKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const m of mappings) {
    const key = serveRouteKey(m.servePort, m.path);
    if (desiredKeys.has(key)) duplicateKeys.add(key);
    desiredKeys.add(key);
  }

  for (const m of mappings) {
    const ev = evaluateMapping(m, snapshot, containers, adminPort);
    if (duplicateKeys.has(serveRouteKey(m.servePort, m.path))) {
      evaluations.set(m.id, {
        ...ev,
        status: 'conflict',
        detail: `端口 ${m.servePort} 上的路径 ${m.path} 被多条映射同时占用，已跳过写入`,
      });
      continue;
    }
    evaluations.set(m.id, ev);
    if (ev.status === 'blocked') {
      blocked.push({ mappingId: m.id, path: m.path, reason: ev.detail ?? '被安全策略拒绝' });
    }
  }

  // 需要保留的位置：已启用且未被阻止的映射。
  const keepKeys = new Set<string>();
  for (const m of mappings) {
    const ev = evaluations.get(m.id);
    if (!ev || ev.status === 'blocked' || ev.status === 'conflict') continue;
    if (!m.enabled) continue;
    const key = serveRouteKey(m.servePort, m.path);
    keepKeys.add(key);
    const existing = routeByKey.get(key);
    const actual = existing && existing.handler.kind === 'proxy' ? existing.handler.raw : null;
    if (actual === null || !isSameProxy(actual, ev.desiredProxy)) {
      upserts.push({ mappingId: m.id, servePort: m.servePort, path: m.path, proxy: ev.desiredProxy });
    }
  }

  // 需要摘除的位置：曾被本工具占用、但不在保留集合中。
  const removalSeen = new Set<string>();
  const addRemoval = (mappingId: string, servePort: number, path: string, currentProxy: string | null): void => {
    const key = serveRouteKey(servePort, path);
    if (keepKeys.has(key) || removalSeen.has(key)) return;
    removalSeen.add(key);
    removals.push({ mappingId, servePort, path, currentProxy });
  };

  for (const m of mappings) {
    const candidates = [...m.ownedRoutes, { servePort: m.servePort, path: m.path }];
    for (const c of candidates) {
      const key = serveRouteKey(c.servePort, c.path);
      if (keepKeys.has(key)) continue;
      const route = routeByKey.get(key);
      if (!route) continue;
      addRemoval(m.id, route.servePort, route.path, route.handler.kind === 'proxy' ? route.handler.raw : null);
    }
  }

  // 安全扫描：任何指向管理端口的 serve 路由都必须被摘除，无论端口、无论是否由本工具创建。
  const exposures: ReconcilePlan['exposures'] = [];
  for (const r of snapshot.routes) {
    if (r.handler.kind !== 'proxy') continue;
    if (r.handler.hostPort !== adminPort) continue;
    exposures.push({ servePort: r.servePort, path: r.path, proxy: r.handler.raw });
    addRemoval('', r.servePort, r.path, r.handler.raw);
  }

  // 被阻止的映射若已经在 serve 中存在，同样需要摘除。
  for (const m of mappings) {
    const ev = evaluations.get(m.id);
    if (ev?.status !== 'blocked') continue;
    for (const c of [...m.ownedRoutes, { servePort: m.servePort, path: m.path }]) {
      const route = routeByKey.get(serveRouteKey(c.servePort, c.path));
      if (!route) continue;
      addRemoval(m.id, route.servePort, route.path, route.handler.kind === 'proxy' ? route.handler.raw : null);
    }
  }

  upserts.sort((a, b) => a.servePort - b.servePort || a.path.localeCompare(b.path));
  removals.sort((a, b) => a.servePort - b.servePort || a.path.localeCompare(b.path));

  return { upserts, removals, blocked, exposures, evaluations };
}

/** 判断 serve 配置是否已经与期望完全一致（即无需 apply）。 */
export function isInSync(plan: ReconcilePlan): boolean {
  return plan.upserts.length === 0 && plan.removals.length === 0;
}
