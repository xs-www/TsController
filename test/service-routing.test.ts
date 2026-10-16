/**
 * Service 级路由（Tailscale Services / tagged node）的专项测试。
 *
 * 覆盖四条与节点级完全不同的链路：
 * 1. 写入时带 `--service`（由 `gateway.calls` 断言）；
 * 2. 目标可以是**远端主机**（service host 代理回本机或其它机器）；
 * 3. 「配置写对了但还没被承认」→ `awaiting-approval`，且**不产生任何写入**；
 * 4. 安全闸门与导入都要覆盖 Service 命名空间。
 */

import { describe, expect, it } from 'vitest';
import { MappingService } from '../src/mappings/mapping-service.ts';
import { MemoryAuditLog, MemoryMappingStore } from '../src/mappings/store.ts';
import { MemorySnapshotWriter } from '../src/snapshot.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeContainerSource, FakeServeGateway, makeContainer } from './fakes.ts';

const ADMIN_PORT = 8787;
const SERVICE = 'svc:dsh';
const REMOTE = 'my-laptop.example-tailnet.ts.net';

function setup() {
  const gateway = new FakeServeGateway();
  const store = new MemoryMappingStore();
  const audit = new MemoryAuditLog();
  const snapshot = new MemorySnapshotWriter();
  const containers = new FakeContainerSource([makeContainer('dsh', [{ hostPort: 3081, containerPort: 3081 }])]);
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
  return { gateway, store, audit, snapshot, containers, service };
}

describe('MappingService · Service 级路由', () => {
  it('创建 Service 级映射时按 --service 维度写入，并在映射库里记下 Service', async () => {
    const { service, gateway, store } = setup();
    gateway.addService(SERVICE, [443]);

    const { mapping, apply } = await service.create({
      path: '/',
      hostPort: 3081,
      service: SERVICE,
    });

    expect(apply.errors).toEqual([]);
    expect(apply.upserted).toEqual([{ service: SERVICE, servePort: 443, path: '/' }]);
    // 关键：写的是 Service 命名空间，而不是节点级的 `/`。
    expect(gateway.proxyOf('/', 443, SERVICE)).toBe('http://127.0.0.1:3081');
    expect(gateway.proxyOf('/', 443, null)).toBeUndefined();
    expect(gateway.calls[0]).toMatchObject({ op: 'upsert', service: SERVICE, servePort: 443 });
    expect((await store.read())[0]!.service).toBe(SERVICE);
    expect(apply.inSync).toBe(true);
  });

  it('接受 `dsh` 与 `svc:dsh` 两种写法，并统一归一化', async () => {
    const { service, gateway, store } = setup();
    gateway.addService(SERVICE, [443]);
    const { mapping } = await service.create({ path: '/', hostPort: 3081, service: 'dsh' });
    expect(mapping.service).toBe(SERVICE);
    expect((await store.read())[0]!.service).toBe(SERVICE);
  });

  it('非法 Service 名 → invalid-service，且不写入 serve', async () => {
    const { service, gateway } = setup();
    await expect(service.create({ path: '/', hostPort: 3081, service: 'DSH' })).rejects.toMatchObject({
      code: 'invalid-service',
    });
    expect(gateway.handlers.size).toBe(0);
    expect(gateway.calls).toEqual([]);
  });

  it('Service 级与节点级可以用同一个路径，互不冲突', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);

    await service.create({ path: '/', hostPort: 3081, service: SERVICE });
    const second = await service.create({ path: '/', hostPort: 8899 });

    expect(second.apply.errors).toEqual([]);
    expect(gateway.proxyOf('/', 443, SERVICE)).toBe('http://127.0.0.1:3081');
    expect(gateway.proxyOf('/', 443, null)).toBe('http://127.0.0.1:8899');
  });

  it('同一 Service 上路径重复 → duplicate-path', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);
    await service.create({ path: '/', hostPort: 3081, service: SERVICE });
    await expect(service.create({ path: '/', hostPort: 5000, service: SERVICE })).rejects.toMatchObject({
      code: 'duplicate-path',
    });
  });

  it('从 Service 级改回节点级时，摘掉 Service 上的旧路由', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);
    const { mapping } = await service.create({ path: '/', hostPort: 3081, service: SERVICE });

    await service.update(mapping.id, { path: '/', hostPort: 3081, service: null });

    expect(gateway.proxyOf('/', 443, SERVICE)).toBeUndefined();
    expect(gateway.proxyOf('/', 443, null)).toBe('http://127.0.0.1:3081');
  });

  it('删除最后一条 Service 映射后，Service 上的路由被摘干净', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);
    const { mapping } = await service.create({ path: '/', hostPort: 3081, service: SERVICE });
    await service.remove(mapping.id);

    expect(gateway.handlers.size).toBe(0);
    expect(gateway.has('/', 443, SERVICE)).toBe(false);
  });

  it('Service 被承认后 → active；未被承认 → awaiting-approval 且不重写配置', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443], false); // 只有端点配置，还没有 service-host 能力
    gateway.set('/', 'http://127.0.0.1:3081', 443, SERVICE);

    const mapping = await service.create({ path: '/', hostPort: 3081, service: SERVICE, confirmTakeover: true });

    expect(mapping.mapping.status).toBe('awaiting-approval');
    expect(mapping.mapping.detail).toContain('Service');
    // 配置已经写对了：不应该产生任何多余的写入。
    expect(mapping.apply.upserted).toEqual([]);
    expect(mapping.apply.inSync).toBe(true);

    // 被承认（service-host 能力出现）之后自动转为 active。
    gateway.addService(SERVICE, [443], true, ['100.65.32.1']);
    const overview = await service.overview();
    expect(overview.mappings[0]!.status).toBe('active');
    expect(overview.services[0]).toMatchObject({ name: SERVICE, advertised: true, vipIps: ['100.65.32.1'] });
  });
});

