/**
 * 安全闸门的真实环境验证。
 *
 * 需求原文：「本应用禁止暴露在 tailnet 中」。这条要求必须在运行时被强制执行，
 * 而不只是写在配置里。本脚本用真实 tailscale 复现四种情形：
 *
 *   A. serve 中（443）存在指向管理端口的路由 → 启动闸门必须摘除它，并写入审计日志；
 *   B. serve 中存在指向其它端口的路由 → 必须原样保留（不能误伤）；
 *   C. 通过 API 建立指向管理端口的映射 → 必须被拒绝（409 exposes-admin）；
 *   D. **非默认端口上的暴露** → 同样必须被检测并摘除；
 *   E. **Service 命名空间上的暴露** → 同样必须被检测并摘除（E 段只在传入
 *      `--service svc:<名字>` 且该 Service 已存在时执行，因为需要真实的 service host）。
 *
 * D 是后加的回归用例：早期实现只解析 443 那一组 Web 配置，挂在 8443 上的暴露
 * 对闸门完全不可见——那是一个真实的安全缺口，这条断言专门守住它。
 *
 * E 是 Service 支持引入的第二个同类缺口：`serve status --json` **不含 Service**，
 * 只读它会让 Service 上的暴露对闸门完全不可见。E 段守的就是这条。
 *
 * 为了做到「零暴露窗口」，泄漏路由在闸门运行前指向一个**无人监听**的端口，
 * 因此被探测到的那一瞬间也不会有任何数据外泄。
 *
 * 用法：node scripts/verify-security.ts [--service svc:dsh]
 */

import { promises as fs } from 'node:fs';
import { createRuntime } from '../src/runtime.ts';
import { formatRouteRef } from '../src/domain/route-path.ts';

const LEAK_PATH = '/__tsc-leak';
const SAFE_PATH = '/__tsc-safe';
const LEAK_PORT = 8443;
const LEAK_PATH_ALT = '/__tsc-leak-alt';
/** Service 命名空间的泄漏路径（只在传入 --service 时使用）。 */
const SERVICE_LEAK_PATH = '/__tsc-leak-svc';
/** 验证期间临时充当「管理端口」；确认空闲后才会使用。 */
const TEST_ADMIN_PORT = 8789;
const DEAD_PORT = 9;

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail = ''): boolean {
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? '  [PASS]' : '  [FAIL]'} ${step}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

/** 待清理的路由位置。 */
const toClean: Array<{ service: string | null; servePort: number; path: string }> = [
  { service: null, servePort: 443, path: LEAK_PATH },
  { service: null, servePort: 443, path: SAFE_PATH },
  { service: null, servePort: LEAK_PORT, path: LEAK_PATH_ALT },
  { service: null, servePort: 443, path: '/__tsc-blocked' },
];

/** 路由位置的身份键（Service + 端口 + 路径）。 */
function keyOf(route: { service?: string | null; servePort: number; path: string }): string {
  return `${route.service ?? 'node'}:${route.servePort}:${route.path}`;
}

