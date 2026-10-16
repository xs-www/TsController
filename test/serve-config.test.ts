import { describe, expect, it } from 'vitest';
import { parseServeStatus, proxiedRoutes, snapshotHostname, splitHostPort } from '../src/tailscale/serve-config.ts';
import { parseTailnetInfo } from '../src/tailscale/tailscale-service.ts';

/** 取自本机 `tailscale serve status --json` 的真实输出（同构，含两个 HTTPS 端口）。 */
const REAL_STATUS = {
  TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
  Web: {
    'my-laptop.example-tailnet.ts.net:443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:3081' },
        '/agent': { Proxy: 'http://127.0.0.1:443/api/agent' },
        '/calendar': { Proxy: 'http://127.0.0.1:443/calendar' },
        '/calendar.ics': { Proxy: 'http://127.0.0.1:443/calendar.ics' },
        '/dsh': { Proxy: 'http://127.0.0.1:3081' },
        '/home': { Proxy: 'http://127.0.0.1:8899' },
        '/salecapitai': { Proxy: 'http://127.0.0.1:8080' },
        '/worldforge': { Proxy: 'http://127.0.0.1:4173' },
      },
    },
    'my-laptop.example-tailnet.ts.net:8443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:8899' },
      },
    },
  },
};

describe('parseServeStatus', () => {
  it('解析真实配置，且保留全部 HTTPS 端口', () => {
    const snap = parseServeStatus(REAL_STATUS);
    expect(snap.httpsPorts).toEqual([443, 8443]);
    expect(snap.hostname).toBe('my-laptop.example-tailnet.ts.net');
    expect(snap.routes).toHaveLength(9);

    const agent = snap.routes.find((r) => r.path === '/agent')!;
    expect(agent).toMatchObject({ servePort: 443, host: 'my-laptop.example-tailnet.ts.net' });
    expect(agent.handler).toMatchObject({ kind: 'proxy', hostPort: 443, targetPath: '/api/agent', loopback: true });
  });

  it('同一路径出现在不同端口时是两条独立路由', () => {
    const snap = parseServeStatus(REAL_STATUS);
    const roots = snap.routes.filter((r) => r.path === '/');
    expect(roots).toHaveLength(2);
    expect(roots.map((r) => r.servePort).sort()).toEqual([443, 8443]);
    expect(roots.map((r) => (r.handler.kind === 'proxy' ? r.handler.hostPort : null)).sort()).toEqual([3081, 8899]);
  });

  it('路由按端口再按路径排序', () => {
    const snap = parseServeStatus(REAL_STATUS);
    const keys = snap.routes.map((r) => `${r.servePort}${r.path}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('无配置时返回空快照而不是报错', () => {
    expect(parseServeStatus({})).toEqual({ httpsPorts: [], hostname: null, routes: [] });
    expect(parseServeStatus(null).routes).toEqual([]);
  });

  it('只声明了 TCP 没有 Web 时不报错', () => {
    const snap = parseServeStatus({ TCP: { '443': { HTTPS: true } } });
    expect(snap.httpsPorts).toEqual([443]);
    expect(snap.hostname).toBeNull();
    expect(snap.routes).toEqual([]);
  });

  it('忽略非 HTTPS 的 TCP 声明', () => {
    const snap = parseServeStatus({ TCP: { '443': { HTTPS: true }, '80': { HTTP: true } } });
    expect(snap.httpsPorts).toEqual([443]);
  });

  it('识别非代理 handler', () => {
    const snap = parseServeStatus({
      TCP: { '443': { HTTPS: true } },
      Web: { 'host:443': { Handlers: { '/text': { Text: 'hi' }, '/dir': { Path: 'C:\\www' } } } },
    });
    expect(snap.routes.find((r) => r.path === '/text')!.handler.kind).toBe('text');
    expect(snap.routes.find((r) => r.path === '/dir')!.handler.kind).toBe('file');
  });

  it('proxiedRoutes 过滤掉无法解析端口的条目', () => {
    const snap = parseServeStatus({
      Web: { 'h:443': { Handlers: { '/a': { Proxy: 'http://127.0.0.1:80' }, '/b': { Text: 'x' } } } },
    });
    expect(proxiedRoutes(snap).map((r) => r.path)).toEqual(['/a']);
    expect(snapshotHostname(snap)).toBe('h');
    expect(splitHostPort('h:443')).toEqual({ host: 'h', port: 443 });
  });
});

describe('parseTailnetInfo', () => {
  it('去掉 DNSName 的尾点并拼出 baseUrl', () => {
    const info = parseTailnetInfo({
      Version: '1.102.4',
      BackendState: 'Running',
      Self: { DNSName: 'my-laptop.example-tailnet.ts.net.', TailscaleIPs: ['100.101.102.103'], HostName: 'My-Laptop' },
    });
    expect(info.dnsName).toBe('my-laptop.example-tailnet.ts.net');
    expect(info.baseUrl).toBe('https://my-laptop.example-tailnet.ts.net');
    expect(info.ips).toEqual(['100.101.102.103']);
    expect(info.backendState).toBe('Running');
  });

  it('字段缺失时不抛错', () => {
    expect(parseTailnetInfo({})).toMatchObject({ dnsName: null, baseUrl: null, ips: [] });
  });
});