describe('MappingService · 远端目标', () => {
  it('Service host 代理到远端主机时，写的是远端地址', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);

    const { apply } = await service.create({
      path: '/',
      hostPort: 3081,
      service: SERVICE,
      remoteHost: REMOTE,
    });

    expect(apply.errors).toEqual([]);
    expect(gateway.proxyOf('/', 443, SERVICE)).toBe(`http://${REMOTE}:3081`);
  });

  it('远端目标不会被误认成本机容器（kind 为 host）', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);
    const { mapping } = await service.create({
      path: '/',
      hostPort: 3081, // 容器清单里 3081 对应容器 dsh
      service: SERVICE,
      remoteHost: REMOTE,
    });
    expect(mapping.target.kind).toBe('host');
    expect(mapping.target.containerName).toBeUndefined();
  });

  it('远端目标只允许挂在 Service 级路由上', async () => {
    const { service, gateway } = setup();
    await expect(
      service.create({ path: '/x', hostPort: 3081, remoteHost: REMOTE }),
    ).rejects.toMatchObject({ code: 'remote-host-requires-service' });
    expect(gateway.handlers.size).toBe(0);
  });

  it('远端目标的端口即使等于管理端口也不拒绝（那是另一台机器）', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443]);
    const { apply } = await service.create({
      path: '/',
      hostPort: ADMIN_PORT,
      service: SERVICE,
      remoteHost: REMOTE,
    });
    expect(apply.errors).toEqual([]);
    expect(apply.blocked).toEqual([]);
  });

  it('非法远端主机名 → invalid-remote-host', async () => {
    const { service } = setup();
    await expect(
      service.create({ path: '/', hostPort: 3081, service: SERVICE, remoteHost: 'http://nas.ts.net' }),
    ).rejects.toMatchObject({ code: 'invalid-remote-host' });
  });
});

describe('MappingService · Service 命名空间的安全闸门', () => {
  it('Service 端点指向管理端口时被检测并摘除', async () => {
    const { service, gateway, audit } = setup();
    gateway.addService('svc:leak', [443], true, ['100.65.32.9']);
    gateway.set('/', `http://127.0.0.1:${ADMIN_PORT}`, 443, 'svc:leak');

    const guard = await service.enforceExposureGuard();

    expect(guard.exposures).toEqual([
      { service: 'svc:leak', servePort: 443, path: '/', proxy: `http://127.0.0.1:${ADMIN_PORT}` },
    ]);
    expect(guard.removed).toEqual([{ service: 'svc:leak', servePort: 443, path: '/' }]);
    expect(gateway.has('/', 443, 'svc:leak')).toBe(false);
    expect((await audit.tail(10)).map((e) => e.kind)).toContain('exposure-removed');
  });

  it('节点级与 Service 级同名路径互不牵连', async () => {
    const { service, gateway } = setup();
    gateway.addService('svc:leak', [443], true, ['100.65.32.9']);
    gateway.set('/', `http://127.0.0.1:${ADMIN_PORT}`, 443, 'svc:leak');
    gateway.set('/', 'http://127.0.0.1:3081', 443, null);

    await service.enforceExposureGuard();

    // Service 上的暴露被摘掉，节点级同名路由原样保留。
    expect(gateway.has('/', 443, 'svc:leak')).toBe(false);
    expect(gateway.proxyOf('/', 443, null)).toBe('http://127.0.0.1:3081');
  });
});

