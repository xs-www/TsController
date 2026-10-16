import { describe, expect, it } from 'vitest';
import { isSameProxy, planReconcile } from '../src/mappings/reconcile.ts';
import { parseServeStatus } from '../src/tailscale/serve-config.ts';
import type { Mapping } from '../src/domain/types.ts';
import { makeContainer, parseFakeRouteKey } from './fakes.ts';

const ADMIN_PORT = 8787;

function mapping(partial: Partial<Mapping> & { path: string; hostPort: number }): Mapping {
  const servePort = partial.servePort ?? 443;
  return {
    id: partial.id ?? `m-${servePort}-${partial.path}`,
    path: partial.path,
    servePort,
    target: {
      kind: partial.target?.kind ?? 'host',
      hostPort: partial.hostPort,
      targetPath: partial.target?.targetPath ?? '',
      ...(partial.target?.containerId ? { containerId: partial.target.containerId } : {}),
      ...(partial.target?.containerName ? { containerName: partial.target.containerName } : {}),
    },
    note: '',
    enabled: partial.enabled ?? true,
    ownedRoutes: partial.ownedRoutes ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 把简写键（`"/a"` / `":8443/a"`）组装成 serve 的原始 JSON 结构。 */
function snapshotOf(handlers: Record<string, string>) {
  const groups: Record<string, { Handlers: Record<string, { Proxy: string }> }> = {};
  for (const [k, proxy] of Object.entries(handlers)) {
    const { servePort, path } = parseFakeRouteKey(k);
    const key = `host:${servePort}`;
    groups[key] ??= { Handlers: {} };
    groups[key]!.Handlers[path] = { Proxy: proxy };
  }
  const tcp = Object.fromEntries(Object.keys(groups).map((k) => [k.slice(k.lastIndexOf(':') + 1), { HTTPS: true }]));
  return parseServeStatus({ TCP: tcp, Web: groups });
}

describe('isSameProxy', () => {
  it('忽略尾斜杠差异', () => {
    expect(isSameProxy('http://127.0.0.1:8080', 'http://127.0.0.1:8080/')).toBe(true);
    expect(isSameProxy('http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/a')).toBe(true);
    expect(isSameProxy('http://127.0.0.1:8080', 'http://127.0.0.1:8081')).toBe(false);
    expect(isSameProxy('http://127.0.0.1:8080', 'http://127.0.0.1:8080/other')).toBe(false);
  });
});

describe('planReconcile（单端口）', () => {
  it('新映射 → 一次挂载，无摘除', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/worldforge', hostPort: 4173 })],
      snapshot: snapshotOf({}),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([
      { mappingId: 'm-443-/worldforge', servePort: 443, path: '/worldforge', proxy: 'http://127.0.0.1:4173' },
    ]);
    expect(plan.removals).toEqual([]);
    expect(plan.evaluations.get('m-443-/worldforge')!.status).toBe('pending');
  });

  it('已一致 → 无需任何写操作', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/worldforge', hostPort: 4173, ownedRoutes: [{ servePort: 443, path: '/worldforge' }] })],
      snapshot: snapshotOf({ '/worldforge': 'http://127.0.0.1:4173' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.removals).toEqual([]);
    expect(plan.evaluations.get('m-443-/worldforge')!.status).toBe('active');
  });

  it('目标端口变化 → 覆盖写入', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/worldforge', hostPort: 5000, ownedRoutes: [{ servePort: 443, path: '/worldforge' }] })],
      snapshot: snapshotOf({ '/worldforge': 'http://127.0.0.1:4173' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([
      { mappingId: 'm-443-/worldforge', servePort: 443, path: '/worldforge', proxy: 'http://127.0.0.1:5000' },
    ]);
    expect(plan.evaluations.get('m-443-/worldforge')!.status).toBe('pending');
  });

  it('禁用映射 → 摘除它占用过的路由', () => {
    const plan = planReconcile({
      mappings: [
        mapping({
          path: '/worldforge',
          hostPort: 4173,
          enabled: false,
          ownedRoutes: [{ servePort: 443, path: '/worldforge' }],
        }),
      ],
      snapshot: snapshotOf({ '/worldforge': 'http://127.0.0.1:4173' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.removals.map((r) => r.path)).toEqual(['/worldforge']);
    expect(plan.evaluations.get('m-443-/worldforge')!.status).toBe('disabled-drift');
  });

  it('永不删除未托管的既有路由', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/worldforge', hostPort: 4173 })],
      snapshot: snapshotOf({
        '/': 'http://127.0.0.1:3081',
        '/dsh': 'http://127.0.0.1:3081',
        '/calendar': 'http://127.0.0.1:443/calendar',
      }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.removals).toEqual([]);
    expect(plan.upserts.map((u) => u.path)).toEqual(['/worldforge']);
  });

  it('路径改名 → 摘旧挂新', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/wf', hostPort: 4173, ownedRoutes: [{ servePort: 443, path: '/worldforge' }] })],
      snapshot: snapshotOf({ '/worldforge': 'http://127.0.0.1:4173' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts.map((u) => u.path)).toEqual(['/wf']);
    expect(plan.removals.map((r) => r.path)).toEqual(['/worldforge']);
  });

  it('容器型映射的目标容器消失 → orphaned-target', () => {
    const m = mapping({
      path: '/wf',
      hostPort: 4173,
      target: {
        kind: 'container',
        hostPort: 4173,
        targetPath: '',
        containerId: 'id-worldforge',
        containerName: 'worldforge',
      },
      ownedRoutes: [{ servePort: 443, path: '/wf' }],
    });
    const gone = planReconcile({
      mappings: [m],
      snapshot: snapshotOf({ '/wf': 'http://127.0.0.1:4173' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(gone.evaluations.get('m-443-/wf')!.status).toBe('orphaned-target');

    const stopped = planReconcile({
      mappings: [m],
      snapshot: snapshotOf({ '/wf': 'http://127.0.0.1:4173' }),
      containers: [makeContainer('worldforge', [{ hostPort: 4173, containerPort: 8080 }], 'exited')],
      adminPort: ADMIN_PORT,
    });
    expect(stopped.evaluations.get('m-443-/wf')!.status).toBe('orphaned-target');

    const healthy = planReconcile({
      mappings: [m],
      snapshot: snapshotOf({ '/wf': 'http://127.0.0.1:4173' }),
      containers: [makeContainer('worldforge', [{ hostPort: 4173, containerPort: 8080 }])],
      adminPort: ADMIN_PORT,
    });
    expect(healthy.evaluations.get('m-443-/wf')!.status).toBe('active');
  });

  it('同一路由被两条映射占用 → conflict 且跳过写入', () => {
    const plan = planReconcile({
      mappings: [
        mapping({ id: 'a', path: '/dup', hostPort: 1000 }),
        mapping({ id: 'b', path: '/DUP', hostPort: 2000 }),
      ],
      snapshot: snapshotOf({}),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.evaluations.get('a')!.status).toBe('conflict');
    expect(plan.evaluations.get('b')!.status).toBe('conflict');
  });

  it('目标路径追加在代理地址之后', () => {
    const plan = planReconcile({
      mappings: [
        mapping({ path: '/agent', hostPort: 443, target: { kind: 'host', hostPort: 443, targetPath: '/api/agent' } }),
      ],
      snapshot: snapshotOf({}),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts[0]!.proxy).toBe('http://127.0.0.1:443/api/agent');
  });
});

describe('planReconcile（多端口）', () => {
  it('同一路径挂在不同端口上是两条互不干扰的路由', () => {
    const plan = planReconcile({
      mappings: [
        mapping({ id: 'a', path: '/', servePort: 443, hostPort: 3081, ownedRoutes: [{ servePort: 443, path: '/' }] }),
        mapping({ id: 'b', path: '/', servePort: 8443, hostPort: 8899 }),
      ],
      snapshot: snapshotOf({ '/': 'http://127.0.0.1:3081' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([
      { mappingId: 'b', servePort: 8443, path: '/', proxy: 'http://127.0.0.1:8899' },
    ]);
    expect(plan.removals).toEqual([]);
    expect(plan.evaluations.get('a')!.status).toBe('active');
    expect(plan.evaluations.get('b')!.status).toBe('pending');
  });

  it('迁移端口 → 摘旧端口的旧路由、挂新端口', () => {
    const plan = planReconcile({
      mappings: [
        mapping({ path: '/home', servePort: 8443, hostPort: 8899, ownedRoutes: [{ servePort: 443, path: '/home' }] }),
      ],
      snapshot: snapshotOf({ '/home': 'http://127.0.0.1:8899' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([
      { mappingId: 'm-8443-/home', servePort: 8443, path: '/home', proxy: 'http://127.0.0.1:8899' },
    ]);
    expect(plan.removals).toEqual([
      { mappingId: 'm-8443-/home', servePort: 443, path: '/home', currentProxy: 'http://127.0.0.1:8899' },
    ]);
  });

  it('某端口上已存在未托管路由时，只影响该端口', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/', servePort: 8443, hostPort: 1234 })],
      snapshot: snapshotOf({ '/': 'http://127.0.0.1:3081', ':8443/': 'http://127.0.0.1:8899' }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.upserts).toEqual([
      { mappingId: 'm-8443-/', servePort: 8443, path: '/', proxy: 'http://127.0.0.1:1234' },
    ]);
    // 443 上的未托管 `/` 不受影响。
    expect(plan.removals).toEqual([]);
  });
});

describe('planReconcile（安全）', () => {
  it('目标指向管理端口 → blocked，并作为暴露被摘除', () => {
    const plan = planReconcile({
      mappings: [
        mapping({ path: '/admin', hostPort: ADMIN_PORT, ownedRoutes: [{ servePort: 443, path: '/admin' }] }),
      ],
      snapshot: snapshotOf({ '/admin': `http://127.0.0.1:${ADMIN_PORT}` }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.blocked).toEqual([
      { mappingId: 'm-443-/admin', path: '/admin', reason: expect.stringContaining('禁止暴露') },
    ]);
    expect(plan.exposures).toEqual([{ servePort: 443, path: '/admin', proxy: `http://127.0.0.1:${ADMIN_PORT}` }]);
    expect(plan.upserts).toEqual([]);
    expect(plan.removals.map((r) => r.path)).toEqual(['/admin']);
    expect(plan.evaluations.get('m-443-/admin')!.status).toBe('blocked');
  });

  it('对外端口与管理端口同号 → blocked', () => {
    const plan = planReconcile({
      mappings: [mapping({ path: '/x', servePort: ADMIN_PORT, hostPort: 4173 })],
      snapshot: snapshotOf({}),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.reason).toContain('同号');
    expect(plan.upserts).toEqual([]);
  });

  it('未托管的既有路由若指向管理端口，也会被摘除（任意端口）', () => {
    const plan = planReconcile({
      mappings: [],
      snapshot: snapshotOf({
        '/leak': `http://127.0.0.1:${ADMIN_PORT}`,
        ':8443/leak2': `http://127.0.0.1:${ADMIN_PORT}`,
      }),
      containers: [],
      adminPort: ADMIN_PORT,
    });
    expect(plan.exposures).toHaveLength(2);
    expect(plan.exposures.map((e) => e.servePort).sort()).toEqual([443, 8443]);
    expect(plan.removals.map((r) => `${r.servePort}:${r.path}`).sort()).toEqual(['443:/leak', '8443:/leak2']);
  });
});
