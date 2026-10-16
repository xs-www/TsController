/**
 * tailscale CLI 的薄封装。
 *
 * 之所以走 CLI 而不是直连 localapi：Windows 上 tailscaled 的命名管道位于
 * `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`，直连需要管理员权限，
 * 而 tailscale.exe 自身已经处理了与服务端的鉴权。
 */

import { execFile } from 'node:child_process';
import type { Logger } from '../logger.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 命令执行器抽象，便于在测试中注入假实现。 */
export interface CommandRunner {
  run(bin: string, args: string[], timeoutMs?: number): Promise<RunResult>;
}

export class TailscaleError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(message: string, args: string[], stderr: string) {
    super(message);
    this.name = 'TailscaleError';
    this.args = args;
    this.stderr = stderr;
  }
}

/** 真实执行器：直接 spawn 进程，不经过 shell。 */
export class ExecFileRunner implements CommandRunner {
  run(bin: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && typeof (err as { code?: unknown }).code === 'string') {
            // ENOENT 之类的启动失败：交给调用方转成可读错误。
            reject(err);
            return;
          }
          const code = err ? ((err as { code?: unknown }).code as number ?? 1) : 0;
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  }
}

/** 把 CLI 的小写错误信息翻译成中文可读提示。 */
function explain(args: string[], stderr: string): string {
  const text = stderr.toLowerCase();
  if (text.includes('access is denied')) {
    return '访问被拒绝：tailscale 需要与已登录用户相同的会话，或需要管理员权限。';
  }
  if (text.includes('not running') || text.includes('failed to connect to local tailscaled')) {
    return 'tailscaled 未运行或未登录，请先启动 Tailscale。';
  }
  if (text.includes('serve is not enabled') || text.includes('https is not enabled')) {
    return '该 tailnet 未启用 HTTPS 证书，请在 Tailscale 管理后台开启 HTTPS Certificates。';
  }
  if (text.includes('tagged node') || text.includes('must be tagged')) {
    return (
      'Service host 必须使用 tag 身份。本节点当前是用户账号拥有的设备，' +
      '因此无法承载 Tailscale Service——请改用一台已打 tag 的设备（例如 NAS）作为 service host。'
    );
  }
  if (text.includes('unknown flag') || text.includes('unknown subcommand')) {
    return `当前 tailscale 版本不支持该命令（${args.join(' ')}），请升级 Tailscale 客户端。`;
  }
  return `tailscale ${args.join(' ')} 执行失败（退出码非 0）。`;
}

/**
 * tailscale CLI 客户端。
 *
 * 所有写操作都使用 `--yes` 以避免交互式确认把常驻进程挂死。
 *
 * **Service 与节点级是两套命名空间**：`--service=svc:x` 的命令只作用于该
 * Service 的配置组，与节点级的 `Web`/`TCP` 配置互不影响。
 */
export class TailscaleCli {
  readonly #bin: string;
  readonly #runner: CommandRunner;
  readonly #logger: Logger;

  constructor(bin: string, runner: CommandRunner, logger: Logger) {
    this.#bin = bin;
    this.#runner = runner;
    this.#logger = logger;
  }

  get bin(): string {
    return this.#bin;
  }

  async #run(args: string[], timeoutMs?: number): Promise<RunResult> {
    try {
      return await this.#runner.run(this.#bin, args, timeoutMs);
    } catch (err) {
      throw new TailscaleError(
        `无法执行 ${this.#bin}：${(err as Error).message}。请用 TSCONTROLLER_TAILSCALE_BIN 指定 tailscale 可执行文件路径。`,
        args,
        '',
      );
    }
  }

  /** 执行并返回 stdout，非 0 退出抛错。 */
  async #runOrThrow(args: string[], timeoutMs?: number): Promise<string> {
    const res = await this.#run(args, timeoutMs);
    if (res.code !== 0) {
      throw new TailscaleError(explain(args, res.stderr), args, res.stderr.trim());
    }
    return res.stdout;
  }

  /** `tailscale status --json`。 */
  async statusJson(): Promise<unknown> {
    const out = await this.#runOrThrow(['status', '--json']);
    try {
      return JSON.parse(out);
    } catch {
      throw new TailscaleError('tailscale status --json 返回了无法解析的 JSON。', ['status', '--json'], out.slice(0, 200));
    }
  }

  /**
   * `tailscale serve status --json`；无 serve 配置时 tailscale 输出 `{}`。
   *
   * **只包含节点级路由**，Service 端点要用 `serveGetConfig()` 读。
   */
  async serveStatusJson(): Promise<unknown> {
    const out = await this.#runOrThrow(['serve', 'status', '--json']);
    return this.#parseJson(out, ['serve', 'status', '--json']);
  }

  /**
   * `tailscale serve get-config --all`：本节点作为 Service host 的端点配置。
   *
   * 空输出（或 `{}`）归一化为 `{}` —— 本节点不是任何 Service 的 host 时
   * tailscale 会打印 `{}`，那是正常状态而不是错误。
   */
  async serveGetConfig(): Promise<unknown> {
    const out = await this.#runOrThrow(['serve', 'get-config', '--all']);
    return this.#parseJson(out, ['serve', 'get-config', '--all']);
  }

  #parseJson(out: string, args: string[]): unknown {
    const trimmed = out.trim();
    if (trimmed === '') return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new TailscaleError(
        `tailscale ${args.join(' ')} 返回了无法解析的 JSON。`,
        args,
        trimmed.slice(0, 200),
      );
    }
  }

  /**
   * 挂载或覆盖一条路径（节点级或 Service 级）。
   *
   * 参数顺序有要求：所有 flag 必须位于目标之前。
   * `--https=<port>` 是明确给出而不是依赖默认——serve 的每个 HTTPS 端口是一个
   * 独立的配置组，省略端口会落到 443 组，从而改错路由。
   *
   * `--service=svc:x` 也必须在端口 flag 之前（官方示例与 CLI 解析均如此）。
   */
  async serveUpsert(servePort: number, path: string, proxyUrl: string, service?: string | null): Promise<void> {
    this.#logger.info('tailscale serve 挂载', { service: service ?? null, servePort, path, proxyUrl });
    await this.#runOrThrow([
      'serve',
      '--bg',
      '--yes',
      ...(service ? [`--service=${service}`] : []),
      `--https=${servePort}`,
      `--set-path=${path}`,
      proxyUrl,
    ]);
  }

  /** 摘除指定端口上的一条路径；不影响该端口或其它端口上的其它路径。 */
  async serveRemove(servePort: number, path: string, service?: string | null): Promise<void> {
    this.#logger.info('tailscale serve 摘除', { service: service ?? null, servePort, path });
    await this.#runOrThrow([
      'serve',
      '--yes',
      ...(service ? [`--service=${service}`] : []),
      `--https=${servePort}`,
      `--set-path=${path}`,
      'off',
    ]);
  }

  /**
   * `tailscale serve clear svc:<name>`：摘除该 Service 在本节点上的**全部**端点配置。
   *
   * 只在删除「最后一条属于该 Service 的映射」且打开自动清理时使用；
   * 注意它同时会停止 advertise，且该命令**不支持** `--yes`（没有交互确认）。
   */
  async serveClear(service: string): Promise<void> {
    this.#logger.info('tailscale serve 清除 Service 配置', { service });
    await this.#runOrThrow(['serve', 'clear', service]);
  }
}
