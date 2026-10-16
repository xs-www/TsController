import { describe, expect, it } from 'vitest';
import {
  buildBaseUrl,
  buildProxyUrl,
  buildServiceDnsName,
  formatRouteRef,
  isLoopbackHost,
  isValidPort,
  normalizeRemoteHost,
  normalizeRoutePath,
  normalizeServiceName,
  normalizeTargetPath,
  parseProxyUrl,
  routePathKey,
  sameRoutePath,
  serveRouteKey,
  serviceShortName,
  suffixFromNodeDnsName,
} from '../src/domain/route-path.ts';

describe('normalizeRoutePath', () => {
  it('接受并归一化常见写法', () => {
    expect(normalizeRoutePath('/worldforge').path).toBe('/worldforge');
    expect(normalizeRoutePath('worldforge').ok).toBe(false);
    expect(normalizeRoutePath('/worldforge/').path).toBe('/worldforge');
    expect(normalizeRoutePath('//calendar//ics//').path).toBe('/calendar/ics');
    expect(normalizeRoutePath('/').path).toBe('/');
    expect(normalizeRoutePath('  /agent  ').path).toBe('/agent');
    expect(normalizeRoutePath('/Calendar').path).toBe('/Calendar');
  });

  it('拒绝危险或不可表达的路径', () => {
    expect(normalizeRoutePath('')).toMatchObject({ ok: false });
    expect(normalizeRoutePath('/a b')).toMatchObject({ ok: false });
    expect(normalizeRoutePath('/a?b=1')).toMatchObject({ ok: false });
    expect(normalizeRoutePath('/a#b')).toMatchObject({ ok: false });
    expect(normalizeRoutePath('/a\\b')).toMatchObject({ ok: false });
    expect(normalizeRoutePath('/../etc')).toMatchObject({ ok: false });
    expect(normalizeRoutePath('/a/./b')).toMatchObject({ ok: false });
  });
});

describe('normalizeTargetPath', () => {
  it('把空串与根路径都归一化为空', () => {
    expect(normalizeTargetPath(undefined).path).toBe('');
    expect(normalizeTargetPath('').path).toBe('');
    expect(normalizeTargetPath('/').path).toBe('');
    expect(normalizeTargetPath('/api/agent/').path).toBe('/api/agent');
  });
});

describe('buildProxyUrl / parseProxyUrl', () => {
  it('往返一致', () => {
    expect(buildProxyUrl(8080)).toBe('http://127.0.0.1:8080');
    expect(buildProxyUrl(443, '/api/agent')).toBe('http://127.0.0.1:443/api/agent');

    expect(parseProxyUrl('http://127.0.0.1:4173')).toMatchObject({ hostPort: 4173, targetPath: '', loopback: true });
    expect(parseProxyUrl('http://127.0.0.1:443/calendar.ics')).toMatchObject({
      hostPort: 443,
      targetPath: '/calendar.ics',
      loopback: true,
    });
    expect(parseProxyUrl('http://192.168.1.10:8080')).toMatchObject({ hostPort: 8080, loopback: false });
    expect(parseProxyUrl('https://[::1]:8443')).toMatchObject({ hostPort: 8443, loopback: true });
    expect(parseProxyUrl('not-a-url')).toBeNull();
  });
});

describe('辅助判断', () => {
  it('isValidPort', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(1.5)).toBe(false);
    expect(isValidPort('80')).toBe(false);
  });

  it('isLoopbackHost', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '100.101.102.103', 'my-laptop.example-tailnet.ts.net']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('sameRoutePath 忽略大小写', () => {
    expect(sameRoutePath('/App', '/app')).toBe(true);
    expect(routePathKey('/App')).toBe('/app');
  });
});

describe('路由身份：Service + 端口 + 路径', () => {
  it('serveRouteKey 把端口纳入身份', () => {
    expect(serveRouteKey(null, 443, '/App')).toBe('-|443|/app');
    expect(serveRouteKey(null, 8443, '/App')).toBe('-|8443|/app');
    // 关键性质：同路径不同端口必须是不同的键。
    expect(serveRouteKey(null, 443, '/')).not.toBe(serveRouteKey(null, 8443, '/'));
  });

  it('serveRouteKey 把 Service 纳入身份', () => {
    // 关键性质：节点级的 `/dsh` 与 Service 级 `svc:dsh` 的 `/` 是两个完全不同的对外名字，
    // 绝不能因为路径/端口相同就被判成同一条路由。
    expect(serveRouteKey('svc:dsh', 443, '/x')).not.toBe(serveRouteKey(null, 443, '/x'));
    expect(serveRouteKey('svc:dsh', 443, '/x')).not.toBe(serveRouteKey('svc:other', 443, '/x'));
    // Service 名大小写不敏感（归一化后比较）。
    expect(serveRouteKey('svc:DSH', 443, '/x')).toBe(serveRouteKey('svc:dsh', 443, '/x'));
  });

  it('buildBaseUrl 只在非 443 时带端口', () => {
    expect(buildBaseUrl('host.ts.net', 443)).toBe('https://host.ts.net');
    expect(buildBaseUrl('host.ts.net', 8443)).toBe('https://host.ts.net:8443');
    expect(buildBaseUrl(null, 8443)).toBe('');
  });

  it('buildBaseUrl 对 Service 级路由改用 Service 的 MagicDNS 名', () => {
    expect(buildBaseUrl('my-laptop.example-tailnet.ts.net', 443, 'svc:dsh', 'example-tailnet.ts.net')).toBe(
      'https://dsh.example-tailnet.ts.net',
    );
    expect(buildBaseUrl('my-laptop.example-tailnet.ts.net', 8443, 'svc:dsh', 'example-tailnet.ts.net')).toBe(
      'https://dsh.example-tailnet.ts.net:8443',
    );
    // MagicDNS 后缀缺失时退回「从节点 DNS 名推导」。
    expect(buildBaseUrl('my-laptop.example-tailnet.ts.net', 443, 'svc:dsh', null)).toBe(
      'https://dsh.example-tailnet.ts.net',
    );
    // 两者都拿不到 → 空串（界面据此隐藏链接，而不是给一个错地址）。
    expect(buildBaseUrl(null, 443, 'svc:dsh', null)).toBe('');
  });

  it('formatRouteRef 省略 443 并在 Service 级带上前缀', () => {
    expect(formatRouteRef({ servePort: 443, path: '/worldforge' })).toBe('/worldforge');
    expect(formatRouteRef({ servePort: 8443, path: '/' })).toBe(':8443/');
    expect(formatRouteRef({ service: 'svc:dsh', servePort: 443, path: '/' })).toBe('svc:dsh:/');
  });
});