async function main(): Promise<void> {
  const wantedService = arg('service', '');
  process.stdout.write('\n=== TsController 安全闸门验证 ===\n\n');

  const runtime = await createRuntime({
    config: { dataDir: 'data/verify-security', port: TEST_ADMIN_PORT, host: '127.0.0.1' },
  });
  const { gateway, mappings, audit } = runtime;

  const before = await gateway.snapshot();
  const original = before.routes.map(formatRouteRef).sort();

  try {
    // ---- 准备：泄漏路由先指向无人监听的端口 ----
    await gateway.upsertRoute(443, LEAK_PATH, `http://127.0.0.1:${TEST_ADMIN_PORT}`);
    await gateway.upsertRoute(443, SAFE_PATH, `http://127.0.0.1:${DEAD_PORT}`);
    await gateway.upsertRoute(LEAK_PORT, LEAK_PATH_ALT, `http://127.0.0.1:${TEST_ADMIN_PORT}`);
    const prepared = await gateway.snapshot();
    check(
      '准备三条 serve 路由（443 两条 + 8443 一条，其中两条指向管理端口）',
      prepared.routes.some((r) => r.path === LEAK_PATH) &&
        prepared.routes.some((r) => r.path === SAFE_PATH) &&
        prepared.routes.some((r) => r.servePort === LEAK_PORT && r.path === LEAK_PATH_ALT),
      `httpsPorts=[${prepared.httpsPorts.join(',')}]`,
    );

    // ---- E. Service 命名空间上的暴露（需要真实的 service host 才有意义） ----
    const serviceInfo =
      wantedService === ''
        ? undefined
        : before.services.find((s) => s.name.toLowerCase() === wantedService.toLowerCase());
    let serviceLeakPort = 0;
    if (wantedService !== '' && serviceInfo && serviceInfo.servePorts.length > 0) {
      serviceLeakPort = serviceInfo.servePorts.includes(443) ? 443 : serviceInfo.servePorts[0]!;
      // 用**另一条**路径，避免覆盖该 Service 上本该存在的根路由。
      await gateway.upsertRoute(serviceLeakPort, SERVICE_LEAK_PATH, `http://127.0.0.1:${TEST_ADMIN_PORT}`, wantedService);
      toClean.push({ service: wantedService, servePort: serviceLeakPort, path: SERVICE_LEAK_PATH });
      const svcPrepared = await gateway.snapshot();
      check(
        `E. 准备一条 ${wantedService} 上的泄漏路由`,
        svcPrepared.routes.some(
          (r) => (r.service ?? null) === wantedService && r.path === SERVICE_LEAK_PATH,
        ),
        `route=${wantedService}:${serviceLeakPort}${SERVICE_LEAK_PATH}`,
      );
    } else if (wantedService !== '') {
      process.stdout.write(
        `  [跳过] E 段：本节点上没有可用的 Service ${wantedService}` +
          `（services=[${before.services.map((s) => s.name).join(',') || '空'}]）。\n`,
      );
    }

    // ---- A. 启动闸门（443 上的暴露） ----
    const guard = await mappings.enforceExposureGuard();
    check(
      'A. 检测到 443 上指向管理端口的 serve 路由',
      guard.exposures.some((e) => e.servePort === 443 && e.path === LEAK_PATH),
      JSON.stringify(guard.exposures.map(formatRouteRef)),
    );
    check(
      'A. 已自动摘除该路由',
      guard.removed.some((r) => r.service === null && r.servePort === 443 && r.path === LEAK_PATH),
      `removed=[${guard.removed.map(formatRouteRef).join(',')}]`,
    );

    const after = await gateway.snapshot();
    check(
      'A. serve 中该路由确实消失',
      !after.routes.some((r) => r.service === null && r.servePort === 443 && r.path === LEAK_PATH),
    );

    // ---- D. 非默认端口上的暴露（本次修复的核心回归点） ----
    check(
      'D. 检测到 8443 上指向管理端口的 serve 路由',
      guard.exposures.some((e) => e.servePort === LEAK_PORT && e.path === LEAK_PATH_ALT),
      '这是修复「只解析 443」缺口后的关键断言',
    );
    check(
      'D. 已自动摘除非默认端口上的该路由',
      !after.routes.some((r) => r.servePort === LEAK_PORT && r.path === LEAK_PATH_ALT),
    );
    // 8443 上可能本来就有用户自己的路由（例如门户挂在根路径），那些必须被保留。
    const preexistingOnLeakPort = prepared.routes.filter(
      (r) => r.servePort === LEAK_PORT && r.path !== LEAK_PATH_ALT,
    );
    check(
      `D. 8443 上的既有路由（${preexistingOnLeakPort.length} 条）未被牵连`,
      preexistingOnLeakPort.every((p) =>
        after.routes.some((r) => keyOf(r) === keyOf(p)),
      ),
      preexistingOnLeakPort.map(formatRouteRef).join(',') || '(该端口上无既有路由)',
    );

    // ---- E 断言 ----
    if (serviceLeakPort > 0) {
      check(
        `E. 检测到 ${wantedService} 上指向管理端口的路由`,
        guard.exposures.some(
          (e) => (e.service ?? null) === wantedService && e.path === SERVICE_LEAK_PATH,
        ),
        '`serve status --json` 不含 Service，只读它就会漏掉这条 —— 这是本段守住的缺口',
      );
      check(
        `E. 已自动摘除 ${wantedService} 上的该路由`,
        !after.routes.some(
          (r) => (r.service ?? null) === wantedService && r.path === SERVICE_LEAK_PATH,
        ),
      );
      check(
        `E. ${wantedService} 上的既有端点未被牵连`,
        before.routes
          .filter((r) => (r.service ?? null) === wantedService)
          .every((p) => after.routes.some((r) => keyOf(r) === keyOf(p))),
      );
    }

    // ---- B. 不误伤 ----
    check('B. 指向其它端口的路由被保留', after.routes.some((r) => r.path === SAFE_PATH));

    // ---- 审计 ----
    const events = await audit.tail(50);
    check(
      '审计日志记录了检测与摘除',
      events.some((e) => e.kind === 'exposure-detected') && events.some((e) => e.kind === 'exposure-removed'),
      events.map((e) => e.kind).join(','),
    );

    const auditFile = new URL('../data/verify-security/audit.jsonl', import.meta.url);
    const auditText = await fs.readFile(auditFile, 'utf8').catch(() => '');
    check('审计日志已落盘且含非默认端口的路由标签', auditText.includes('exposure-removed') && auditText.includes(':8443'));

    // ---- C. API 层拒绝 ----
    let rejected = false;
    let code = '';
    try {
      await mappings.create({ path: '/__tsc-blocked', hostPort: TEST_ADMIN_PORT });
    } catch (err) {
      rejected = true;
      code = (err as { code?: string }).code ?? '';
    }
    check('C. 建立指向管理端口的映射被拒绝', rejected && code === 'exposes-admin', `code=${code}`);

    // ---- C2. 对外端口与管理端口同号 ----
    let rejected2 = false;
    let code2 = '';
    try {
      await mappings.create({ path: '/__tsc-blocked2', hostPort: 4173, servePort: TEST_ADMIN_PORT });
    } catch (err) {
      rejected2 = true;
      code2 = (err as { code?: string }).code ?? '';
    }
    check('C2. 对外端口与管理端口同号被拒绝', rejected2 && code2 === 'serve-port-is-admin', `code=${code2}`);

    const finalSnapshot = await gateway.snapshot();
    check(
      'C. 被拒绝的映射没有写入 serve',
      !finalSnapshot.routes.some((r) => r.path === '/__tsc-blocked' || r.path === '/__tsc-blocked2'),
    );
  } finally {
    for (const route of toClean) {
      const exists = (await gateway.snapshot()).routes.some((r) => keyOf(r) === keyOf(route));
      if (!exists) continue;
      try {
        await gateway.removeRoute(route.servePort, route.path, route.service);
        process.stdout.write(`  [清理] 摘除 ${formatRouteRef(route)}\n`);
      } catch (err) {
        process.stdout.write(`  [清理失败] ${formatRouteRef(route)}: ${(err as Error).message}\n`);
      }
    }
  }

  const final = (await gateway.snapshot()).routes.map(formatRouteRef).sort();
  check(
    '原有 serve 配置未被破坏',
    JSON.stringify(final) === JSON.stringify(original),
    `before=[${original.join(',')}] after=[${final.join(',')}]`,
  );
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===\n`);
  if (failed.length > 0) {
    for (const f of failed) process.stdout.write(`  失败：${f.step} — ${f.detail}\n`);
    process.exit(1);
  }
  process.stdout.write('安全闸门验证全部通过。\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n验证脚本异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
