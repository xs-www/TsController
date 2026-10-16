/**
 * 真实环境端到端验证。
 *
 * 与单测不同，这个脚本会真的读写本机的 Docker 与 tailscale：
 *   1. 读容器与 serve 配置；
 *   2. 建一条临时映射 `/__tscontroller-selftest` → 某个真实容器端口；
 *   3. 通过 `https://<机器名>.<tailnet>.ts.net/__tscontroller-selftest` 真实请求一次；
 *   4. 删除映射，并确认 serve 配置恢复到运行前的状态。
 *
 * 无论成功失败都会在 finally 中清理，且会逐条比对「运行前的既有路由」是否原样保留。
 *
 * 用法：
 *   node scripts/verify-live.ts [--port 8080] [--path /__tscontroller-selftest]
 */

import { createRuntime } from '../src/runtime.ts';
import { buildBaseUrl, formatRouteRef } from '../src/domain/route-path.ts';
import type { MappingService } from '../src/mappings/mapping-service.ts';

const TEST_PATH = '/__tscontroller-selftest';

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail = ''): boolean {
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? '  [PASS]' : '  [FAIL]'} ${step}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

async function requestThroughTailnet(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const wantedPort = arg('port', '');
  const testPath = arg('path', TEST_PATH);
  const servePortArg = arg('serve-port', '');
  const servePort = servePortArg === '' ? null : Number(servePortArg);

  const runtime = await createRuntime({
    config: { dataDir: 'data/verify', port: 8788, host: '127.0.0.1' },
  });
  const { gateway, containers, mappings, logger } = runtime;
  void logger;

  process.stdout.write('\n=== TsController 真实环境验证 ===\n\n');

  // ---- 1. 读取现状 ----
  const tailnet = await gateway.tailnet();
  const before = await gateway.snapshot();
  const beforeKeys = before.routes.map((r) => `${r.servePort}:${r.path}`).sort();
  check('读取 tailnet 身份', tailnet.dnsName !== null, `${tailnet.baseUrl} (${tailnet.ips.join(', ')})`);
  if (!tailnet.baseUrl) {
    process.stdout.write('\n无法确定 tailnet 基址，终止验证。\n');
    process.exit(1);
  }

  const containerList = await containers.listContainers();
  const published = containerList.filter((c) => c.state === 'running' && c.ports.length > 0);
  check('读取 Docker 容器', containerList.length > 0, `${containerList.length} 个容器，${published.length} 个有已发布端口`);

  process.stdout.write('\n  运行中的容器端口：\n');
  for (const c of published) {
    for (const p of c.ports) {
      process.stdout.write(`    ${c.name.padEnd(20)} ${p.hostIp}:${p.hostPort} → ${p.containerPort}/${p.protocol}\n`);
    }
  }

  process.stdout.write(
    `\n  serve 既有路由（${beforeKeys.length} 条）：${beforeKeys.join(', ') || '(无)'}\n`,
  );
  process.stdout.write(`  serve 已声明 HTTPS 端口：${before.httpsPorts.join(', ') || '(无)'}\n`);

  // ---- 2. 选一个目标端口 ----
  const candidates = published.flatMap((c) => c.ports.filter((p) => p.protocol === 'tcp').map((p) => ({ c, p })));
  const chosen = wantedPort
    ? candidates.find((x) => x.p.hostPort === Number(wantedPort))
    : candidates.find((x) => x.p.hostIp === '127.0.0.1') ?? candidates[0];

  if (!chosen) {
    process.stdout.write('\n找不到可用的 TCP 目标端口，终止验证。\n');
    process.exit(1);
  }
  check('选定目标端口', true, `${chosen.c.name} → 127.0.0.1:${chosen.p.hostPort}（容器端口 ${chosen.p.containerPort}）`);

  let createdId: string | null = null;
  const mappingService: MappingService = mappings;

  try {
    // ---- 3. 创建映射 ----
    const created = await mappingService.create({
      path: testPath,
      hostPort: chosen.p.hostPort,
      ...(servePort !== null ? { servePort } : {}),
      note: '自检临时映射',
    });
    createdId = created.mapping.id;
    const effectivePort = created.mapping.servePort;
    check(
      '创建映射并写入 serve',
      created.apply.upserted.some((u) => u.path === testPath && u.servePort === effectivePort) &&
        created.apply.errors.length === 0,
      `status=${created.mapping.status} servePort=${effectivePort} upserted=[${created.apply.upserted.map(formatRouteRef).join(',')}] errors=${JSON.stringify(created.apply.errors)}`,
    );

    const afterCreate = await gateway.snapshot();
    const written = afterCreate.routes.find((r) => r.path === testPath && r.servePort === effectivePort);
    check(
      'serve 中出现该路由',
      written !== undefined && written.handler.kind === 'proxy',
      written ? `:${written.servePort}${written.path} → ${written.handler.raw}` : '未找到',
    );

    // ---- 4. 真实请求 ----
    const url = `${buildBaseUrl(tailnet.dnsName, effectivePort)}${testPath}`;
    process.stdout.write(`\n  真实请求：${url}\n`);
    let passed = false;
    try {
      const res = await requestThroughTailnet(url);
      passed = res.status > 0 && res.status < 500;
      check(
        '通过 ts.net 访问到容器',
        passed,
        `HTTP ${res.status}，响应 ${res.body.length} 字节`,
      );
      if (!passed) process.stdout.write(`    响应片段：${res.body.slice(0, 200)}\n`);
    } catch (err) {
      check('通过 ts.net 访问到容器', false, (err as Error).message);
    }

    // ---- 5. 删除映射 ----
    const removed = await mappingService.remove(createdId);
    createdId = null;
    check(
      '删除映射并摘除 serve 路由',
      removed.apply.removed.some((r) => r.path === testPath && r.servePort === effectivePort),
      `removed=[${removed.apply.removed.map(formatRouteRef).join(',')}] errors=${JSON.stringify(removed.apply.errors)}`,
    );

    const afterDelete = await gateway.snapshot();
    check(
      'serve 中该路由已消失',
      !afterDelete.routes.some((r) => r.path === testPath && r.servePort === effectivePort),
    );
    const afterKeys = afterDelete.routes.map((r) => `${r.servePort}:${r.path}`).sort();
    check(
      '既有路由原样保留',
      JSON.stringify(afterKeys) === JSON.stringify(beforeKeys),
      `before=[${beforeKeys.join(',')}] after=[${afterKeys.join(',')}]`,
    );
  } finally {
    // 兜底清理：映射库被写坏或中途异常时，直接摘掉测试路径。
    if (createdId) {
      try {
        await mappingService.remove(createdId);
      } catch {
        /* 忽略：下面的兜底会再摘一次 */
      }
    }
    const leftover = (await gateway.snapshot()).routes.filter((r) => r.path === testPath);
    for (const r of leftover) {
      try {
        await gateway.removeRoute(r.servePort, r.path);
        process.stdout.write(`  [清理] 兜底摘除残留路由 ${r.servePort}:${r.path}\n`);
      } catch (err) {
        process.stdout.write(`  [清理失败] ${r.servePort}:${r.path}: ${(err as Error).message}\n`);
      }
    }
  }

  // ---- 6. 汇总 ----
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===\n`);
  if (failed.length > 0) {
    for (const f of failed) process.stdout.write(`  失败：${f.step} — ${f.detail}\n`);
    process.exit(1);
  }
  process.stdout.write('真实环境验证全部通过。\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n验证脚本异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