describe('Service 名', () => {
  it('接受裸名与 svc: 前缀，并统一归一化为 svc: 形式', () => {
    expect(normalizeServiceName('dsh')).toMatchObject({ ok: true, service: 'svc:dsh' });
    expect(normalizeServiceName('svc:dsh')).toMatchObject({ ok: true, service: 'svc:dsh' });
    expect(normalizeServiceName('  svc:dsh  ')).toMatchObject({ ok: true, service: 'svc:dsh' });
    expect(normalizeServiceName('my-app_1.web')).toMatchObject({ ok: true, service: 'svc:my-app_1.web' });
  });

  it('拒绝空名、只有前缀、以及非法字符', () => {
    expect(normalizeServiceName('').ok).toBe(false);
    expect(normalizeServiceName(null).ok).toBe(false);
    expect(normalizeServiceName('svc:').ok).toBe(false);
    expect(normalizeServiceName('-dsh').ok).toBe(false);
    expect(normalizeServiceName('dsh/../x').ok).toBe(false);
    expect(normalizeServiceName('DSH').ok).toBe(false); // 大小写不折叠：静默改写会指向不存在的 Service
  });

  it('serviceShortName 去掉前缀', () => {
    expect(serviceShortName('svc:dsh')).toBe('dsh');
    expect(serviceShortName('dsh')).toBe('dsh');
  });

  it('buildServiceDnsName / suffixFromNodeDnsName', () => {
    expect(buildServiceDnsName('svc:dsh', 'example-tailnet.ts.net')).toBe('dsh.example-tailnet.ts.net');
    expect(buildServiceDnsName('svc:dsh', null, 'my-laptop.example-tailnet.ts.net')).toBe(
      'dsh.example-tailnet.ts.net',
    );
    expect(buildServiceDnsName('svc:dsh', null, null)).toBeNull();
    expect(suffixFromNodeDnsName('my-laptop.example-tailnet.ts.net')).toBe('example-tailnet.ts.net');
    expect(suffixFromNodeDnsName('laptop')).toBeNull();
  });
});

describe('远端代理目标', () => {
  it('buildProxyUrl 支持远端主机与协议', () => {
    expect(buildProxyUrl({ hostPort: 3081 })).toBe('http://127.0.0.1:3081');
    expect(buildProxyUrl(443, '/api/agent')).toBe('http://127.0.0.1:443/api/agent');
    expect(buildProxyUrl({ hostPort: 3081, remoteHost: 'my-laptop.example-tailnet.ts.net' })).toBe(
      'http://my-laptop.example-tailnet.ts.net:3081',
    );
    expect(
      buildProxyUrl({ hostPort: 3081, remoteHost: 'my-laptop.example-tailnet.ts.net', targetPath: '/dsh' }),
    ).toBe('http://my-laptop.example-tailnet.ts.net:3081/dsh');
    expect(buildProxyUrl({ hostPort: 8443, remoteHost: 'nas.ts.net', scheme: 'https' })).toBe(
      'https://nas.ts.net:8443',
    );
  });

  it('normalizeRemoteHost 把回环视为「未指定远端」，并拒绝带协议/端口的写法', () => {
    expect(normalizeRemoteHost(undefined)).toMatchObject({ ok: true, host: null });
    expect(normalizeRemoteHost('')).toMatchObject({ ok: true, host: null });
    expect(normalizeRemoteHost('127.0.0.1')).toMatchObject({ ok: true, host: null });
    expect(normalizeRemoteHost('localhost')).toMatchObject({ ok: true, host: null });
    expect(normalizeRemoteHost('my-laptop.example-tailnet.ts.net')).toMatchObject({
      ok: true,
      host: 'my-laptop.example-tailnet.ts.net',
    });
    expect(normalizeRemoteHost('http://nas.ts.net').ok).toBe(false);
    expect(normalizeRemoteHost('nas ts.net').ok).toBe(false);
  });

  it('parseProxyUrl 拒绝 https+insecure 这类伪协议', () => {
    expect(parseProxyUrl('https+insecure://127.0.0.1:8443')).toBeNull();
  });
});
