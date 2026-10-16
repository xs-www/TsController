/**
 * `tailscale serve` 配置的解析。
 *
 * 这里有两个**互不相同、且都必须读**的数据源：
 *
 * | 来源 | 内容 | 结构 |
 * | --- | --- | --- |
 * | `tailscale serve status --json` | 节点级 serve 路由 | `{ TCP, Web }`（legacy raw 格式） |
 * | `tailscale serve get-config --all` | **Service 级**端点配置 | `{ version, services }`（huJSON） |
 *
 * **为什么必须读第二个**：官方明确写着这两个命令返回的信息不同，Service 列表
 * 只在 `get-config` 里（[tailscale#18289]）。只读 `status --json` 会让 Service
 * 路由对 TsController 完全不可见——既管不了，**安全闸门也扫不到**。这与早期
 * 「只取一组 `Web` 导致非 443 端口不可见」是同一类缺口。
 *
 * 写入统一走 `tailscale serve --set-path` / `--service` 命令行，因为 `get-config`
 * 的往返是**有损**的（它只序列化根 handler 与端点映射）。
 *
 * [tailscale#18289]: https://github.com/tailscale/tailscale/issues/18289
 */

import { parseProxyUrl, serviceShortName } from '../domain/route-path.ts';
import type { ServiceInfo, ServeHandler, ServeRoute, ServeSnapshot } from '../domain/types.ts';

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
          host: parsed ? parsed.host : null,
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

