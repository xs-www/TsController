import { describe, expect, it } from 'vitest';
import { MappingConflictError, MappingService } from '../src/mappings/mapping-service.ts';
import { MemoryAuditLog, MemoryMappingStore } from '../src/mappings/store.ts';
import { MemorySnapshotWriter } from '../src/snapshot.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeContainerSource, FakeServeGateway, makeContainer } from './fakes.ts';

const ADMIN_PORT = 8787;

function setup(options: { handlers?: Record<string, string>; containers?: ReturnType<typeof makeContainer>[] } = {}) {
  const gateway = new FakeServeGateway(options.handlers ?? {});
  const containers = new FakeContainerSource(options.containers ?? []);
  const store = new MemoryMappingStore();
  const audit = new MemoryAuditLog();
  const snapshot = new MemorySnapshotWriter();
  const service = new MappingService({
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
  return { gateway, containers, store, audit, service, snapshot };
}

describe('MappingService.create', () => {
  it('创建后立即写入 serve 并持久化', async () => {
    const { gateway, store, service } = setup();
    const { mapping, apply } = await service.create({ path: '/worldforge', hostPort: 4173 });

    expect(mapping.path).toBe('/worldforge');
    expect(mapping.servePort).toBe(443);
    expect(mapping.status).toBe('active');
    expect(apply.upserted).toEqual([{ service: null, servePort: 443, path: '/worldforge' }]);
    expect(apply.inSync).toBe(true);
    expect(gateway.proxyOf('/worldforge')).toBe('http://127.0.0.1:4173');
    expect((await store.read())[0]!.ownedRoutes).toEqual([{ service: null, servePort: 443, path: '/worldforge' }]);
  });

  it('自动按宿主机端口关联容器', async () => {
    const { service } = setup({ containers: [makeContainer('worldforge', [{ hostPort: 4173, containerPort: 8080 }])] });
    const { mapping } = await service.create({ path: '/wf', hostPort: 4173 });
    expect(mapping.target.kind).toBe('container');
    expect(mapping.target.containerName).toBe('worldforge');
    expect(mapping.target.containerPort).toBe(8080);
  });

  it('拒绝指向管理端口的映射', async () => {
    const { service, gateway } = setup();
    await expect(service.create({ path: '/admin', hostPort: ADMIN_PORT })).rejects.toMatchObject({
      name: 'MappingConflictError',
      code: 'exposes-admin',
    });
    expect(gateway.handlers.size).toBe(0);
  });

  it('拒绝对外端口与管理端口同号的映射', async () => {
    const { service, gateway } = setup();
    await expect(service.create({ path: '/x', hostPort: 4173, servePort: ADMIN_PORT })).rejects.toMatchObject({
      code: 'serve-port-is-admin',
    });
    expect(gateway.handlers.size).toBe(0);
  });

  it('目标路径非法时拒绝', async () => {
    const { service } = setup();
    await expect(service.create({ path: 'no-slash', hostPort: 4173 })).rejects.toBeInstanceOf(MappingConflictError);
    await expect(service.create({ path: '/ok', hostPort: 4173, targetPath: '/a b' })).rejects.toMatchObject({
      code: 'invalid-target-path',
    });
  });

  it('同一端口上路径重复时拒绝', async () => {
    const { service } = setup();
    await service.create({ path: '/wf', hostPort: 4173 });
    await expect(service.create({ path: '/wf', hostPort: 5000 })).rejects.toMatchObject({ code: 'duplicate-path' });
  });

  it('占用未托管路由时需要显式确认接管', async () => {
    const { service, gateway } = setup({ handlers: { '/worldforge': 'http://127.0.0.1:4173' } });
    await expect(service.create({ path: '/worldforge', hostPort: 5000 })).rejects.toMatchObject({
      code: 'takeover-required',
    });
    const { mapping } = await service.create({ path: '/worldforge', hostPort: 5000, confirmTakeover: true });
    expect(mapping.status).toBe('active');
    expect(gateway.proxyOf('/worldforge')).toBe('http://127.0.0.1:5000');
  });

  it('写入失败时保留映射并给出可重试的 pending 状态', async () => {
    const { service, gateway } = setup();
    gateway.fail('/wf');
    const { mapping, apply } = await service.create({ path: '/wf', hostPort: 4173 });

    expect(apply.errors[0]).toContain('挂载 /wf 失败');
    expect(mapping.status).toBe('pending');
    expect(gateway.has('/wf')).toBe(false);

    gateway.failUpsert.clear();
    const retry = await service.apply();
    expect(retry.upserted).toEqual([{ service: null, servePort: 443, path: '/wf' }]);
    expect((await service.overview()).mappings[0]!.status).toBe('active');
  });
});

describe('MappingService 多端口', () => {
  it('默认端口来自依赖注入，可在创建时覆盖', async () => {
    const { service, gateway } = setup();
    const a = await service.create({ path: '/a', hostPort: 4173 });
    const b = await service.create({ path: '/b', hostPort: 4173, servePort: 8443 });

    expect(a.mapping.servePort).toBe(443);
    expect(b.mapping.servePort).toBe(8443);
    expect(gateway.proxyOf('/a')).toBe('http://127.0.0.1:4173');
    expect(gateway.proxyOf('/b', 8443)).toBe('http://127.0.0.1:4173');
  });

  it('同一路径可以同时挂在两个端口上', async () => {
    const { service, gateway } = setup();
    await service.create({ path: '/', hostPort: 3081 });
    const second = await service.create({ path: '/', hostPort: 8899, servePort: 8443 });

    expect(second.apply.errors).toEqual([]);
    expect(second.mapping.status).toBe('active');
    expect(gateway.proxyOf('/', 443)).toBe('http://127.0.0.1:3081');
    expect(gateway.proxyOf('/', 8443)).toBe('http://127.0.0.1:8899');
  });

  it('改端口时摘掉旧端口上的路由', async () => {
    const { service, gateway } = setup();
    const { mapping } = await service.create({ path: '/home', hostPort: 8899 });
    expect(gateway.has('/home', 443)).toBe(true);

    await service.update(mapping.id, { path: '/home', hostPort: 8899, servePort: 8443 });

    expect(gateway.has('/home', 443)).toBe(false);
    expect(gateway.proxyOf('/home', 8443)).toBe('http://127.0.0.1:8899');
    expect((await service.overview()).mappings[0]!.status).toBe('active');
  });

  it('在非默认端口上也能禁用与删除', async () => {
    const { service, gateway } = setup();
    const { mapping } = await service.create({ path: '/home', hostPort: 8899, servePort: 8443 });

    await service.setEnabled(mapping.id, false);
    expect(gateway.has('/home', 8443)).toBe(false);

    await service.setEnabled(mapping.id, true);
    expect(gateway.has('/home', 8443)).toBe(true);

    const removed = await service.remove(mapping.id);
    expect(removed.apply.removed).toEqual([{ service: null, servePort: 8443, path: '/home' }]);
    expect(gateway.has('/home', 8443)).toBe(false);
  });

  it('删除非默认端口的映射后，再 apply 不会误删其它端口的路由', async () => {
    const { service, gateway } = setup();
    const { mapping } = await service.create({ path: '/home', hostPort: 8899, servePort: 8443 });
    gateway.set('/', 'http://127.0.0.1:3081', 443);
    gateway.set('/', 'http://127.0.0.1:8899', 8443);

    await service.remove(mapping.id);
    await service.apply();

    expect(gateway.proxyOf('/', 443)).toBe('http://127.0.0.1:3081');
    expect(gateway.proxyOf('/', 8443)).toBe('http://127.0.0.1:8899');
  });
});

describe('MappingService 状态变更', () => {
  it('禁用会摘除 serve 路由，重新启用会挂回', async () => {
    const { service, gateway } = setup();
    const { mapping } = await service.create({ path: '/wf', hostPort: 4173 });

    await service.setEnabled(mapping.id, false);
    expect(gateway.has('/wf')).toBe(false);
    expect((await service.overview()).mappings[0]!.status).toBe('disabled');

    await service.setEnabled(mapping.id, true);
    expect(gateway.proxyOf('/wf')).toBe('http://127.0.0.1:4173');
    expect((await service.overview()).mappings[0]!.status).toBe('active');
  });

  it('删除会摘除 serve 路由且不再留下归属', async () => {
    const { service, gateway, store } = setup();
    const { mapping } = await service.create({ path: '/wf', hostPort: 4173 });
    await service.remove(mapping.id);

    expect(gateway.has('/wf')).toBe(false);
    expect(await store.read()).toEqual([]);

    // 再 apply 一次不应误删其它路由。
    gateway.set('/', 'http://127.0.0.1:3081');
    await service.apply();
    expect(gateway.proxyOf('/')).toBe('http://127.0.0.1:3081');
  });

  it('改名时摘掉旧路径', async () => {
    const { service, gateway } = setup();
    const { mapping } = await service.create({ path: '/wf', hostPort: 4173 });
    await service.update(mapping.id, { path: '/worldforge', hostPort: 4173 });

    expect(gateway.has('/wf')).toBe(false);
    expect(gateway.proxyOf('/worldforge')).toBe('http://127.0.0.1:4173');
  });

  it('摘除失败时保留归属，下次 apply 重试', async () => {
    const { service, gateway } = setup();
    const { mapping } = await service.create({ path: '/wf', hostPort: 4173 });
    gateway.failDeletion('/wf');

    await service.setEnabled(mapping.id, false);
    expect(gateway.has('/wf')).toBe(true);
    expect((await service.overview()).mappings[0]!.status).toBe('disabled-drift');
    expect((await service.overview()).mappings[0]!.ownedRoutes).toEqual([
      { service: null, servePort: 443, path: '/wf' },
    ]);

    gateway.failRemove.clear();
    const res = await service.apply();
    expect(res.removed).toEqual([{ service: null, servePort: 443, path: '/wf' }]);
    expect(gateway.has('/wf')).toBe(false);
  });
});

describe('MappingService.importExternal', () => {
  it('把既有 serve 路由接管为受管映射，并自动关联容器', async () => {
    const { service, gateway } = setup({
      handlers: {
        '/': 'http://127.0.0.1:3081',
        '/worldforge': 'http://127.0.0.1:4173',
        '/agent': 'http://127.0.0.1:443/api/agent',
        ':8443/': 'http://127.0.0.1:8899',
      },
      containers: [makeContainer('worldforge', [{ hostPort: 4173, containerPort: 8080 }])],
    });

    const { imported } = await service.importExternal();
    expect(imported.map((m) => `${m.servePort}:${m.path}`).sort()).toEqual([
      '443:/',
      '443:/agent',
      '443:/worldforge',
      '8443:/',
    ]);

    const overview = await service.overview();
    expect(overview.externalRoutes).toEqual([]);
    const wf = overview.mappings.find((m) => m.path === '/worldforge')!;
    expect(wf.target.kind).toBe('container');
    expect(wf.status).toBe('active');
    const agent = overview.mappings.find((m) => m.path === '/agent')!;
    expect(agent.target.targetPath).toBe('/api/agent');
    const portal = overview.mappings.find((m) => m.servePort === 8443)!;
    expect(portal.target.hostPort).toBe(8899);
    // 导入不应改动 serve 配置本身。
    expect(gateway.calls.filter((c) => c.op === 'upsert')).toEqual([]);
  });

  it('拒绝接管指向管理端口的路由', async () => {
    const { service } = setup({ handlers: { '/leak': `http://127.0.0.1:${ADMIN_PORT}` } });
    const { imported, skipped } = await service.importExternal();
    expect(imported).toEqual([]);
    expect(skipped[0]).toMatchObject({ servePort: 443, path: '/leak' });
  });

  it('可只导入指定路由（端口 + 路径）', async () => {
    const { service } = setup({
      handlers: { '/a': 'http://127.0.0.1:1000', ':8443/a': 'http://127.0.0.1:2000' },
    });
    const { imported } = await service.importExternal([{ servePort: 8443, path: '/a' }]);
    expect(imported.map((m) => `${m.servePort}:${m.path}`)).toEqual(['8443:/a']);
  });
});

describe('MappingService.enforceExposureGuard', () => {
  it('摘除暴露管理端口的路由并留下审计', async () => {
    const { service, gateway, audit } = setup({
      handlers: { '/leak': `http://127.0.0.1:${ADMIN_PORT}`, '/ok': 'http://127.0.0.1:3081' },
    });
    const guard = await service.enforceExposureGuard();

    expect(guard.exposures).toEqual([
      { service: null, servePort: 443, path: '/leak', proxy: `http://127.0.0.1:${ADMIN_PORT}` },
    ]);
    expect(guard.removed).toEqual([{ service: null, servePort: 443, path: '/leak' }]);
    expect(gateway.has('/leak')).toBe(false);
    expect(gateway.proxyOf('/ok')).toBe('http://127.0.0.1:3081');

    const events = await audit.tail(10);
    expect(events.map((e) => e.kind)).toContain('exposure-detected');
    expect(events.map((e) => e.kind)).toContain('exposure-removed');
  });

  it('扫描范围覆盖全部 HTTPS 端口，不只 443', async () => {
    const { service, gateway } = setup({
      handlers: { ':8443/leak': `http://127.0.0.1:${ADMIN_PORT}`, '/ok': 'http://127.0.0.1:3081' },
    });
    const guard = await service.enforceExposureGuard();

    expect(guard.exposures).toEqual([
      { service: null, servePort: 8443, path: '/leak', proxy: `http://127.0.0.1:${ADMIN_PORT}` },
    ]);
    expect(guard.removed).toEqual([{ service: null, servePort: 8443, path: '/leak' }]);
    expect(gateway.has('/leak', 8443)).toBe(false);
    // 443 上的正常路由不受影响。
    expect(gateway.proxyOf('/ok')).toBe('http://127.0.0.1:3081');
  });

  it('没有暴露时什么都不做', async () => {
    const { service, audit } = setup({ handlers: { '/ok': 'http://127.0.0.1:3081' } });
    const guard = await service.enforceExposureGuard();
    expect(guard).toEqual({ exposures: [], removed: [] });
    expect(await audit.tail(10)).toEqual([]);
  });
});

describe('MappingService 快照发布', () => {
  it('每次收敛后刷新快照，内容反映收敛后的真实状态', async () => {
    const { service, snapshot } = setup({ handlers: { '/external': 'http://127.0.0.1:3081' } });
    expect(snapshot.writes).toEqual([]);

    await service.create({ path: '/wf', hostPort: 4173 });

    const afterCreate = snapshot.last!;
    expect(afterCreate.schemaVersion).toBe(2);
    expect(afterCreate.routes.map((r) => r.path)).toEqual(['/external', '/wf']);
    const wf = afterCreate.routes.find((r) => r.path === '/wf')!;
    expect(wf).toMatchObject({ managed: true, status: 'active', proxy: 'http://127.0.0.1:4173' });
    expect(afterCreate.routes.find((r) => r.path === '/external')!.managed).toBe(false);
    expect(afterCreate.summary).toMatchObject({ total: 2, managed: 1, unmanaged: 1, active: 1 });
  });

  it('删除后快照不再包含该路由', async () => {
    const { service, snapshot } = setup();
    const { mapping } = await service.create({ path: '/wf', hostPort: 4173 });
    await service.remove(mapping.id);

    expect(snapshot.last!.routes.some((r) => r.path === '/wf')).toBe(false);
    expect(snapshot.last!.summary.total).toBe(0);
  });

  it('publishSnapshot 可在无变更时手动调用（启动与定期刷新走这条路径）', async () => {
    const { service, gateway, snapshot } = setup();
    gateway.set('/manual', 'http://127.0.0.1:9999');

    const published = await service.publishSnapshot();

    expect(published.routes.map((r) => r.path)).toEqual(['/manual']);
    expect(snapshot.last).toEqual(published);
    // 未托管路由不该被认领。
    expect(published.routes[0]!.managed).toBe(false);
  });

  it('快照写入失败不影响收敛结果', async () => {
    const { service, gateway } = setup();
    const failing = new (class extends MemorySnapshotWriter {
      override async write(): Promise<string> {
        throw new Error('模拟磁盘故障');
      }
    })();
    const svc = new MappingService({
      store: new MemoryMappingStore(),
      gateway,
      containers: new FakeContainerSource(),
      audit: new MemoryAuditLog(),
      logger: silentLogger,
      adminPort: ADMIN_PORT,
      servePort: 443,
      autoUnexpose: true,
      snapshot: failing,
    });

    const result = await svc.create({ path: '/wf', hostPort: 4173 });
    expect(result.apply.errors).toEqual([]);
    expect(result.mapping.status).toBe('active');
    expect(gateway.proxyOf('/wf')).toBe('http://127.0.0.1:4173');
    void service;
  });
});

describe('MappingService.overview', () => {
  it('区分受管与未托管路由', async () => {
    const { service } = setup({
      handlers: { '/': 'http://127.0.0.1:3081', '/dsh': 'http://127.0.0.1:3081' },
    });
    await service.create({ path: '/wf', hostPort: 4173 });
    const overview = await service.overview();

    expect(overview.externalRoutes.map((r) => r.path)).toEqual(['/', '/dsh']);
    expect(overview.counts.active).toBe(1);
    expect(overview.planSummary.inSync).toBe(true);
  });

  it('同名的未托管路由只在对应端口上被认作未托管', async () => {
    const { service } = setup({ handlers: { '/': 'http://127.0.0.1:3081' } });
    await service.create({ path: '/', hostPort: 8899, servePort: 8443 });

    const overview = await service.overview();
    expect(overview.externalRoutes).toEqual([
      {
        service: null,
        servePort: 443,
        path: '/',
        proxy: 'http://127.0.0.1:3081',
        hostPort: 3081,
        host: '127.0.0.1',
        kind: 'proxy',
        fromServiceConfig: false,
        serviceInfo: null,
      },
    ]);
    expect(overview.mappings[0]).toMatchObject({ servePort: 8443, status: 'active' });
  });

  it('serveRoutes 标记归属且带端口', async () => {
    const { service } = setup({ handlers: { '/dsh': 'http://127.0.0.1:3081' } });
    const { mapping } = await service.create({ path: '/home', hostPort: 8899, servePort: 8443 });
    const routes = await service.serveRoutes();

    expect(routes.find((r) => r.servePort === 8443 && r.path === '/home')).toMatchObject({
      managed: true,
      mappingId: mapping.id,
    });
    expect(routes.find((r) => r.servePort === 443 && r.path === '/dsh')).toMatchObject({
      managed: false,
      mappingId: null,
    });
  });
});
