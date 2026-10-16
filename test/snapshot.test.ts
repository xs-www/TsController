import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  FileSnapshotWriter,
  SNAPSHOT_SCHEMA_VERSION,
  type BuildSnapshotInput,
  type Snapshot,
} from '../src/snapshot.ts';
import { planReconcile } from '../src/mappings/reconcile.ts';
import type { ContainerInfo, Mapping, ServeRoute, ServeSnapshot, TailnetInfo } from '../src/domain/types.ts';
import { makeContainer } from './fakes.ts';

const TAILNET: TailnetInfo = {
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

/**
 * 组装一份合法的 ServeSnapshot。
 *
 * v2 起快照多了 `services`（Service 状态列表），路由也各自带 `service` 维度，
 * 用这个助手统一补齐，避免每个用例重复写样板。
 */
function snapOf(partial: Partial<ServeSnapshot> & Pick<ServeSnapshot, 'routes'>): ServeSnapshot {
  return {
    httpsPorts: partial.httpsPorts ?? [443],
    hostname: partial.hostname === undefined ? TAILNET.dnsName : partial.hostname,
    routes: partial.routes,
    services: partial.services ?? [],
  };
}

function route(
  servePort: number,
  p: string,
  proxy: string | null,
  service: string | null = null,
  host: string | null = 'my-laptop.example-tailnet.ts.net',
): ServeRoute {
  const targetHost = proxy === null ? null : new URL(proxy).hostname;
  const loopback = targetHost === '127.0.0.1' || targetHost === 'localhost' || targetHost === '::1';
  return {
    service,
    servePort,
    host: service ? `${service.replace(/^svc:/, '')}.example-tailnet.ts.net` : (host ?? ''),
    path: p,
    handler:
      proxy === null
        ? { kind: 'text', raw: 'hi' }
        : {
            kind: 'proxy',
            raw: proxy,
            hostPort: Number(new URL(proxy).port),
            host: targetHost,
            targetPath: new URL(proxy).pathname === '/' ? '' : new URL(proxy).pathname,
            loopback,
          },
    managed: false,
    mappingId: null,
  };
}

function mapping(partial: Partial<Mapping> & { path: string; servePort: number; hostPort: number }): Mapping {
  return {
    id: partial.id ?? `m-${partial.servePort}-${partial.path}`,
    service: partial.service ?? null,
    path: partial.path,
    servePort: partial.servePort,
    target: {
      kind: partial.target?.kind ?? 'host',
      hostPort: partial.hostPort,
      targetPath: partial.target?.targetPath ?? '',
      ...(partial.target?.remoteHost ? { remoteHost: partial.target.remoteHost } : {}),
      ...(partial.target?.containerName ? { containerName: partial.target.containerName } : {}),
      ...(partial.target?.containerPort !== undefined ? { containerPort: partial.target.containerPort } : {}),
    },
    note: partial.note ?? '',
    enabled: partial.enabled ?? true,
    ownedRoutes: partial.ownedRoutes ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function build(
  serve: ServeSnapshot,
  mappings: Mapping[],
  overrides: Partial<BuildSnapshotInput> = {},
  containers: ContainerInfo[] = [],
): Snapshot {
  const plan = planReconcile({ mappings, snapshot: serve, containers, adminPort: 8787, tailnet: TAILNET });
  return buildSnapshot({
    generatedAt: '2026-10-16T00:00:00.000Z',
    generator: 'tscontroller',
    tailnet: TAILNET,
    serve,
    mappings,
    plan,
    containers,
    adminPort: 8787,
    autoUnexpose: true,
    ...overrides,
  });
}

describe('buildSnapshot', () => {
  it('输出稳定 schema 与来源信息', () => {
    const snap = build(snapOf({ httpsPorts: [443], hostname: TAILNET.dnsName, routes: [] }), []);
    expect(snap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snap.generatedAt).toBe('2026-10-16T00:00:00.000Z');
    expect(snap.source).toMatchObject({
      hostname: 'my-laptop.example-tailnet.ts.net',
      baseUrl: 'https://my-laptop.example-tailnet.ts.net',
      adminPort: 8787,
    });
    expect(snap.servePorts).toEqual([443]);
    expect(snap.routes).toEqual([]);
    expect(snap.security).toEqual({ autoUnexpose: true, exposures: [] });
  });

  it('443 省略端口，非 443 显式带上', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443, 8443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/worldforge', 'http://127.0.0.1:4173'), route(8443, '/', 'http://127.0.0.1:8899')],
    });
    const snap = build(serve, []);

    expect(snap.routes.map((r) => r.url)).toEqual([
      'https://my-laptop.example-tailnet.ts.net/worldforge',
      'https://my-laptop.example-tailnet.ts.net:8443/',
    ]);
  });

  it('主机名未知时 url 为 null，其余字段仍可用', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: null,
      routes: [route(443, '/x', 'http://127.0.0.1:4173')],
    });
    // 节点级路由的对外地址由**快照主机名**决定（tailnet.dnsName 缺失不影响它）。
    const snap = build(serve, [], { tailnet: { ...TAILNET, dnsName: null, baseUrl: null } });
    expect(snap.source.hostname).toBeNull();
    expect(snap.routes[0]!.url).toBe('https://my-laptop.example-tailnet.ts.net/x');

    // 快照本身也没有主机名（例如 tailscale 未登录）时才是 null。
    const blind = build(
      snapOf({ httpsPorts: [443], hostname: null, routes: [route(443, '/x', 'http://127.0.0.1:4173', null, null)] }),
      [],
    );
    expect(blind.routes[0]!.url).toBeNull();
    expect(blind.routes[0]!.proxy).toBe('http://127.0.0.1:4173');
  });

  it('区分受管与未托管，并带上映射元数据', () => {
    const m = mapping({
      path: '/worldforge',
      servePort: 443,
      hostPort: 4173,
      note: '世界引擎',
      target: {
        kind: 'container',
        hostPort: 4173,
        targetPath: '',
        containerName: 'worldforge',
        containerPort: 8080,
      },
      ownedRoutes: [{ service: null, servePort: 443, path: '/worldforge' }],
    });
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/', 'http://127.0.0.1:3081'), route(443, '/worldforge', 'http://127.0.0.1:4173')],
    });
    const snap = build(
      serve,
      [m],
      {},
      [makeContainer('worldforge', [{ hostPort: 4173, containerPort: 8080 }])],
    );

    const managed = snap.routes.find((r) => r.path === '/worldforge')!;
    expect(managed).toMatchObject({
      managed: true,
      mappingId: m.id,
      status: 'active',
      containerName: 'worldforge',
      containerPort: 8080,
      note: '世界引擎',
      enabled: true,
    });

    const external = snap.routes.find((r) => r.path === '/')!;
    expect(external).toMatchObject({ managed: false, mappingId: null, status: null, note: null, enabled: null });
  });

  it('汇总计数覆盖各状态', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: TAILNET.dnsName,
      routes: [
        route(443, '/a', 'http://127.0.0.1:1000'),
        route(443, '/b', 'http://127.0.0.1:1001'),
        route(443, '/c', 'http://127.0.0.1:1002'),
        route(443, '/free', 'http://127.0.0.1:9999'),
      ],
    });
    const mappings = [
      mapping({ path: '/a', servePort: 443, hostPort: 1000, ownedRoutes: [{ service: null, servePort: 443, path: '/a' }] }),
      mapping({ path: '/b', servePort: 443, hostPort: 2000 }), // 未写入 → pending
      mapping({ path: '/c', servePort: 443, hostPort: 1002, enabled: false, ownedRoutes: [{ service: null, servePort: 443, path: '/c' }] }),
    ];
    const snap = build(serve, mappings);

    expect(snap.summary).toEqual({
      total: 4,
      managed: 3,
      unmanaged: 1,
      active: 1,
      pending: 1,
      disabled: 1,
      orphanedTarget: 0,
      blocked: 0,
      awaitingApproval: 0,
    });
  });

  it('同一路径出现在两个端口时互不混淆', () => {
    const m = mapping({
      path: '/',
      servePort: 8443,
      hostPort: 8899,
      ownedRoutes: [{ service: null, servePort: 8443, path: '/' }],
    });
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443, 8443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/', 'http://127.0.0.1:3081'), route(8443, '/', 'http://127.0.0.1:8899')],
    });
    const snap = build(serve, [m]);

    const on443 = snap.routes.find((r) => r.servePort === 443)!;
    const on8443 = snap.routes.find((r) => r.servePort === 8443)!;
    expect(on443.managed).toBe(false);
    expect(on8443).toMatchObject({ managed: true, mappingId: m.id, status: 'active' });
  });

  it('非代理 handler 的代理字段为空但路由仍被列出', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/text', null)],
    });
    const snap = build(serve, []);
    expect(snap.routes[0]).toMatchObject({ proxy: null, targetHostPort: null, targetPath: '' });
  });

  it('暴露会被写进 security 段', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443, 8443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/leak', 'http://127.0.0.1:8787'), route(8443, '/leak2', 'http://127.0.0.1:8787')],
    });
    const snap = build(serve, [], { autoUnexpose: false });
    expect(snap.security.autoUnexpose).toBe(false);
    expect(snap.security.exposures.map((e) => `${e.servePort}:${e.path}`)).toEqual(['443:/leak', '8443:/leak2']);
  });

  it('路由按端口再按路径排序', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443, 8443],
      hostname: TAILNET.dnsName,
      routes: [
        route(8443, '/z', 'http://127.0.0.1:1'),
        route(443, '/b', 'http://127.0.0.1:2'),
        route(443, '/a', 'http://127.0.0.1:3'),
      ],
    });
    const snap = build(serve, []);
    expect(snap.routes.map((r) => `${r.servePort}${r.path}`)).toEqual(['443/a', '443/b', '8443/z']);
  });

  it('未托管路由也能按宿主机端口反查容器（门户需要这个）', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/portal', 'http://127.0.0.1:8899'), route(443, '/ghost', 'http://127.0.0.1:65000')],
    });
    const snap = build(
      serve,
      [],
      {},
      [makeContainer('homepage-portal', [{ hostPort: 8899, containerPort: 3000 }])],
    );

    const linked = snap.routes.find((r) => r.path === '/portal')!;
    expect(linked).toMatchObject({
      managed: false,
      containerName: 'homepage-portal',
      containerPort: 3000,
      containerSource: 'port',
    });
    // 端口对不上任何容器时保持 null，不要瞎猜。
    expect(snap.routes.find((r) => r.path === '/ghost')).toMatchObject({
      containerName: null,
      containerPort: null,
      containerSource: null,
    });
  });

  it('映射库的容器归属优先于端口反查，并用 containerSource 标明来源', () => {
    const m = mapping({
      path: '/portal',
      servePort: 443,
      hostPort: 8899,
      target: {
        kind: 'container',
        hostPort: 8899,
        targetPath: '',
        containerName: 'mapped-name',
        containerPort: 4000,
      },
      ownedRoutes: [{ service: null, servePort: 443, path: '/portal' }],
    });
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/portal', 'http://127.0.0.1:8899')],
    });
    // 容器清单里同一个端口对应另一个名字——映射库应当胜出。
    const snap = build(serve, [m], {}, [makeContainer('port-name', [{ hostPort: 8899, containerPort: 3000 }])]);

    expect(snap.routes[0]).toMatchObject({
      managed: true,
      containerName: 'mapped-name',
      containerPort: 4000,
      containerSource: 'mapping',
    });
  });

  it('已停止的容器不参与端口反查（优先运行中的）', () => {
    const serve: ServeSnapshot = snapOf({
      httpsPorts: [443],
      hostname: TAILNET.dnsName,
      routes: [route(443, '/x', 'http://127.0.0.1:5000')],
    });
    const snap = build(
      serve,
      [],
      {},
      [
        makeContainer('stopped', [{ hostPort: 5000, containerPort: 1 }], 'exited'),
        makeContainer('running', [{ hostPort: 5000, containerPort: 2 }]),
      ],
    );
    expect(snap.routes[0]).toMatchObject({ containerName: 'running', containerPort: 2 });
  });

  it('可被 JSON 序列化（消费方直接 JSON.parse）', () => {
    const snap = build(
      snapOf({ httpsPorts: [443], hostname: TAILNET.dnsName, routes: [route(443, '/x', 'http://127.0.0.1:1')] }),
      [],
    );
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

describe('FileSnapshotWriter', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('创建目录并写出可解析的 JSON', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsc-snap-'));
    const target = path.join(dir, 'public');
    const writer = new FileSnapshotWriter(target);

    const snap = build(
      snapOf({ httpsPorts: [443], hostname: TAILNET.dnsName, routes: [route(443, '/x', 'http://127.0.0.1:1')] }),
      [],
    );
    const written = await writer.write(snap);

    expect(written).toBe(path.join(target, 'serve-routes.json'));
    const parsed = JSON.parse(await fs.readFile(written, 'utf8')) as Snapshot;
    expect(parsed.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(parsed.routes).toHaveLength(1);
  });

  it('重复写入覆盖而不是追加，且不残留临时文件', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsc-snap-'));
    const writer = new FileSnapshotWriter(path.join(dir, 'public'));
    const empty = build(snapOf({ httpsPorts: [], hostname: null, routes: [] }), []);
    const one = build(
      snapOf({ httpsPorts: [443], hostname: TAILNET.dnsName, routes: [route(443, '/x', 'http://127.0.0.1:1')] }),
      [],
    );

    await writer.write(one);
    await writer.write(empty);

    const parsed = JSON.parse(await fs.readFile(writer.filePath, 'utf8')) as Snapshot;
    expect(parsed.routes).toEqual([]);
    const files = await fs.readdir(path.dirname(writer.filePath));
    expect(files).toEqual(['serve-routes.json']);
  });
});
