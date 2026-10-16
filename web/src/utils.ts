/** 与后端 `normalizeRoutePath` 对齐的前端路径处理。 */

import type { MappingStatus, MappingTarget, MappingView } from './api';

/** Service 名的前缀；Tailscale 要求 Service 名带它（`svc:dsh`）。 */
export const SERVICE_PREFIX = 'svc:';

/**
 * 映射状态的固定顺序（用于分组展示与统计）。
 *
 * 顺序即严重度。`awaiting-approval` 夹在 pending 与 active 之间：它的 serve
 * 配置已经写对了（所以不是 pending），但广告未被承认、对外还不通（所以不是
 * active）——它是「只差管理员点一下」的状态。
 */
export const MAPPING_STATUS_ORDER: MappingStatus[] = [
  'blocked',
  'conflict',
  'orphaned-target',
  'disabled-drift',
  'pending',
  'awaiting-approval',
  'active',
  'disabled',
];

/**
 * 按状态把映射分组，返回的组内按 `(Service, 路径)` 排序，空组不会出现。
 *
 * 先按 Service 再按路径：节点级路由与各 Service 的路由因此各自成段，
 * 不会因为路径恰好同名而交替出现。
 */
export function groupByStatus(mappings: MappingView[]): Array<{ status: MappingStatus; items: MappingView[] }> {
  return MAPPING_STATUS_ORDER.map((status) => ({
    status,
    items: mappings
      .filter((m) => m.status === status)
      .sort(
        (a, b) => (a.service ?? '').localeCompare(b.service ?? '') || a.path.localeCompare(b.path),
      ),
  })).filter((g) => g.items.length > 0);
}

/**
 * 把容器名转换成一个合法的默认挂载路径。
 *
 * 规则与后端一致：小写、只保留 `[a-z0-9._-]`、非法字符折叠成单个 `-`、
 * 去掉首尾 `-`，回退值由调用方决定。
 */
export function slugifyPath(name: string): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' ? 'app' : slug;
}

/** 默认路径："/" + 容器名（小写化并清理非法字符）。 */
export function defaultPathFor(containerName: string): string {
  return `/${slugifyPath(containerName)}`;
}

/**
 * 前端侧的路径归一化：折叠重复斜杠、去掉尾斜杠（根路径保留）。
 *
 * 后端仍会做权威校验，这里只是让用户尽早看到预期结果。
 */
export function normalizePathInput(input: string): string {
  const raw = (input ?? '').trim();
  if (raw === '') return '';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const segments = withSlash.split('/').filter((s) => s !== '');
  return `/${segments.join('/')}`;
}

/**
 * 前端侧的 Service 名归一化：去空白、去掉裸 `svc:` 前缀、统一成 `svc:dsh`。
 *
 * 与 `normalizePathInput` 同一哲学：只做「用户一眼能预期的整理」，**不做**完整校验
 * ——非法名（大写、空格、`svc:` 后面为空）原样交给后端拒绝，并把原因回显给用户。
 * 空输入与「只有前缀」都归一化为 `""`（即节点级路由）。
 */
export function normalizeServiceInput(input: string): string {
  const raw = (input ?? '').trim();
  if (raw === '') return '';
  const lower = raw.toLowerCase();
  const bare = lower.startsWith(SERVICE_PREFIX) ? lower.slice(SERVICE_PREFIX.length).trim() : raw;
  if (bare === '') return '';
  return `${SERVICE_PREFIX}${bare}`;
}

/** 去掉 `svc:` 前缀，得到用于展示与拼 DNS 名的裸名字。 */
export function serviceShortName(service: string): string {
  return service.toLowerCase().startsWith(SERVICE_PREFIX) ? service.slice(SERVICE_PREFIX.length) : service;
}

/** 该映射目标是否在远端主机上（`remoteHost` 非空）。 */
export function isRemoteTarget(target: MappingTarget): boolean {
  const host = (target.remoteHost ?? '').trim();
  return host !== '' && host.toLowerCase() !== '127.0.0.1' && host.toLowerCase() !== 'localhost';
}

