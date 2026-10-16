import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { MappingService } from '../src/mappings/mapping-service.ts';
import { MemoryAuditLog, MemoryMappingStore } from '../src/mappings/store.ts';
import { MemorySnapshotWriter } from '../src/snapshot.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeContainerSource, FakeServeGateway, makeContainer } from './fakes.ts';

const ADMIN_PORT = 8787;

interface Harness {
  app: FastifyInstance;
  gateway: FakeServeGateway;
  store: MemoryMappingStore;
  snapshot: MemorySnapshotWriter;
  config: AppConfig;
}

async function setup(handlers: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ port: ADMIN_PORT, dataDir: 'data-test', host: '127.0.0.1' });
  const gateway = new FakeServeGateway(handlers);
  const containers = new FakeContainerSource([makeContainer('worldforge', [{ hostPort: 4173, containerPort: 8080 }])]);
  const store = new MemoryMappingStore();
  const audit = new MemoryAuditLog();
  const snapshot = new MemorySnapshotWriter();
  const mappings = new MappingService({
    store,
    gateway,
    containers,
    audit,
    logger: silentLogger,
    adminPort: ADMIN_PORT,
    servePort: 443,
    autoUnexpose: true,
    snapshot,
  });
  const app = await buildApp({ config, mappings, containers, gateway, store, audit, logger: silentLogger });
  return { app, gateway, store, snapshot, config };
}

let current: Harness | null = null;
afterEach(async () => {
  await current?.app.close();
  current = null;
});