/** 归一化服务配置里的 `tcp:443` / `tcp:443-8443` 端点键。 */
export function parseEndpointKey(key: string): { protocol: string; port: number } | null {
  const m = /^([a-z]+):(\d+)(?:-(\d+))?$/i.exec(key.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { protocol: m[1]!.toLowerCase(), port };
}

/**
 * 解析 `tailscale serve status --json` 里的**节点级**路由。
 *
 * **必须遍历全部 `Web` 组**，而不是只挑一组：serve 的每个 HTTPS 端口是
 * 一个独立的 `Web` 键（`host:443`、`host:8443`…），只取其一会让其它端口上的
 * 路由对本工具完全不可见——既管不了，安全闸门也扫不到。
 *
 * 无任何 serve 配置时 tailscale 返回 `{}`，此时得到空快照而不是报错。
 *
 * 注意：**这个输出里没有 Service**（见文件头说明），Service 由
 * `parseServiceConfig()` 单独解析。
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
        service: null,
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

  return { httpsPorts, hostname, routes, services: [] };
}

/** `get-config --all` 的单条 service 详情。 */
interface RawServiceDetails {
  endpoints?: unknown;
  advertised?: unknown;
}

/**
 * 解析 `tailscale serve get-config --all` 的 Service 端点配置。
 *
 * 结构（huJSON）：
 *
 * ```json
 * { "version": "0.0.1",
 *   "services": { "svc:dsh": { "advertised": true,
 *                             "endpoints": { "tcp:443": "http://my-laptop.example-tailnet.ts.net:3081" } } } }
 * ```
 *
 * **已知有损之处**（因此本函数的输出只用于「读状态」，绝不用于重建写配置）：
 * - 只有根 handler：挂在 `/sub` 上的额外 handler 不会出现在这里；
 * - 目标路径被丢弃：`http://host:3081/api` 的 `/api` 在往返后可能只剩主机与端口
 *   （上游 `runServeGetConfig` 用 `net.SplitHostPort` 拆解 Proxy，尾部路径不在
 *   输出模型里）。因此 Service 路由的**目标路径以映射库为准**，serve 中若被
 *   改写，只能靠 apply 重新收敛。
 *
 * `magicDnsSuffix` 用于拼出 Service 的对外主机名；缺失时退回裸 Service 名。
 */
export function parseServiceConfig(raw: unknown, magicDnsSuffix?: string | null): ServeSnapshot {
  const root = isRecord(raw) ? raw : {};
  const servicesRaw = isRecord(root.services) ? root.services : {};

  const routes: ServeRoute[] = [];
  const services: ServiceInfo[] = [];
  const ports = new Set<number>();

  for (const [rawName, entryUnknown] of Object.entries(servicesRaw)) {
    if (!isRecord(entryUnknown)) continue;
    const entry = entryUnknown as RawServiceDetails;
    const name = rawName.trim();
    if (name === '') continue;

    const dnsName = magicDnsSuffix
      ? `${serviceShortName(name)}.${magicDnsSuffix.replace(/^\.+|\.+$/g, '')}`
      : serviceShortName(name);

    const endpoints = isRecord(entry.endpoints) ? entry.endpoints : {};
    const servicePorts: number[] = [];

    for (const [endpointKey, targetUnknown] of Object.entries(endpoints)) {
      const parsedKey = parseEndpointKey(endpointKey);
      if (!parsedKey) continue; // `tun` 之类没有端口的端点：本工具不参与
      const target = typeof targetUnknown === 'string' ? targetUnknown.trim() : '';
      if (target === '') continue;

      const handler = parseServiceTarget(target);
      if (handler === null) {
        // 无法归类的目标不是「可托管代理」，但也**不能**静默丢掉——那会让
        // 「本节点上还有一条我没看见的端点」这种事发生。归为 other，只读展示。
        routes.push({
          service: name,
          servePort: parsedKey.port,
          host: dnsName,
          path: '/',
          handler: { kind: 'other', raw: target },
          managed: false,
          mappingId: null,
        });
        continue;
      }

      // `httpsPorts` 的语义是「本节点上需要被安全检查盯住的 HTTP(S) 出口」。
      // 判定看**目标**的协议：端点键只是 L4 的监听声明（`tcp:443`），真正决定
      // 这一跳是不是 HTTP 的是目标串（`http://…` / `https://…`）。
      // 纯 L4 转发（`tcp://…`）不参与——安全闸门对 TCP 转发本来也无能为力。
      const targetProtocol = handler.kind === 'proxy' ? handler.raw.slice(0, handler.raw.indexOf(':')).toLowerCase() : '';
      if (targetProtocol === 'http' || targetProtocol === 'https') {
        servicePorts.push(parsedKey.port);
        ports.add(parsedKey.port);
      }
      routes.push({
        service: name,
        servePort: parsedKey.port,
        host: dnsName,
        path: '/',
        handler,
        managed: false,
        mappingId: null,
      });
    }

    services.push({
      name,
      dnsName,
      servePorts: [...new Set(servicePorts)].sort((a, b) => a - b),
      // 只有在配置里**显式**写着 `advertised: true` 时才认为已 advertise；
      // 缺省值不可信——本节点是否真的被承认为 host，唯一的证据是
      // `status --json` 的 `Self.CapMap["service-host"]`（由 mergeServeSnapshots 补上）。
      advertised: entry.advertised === true,
      vipIps: [],
    });
  }

  routes.sort((a, b) => a.servePort - b.servePort || a.path.localeCompare(b.path));
  services.sort((a, b) => a.name.localeCompare(b.name));

  return { httpsPorts: [...ports].sort((a, b) => a - b), hostname: null, routes, services };
}

/**
 * 把 `get-config` 里的目标串转成 handler。
 *
 * 目标串是 URI 形式：`http://host:port` / `https://host:port` / `tcp://host:port`
 * / `unix:/path`。只有 HTTP(S) 是本工具能接管的形态；`tcp:`（L4 转发）与
 * `unix:` 归为 `other`，与节点级的处理保持一致（只读展示，不参与托管）。
 *
 * 返回 `null` 表示「连归类都做不到」——调用方应把它当作 `other` 展示，
 * 而不是当成错误，也不该丢掉。
 */
export function parseServiceTarget(target: string): ServeHandler | null {
  if (target.toLowerCase().startsWith('unix:')) return { kind: 'other', raw: target };
  const protocol = target.includes('://') ? target.slice(0, target.indexOf('://')).toLowerCase() : '';
  if (protocol === 'tcp' || protocol === 'tls-terminated-tcp') {
    return { kind: 'other', raw: target };
  }
  if (protocol !== 'http' && protocol !== 'https') return null;

  const parsed = parseProxyUrl(target);
  if (!parsed) return { kind: 'other', raw: target };
  return {
    kind: 'proxy',
    raw: target,
    hostPort: parsed.hostPort,
    host: parsed.host,
    targetPath: parsed.targetPath,
    loopback: parsed.loopback,
    fromServiceConfig: true,
  };
}

/**
 * 合并节点级与 Service 级的两个快照。
 *
 * 两个来源的路由键不可能撞车（`service` 维度不同），因此这里只做拼接与
 * Service 信息的补全：
 * - `serviceHosts`（来自 `status --json` 的 `Self.CapMap["service-host"]`）
 *   给 `ServiceInfo` 补上 `advertised` 与 TailVIP；
 * - 只在 `serviceHosts` 里出现、配置里没有端点的 Service 也会被列出
 *   （状态是「已被承认但没有 endpoint 配置」，同样值得让用户看到）。
 */
export function mergeServeSnapshots(
  nodeLevel: ServeSnapshot,
  serviceLevel: ServeSnapshot,
  serviceHosts: Record<string, string[]> = {},
): ServeSnapshot {
  const ports = new Set<number>([...nodeLevel.httpsPorts, ...serviceLevel.httpsPorts]);

  const byName = new Map<string, ServiceInfo>();
  for (const s of serviceLevel.services) {
    byName.set(s.name.toLowerCase(), { ...s, vipIps: [...s.vipIps] });
  }
  for (const [rawName, ips] of Object.entries(serviceHosts)) {
    const key = rawName.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.advertised = true;
      existing.vipIps = [...ips];
    } else {
      byName.set(key, {
        name: rawName,
        dnsName: null,
        servePorts: [],
        advertised: true,
        vipIps: [...ips],
      });
    }
  }

  const services = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of services) for (const p of s.servePorts) ports.add(p);

  const routes = [...nodeLevel.routes, ...serviceLevel.routes].sort(
    (a, b) =>
      a.servePort - b.servePort ||
      (a.service ?? '').localeCompare(b.service ?? '') ||
      a.path.localeCompare(b.path),
  );

  return {
    httpsPorts: [...ports].sort((a, b) => a - b),
    // 节点级主机名以 status 为准；只有 Service 配置时退回第一个 Service 的 DNS 名。
    hostname: nodeLevel.hostname ?? null,
    routes,
    services,
  };
}

/** 取快照中可代理到宿主机的路由（可被 TsController 管理的候选）。 */
export function proxiedRoutes(snapshot: ServeSnapshot): ServeRoute[] {
  return snapshot.routes.filter((r) => r.handler.kind === 'proxy' && r.handler.hostPort !== null);
}

/** 快照中的节点级 serve 主机名。 */
export function snapshotHostname(snapshot: ServeSnapshot): string | null {
  return snapshot.hostname;
}

/** 按 Service 名查状态。 */
export function serviceInfoOf(snapshot: ServeSnapshot, service: string): ServiceInfo | null {
  const key = service.toLowerCase();
  return snapshot.services.find((s) => s.name.toLowerCase() === key) ?? null;
}
