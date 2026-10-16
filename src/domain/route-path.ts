/**
 * 路由路径与代理地址的纯函数工具。
 *
 * 这些函数是映射校验的唯一入口：无论是 API 入参、持久化数据还是从
 * `tailscale serve` 读回的配置，都必须先经过这里归一化。
 */

export const LOOPBACK_HOST = '127.0.0.1';

export interface PathValidation {
  ok: boolean;
  /** 归一化后的路径，仅在 ok 为 true 时有效。 */
  path: string;
  /** ok 为 false 时的拒绝原因。 */
  reason: string;
}

/**
 * 校验并归一化 serve 的挂载路径。
 *
 * 规则：
 * - 必须以 "/" 开头；
 * - 不允许空白、查询串、片段、反斜杠；
 * - 不允许 "." / ".." 段（serve 会对请求路径做解码后匹配，`..` 会让语义不可预测）；
 * - 折叠重复斜杠，去掉尾斜杠（根路径 "/" 保留）。
 */
export function normalizeRoutePath(input: string): PathValidation {
  const raw = (input ?? '').trim();
  if (raw === '') {
    return { ok: false, path: '', reason: '路径不能为空' };
  }
  if (!raw.startsWith('/')) {
    return { ok: false, path: '', reason: '路径必须以 "/" 开头' };
  }
  if (raw.includes('\\')) {
    return { ok: false, path: '', reason: '路径不能包含反斜杠' };
  }
  if (/[\s?#]/.test(raw)) {
    return { ok: false, path: '', reason: '路径不能包含空白、? 或 #' };
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    return { ok: false, path: '', reason: '路径不能包含控制字符' };
  }

  const segments = raw.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      return { ok: false, path: '', reason: '路径不能包含 "." 或 ".." 段' };
    }
  }

  const collapsed = '/' + segments.join('/');
  return { ok: true, path: collapsed, reason: '' };
}

/** 校验并归一化「追加到代理目标上的路径」；空串与 "/" 都归一化为 ""。 */
export function normalizeTargetPath(input: string | undefined | null): PathValidation {
  const raw = (input ?? '').trim();
  if (raw === '' || raw === '/') {
    return { ok: true, path: '', reason: '' };
  }
  return normalizeRoutePath(raw);
}

/** 端口合法性（1-65535 的整数）。 */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

/** 构造 serve 期望的代理地址，例如 `http://127.0.0.1:8080/api/agent`。 */
export function buildProxyUrl(hostPort: number, targetPath = ''): string {
  const suffix = targetPath === '' || targetPath === '/' ? '' : targetPath;
  return `http://${LOOPBACK_HOST}:${hostPort}${suffix}`;
}

export interface ParsedProxy {
  host: string;
  hostPort: number;
  targetPath: string;
  loopback: boolean;
}

/**
 * 解析 serve 配置中的 Proxy 字符串。
 *
 * 只接受 http(s) 代理；返回 null 表示这不是我们能接管的代理形式。
 */
export function parseProxyUrl(raw: string): ParsedProxy | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!isValidPort(port)) return null;

  const targetPath = url.pathname === '/' ? '' : url.pathname;
  return {
    host,
    hostPort: port,
    targetPath,
    loopback: isLoopbackHost(host),
  };
}

/** 判断主机名是否为本机回环地址。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

/**
 * 是否应当视为同一挂载路径。
 *
 * serve 自身按最长前缀精确匹配且区分大小写，但用户在界面里输入 `/App` 与
 * `/app` 时更可能是想表达同一条路由，因此冲突检测按大小写不敏感处理。
 */
export function sameRoutePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** 归一化后用于冲突检测的键。 */
export function routePathKey(path: string): string {
  return path.toLowerCase();
}

/**
 * 路由的完整唯一键：`端口|路径`。
 *
 * 路由身份是「端口 + 路径」的组合——`/` 挂在 443 与 8443 上是两个互不干扰的
 * 独立入口。任何跨路由的匹配、去重、归属判断都必须用这个键。
 */
export function serveRouteKey(servePort: number, path: string): string {
  return `${servePort}|${routePathKey(path)}`;
}

/**
 * 拼出对外的基址；非 443 端口要显式带上。
 *
 * 端口不能省：`https://host:8443` 与 `https://host` 是两个不同的 origin，
 * 省略会让用户拿到一个指向错误服务的链接。
 */
export function buildBaseUrl(hostname: string | null, servePort: number): string {
  if (!hostname) return '';
  return servePort === 443 ? `https://${hostname}` : `https://${hostname}:${servePort}`;
}

/**
 * 面向日志与提示的路由标签。
 *
 * 443 是绝对主流的端口，为此省略它以免噪音：`/worldforge` 而不是 `443:/worldforge`；
 * 其它端口则必须显式带上，否则无法区分同名的两条路由。
 */
export function formatRouteRef(route: { servePort: number; path: string }): string {
  return route.servePort === 443 ? route.path : `:${route.servePort}${route.path}`;
}
