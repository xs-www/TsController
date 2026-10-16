/**
 * HTTP 管理面。
 *
 * 安全前提（由 config 强制保证）：
 * 1. 只监听回环地址，因此 tailnet 内其它设备无法直连；
 * 2. 额外校验 Host 头，抵御 DNS rebinding —— 否则恶意网页可以让浏览器
 *    把 attacker.com 解析到 127.0.0.1 再调用本 API；
 * 3. 任何指向管理端口的 serve 路由都会被安全闸门摘除。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.ts';
import { isLoopbackHost } from './domain/route-path.ts';
import type { Logger } from './logger.ts';
import type { ContainerSource } from './docker/docker-service.ts';
import type { ServeGateway } from './tailscale/tailscale-service.ts';
import { MappingConflictError, type MappingService } from './mappings/mapping-service.ts';
import type { AuditLog, MappingStore } from './mappings/store.ts';
import { DockerApiError } from './docker/docker-client.ts';
import { TailscaleError } from './tailscale/tailscale-cli.ts';

export interface AppDeps {
  config: AppConfig;
  mappings: MappingService;
  containers: ContainerSource;
  gateway: ServeGateway;
  store: MappingStore;
  audit: AuditLog;
  logger: Logger;
}

const mappingBodySchema = z.object({
  path: z.string().min(1),
  hostPort: z.number().int().min(1).max(65535),
  /** 对外 HTTPS 端口；省略时后端用配置里的默认端口。 */
  servePort: z.number().int().min(1).max(65535).optional(),
  targetPath: z.string().optional(),
  /**
   * 关联的 Tailscale Service，接受 `dsh` 或 `svc:dsh`。
   *
   * `null` / 空串表示节点级路由。字段省略表示「不改动」（PATCH 语义）。
   */
  service: z.string().max(120).nullable().optional(),
  /** 代理目标主机；省略即本机。只在 Service 级路由上支持。 */
  remoteHost: z.string().max(253).nullable().optional(),
  /** 代理协议；省略即 http。 */
  scheme: z.enum(['http', 'https']).optional(),
  kind: z.enum(['container', 'host']).optional(),
  containerId: z.string().optional(),
  containerName: z.string().optional(),
  containerPort: z.number().int().min(1).max(65535).optional(),
  note: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  confirmTakeover: z.boolean().optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });

/** 把领域错误映射成合适的 HTTP 状态码。 */
function statusFor(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err instanceof MappingConflictError) return err.code === 'not-found' ? 404 : 409;
  if (err instanceof TailscaleError) return 502;
  if (err instanceof DockerApiError) return 503;
  return 500;
}