/**
 * 人类可读的代理目标，例如 `127.0.0.1:4173` / `my-laptop.example-tailnet.ts.net:3081`。
 *
 * 只描述「代理到哪」，不含目标路径 —— 路径由调用方按需追加。
 */
export function formatTarget(target: MappingTarget): string {
  const host = isRemoteTarget(target) ? (target.remoteHost ?? '').trim() : '127.0.0.1';
  return `${host}:${String(target.hostPort)}`;
}

/**
 * 拼出某个（Service, 端口, 路径）对应的完整访问地址。
 *
 * 非 443 端口必须显式带上：`https://host:8443` 与 `https://host` 是两个不同的
 * origin，省略会给出一个指向错误服务的链接。
 *
 * 只有 `serveHost` 的调用点（例如 serve 路由表）继续用它；拿到 `MappingView` 时
 * 优先用 `baseUrl`（它已经带上了正确的 Service 主机名与端口）。
 */
export function joinUrl(serveHost: string | null, servePort: number, path: string): string | null {
  if (serveHost === null || serveHost === '') return null;
  const origin = servePort === 443 ? `https://${serveHost}` : `https://${serveHost}:${servePort}`;
  return origin + path;
}

/**
 * 路由位置的展示标签。
 *
 * - 443 是绝对主流端口，为此省略它以免噪音；其它端口必须带上，否则无法区分
 *   同名的两条路由。
 * - Service 级路由必须带上 Service 名：`svc:dsh` 与节点级是两个命名空间，
 *   同一个（端口, 路径）在两边是两条互不相干的路由。
 */
export function formatRouteLabel(servePort: number, path: string, service?: string | null): string {
  const scope = service !== undefined && service !== null && service !== '' ? `${service}:` : '';
  const port = servePort === 443 ? '' : `:${servePort}`;
  return `${scope}${port}${path}`;
}

/**
 * 由 `MappingView` 拼出完整访问地址：`baseUrl + path`。
 *
 * `baseUrl` 由后端给出（Service 级是 `https://<service>.<tailnet>.ts.net`，
 * 节点级是 `https://<节点>.<tailnet>.ts.net`，非 443 端口已带上），
 * 因此这里只做拼接。`baseUrl` 为 null（主机名未知）时返回 null。
 */
export function mappingUrl(mapping: { baseUrl: string | null; path: string }): string | null {
  if (mapping.baseUrl === null || mapping.baseUrl === '') return null;
  return mapping.baseUrl + mapping.path;
}

/**
 * 只带 Service 维度的展示标签，用于没有端口信息的场合（例如 apply 的 blocked 列表）。
 *
 * 与 `formatRouteLabel` 的分工：那里必须给出端口，因为它描述一个具体路由位置。
 */
export function formatScopedLabel(service: string | null | undefined, path: string): string {
  return service !== undefined && service !== null && service !== '' ? `${service}:${path}` : path;
}

/** 展示用的端口摘要，例如 `127.0.0.1:4173 → 8080/tcp`。 */
export function formatPort(hostIp: string, hostPort: number, containerPort: number, protocol: string): string {
  return `${hostIp}:${hostPort} → ${containerPort}/${protocol}`;
}

/** hostIp 是否监听全部网卡（可被 tailnet 内设备绕过本工具直连）。 */
export function isWildcardHost(hostIp: string): boolean {
  const ip = hostIp.replace(/^\[|\]$/g, '');
  return ip === '0.0.0.0' || ip === '::';
}

/** ISO 时间 → 本地可读时间；解析失败时原样返回。 */
export function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

/** 毫秒时间戳 → 本地可读时间。 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 复制文本；优先用异步剪贴板 API，失败时回退到 textarea + execCommand。 */export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退方案（非安全上下文或权限被拒绝）。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
