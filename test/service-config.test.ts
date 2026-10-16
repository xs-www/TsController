/**
 * Tailscale Service 配置解析与 CLI 参数拼装的测试。
 *
 * 这两层是 Service 支持的**地基**：
 * - `parseServiceConfig` 读的是 `serve get-config --all`（`serve status --json` 里没有 Service）；
 * - `TailscaleCli` 必须把 `--service=svc:x` 放在 `--https` 之前，否则会改错命名空间。
 *
 * 测试数据取自上游实现（`cmd/tailscale/cli/serve_v2.go` 的 `runServeGetConfig`
 * 与官方文档的配置样例）。
 */

import { describe, expect, it } from 'vitest';
import {
  mergeServeSnapshots,
  parseEndpointKey,
  parseServeStatus,
  parseServiceConfig,
  parseServiceTarget,
  serviceInfoOf,
} from '../src/tailscale/serve-config.ts';
import { parseServiceHostCap } from '../src/tailscale/tailscale-service.ts';
import { TailscaleCli, type CommandRunner, type RunResult } from '../src/tailscale/tailscale-cli.ts';
import { silentLogger } from '../src/logger.ts';

/** 真实 `serve get-config --all` 的同构输出。 */
const REAL_SERVICE_CONFIG = {
  version: '0.0.1',
  services: {
    'svc:dsh': {
      advertised: true,
      endpoints: {
        'tcp:443': 'http://my-laptop.example-tailnet.ts.net:3081',
      },
    },
    'svc:db': {
      endpoints: {
        'tcp:5432': 'tcp://127.0.0.1:5432',
        'tcp:8080': 'https://nas.example-tailnet.ts.net:8443',
        'tcp:9000': 'unix:/var/run/app.sock',
        'tcp:9999': '',
      },
    },
  },
};

describe('parseEndpointKey', () => {
  it('解析 tcp:端口 与端口区间', () => {
    expect(parseEndpointKey('tcp:443')).toEqual({ protocol: 'tcp', port: 443 });
    expect(parseEndpointKey('tcp:8000-8010')).toEqual({ protocol: 'tcp', port: 8000 });
    expect(parseEndpointKey('TCP:80')).toEqual({ protocol: 'tcp', port: 80 });
  });

  it('拒绝没有端口或越界的形态（tun 之类不参与托管）', () => {
    expect(parseEndpointKey('tun')).toBeNull();
    expect(parseEndpointKey('tcp:')).toBeNull();
    expect(parseEndpointKey('tcp:0')).toBeNull();
    expect(parseEndpointKey('tcp:70000')).toBeNull();
  });
});

describe('parseServiceTarget', () => {
  it('HTTP(S) 目标是可托管的代理', () => {
    const remote = parseServiceTarget('http://my-laptop.example-tailnet.ts.net:3081');
    expect(remote).toMatchObject({
      kind: 'proxy',
      host: 'my-laptop.example-tailnet.ts.net',
      hostPort: 3081,
      loopback: false,
      fromServiceConfig: true,
    });
    const local = parseServiceTarget('http://127.0.0.1:3081');
    expect(local).toMatchObject({ kind: 'proxy', hostPort: 3081, loopback: true });
    const tls = parseServiceTarget('https://nas.example-tailnet.ts.net:8443');
    expect(tls).toMatchObject({ kind: 'proxy', hostPort: 8443, loopback: false });
  });

  it('tcp / unix 目标是「其它」，只读展示不参与托管', () => {
    expect(parseServiceTarget('tcp://127.0.0.1:5432')).toMatchObject({ kind: 'other' });
    expect(parseServiceTarget('unix:/var/run/app.sock')).toMatchObject({ kind: 'other' });
  });

  it('无法解析的目标也归为「其它」，而不是让整次解析失败', () => {
    expect(parseServiceTarget('nonsense')).toBeNull();
    const snap = parseServiceConfig({ services: { 'svc:x': { endpoints: { 'tcp:443': 'nonsense' } } } }, 'ts.net');
    // 不丢弃：归为 other 以便界面能如实显示「本节点上还有这么一条端点」。
    expect(snap.routes).toHaveLength(1);
    expect(snap.routes[0]!.handler).toMatchObject({ kind: 'other', raw: 'nonsense' });
    expect(snap.httpsPorts).toEqual([]);
  });
});