describe('管理 API', () => {
  it('/api/health 可用', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('/api/system 暴露 tailnet 基址与管理端口，并报告安全状态', async () => {
    current = await setup({ '/dsh': 'http://127.0.0.1:3081' });
    const res = await current.app.inject({ method: 'GET', url: '/api/system' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseUrl).toBe('https://my-laptop.example-tailnet.ts.net');
    expect(body.adminUrl).toBe(`http://127.0.0.1:${ADMIN_PORT}`);
    expect(body.security.safe).toBe(true);
    expect(body.sources.docker).toBe('fake-docker');
  });

  it('/api/containers 返回容器与端口', async () => {
    current = await setup();
    const body = (await current.app.inject({ method: 'GET', url: '/api/containers' })).json();
    expect(body.containers[0]).toMatchObject({ name: 'worldforge' });
    expect(body.containers[0].ports[0]).toMatchObject({ hostPort: 4173, containerPort: 8080 });
  });

  it('完整生命周期：创建 → 查询 → 改端口 → 禁用 → 删除', async () => {
    current = await setup();

    const created = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/worldforge', hostPort: 4173, note: '世界引擎' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().mapping.id as string;
    expect(current.gateway.proxyOf('/worldforge')).toBe('http://127.0.0.1:4173');

    const list = (await current.app.inject({ method: 'GET', url: '/api/mappings' })).json();
    expect(list.mappings).toHaveLength(1);
    expect(list.mappings[0]).toMatchObject({ id, status: 'active', note: '世界引擎' });

    const patched = await current.app.inject({
      method: 'PATCH',
      url: `/api/mappings/${id}`,
      payload: { hostPort: 5000 },
    });
    expect(patched.statusCode).toBe(200);
    expect(current.gateway.proxyOf('/worldforge')).toBe('http://127.0.0.1:5000');

    const disabled = await current.app.inject({
      method: 'POST',
      url: `/api/mappings/${id}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(current.gateway.has('/worldforge')).toBe(false);

    const removed = await current.app.inject({ method: 'DELETE', url: `/api/mappings/${id}` });
    expect(removed.statusCode).toBe(200);
    expect(await current.store.read()).toEqual([]);
  });

  it('拒绝建立指向管理端口的映射（409）', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/admin', hostPort: ADMIN_PORT },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('exposes-admin');
  });

  it('路径被未托管路由占用时要求确认接管（409 → 201）', async () => {
    current = await setup({ '/worldforge': 'http://127.0.0.1:4173' });

    const denied = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/worldforge', hostPort: 5000 },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().code).toBe('takeover-required');

    const allowed = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/worldforge', hostPort: 5000, confirmTakeover: true },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('入参非法时返回 400', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/x', hostPort: 70000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('不存在的映射返回 404', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'DELETE', url: '/api/mappings/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('导入既有 serve 路由', async () => {
    current = await setup({ '/worldforge': 'http://127.0.0.1:4173' });
    const res = await current.app.inject({ method: 'POST', url: '/api/mappings/import', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toHaveLength(1);
  });

  it('可导入指定端口上的指定路由', async () => {
    current = await setup({ '/a': 'http://127.0.0.1:1000', ':8443/a': 'http://127.0.0.1:2000' });
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings/import',
      payload: { routes: [{ servePort: 8443, path: '/a' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported.map((m: { servePort: number }) => m.servePort)).toEqual([8443]);
  });

  it('可在指定对外端口上创建映射，且 /api/system 暴露全部端口', async () => {
    current = await setup({ '/': 'http://127.0.0.1:3081' });

    const created = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/', hostPort: 8899, servePort: 8443 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().mapping).toMatchObject({ path: '/', servePort: 8443, status: 'active' });
    expect(current.gateway.proxyOf('/', 8443)).toBe('http://127.0.0.1:8899');
    // 443 上的既有路由不受影响。
    expect(current.gateway.proxyOf('/', 443)).toBe('http://127.0.0.1:3081');

    const system = (await current.app.inject({ method: 'GET', url: '/api/system' })).json();
    expect(system.servePorts).toEqual([443, 8443]);
    expect(system.serveHost).toBe('my-laptop.example-tailnet.ts.net');
    expect(system.servePort).toBe(443);

    const routes = (await current.app.inject({ method: 'GET', url: '/api/serve/routes' })).json();
    expect(routes.httpsPorts).toEqual([443, 8443]);
    expect(routes.routes.map((r: { servePort: number }) => r.servePort)).toEqual([443, 8443]);
  });

  it('拒绝对外端口与管理端口同号（409）', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/x', hostPort: 4173, servePort: ADMIN_PORT },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('serve-port-is-admin');
  });

  it('对外端口越界时返回 400', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/x', hostPort: 4173, servePort: 70000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('/api/serve/routes 与 /api/audit 可用', async () => {
    current = await setup({ '/dsh': 'http://127.0.0.1:3081' });
    const routes = (await current.app.inject({ method: 'GET', url: '/api/serve/routes' })).json();
    expect(routes.routes[0]).toMatchObject({ path: '/dsh', managed: false });

    await current.app.inject({ method: 'POST', url: '/api/mappings', payload: { path: '/wf', hostPort: 4173 } });
    const audit = (await current.app.inject({ method: 'GET', url: '/api/audit?limit=5' })).json();
    expect(audit.events.length).toBeGreaterThan(0);
  });

  it('拒绝非回环 Host 的请求（防 DNS rebinding）', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'GET',
      url: '/api/system',
      headers: { host: 'attacker.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden-host');
  });

  it('接受带端口的回环 Host', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'GET',
      url: '/api/system',
      headers: { host: `127.0.0.1:${ADMIN_PORT}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('管理 API · Service 维度', () => {
  it('/api/system 报告 tag 身份与 Service 列表', async () => {
    current = await setup();
    current.gateway.addService('svc:dsh', [443], true, ['100.65.32.1']);
    current.gateway.tailnetInfo = { ...current.gateway.tailnetInfo, tags: ['tag:service-host'] };

    const body = (await current.app.inject({ method: 'GET', url: '/api/system' })).json();

    expect(body.magicDnsSuffix).toBe('example-tailnet.ts.net');
    expect(body.selfTags).toEqual(['tag:service-host']);
    expect(body.canHostService).toBe(true);
    expect(body.services).toEqual([
      {
        name: 'svc:dsh',
        dnsName: 'dsh.example-tailnet.ts.net',
        servePorts: [443],
        advertised: true,
        vipIps: ['100.65.32.1'],
      },
    ]);
  });

  it('没有 tag 时 canHostService 为 false（界面据此解释为什么不能承载 Service）', async () => {
    current = await setup();
    const body = (await current.app.inject({ method: 'GET', url: '/api/system' })).json();
    expect(body.selfTags).toEqual([]);
    expect(body.canHostService).toBe(false);
  });

  it('通过 API 建立 Service 级远端映射，并在 /api/mappings 与快照里体现', async () => {
    current = await setup();
    current.gateway.addService('svc:dsh', [443], true, ['100.65.32.1']);

    const created = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: {
        path: '/',
        hostPort: 3081,
        service: 'dsh',
        remoteHost: 'my-laptop.example-tailnet.ts.net',
      },
    });
    expect(created.statusCode).toBe(201);
    const mapping = created.json().mapping;
    expect(mapping).toMatchObject({
      service: 'svc:dsh',
      path: '/',
      status: 'active',
      baseUrl: 'https://dsh.example-tailnet.ts.net',
      desiredProxy: 'http://my-laptop.example-tailnet.ts.net:3081',
    });
    expect(current.gateway.proxyOf('/', 443, 'svc:dsh')).toBe(
      'http://my-laptop.example-tailnet.ts.net:3081',
    );

    const list = (await current.app.inject({ method: 'GET', url: '/api/mappings' })).json();
    expect(list.services.map((s: { name: string }) => s.name)).toEqual(['svc:dsh']);
    expect(list.selfTags).toEqual([]);

    const routes = (await current.app.inject({ method: 'GET', url: '/api/serve/routes' })).json();
    expect(routes.services.map((s: { name: string }) => s.name)).toEqual(['svc:dsh']);
    expect(routes.routes[0]).toMatchObject({ service: 'svc:dsh', managed: true });
  });

  it('PATCH 可以在节点级与 Service 级之间切换（摘旧挂新）', async () => {
    current = await setup();
    current.gateway.addService('svc:dsh', [443], true, []);

    const created = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/dsh', hostPort: 3081 },
    });
    const id = created.json().mapping.id as string;
    expect(current.gateway.proxyOf('/dsh', 443, null)).toBe('http://127.0.0.1:3081');

    const patched = await current.app.inject({
      method: 'PATCH',
      url: `/api/mappings/${id}`,
      payload: { service: 'svc:dsh', path: '/', remoteHost: 'my-laptop.example-tailnet.ts.net' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().mapping).toMatchObject({ service: 'svc:dsh', path: '/' });
    expect(current.gateway.proxyOf('/', 443, 'svc:dsh')).toBe(
      'http://my-laptop.example-tailnet.ts.net:3081',
    );
    // 节点级的旧路径被摘除。
    expect(current.gateway.proxyOf('/dsh', 443, null)).toBeUndefined();
  });

  it('远端目标只允许 Service 级（409 remote-host-requires-service）', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/x', hostPort: 3081, remoteHost: 'my-laptop.example-tailnet.ts.net' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('remote-host-requires-service');
  });

  it('非法 Service 名返回 409 invalid-service', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings',
      payload: { path: '/', hostPort: 3081, service: 'DSH' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('invalid-service');
  });

  it('/api/mappings/import 接受 Service 维度的路由选择', async () => {
    current = await setup();
    current.gateway.addService('svc:dsh', [443], true, []);
    current.gateway.addService('svc:other', [443], true, []);
    current.gateway.set('/', 'http://127.0.0.1:3081', 443, 'svc:dsh');
    current.gateway.set('/', 'http://127.0.0.1:8899', 443, 'svc:other');

    const res = await current.app.inject({
      method: 'POST',
      url: '/api/mappings/import',
      payload: { routes: [{ service: 'svc:other', servePort: 443, path: '/' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported.map((m: { service: string }) => m.service)).toEqual(['svc:other']);
  });
});
