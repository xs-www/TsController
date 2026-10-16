/** 与后端 `normalizeRoutePath` 对齐的前端路径处理。 */

import type { MappingStatus, MappingView } from './api';

/** 映射状态的固定顺序（用于分组展示与统计）。 */
export const MAPPING_STATUS_ORDER: MappingStatus[] = [
  'blocked',
  'conflict',
  'orphaned-target',
  'disabled-drift',
  'pending',
  'active',
  'disabled',
];

/** 按状态把映射分组，返回的组内按路径排序，空组不会出现。 */
export function groupByStatus(mappings: MappingView[]): Array<{ status: MappingStatus; items: MappingView[] }> {
  return MAPPING_STATUS_ORDER.map((status) => ({
    status,
    items: mappings.filter((m) => m.status === status).sort((a, b) => a.path.localeCompare(b.path)),
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
 * 拼出某个（端口, 路径）对应的完整访问地址。
 *
 * 非 443 端口必须显式带上：`https://host:8443` 与 `https://host` 是两个不同的
 * origin，省略会给出一个指向错误服务的链接。
 */
export function joinUrl(serveHost: string | null, servePort: number, path: string): string | null {
  if (serveHost === null || serveHost === '') return null;
  const origin = servePort === 443 ? `https://${serveHost}` : `https://${serveHost}:${servePort}`;
  return origin + path;
}

/**
 * 路由位置的展示标签。
 *
 * 443 是绝对主流端口，为此省略它以免噪音；其它端口必须带上，否则无法区分
 * 同名的两条路由。
 */
export function formatRouteLabel(servePort: number, path: string): string {
  return servePort === 443 ? path : `:${servePort}${path}`;
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