describe('parseServiceConfig', () => {
  it('把端点映射成带 Service 维度的路由', () => {
    const snap = parseServiceConfig(REAL_SERVICE_CONFIG, 'example-tailnet.ts.net');

    // 空目标是无效端点 → 不产生路由；tcp/unix 归为 other（只读展示）。
    expect(snap.routes).toHaveLength(4);
    const dsh = snap.routes.find((r) => r.service === 'svc:dsh')!;
    expect(dsh).toMatchObject({
      servePort: 443,
      path: '/',
      host: 'dsh.example-tailnet.ts.net',
      managed: false,
      mappingId: null,
    });
    expect(dsh.handler).toMatchObject({
      kind: 'proxy',
      hostPort: 3081,
      host: 'my-laptop.example-tailnet.ts.net',
      loopback: false,
      fromServiceConfig: true,
    });

    const nas = snap.routes.find((r) => r.servePort === 8080)!;
    expect(nas.handler).toMatchObject({ kind: 'proxy', host: 'nas.example-tailnet.ts.net', hostPort: 8443 });

    // L4（tcp:）与 unix socket 端点一律归为 other：不托管，但也不隐藏。
    expect(snap.routes.find((r) => r.servePort === 5432)!.handler).toMatchObject({
      kind: 'other',
      raw: 'tcp://127.0.0.1:5432',
    });
    expect(snap.routes.find((r) => r.servePort === 9000)!.handler).toMatchObject({
      kind: 'other',
      raw: 'unix:/var/run/app.sock',
    });
  });

  it('收集 Service 状态与「需要被安全检查盯住」的 HTTP(S) 端口', () => {
    const snap = parseServiceConfig(REAL_SERVICE_CONFIG, 'example-tailnet.ts.net');
    // tcp: 端点不是 HTTP 出口，不进 httpsPorts；8080 是 https 目标，进。
    expect(snap.httpsPorts).toEqual([443, 8080]);
    expect(serviceInfoOf(snap, 'svc:dsh')).toMatchObject({
      name: 'svc:dsh',
      dnsName: 'dsh.example-tailnet.ts.net',
      servePorts: [443],
      advertised: true,
      vipIps: [],
    });
    // `svc:db` 没有显式 advertised → 不可以当作「已被承认」。
    expect(serviceInfoOf(snap, 'svc:db')!.advertised).toBe(false);
  });

  it('未知/空输入返回空快照而不是抛错', () => {
    expect(parseServiceConfig({}, 'example-tailnet.ts.net')).toEqual({
      httpsPorts: [],
      hostname: null,
      routes: [],
      services: [],
    });
    expect(parseServiceConfig(null).routes).toEqual([]);
    expect(parseServiceConfig({ services: { 'svc:x': {} } }, 'ts.net').services).toEqual([
      { name: 'svc:x', dnsName: 'x.ts.net', servePorts: [], advertised: false, vipIps: [] },
    ]);
  });

  it('没有 MagicDNS 后缀时退回裸 Service 名（不报错）', () => {
    const snap = parseServiceConfig({ services: { 'svc:dsh': { endpoints: { 'tcp:443': 'http://127.0.0.1:1' } } } });
    expect(snap.routes[0]!.host).toBe('dsh');
  });
});

describe('mergeServeSnapshots', () => {
  it('节点级与 Service 级路由共存，端口取并集', () => {
    const node = parseServeStatus({
      TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
      Web: { 'my-laptop.example-tailnet.ts.net:443': { Handlers: { '/dsh': { Proxy: 'http://127.0.0.1:3081' } } } },
    });
    const svc = parseServiceConfig(
      { services: { 'svc:dsh': { endpoints: { 'tcp:443': 'http://127.0.0.1:3081' } } } },
      'example-tailnet.ts.net',
    );
    const merged = mergeServeSnapshots(node, svc, {});

    expect(merged.httpsPorts).toEqual([443, 8443]);
    expect(merged.hostname).toBe('my-laptop.example-tailnet.ts.net');
    expect(merged.routes.map((r) => `${r.service ?? 'node'}${r.path}`)).toEqual(['node/dsh', 'svc:dsh/']);
  });

  it('service-host 能力把 Service 标成已承认并带上 TailVIP', () => {
    const svc = parseServiceConfig(
      { services: { 'svc:dsh': { endpoints: { 'tcp:443': 'http://127.0.0.1:3081' } } } },
      'example-tailnet.ts.net',
    );
    const merged = mergeServeSnapshots(parseServeStatus({}), svc, { 'svc:dsh': ['100.65.32.1', 'fd7a::1'] });
    expect(serviceInfoOf(merged, 'svc:dsh')).toMatchObject({
      advertised: true,
      vipIps: ['100.65.32.1', 'fd7a::1'],
    });
  });

  it('只在 service-host 里出现（配置里没有端点）的 Service 也会被列出', () => {
    const merged = mergeServeSnapshots(parseServeStatus({}), parseServiceConfig({}), { 'svc:ghost': ['100.65.32.9'] });
    expect(merged.services).toEqual([
      { name: 'svc:ghost', dnsName: null, servePorts: [], advertised: true, vipIps: ['100.65.32.9'] },
    ]);
  });
});

