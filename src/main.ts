/**
 * 进程入口。
 *
 * 启动顺序刻意把安全检查放在监听之前：先确认 serve 配置里没有任何指向
 * 管理端口的路由，再对外提供管理接口。
 */

import { createRuntime } from './runtime.ts';
import { isLoopbackHost } from './domain/route-path.ts';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const { config, logger, app, mappings } = runtime;

  // 启动闸门：确保「本应用禁止暴露在 tailnet 中」这一硬性需求在每次启动时都被执行。
  try {
    const guard = await mappings.enforceExposureGuard();
    if (guard.exposures.length > 0) {
      logger.error('检测到管理端口曾被暴露在 tailnet 中', {
        exposures: guard.exposures,
        removed: guard.removed,
      });
    }
  } catch (err) {
    logger.warn('启动安全检查未能完成（Tailscale 不可用？）', { error: (err as Error).message });
  }

  // 预热 Docker 连接：端点探测是惰性的，提前连一次能让启动日志显示真实来源，
  // 也能在 Docker 未启动时立刻给出可读告警，而不是等到用户点开界面才报错。
  try {
    const containers = await runtime.containers.listContainers();
    logger.info('Docker 容器清单已就绪', { count: containers.length, endpoint: runtime.containers.describeSource() });
  } catch (err) {
    logger.warn('无法读取 Docker 容器清单，界面将只显示 tailscale 侧状态', {
      error: (err as Error).message,
    });
  }

  // 发布首份 serve 路由快照：其它项目（容器）靠只读挂载这个文件读取路由状态，
  // 因此它必须在进程可供调用之前就存在。
  try {
    const snapshot = await mappings.publishSnapshot();
    logger.info('serve 路由快照已发布', {
      file: mappings.snapshotFilePath,
      routes: snapshot.routes.length,
      managed: snapshot.summary.managed,
    });
  } catch (err) {
    logger.warn('serve 路由快照发布失败（其它项目的只读消费会受影响）', {
      error: (err as Error).message,
    });
  }

  await app.listen({ host: config.host, port: config.port });

  // 纵深防御：复核内核实际绑定的地址确实是回环。
  const address = app.server.address();
  if (address && typeof address === 'object' && !isLoopbackHost(address.address)) {
    logger.error('监听地址非回环，正在关闭', { address: address.address });
    await app.close();
    throw new Error(`拒绝在非回环地址 ${address.address} 上提供服务`);
  }

  let baseUrl = '(未知)';
  try {
    baseUrl = (await runtime.gateway.tailnet()).baseUrl ?? baseUrl;
  } catch {
    /* Tailscale 不可用时不影响管理界面启动 */
  }

  logger.info('TsController 已启动', {
    admin: `http://${config.host}:${config.port}`,
    tailnetBaseUrl: baseUrl,
    dataDir: config.dataDir,
    autoUnexpose: config.autoUnexpose,
    docker: runtime.containers.describeSource(),
    tailscale: runtime.gateway.describeSource(),
  });

  process.stdout.write(
    [
      '',
      '  TsController —— 本机 tailnet ↔ Docker 路由控制器',
      `  管理界面： http://${config.host}:${config.port}   （仅本机可访问）`,
      `  对外基址： ${baseUrl}`,
      `  数据目录： ${config.dataDir}`,
      `  路由快照： ${mappings.snapshotFilePath}`,
      '',
    ].join('\n') + '\n',
  );

  // 定期刷新快照：用户手工执行 `tailscale serve` 改了配置时，文件仍会被纠正回来。
  // 间隔为 0 表示只在启动与每次收敛后写。定时器 unref，不阻止进程退出。
  if (config.snapshotIntervalMs > 0) {
    const timer = setInterval(() => {
      void mappings.publishSnapshot().catch((err: unknown) => {
        logger.warn('定期刷新路由快照失败', { error: (err as Error).message });
      });
    }, config.snapshotIntervalMs);
    timer.unref();
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('收到退出信号，正在关闭', { signal });
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`启动失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
