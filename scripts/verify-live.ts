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
 *   node scripts/verify-live.ts --service svc:dsh        # 额外验证 Service 级路由
 *
 * 关于 `--service`：Service 级路由要求本节点是**已打 tag 的 service host**。
 * 不满足时会打印原因并**跳过**这一段（节点级验证照常执行），而不是失败——
 * 本机是用户账号身份时，拿不到 Service 才是预期状态。
 */

import { createRuntime } from '../src/runtime.ts';
import { buildServiceDnsName, formatRouteRef } from '../src/domain/route-path.ts';
import type { MappingService } from '../src/mappings/mapping-service.ts';

const TEST_PATH = '/__tscontroller-selftest';

/** 只统计真正执行过的断言，跳过的段落不计入分母。 */
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

/** 对外的完整基址：节点级用节点 DNS 名，Service 级用 Service 的 MagicDNS 名。 */
function originOf(nodeDns: string, magicDnsSuffix: string | null, servePort: number, service: string | null): string {
  const host = service ? buildServiceDnsName(service, magicDnsSuffix, nodeDns) : nodeDns;
  if (!host) throw new Error('无法确定对外主机名');
  return servePort === 443 ? `https://${host}` : `https://${host}:${servePort}`;
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
  const wantedService = arg('service', '');

  const runtime = await createRuntime({
    config: { dataDir: 'data/verify', port: 8788, host: '127.0.0.1' },
  });
  const { gateway, containers, mappings, logger } = runtime;
  void logger;

  process.stdout.write('\n=== TsController 真实环境验证 ===\n\n');

  // ---- 1. 读取现状 ----
  const tailnet = await gateway.tailnet();
  const before = await gateway.snapshot();
  const routeKey = (r: { service: string | null; servePort: number; path: string }): string =>
    `${r.service ?? 'node'}:${r.servePort}:${r.path}`;
  const beforeKeys = before.routes.map(routeKey).sort();
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
  process.stdout.write(
    `  本节点 tag：${tailnet.tags.join(', ') || '(无 —— 不可能充当 Service host)'}\n`,
  );
  if (before.services.length > 0) {
    process.stdout.write('  本节点的 Service：\n');
    for (const s of before.services) {
      process.stdout.write(
        `    ${s.name.padEnd(18)} ${s.dnsName ?? '(未知 DNS 名)'}  ports=${s.servePorts.join(',') || '-'} ` +
          `${s.advertised ? '已承认' : '等待审批'} vip=${s.vipIps.join(',') || '-'}\n`,
      );
    }
  }

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

  /** 跑一轮完整的「建 → 请求 → 删 → 比对」。节点级与 Service 级共用这一段。 */
  async function round(options: {
    label: string;
    service: string | null;
    hostPort: number;
    remoteHost?: string;
    servePort: number | null;
  }): Promise<void> {
    process.stdout.write(`\n--- ${options.label} ---\n`);
    let createdId: string | null = null;
    let effectivePort = options.servePort ?? 443;

    try {
      const created = await mappingService.create({
        path: testPath,
        hostPort: options.hostPort,
        service: options.service,
        ...(options.remoteHost !== undefined ? { remoteHost: options.remoteHost } : {}),
        ...(options.servePort !== null ? { servePort: options.servePort } : {}),
        note: '自检临时映射',
      });
      createdId = created.mapping.id;
      effectivePort = created.mapping.servePort;
      check(
        `[${options.label}] 创建映射并写入 serve`,
        created.apply.upserted.some(
          (u) => u.path === testPath && u.servePort === effectivePort && u.service === options.service,
        ) && created.apply.errors.length === 0,
        `status=${created.mapping.status} route=${formatRouteRef({ service: options.service, servePort: effectivePort, path: testPath })} ` +
          `upserted=[${created.apply.upserted.map(formatRouteRef).join(',')}] errors=${JSON.stringify(created.apply.errors)}`,
      );
      if (created.mapping.status === 'awaiting-approval') {
        process.stdout.write(
          '    [注意] 该 Service host 尚未被承认（等待管理员审批）；下面的真实请求预期会失败，这是预期状态。\n',
        );
      }

      const afterCreate = await gateway.snapshot();
      const written = afterCreate.routes.find(
        (r) => r.path === testPath && r.servePort === effectivePort && r.service === options.service,
      );
      check(
        `[${options.label}] serve 中出现该路由`,
        written !== undefined && written.handler.kind === 'proxy',
        written ? `${formatRouteRef(written)} → ${written.handler.raw}` : '未找到',
      );

      // ---- 真实请求 ----
      const origin = originOf(tailnet.dnsName!, tailnet.magicDnsSuffix, effectivePort, options.service);
      const url = `${origin}${testPath}`;
      process.stdout.write(`\n  真实请求：${url}\n`);
      try {
        const res = await requestThroughTailnet(url);
        const passed = res.status > 0 && res.status < 500;
        check(`[${options.label}] 通过 ts.net 访问到容器`, passed, `HTTP ${res.status}，响应 ${res.body.length} 字节`);
        if (!passed) process.stdout.write(`    响应片段：${res.body.slice(0, 200)}\n`);
      } catch (err) {
        check(`[${options.label}] 通过 ts.net 访问到容器`, false, (err as Error).message);
      }

      // ---- 删除 ----
      const removed = await mappingService.remove(createdId);
      createdId = null;
      check(
        `[${options.label}] 删除映射并摘除 serve 路由`,
        removed.apply.removed.some(
          (r) => r.path === testPath && r.servePort === effectivePort && r.service === options.service,
        ),
        `removed=[${removed.apply.removed.map(formatRouteRef).join(',')}] errors=${JSON.stringify(removed.apply.errors)}`,
      );

      const afterDelete = await gateway.snapshot();
      check(
        `[${options.label}] serve 中该路由已消失`,
        !afterDelete.routes.some(
          (r) => r.path === testPath && r.servePort === effectivePort && r.service === options.service,
        ),
      );
      const afterKeys = afterDelete.routes.map(routeKey).sort();
      check(
        `[${options.label}] 既有路由原样保留`,
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
      const leftover = (await gateway.snapshot()).routes.filter(
        (r) =>
          r.path === testPath &&
          (options.service === null ? true : (r.service ?? null) === options.service),
      );
      for (const r of leftover) {
        try {
          await gateway.removeRoute(r.servePort, r.path, r.service);
          process.stdout.write(`  [清理] 兜底摘除残留路由 ${formatRouteRef(r)}\n`);
        } catch (err) {
          process.stdout.write(`  [清理失败] ${formatRouteRef(r)}: ${(err as Error).message}\n`);
        }
      }
    }
  }

  const mappingService: MappingService = mappings;

  // ---- 3. 节点级一轮（始终执行） ----
  await round({
    label: '节点级',
    service: null,
    hostPort: chosen.p.hostPort,
    servePort,
  });

  // ---- 4. Service 一轮（仅在明确要求且前提满足时） ----
  if (wantedService !== '') {
    const info = before.services.find((s) => s.name.toLowerCase() === wantedService.toLowerCase());
    if (before.services.length === 0 && tailnet.tags.length === 0) {
      process.stdout.write(
        `\n  [跳过] 本节点没有 tag 身份（tags 为空），不可能充当 Service host。\n` +
          '         请在已打 tag 的设备上运行本验证，或先给本机打 tag 后重新登录 Tailscale。\n',
      );
    } else if (!info) {
      process.stdout.write(
        `\n  [跳过] 本节点上没有 Service ${wantedService} 的配置。\n` +
          `         请先在该 service host 上执行：tailscale serve --service=${wantedService} --https=443 <目标>\n`,
      );
    } else if (info.servePorts.length === 0) {
      process.stdout.write(`\n  [跳过] Service ${wantedService} 没有任何端点配置。\n`);
    } else {
      const port = info.servePorts.includes(443) ? 443 : info.servePorts[0]!;
      const remote = arg('remote-host', tailnet.dnsName ?? '');
      await round({
        label: `Service ${wantedService}`,
        service: wantedService,
        hostPort: chosen.p.hostPort,
        servePort: port,
        // service host 通常不在本机：目标写成节点自己的 tailnet DNS 名，
        // 由 service host 反向代理回来。默认取本机 DNS 名，可用 --remote-host 覆盖。
        ...(remote !== '' ? { remoteHost: remote } : {}),
      });
    }
  } else {
    process.stdout.write(
      '\n  [提示] 未指定 --service，跳过 Service 级验证。' +
        '在已打 tag 的 service host 上可加 --service svc:<名字>（必要时再配 --remote-host <主机>）。\n',
    );
  }

  // ---- 5. 汇总 ----
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