describe('parseServiceHostCap', () => {
  it('解析对象形态的 CapMap', () => {
    expect(parseServiceHostCap({ 'service-host': { 'svc:dsh': ['100.65.32.1'] } })).toEqual({
      'svc:dsh': ['100.65.32.1'],
    });
  });

  it('解析数组形态的 CapMap（不同版本的序列化差异）', () => {
    expect(parseServiceHostCap([{ 'service-host': { 'svc:dsh': ['100.65.32.1'] } }])).toEqual({
      'svc:dsh': ['100.65.32.1'],
    });
  });

  it('忽略非 svc: 的键与非法值，并容忍完全缺失', () => {
    expect(parseServiceHostCap({ 'service-host': { other: ['x'], 'svc:dsh': 'not-an-array' } })).toEqual({
      'svc:dsh': [],
    });
    expect(parseServiceHostCap(undefined)).toEqual({});
    expect(parseServiceHostCap(null)).toEqual({});
    expect(parseServiceHostCap({})).toEqual({});
  });
});

/** 记录参数的假执行器。 */
class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ args: string[] }> = [];
  readonly #out: string;

  constructor(out = '{}') {
    this.#out = out;
  }

  run(_bin: string, args: string[]): Promise<RunResult> {
    this.calls.push({ args });
    return Promise.resolve({ code: 0, stdout: this.#out, stderr: '' });
  }
}

describe('TailscaleCli 的 Service 参数拼装', () => {
  it('服务级挂载把 --service 放在 --https 之前', async () => {
    const runner = new RecordingRunner();
    const cli = new TailscaleCli('tailscale', runner, silentLogger);

    await cli.serveUpsert(443, '/', 'http://my-laptop.example-tailnet.ts.net:3081', 'svc:dsh');

    expect(runner.calls[0]!.args).toEqual([
      'serve',
      '--bg',
      '--yes',
      '--service=svc:dsh',
      '--https=443',
      '--set-path=/',
      'http://my-laptop.example-tailnet.ts.net:3081',
    ]);
  });

  it('节点级挂载不带 --service（保持既有行为）', async () => {
    const runner = new RecordingRunner();
    const cli = new TailscaleCli('tailscale', runner, silentLogger);
    await cli.serveUpsert(8443, '/home', 'http://127.0.0.1:8899');
    expect(runner.calls[0]!.args).toEqual([
      'serve',
      '--bg',
      '--yes',
      '--https=8443',
      '--set-path=/home',
      'http://127.0.0.1:8899',
    ]);
  });

  it('服务级摘除同样带 --service，且 off 在最后', async () => {
    const runner = new RecordingRunner();
    const cli = new TailscaleCli('tailscale', runner, silentLogger);
    await cli.serveRemove(443, '/', 'svc:dsh');
    expect(runner.calls[0]!.args).toEqual([
      'serve',
      '--yes',
      '--service=svc:dsh',
      '--https=443',
      '--set-path=/',
      'off',
    ]);
  });

  it('serveGetConfig 走 get-config --all，空输出归一化为 {}', async () => {
    const runner = new RecordingRunner('   \n');
    const cli = new TailscaleCli('tailscale', runner, silentLogger);
    expect(await cli.serveGetConfig()).toEqual({});
    expect(runner.calls[0]!.args).toEqual(['serve', 'get-config', '--all']);
  });

  it('serveClear 走 clear，不接受 --yes', async () => {
    const runner = new RecordingRunner();
    const cli = new TailscaleCli('tailscale', runner, silentLogger);
    await cli.serveClear('svc:dsh');
    expect(runner.calls[0]!.args).toEqual(['serve', 'clear', 'svc:dsh']);
  });
});
