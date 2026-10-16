/**
 * 路由路径、Service 名与代理地址的纯函数工具。
 *
 * 这些函数是映射校验的唯一入口：无论是 API 入参、持久化数据还是从
 * `tailscale serve` 读回的配置，都必须先经过这里归一化。
 *
 * **路由身份的完整键是 `(service, servePort, path)`**，见 `serveRouteKey()`。
 */

export const LOOPBACK_HOST = '127.0.0.1';

/** Service 名前缀；Tailscale 要求 Service 名带该前缀（`svc:dsh`）。 */
export const SERVICE_PREFIX = 'svc:';

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

/* ------------------------------------------------------------------ */
/* Service 名                                                          */
/* ------------------------------------------------------------------ */

/** Service 名的校验/归一化结果。 */
export interface ServiceNameValidation {
  ok: boolean;
  /** 归一化后的 Service 名，始终带 `svc:` 前缀；仅在 ok 为 true 时有效。 */
  service: string | null;
  /** ok 为 false 时的拒绝原因。 */
  reason: string;
}

/**
 * 校验并归一化 Service 名。
 *
 * 接受 `dsh` 与 `svc:dsh` 两种写法，一律归一化为 `svc:dsh`
 * ——Tailscale 的配置与 CLI 里始终是带前缀的形式，内部只保留一种表示。
 *
 * 字符集按 Tailscale Service 名的实际约束收窄：小写字母、数字、`-`、`_`，
 * 且必须字母或数字开头（大写不折叠成小写，而是直接拒绝——名字大小写不同就是
 * 不同的 Service，静默改写会指向一个不存在的名字）。
 */
export function normalizeServiceName(input: string | null | undefined): ServiceNameValidation {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: false, service: null, reason: 'Service 名不能为空' };

  const withoutPrefix = raw.toLowerCase().startsWith(SERVICE_PREFIX) ? raw.slice(SERVICE_PREFIX.length) : raw;
  if (withoutPrefix === '') {
    return { ok: false, service: null, reason: `Service 名不能只有 "${SERVICE_PREFIX}" 前缀` };
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(withoutPrefix)) {
    return {
      ok: false,
      service: null,
      reason: 'Service 名只能包含小写字母、数字、"."、"、" 与 "-"，且必须以字母或数字开头',
    };
  }
  return { ok: true, service: `${SERVICE_PREFIX}${withoutPrefix}`, reason: '' };
}

/** 去掉 `svc:` 前缀，得到用于拼 DNS 名与界面展示的裸名字。 */
export function serviceShortName(service: string): string {
  return service.toLowerCase().startsWith(SERVICE_PREFIX) ? service.slice(SERVICE_PREFIX.length) : service;
}

/* ------------------------------------------------------------------ */
/* 代理地址                                                            */
/* ------------------------------------------------------------------ */

/** 构造代理地址的入参。 */
export interface ProxyTargetParts {
  /** 目标端口。 */
  hostPort: number;
  /** 追加到目标上的路径，"" 表示不追加。 */
  targetPath?: string;
  /**
   * 目标主机；省略或空串即本机回环（`127.0.0.1`）。
   *
   * Service host 可以代理远端资源，此时必须给出远端主机名
   * （例如 `my-laptop.example-tailnet.ts.net`）。
   */
  remoteHost?: string | null;
  /** 协议；省略即 `http`。 */
  scheme?: 'http' | 'https';
}

/**
 * 校验远端主机名。
 *
 * 只接受主机名或 IP 字面量（不含协议、不含端口、不含路径）。
 * 空串视为「未指定」并归一化为 `null` —— 因此本函数**必须**由调用方在
 * 组装代理地址前调用，不能与 `??` 混用。
 */
export function normalizeRemoteHost(input: string | null | undefined): { ok: boolean; host: string | null; reason: string } {
  const raw = (input ?? '').trim();
  if (raw === '' || raw.toLowerCase() === LOOPBACK_HOST || raw.toLowerCase() === 'localhost') {
    // 本机回环等同于「未指定远端」：`remoteHost` 的语义就是「非本机」。
    return { ok: true, host: null, reason: '' };
  }
  if (raw.length > 253) return { ok: false, host: null, reason: '主机名过长' };
  if (raw.includes('://')) return { ok: false, host: null, reason: '主机名不能包含协议前缀' };
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(raw)) {
    return { ok: false, host: null, reason: '主机名包含非法字符' };
  }
  return { ok: true, host: raw, reason: '' };
}

/**
 * 构造 serve 期望的代理地址。
 *
 * - 本机目标：`buildProxyUrl({ hostPort: 8080, targetPath: '/api' })` → `http://127.0.0.1:8080/api`
 * - 远端目标：`buildProxyUrl({ hostPort: 3081, remoteHost: 'my-laptop.example-tailnet.ts.net' })`
 *   → `http://my-laptop.example-tailnet.ts.net:3081`
 */