describe('MappingService · 导入 Service 端点', () => {
  it('把既有 Service 端点接管为受管映射，且不改动 serve', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443], true, ['100.65.32.1']);
    gateway.set('/', `http://${REMOTE}:3081`, 443, SERVICE);

    const { imported, skipped } = await service.importExternal();

    expect(skipped).toEqual([]);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ service: SERVICE, path: '/', servePort: 443 });
    // 远端目标被识别为 host + remoteHost。
    expect(imported[0]!.target).toMatchObject({ kind: 'host', hostPort: 3081, remoteHost: REMOTE });
    expect(imported[0]!.note).toContain('Service');
    // 导入只是认领，不写 serve。
    expect(gateway.calls.filter((c) => c.op === 'upsert')).toEqual([]);

    const overview = await service.overview();
    expect(overview.externalRoutes).toEqual([]);
    expect(overview.mappings[0]!.status).toBe('active');
  });

  it('可只导入指定的 Service 路由', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443], true, []);
    gateway.addService('svc:other', [443], true, []);
    gateway.set('/', 'http://127.0.0.1:3081', 443, SERVICE);
    gateway.set('/', 'http://127.0.0.1:8899', 443, 'svc:other');

    const { imported } = await service.importExternal([{ service: 'svc:other', servePort: 443, path: '/' }]);
    expect(imported.map((m) => m.service)).toEqual(['svc:other']);
  });

  it('Service 上的暴露不做接管，并给出原因', async () => {
    const { service, gateway } = setup();
    gateway.addService('svc:leak', [443], true, []);
    gateway.set('/', `http://127.0.0.1:${ADMIN_PORT}`, 443, 'svc:leak');

    const { imported, skipped } = await service.importExternal();
    expect(imported).toEqual([]);
    expect(skipped[0]).toMatchObject({ service: 'svc:leak', path: '/', reason: expect.stringContaining('管理端口') });
  });
});

describe('MappingService · Service 状态视图', () => {
  it('overview 会把 Service 列表与 selfTags 一并返回', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443], true, ['100.65.32.1']);
    gateway.tailnetInfo = { ...gateway.tailnetInfo, tags: ['tag:service-host'] };

    const overview = await service.overview();
    expect(overview.services).toEqual([
      {
        name: SERVICE,
        dnsName: 'dsh.example-tailnet.ts.net',
        servePorts: [443],
        advertised: true,
        vipIps: ['100.65.32.1'],
      },
    ]);
    expect(overview.selfTags).toEqual(['tag:service-host']);
  });

  it('canHostService 依据本节点是否有 tag 判定', async () => {
    const { service, gateway } = setup();
    expect(await service.canHostService()).toEqual({ tags: [], canHostService: false });
    gateway.tailnetInfo = { ...gateway.tailnetInfo, tags: ['tag:service-host'] };
    expect(await service.canHostService()).toEqual({ tags: ['tag:service-host'], canHostService: true });
  });

  it('Service 路由的对外地址用 Service 的 MagicDNS 名', async () => {
    const { service, gateway } = setup();
    gateway.addService(SERVICE, [443], true, []);
    const { mapping } = await service.create({ path: '/', hostPort: 3081, service: SERVICE });
    expect(mapping.baseUrl).toBe('https://dsh.example-tailnet.ts.net');
  });

  it('快照带上了 Service 维度与 Service 列表（schemaVersion=2）', async () => {
    const { service, gateway, snapshot } = setup();
    gateway.addService(SERVICE, [443], true, ['100.65.32.1']);
    await service.create({ path: '/', hostPort: 3081, service: SERVICE });

    const snap = snapshot.last!;
    expect(snap.schemaVersion).toBe(2);
    expect(snap.services.map((s) => s.name)).toEqual([SERVICE]);
    const route = snap.routes.find((r) => r.service === SERVICE)!;
    expect(route).toMatchObject({
      service: SERVICE,
      path: '/',
      host: 'dsh.example-tailnet.ts.net',
      url: 'https://dsh.example-tailnet.ts.net/',
      managed: true,
      status: 'active',
    });
  });
});