function messageOf(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? statusFor(err);
    if (status >= 500) deps.logger.error('请求处理失败', { url: req.url, error: messageOf(err) });
    else deps.logger.debug('请求被拒绝', { url: req.url, error: messageOf(err) });
    const code = err instanceof MappingConflictError ? err.code : 'error';
    reply.code(status).send({ error: messageOf(err), code });
  });

  // Host 头白名单：只接受回环主机名。
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!host) {
      reply.code(400).send({ error: '缺少 Host 头', code: 'bad-host' });
      return;
    }
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]!;
    if (!isLoopbackHost(hostname)) {
      deps.logger.warn('拒绝非回环 Host 的请求', { host, url: req.url });
      reply.code(403).send({ error: '本管理接口只接受来自本机的请求', code: 'forbidden-host' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/api/system', async () => {
    const [tailnet, snapshot, overview] = await Promise.all([
      deps.gateway.tailnet(),
      deps.gateway.snapshot(),
      deps.mappings.overview(),
    ]);
    // 暴露判定只对**本机回环**目标成立：远端主机上的同名端口与本进程无关。
    const exposures = snapshot.routes
      .filter((r) => r.handler.kind === 'proxy' && r.handler.loopback && r.handler.hostPort === config.port)
      .map((r) => ({
        service: r.service,
        servePort: r.servePort,
        path: r.path,
        proxy: r.handler.kind === 'proxy' ? r.handler.raw : '',
      }));

    return {
      baseUrl: tailnet.baseUrl,
      dnsName: tailnet.dnsName,
      magicDnsSuffix: tailnet.magicDnsSuffix,
      tailnetIps: tailnet.ips,
      hostname: tailnet.hostname,
      backendState: tailnet.backendState,
      tailscaleVersion: tailnet.version,
      /** 本节点的 tag；为空即本节点不可能充当 Service host。 */
      selfTags: tailnet.tags,
      /** 本节点是否具备充当 Service host 的身份前提。 */
      canHostService: tailnet.tags.length > 0,
      adminUrl: `http://${config.host}:${config.port}`,
      adminPort: config.port,
      /** 新建映射时的默认对外端口。 */
      servePort: config.servePort,
      /** serve 中已声明的全部 HTTPS 端口（可能包含本工具未托管的路由）。 */
      servePorts: snapshot.httpsPorts,
      /** 节点级 serve 主机名（不含端口）。 */
      serveHost: snapshot.hostname,
      /** 当前节点上的 Tailscale Service 及状态。 */
      services: overview.services,
      sources: {
        docker: deps.containers.describeSource(),
        tailscale: deps.gateway.describeSource(),
        dataDir: config.dataDir,
        /** serve 路由快照的落盘路径；供其它项目只读挂载。 */
        snapshotFile: deps.mappings.snapshotFilePath,
      },
      security: {
        autoUnexpose: config.autoUnexpose,
        exposures,
        safe: exposures.length === 0,
      },
      plan: overview.planSummary,
      counts: overview.counts,
    };
  });

  app.get('/api/containers', async () => {
    const containers = await deps.containers.listContainers();
    return { containers, source: deps.containers.describeSource() };
  });

  app.get('/api/mappings', async () => deps.mappings.overview());

  app.post('/api/mappings', async (req, reply) => {
    const input = mappingBodySchema.parse(req.body);
    const result = await deps.mappings.create(input);
    reply.code(201);
    return result;
  });

  app.patch('/api/mappings/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = mappingBodySchema.partial().parse(req.body);
    const current = (await deps.store.read()).find((m) => m.id === id);
    if (!current) throw new MappingConflictError('not-found', `映射 ${id} 不存在`);
    return deps.mappings.update(id, {
      path: input.path ?? current.path,
      hostPort: input.hostPort ?? current.target.hostPort,
      servePort: input.servePort ?? current.servePort,
      targetPath: input.targetPath ?? current.target.targetPath,
      note: input.note ?? current.note,
      enabled: input.enabled ?? current.enabled,
      ...(input.service !== undefined ? { service: input.service } : {}),
      ...(input.remoteHost !== undefined ? { remoteHost: input.remoteHost } : {}),
      ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
      ...(input.confirmTakeover !== undefined ? { confirmTakeover: input.confirmTakeover } : {}),
    });
  });

  app.delete('/api/mappings/:id', async (req) => {
    const { id } = req.params as { id: string };
    return deps.mappings.remove(id);
  });

  app.post('/api/mappings/:id/enabled', async (req) => {
    const { id } = req.params as { id: string };
    const { enabled } = enabledSchema.parse(req.body);
    return deps.mappings.setEnabled(id, enabled);
  });

  app.post('/api/mappings/import', async (req) => {
    const body = z
      .object({
        /** 要接管的未托管路由；省略即接管全部。路由身份是 (Service, 端口, 路径)。 */
        routes: z
          .array(
            z.object({
              service: z.string().max(120).nullable().optional(),
              servePort: z.number().int().min(1).max(65535),
              path: z.string().min(1),
            }),
          )
          .optional(),
      })
      .parse(req.body ?? {});
    return deps.mappings.importExternal(body.routes);
  });

  app.post('/api/apply', async () => deps.mappings.apply());

  app.get('/api/serve/routes', async () => {
    const [routes, snapshot] = await Promise.all([deps.mappings.serveRoutes(), deps.gateway.snapshot()]);
    return {
      serveHost: snapshot.hostname,
      httpsPorts: snapshot.httpsPorts,
      services: snapshot.services,
      routes,
    };
  });

  app.get('/api/audit', async (req) => {
    const raw = Number((req.query as { limit?: string }).limit ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 50;
    return { events: await deps.audit.tail(limit) };
  });

  // 前端静态资源：构建产物存在才挂载，否则后端只提供 API。
  let hasWeb = false;
  try {
    await fs.access(path.join(config.webRoot, 'index.html'));
    hasWeb = true;
  } catch {
    hasWeb = false;
  }

  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webRoot, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: `未知接口 ${req.url}`, code: 'not-found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><meta charset="utf-8"><title>TsController</title>' +
            '<body style="font-family:system-ui;padding:2rem;line-height:1.6">' +
            '<h1>TsController API 已启动</h1>' +
            '<p>前端尚未构建。请在项目目录执行 <code>npm run web:build</code> 后重启，' +
            '或在开发模式下另开一个终端执行 <code>npm run web:dev</code>。</p>' +
            '<p>API 示例：<a href="/api/system">/api/system</a> · <a href="/api/containers">/api/containers</a></p>' +
            '</body>',
        );
    });
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: `未知接口 ${req.url}`, code: 'not-found' });
    });
  }

  return app;
}