export function buildProxyUrl(parts: ProxyTargetParts): string;
/** 兼容旧签名：`buildProxyUrl(hostPort, targetPath)`。 */
export function buildProxyUrl(hostPort: number, targetPath?: string): string;
export function buildProxyUrl(
  partsOrPort: ProxyTargetParts | number,
  targetPathArg = '',
): string {
  const parts: ProxyTargetParts =
    typeof partsOrPort === 'number'
      ? { hostPort: partsOrPort, targetPath: targetPathArg }
      : partsOrPort;
  const suffix = parts.targetPath === undefined || parts.targetPath === '' || parts.targetPath === '/'
    ? ''
    : parts.targetPath;
  const host = parts.remoteHost === undefined || parts.remoteHost === null || parts.remoteHost === ''
    ? LOOPBACK_HOST
    : parts.remoteHost;
  const scheme = parts.scheme ?? 'http';
  return `${scheme}://${host}:${parts.hostPort}${suffix}`;
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
 * `https+insecure` 之类的伪协议同样被拒绝（`new URL` 会接受它，因此要显式排除）。
 */
export function parseProxyUrl(raw: string): ParsedProxy | null {
  if (/^https\+insecure:/i.test(raw.trim())) return null;
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

/* ------------------------------------------------------------------ */
/* 路由身份与对外地址                                                  */
/* ------------------------------------------------------------------ */

/**
 * 是否应当视为同一挂载路径。
 *
 * serve 自身按最长前缀精确匹配且区分大小写，但用户在界面里输入 `/App` 与
 * `/app` 时更可能是想表达同一条路由，因此冲突检测按大小写不敏感处理。
 */
export function sameRoutePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** 归一化后用于冲突检测的路径键。 */
export function routePathKey(path: string): string {
  return path.toLowerCase();
}

/** Service 维度在路由键里的占位符（`null` 不能直接拼进字符串）。 */
const NODE_SCOPE = '-';

/**
 * 路由的完整唯一键：`Service|端口|路径`。
 *
 * 三个维度缺一不可：
 * - Service 决定**对外主机名**（`dsh.ts.net` 还是 `laptop.ts.net`）；
 * - 端口决定 origin（`/` 在 443 与 8443 上是两个独立入口）；
 * - 路径是挂载点。
 *
 * 节点级路由的 Service 位用 `-` 占位，与任何 `svc:*` 都不冲突。
 */
export function serveRouteKey(service: string | null | undefined, servePort: number, path: string): string {
  return `${service === null || service === undefined || service === '' ? NODE_SCOPE : service.toLowerCase()}|${servePort}|${routePathKey(path)}`;
}

/** 面向界面与日志的路由标签，例如 `svc:dsh:443/dsh`。 */
export function formatRouteRef(route: {
  service?: string | null;
  servePort: number;
  path: string;
}): string {
  const scope = route.service ? `${route.service}:` : '';
  const port = route.servePort === 443 ? '' : `:${route.servePort}`;
  return `${scope}${port}${route.path}`;
}

/**
 * 拼出对外的基址（不含路径）；无法确定主机名时返回空串。
 *
 * - 节点级（`service === null`）：`https://<hostname>`；非 443 端口带上端口。
 * - Service 级：`https://<service 名>.<MagicDNS 后缀>`。
 *
 * 端口不能省：`https://host:8443` 与 `https://host` 是两个不同的 origin，
 * 省略会让用户拿到一个指向错误服务的链接。
 */
export function buildBaseUrl(
  hostname: string | null,
  servePort: number,
  service?: string | null,
  magicDnsSuffix?: string | null,
): string {
  const host = service
    ? buildServiceDnsName(service, magicDnsSuffix ?? null, hostname)
    : hostname;
  if (!host) return '';
  return servePort === 443 ? `https://${host}` : `https://${host}:${servePort}`;
}

/**
 * 拼出 Service 的 MagicDNS 名（不含端口），例如 `dsh.example-tailnet.ts.net`。
 *
 * 后缀的取得顺序：
 * 1. 显式给出的 MagicDNS 后缀（`tailscale status --json` 的
 *    `CurrentTailnet.MagicDNSSuffix`）；
 * 2. 从节点自己的 DNS 名里去掉第一段（`my-laptop.example-tailnet.ts.net`
 *    → `example-tailnet.ts.net`）——同一 tailnet 内两者必然一致，这是纯兜底；
 *
 * 两者都拿不到时返回 null（此时界面无法给出可点击地址，但不影响读写配置）。
 */
export function buildServiceDnsName(
  service: string,
  magicDnsSuffix: string | null,
  nodeDnsName?: string | null,
): string | null {
  const suffix = (magicDnsSuffix ?? '').trim() || suffixFromNodeDnsName(nodeDnsName ?? null);
  if (!suffix) return null;
  return `${serviceShortName(service)}.${suffix.replace(/^\.+/, '').replace(/\.+$/, '')}`;
}

/** 从节点 DNS 名推导 tailnet 的 MagicDNS 后缀。 */
export function suffixFromNodeDnsName(nodeDnsName: string | null | undefined): string | null {
  const clean = (nodeDnsName ?? '').trim().replace(/\.+$/, '');
  if (clean === '') return null;
  const idx = clean.indexOf('.');
  if (idx === -1) return null;
  const suffix = clean.slice(idx + 1);
  return suffix === '' ? null : suffix;
}
