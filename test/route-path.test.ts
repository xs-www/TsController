import { describe, expect, it } from 'vitest';
import {
  buildBaseUrl,
  buildProxyUrl,
  formatRouteRef,
  isLoopbackHost,
  isValidPort,
  normalizeRoutePath,
  normalizeTargetPath,
  parseProxyUrl,
  routePathKey,
  sameRoutePath,
  serveRouteKey,
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

describe('路由身份：端口 + 路径', () => {
  it('serveRouteKey 把端口纳入身份', () => {
    expect(serveRouteKey(443, '/App')).toBe('443|/app');
    expect(serveRouteKey(8443, '/App')).toBe('8443|/app');
    // 关键性质：同路径不同端口必须是不同的键。
    expect(serveRouteKey(443, '/')).not.toBe(serveRouteKey(8443, '/'));
  });

  it('buildBaseUrl 只在非 443 时带端口', () => {
    expect(buildBaseUrl('host.ts.net', 443)).toBe('https://host.ts.net');
    expect(buildBaseUrl('host.ts.net', 8443)).toBe('https://host.ts.net:8443');
    expect(buildBaseUrl(null, 8443)).toBe('');
  });

  it('formatRouteRef 省略 443 以免日志噪音', () => {
    expect(formatRouteRef({ servePort: 443, path: '/worldforge' })).toBe('/worldforge');
    expect(formatRouteRef({ servePort: 8443, path: '/' })).toBe(':8443/');
  });
});
