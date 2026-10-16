/**
 * `tailscale serve status --json` 的解析。
 *
 * 该输出是 tailscaled 的 serve 配置原文（legacy raw serve config format），
 * 结构为 `{ TCP: { "<port>": { HTTPS: true } }, Web: { "<host>:<port>": { Handlers: {...} } } }`。
 * 我们只读不写这份 JSON —— 写入统一走 `tailscale serve --set-path` 命令行，
 * 因为新版本 `serve set-config` 已转向 services 格式并会忽略节点级字段。
 */

import { parseProxyUrl } from '../domain/route-path.ts';
import type { ServeHandler, ServeRoute, ServeSnapshot } from '../domain/types.ts';

/** serve handler 中可能出现的键，按我们的理解优先级排列。 */
const PROXY_KEYS = ['Proxy'] as const;
const NON_PROXY_KEYS = ['Path', 'Text'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析单个 handler 对象。 */
export function parseHandler(value: unknown): ServeHandler {
  if (isRecord(value)) {
    for (const key of PROXY_KEYS) {
      const raw = value[key];
      if (typeof raw === 'string') {
        const parsed = parseProxyUrl(raw);
        return {
          kind: 'proxy',
          raw,
          hostPort: parsed ? parsed.hostPort : null,
          targetPath: parsed ? parsed.targetPath : '',
          loopback: parsed ? parsed.loopback : false,
        };
      }
    }
    for (const key of NON_PROXY_KEYS) {
      const raw = value[key];
      if (typeof raw === 'string') {
        return { kind: key === 'Path' ? 'file' : 'text', raw };
      }
    }
  }
  return { kind: 'other', raw: JSON.stringify(value ?? null) };
}

/** 从 "host:443" 中拆出主机名与端口。 */
export function splitHostPort(key: string): { host: string; port: number | null } {
  const idx = key.lastIndexOf(':');
  if (idx === -1) return { host: key, port: null };
  const port = Number(key.slice(idx + 1));
  return { host: key.slice(0, idx), port: Number.isInteger(port) ? port : null };
}

/**
 * 解析 `tailscale serve status --json`。
 *
 * **必须遍历全部 `Web` 组**，而不是只挑一组：serve 的每个 HTTPS 端口是
 * 一个独立的 `Web` 键（`host:443`、`host:8443`…），只取其一会让其它端口上的
 * 路由对本工具完全不可见——既管不了，安全闸门也扫不到。
 *
 * 无任何 serve 配置时 tailscale 返回 `{}`，此时得到空快照而不是报错。
 */
export function parseServeStatus(raw: unknown): ServeSnapshot {
  const root = isRecord(raw) ? raw : {};

  const tcp = isRecord(root.TCP) ? root.TCP : {};
  const httpsPorts = Object.entries(tcp)
    .filter(([, cfg]) => isRecord(cfg) && cfg.HTTPS === true)
    .map(([portKey]) => Number(portKey))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
    .sort((a, b) => a - b);

  const web = isRecord(root.Web) ? root.Web : {};
  const routes: ServeRoute[] = [];
  let hostname: string | null = null;

  for (const [key, entry] of Object.entries(web)) {
    const { host, port } = splitHostPort(key);
    // Web 键里没有端口时回落到最小的已声明 HTTPS 端口（正常不会发生）。
    const servePort = port ?? httpsPorts[0] ?? 443;
    if (hostname === null) hostname = host;

    const handlers = isRecord(entry) && isRecord(entry.Handlers) ? entry.Handlers : {};
    for (const [path, handler] of Object.entries(handlers)) {
      routes.push({
        servePort,
        host,
        path,
        handler: parseHandler(handler),
        managed: false,
        mappingId: null,
      });
    }
  }

  routes.sort((a, b) => a.servePort - b.servePort || a.path.localeCompare(b.path));

  return { httpsPorts, hostname, routes };
}

/** 取快照中可代理到宿主机的路由（可被 TsController 管理的候选）。 */
export function proxiedRoutes(snapshot: ServeSnapshot): ServeRoute[] {
  return snapshot.routes.filter((r) => r.handler.kind === 'proxy' && r.handler.hostPort !== null);
}

/** 快照中的 serve 主机名。 */
export function snapshotHostname(snapshot: ServeSnapshot): string | null {
  return snapshot.hostname;
}
