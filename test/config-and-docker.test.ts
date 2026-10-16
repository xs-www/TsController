import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { DockerEngineClient, normalizePipeName, resolveEndpoints } from '../src/docker/docker-client.ts';
import { normalizeContainer, normalizePorts } from '../src/docker/docker-service.ts';
import { reviveMapping } from '../src/mappings/store.ts';
import { silentLogger } from '../src/logger.ts';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('loadConfig', () => {
  it('默认监听回环地址', () => {
    delete process.env.TSCONTROLLER_HOST;
    expect(loadConfig({ dataDir: 'x' }).host).toBe('127.0.0.1');
  });

  it('拒绝任何非回环监听地址', () => {
    for (const host of ['0.0.0.0', '100.101.102.103', '::', '192.168.1.10']) {
      process.env.TSCONTROLLER_HOST = host;
      expect(() => loadConfig({ dataDir: 'x' })).toThrow(/禁止暴露在 tailnet/);
    }
  });

  it('接受回环别名', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      process.env.TSCONTROLLER_HOST = host;
      expect(loadConfig({ dataDir: 'x' }).host).toBe(host);
    }
  });

  it('端口越界时报错', () => {
    process.env.TSCONTROLLER_PORT = '99999';
    expect(() => loadConfig({ dataDir: 'x' })).toThrow(/TSCONTROLLER_PORT/);
  });

  describe('路径型配置', () => {
    it('快照目录默认锚定到 <DATA_DIR>/public', () => {
      delete process.env.TSCONTROLLER_SNAPSHOT_DIR;
      const cfg = loadConfig({ dataDir: path.resolve('data-test') });
      expect(cfg.snapshotDir).toBe(path.join(path.resolve('data-test'), 'public'));
    });

    it('TSCONTROLLER_SNAPSHOT_DIR 可覆盖快照目录（NAS 部署要用）', () => {
      process.env.TSCONTROLLER_SNAPSHOT_DIR = path.resolve('vol/tsc-snapshot');
      const cfg = loadConfig({ dataDir: path.resolve('data-test') });
      expect(cfg.snapshotDir).toBe(path.resolve('vol/tsc-snapshot'));
    });

    it('空字符串视为未设置，回落到默认值', () => {
      process.env.TSCONTROLLER_SNAPSHOT_DIR = '   ';
      process.env.TSCONTROLLER_DATA_DIR = path.resolve('data-env');
      const cfg = loadConfig();
      expect(cfg.snapshotDir).toBe(path.join(path.resolve('data-env'), 'public'));
    });

    it('snapshotIntervalMs 可配置，0 表示只在启动与收敛后写', () => {
      process.env.TSCONTROLLER_SNAPSHOT_INTERVAL_MS = '0';
      expect(loadConfig({ dataDir: 'x' }).snapshotIntervalMs).toBe(0);
      process.env.TSCONTROLLER_SNAPSHOT_INTERVAL_MS = '15000';
      expect(loadConfig({ dataDir: 'x' }).snapshotIntervalMs).toBe(15000);
      process.env.TSCONTROLLER_SNAPSHOT_INTERVAL_MS = 'abc';
      expect(() => loadConfig({ dataDir: 'x' })).toThrow(/TSCONTROLLER_SNAPSHOT_INTERVAL_MS/);
    });
  });
});

describe('Docker 端点解析', () => {
  it('归一化各种管道写法', () => {
    expect(normalizePipeName('npipe://./pipe/docker_engine')).toBe('docker_engine');
    expect(normalizePipeName('//./pipe/dockerDesktopLinuxEngine')).toBe('dockerDesktopLinuxEngine');
    expect(normalizePipeName('\\\\.\\pipe\\docker_engine')).toBe('docker_engine');
    expect(normalizePipeName('docker_engine')).toBe('docker_engine');
  });

  it('显式配置是权威的，不再追加平台默认候选', () => {
    const eps = resolveEndpoints('npipe://./pipe/custom', {});
    expect(eps).toEqual([{ kind: 'npipe', pipe: 'custom' }]);
  });

  it('未配置时才使用平台默认候选（Windows 上至少两个命名管道）', () => {
    const eps = resolveEndpoints(null, {});
    expect(eps.length).toBeGreaterThanOrEqual(2);
    expect(eps.every((e) => e.kind === 'npipe' || e.kind === 'unix')).toBe(true);
  });

  it('无法连接时抛出可读错误，且失败结果被负缓存', async () => {
    const client = new DockerEngineClient('npipe://./pipe/definitely-not-there', {
      ...silentLogger,
      child: () => silentLogger,
    } as never, {});
    const first = Date.now();
    await expect(client.request('/version')).rejects.toThrow(/无法连接 Docker Engine/);
    const firstCost = Date.now() - first;
    const cached = Date.now();
    await expect(client.request('/version')).rejects.toThrow(/无法连接 Docker Engine/);
    // 负缓存命中应当显著快于首次探测。
    expect(Date.now() - cached).toBeLessThan(Math.max(firstCost, 50));
  });

  it('解析 DOCKER_HOST 的 unix 与 tcp 形式', () => {
    expect(resolveEndpoints(null, { DOCKER_HOST: 'unix:///var/run/docker.sock' })[0]).toEqual({
      kind: 'unix',
      socketPath: '/var/run/docker.sock',
    });
    expect(resolveEndpoints(null, { DOCKER_HOST: 'tcp://127.0.0.1:2375' })[0]).toEqual({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 2375,
    });
  });

  it('未连接时 endpoint 提示未连接', () => {
    const client = new DockerEngineClient(null, { ...console } as never, {});
    expect(client.endpoint()).toContain('未连接');
  });
});

