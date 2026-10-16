/**
 * 依赖装配。
 *
 * 把「读环境变量 → 构造真实实现」集中在这里，测试与验证脚本则各自注入假实现。
 */

import { promises as fs } from 'node:fs';
import type { AppConfig } from './config.ts';
import { loadConfig } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { DockerEngineClient, type DockerTransport } from './docker/docker-client.ts';
import { DockerContainerService, type ContainerSource } from './docker/docker-service.ts';
import { ExecFileRunner, TailscaleCli, type CommandRunner } from './tailscale/tailscale-cli.ts';
import { TailscaleServeGateway, type ServeGateway } from './tailscale/tailscale-service.ts';
import { FileAuditLog, FileMappingStore, type AuditLog, type MappingStore } from './mappings/store.ts';
import { MappingService } from './mappings/mapping-service.ts';
import { FileSnapshotWriter, type SnapshotWriter } from './snapshot.ts';
import { buildApp } from './app.ts';
import type { FastifyInstance } from 'fastify';

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  store: MappingStore;
  audit: AuditLog;
  containers: ContainerSource;
  gateway: ServeGateway;
  mappings: MappingService;
  app: FastifyInstance;
  snapshot: SnapshotWriter;
}

export interface RuntimeOverrides {
  config?: Partial<AppConfig>;
  store?: MappingStore;
  audit?: AuditLog;
  containers?: ContainerSource;
  gateway?: ServeGateway;
  snapshot?: SnapshotWriter;
  dockerTransport?: DockerTransport;
  commandRunner?: CommandRunner;
  logger?: Logger;
}

/** 装配完整运行时（含 Fastify 实例，但尚未 listen）。 */
export async function createRuntime(overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const config = loadConfig(overrides.config ?? {});
  const logger = overrides.logger ?? createLogger((process.env.TSCONTROLLER_LOG_LEVEL as 'debug') ?? 'info');

  await fs.mkdir(config.dataDir, { recursive: true });

  const transport = overrides.dockerTransport ?? new DockerEngineClient(config.dockerPipe, logger.child('docker'));
  const containers = overrides.containers ?? new DockerContainerService(transport);

  const runner = overrides.commandRunner ?? new ExecFileRunner();
  const cli = new TailscaleCli(config.tailscaleBin, runner, logger.child('tailscale'));
  const gateway = overrides.gateway ?? new TailscaleServeGateway(cli, logger.child('tailscale'));

  const store = overrides.store ?? new FileMappingStore(config.dataDir, logger.child('store'), config.servePort);
  const audit = overrides.audit ?? new FileAuditLog(config.dataDir, logger.child('audit'));
  const snapshot = overrides.snapshot ?? new FileSnapshotWriter(config.snapshotDir);

  const mappings = new MappingService({
    store,
    gateway,
    containers,
    audit,
    logger: logger.child('mappings'),
    adminPort: config.port,
    servePort: config.servePort,
    autoUnexpose: config.autoUnexpose,
    snapshot,
  });

  const app = await buildApp({ config, mappings, containers, gateway, store, audit, logger });

  return { config, logger, store, audit, containers, gateway, mappings, app, snapshot };
}