describe('Docker 数据归一化', () => {
  it('丢弃未发布的端口', () => {
    const ports = normalizePorts([
      { IP: '0.0.0.0', PrivatePort: 80, Type: 'tcp' },
      { IP: '127.0.0.1', PrivatePort: 8080, PublicPort: 4173, Type: 'tcp' },
    ]);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ hostPort: 4173, containerPort: 8080, protocol: 'tcp' });
  });

  it('保留 IPv4/IPv6 双记录以判断暴露面', () => {
    const ports = normalizePorts([
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
    ]);
    expect(ports).toHaveLength(2);
  });

  it('归一化容器主体', () => {
    const c = normalizeContainer({
      Id: 'abc123',
      Names: ['/cs22-web'],
      Image: 'cs22-marketplace-web:local',
      State: 'running',
      Status: 'Up 3 hours',
      Created: 1_700_000_000,
      Labels: { 'com.docker.compose.project': 'cs22-marketplace', 'com.docker.compose.service': 'web' },
      Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    });
    expect(c).toMatchObject({
      name: 'cs22-web',
      composeProject: 'cs22-marketplace',
      composeService: 'web',
      createdAt: 1_700_000_000_000,
    });
    expect(c.ports).toHaveLength(1);
  });
});

describe('reviveMapping', () => {
  it('丢弃非法条目', () => {
    expect(reviveMapping(null, 443)).toBeNull();
    expect(reviveMapping({ id: 'a', path: 'nope', target: { hostPort: 80 } }, 443)).toBeNull();
    expect(reviveMapping({ id: 'a', path: '/ok', target: { hostPort: 0 } }, 443)).toBeNull();
    expect(reviveMapping({ path: '/ok', target: { hostPort: 80 } }, 443)).toBeNull();
  });

  it('保留合法条目并补默认值', () => {
    const m = reviveMapping({ id: 'a', path: '/ok/', target: { hostPort: '8080', targetPath: '/' } }, 443);
    expect(m).toMatchObject({ id: 'a', path: '/ok', servePort: 443, enabled: true, note: '', ownedRoutes: [] });
    expect(m!.target).toMatchObject({ kind: 'container', hostPort: 8080, targetPath: '' });
  });

  it('缺少 servePort 时补默认端口', () => {
    expect(reviveMapping({ id: 'a', path: '/ok', target: { hostPort: 80 } }, 8443)!.servePort).toBe(8443);
    expect(
      reviveMapping({ id: 'a', path: '/ok', servePort: 9000, target: { hostPort: 80 } }, 443)!.servePort,
    ).toBe(9000);
    // 非法 servePort 也回落到默认值，而不是丢弃整条记录。
    expect(
      reviveMapping({ id: 'a', path: '/ok', servePort: 0, target: { hostPort: 80 } }, 443)!.servePort,
    ).toBe(443);
  });

  it('迁移旧格式的 ownedPaths（无端口维度）到 ownedRoutes', () => {
    const m = reviveMapping(
      {
        id: 'a',
        path: '/home',
        servePort: 8443,
        target: { hostPort: 8899 },
        ownedPaths: ['/home', '/old'],
      },
      443,
    )!;
    expect(m.ownedRoutes).toEqual([
      { servePort: 8443, path: '/home' },
      { servePort: 8443, path: '/old' },
    ]);
  });

  it('新格式 ownedRoutes 优先于旧的 ownedPaths，并丢弃非法项', () => {
    const m = reviveMapping(
      {
        id: 'a',
        path: '/home',
        target: { hostPort: 8899 },
        ownedPaths: ['/ignored'],
        ownedRoutes: [
          { servePort: 8443, path: '/home' },
          { servePort: 99999, path: '/bad-port' },
          { servePort: 443, path: 'no-slash' },
          { servePort: 443, path: '/home' },
        ],
      },
      443,
    )!;
    expect(m.ownedRoutes).toEqual([
      { servePort: 8443, path: '/home' },
      // 端口非法 → 回落到默认端口而不是丢弃路径
      { servePort: 443, path: '/bad-port' },
      // 路径非法 → 丢弃
      // 与第一条同端口不同路径，保留
      { servePort: 443, path: '/home' },
    ]);
  });
});
