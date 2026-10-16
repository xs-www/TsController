/**
 * 运行配置。全部来自环境变量，缺省值面向「Windows 本机常驻小工具」。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHost } from './domain/route-path.ts';

/**
 * 项目根目录。
 *
 * 锚定在源码位置而不是 `process.cwd()`：本工具会被注册为计划任务/服务启动，
 * 那时的工作目录往往是 `C:\Windows\System32`，用相对路径会指向错误的位置。
 */
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export interface AppConfig {
  /** 管理界面监听地址。**强制限定为本机回环地址**。 */
  host: string;
  /** 管理界面端口。 */
  port: number;
  /** 持久化目录（映射库、审计日志）。 */
  dataDir: string;
  /** tailscale 可执行文件路径。 */
  tailscaleBin: string;
  /** Docker 命名管道；null 表示自动探测。 */
  dockerPipe: string | null;
  /** 对外展示用的 serve HTTPS 端口。 */
  servePort: number;
  /**
   * 启动与每次应用前，是否自动摘除指向管理端口的 serve 路由。
   *
   * 关闭该项只影响「自动修复」，检测与告警始终生效。
   */
  autoUnexpose: boolean;
  /**
   * serve 路由快照的落盘目录。
   *
   * 默认放在 `<DATA_DIR>/public` 而不是 `<DATA_DIR>` 根下：消费方（其它容器）
   * 只需只读挂载这一个目录，不必把 `mappings.json`、`audit.jsonl` 一起暴露。
   */
  snapshotDir: string;
  /**
   * 快照定期刷新间隔（毫秒）。0 表示只在启动与每次收敛后写。
   *
   * 定期的意义：用户手工执行 `tailscale serve` 改了配置时，快照仍会被纠正回来。
   */
  snapshotIntervalMs: number;
  /** 前端构建产物目录；不存在时后端只提供 API。 */
  webRoot: string;
}

const DEFAULT_TAILSCALE_BIN =
  process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min}-${max} 之间的整数，当前为 ${JSON.stringify(raw)}`);
  }
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`环境变量 ${name} 必须是布尔值，当前为 ${JSON.stringify(raw)}`);
}

function readStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/**
 * 读取并校验配置。
 *
 * 关键安全约束：`TSCONTROLLER_HOST` 只允许回环地址。这不是可配置的策略，
 * 而是本应用的硬性需求——管理面一旦监听在 tailscale 接口或 0.0.0.0 上，
 * 就等于把「查看/改写整机路由」的能力暴露给了整个 tailnet。
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const host = overrides.host ?? readStr('TSCONTROLLER_HOST', '127.0.0.1');
  if (!isLoopbackHost(host)) {
    throw new Error(
      `TSCONTROLLER_HOST=${host} 被拒绝：管理界面只允许监听本机回环地址（127.0.0.1 / ::1 / localhost）。` +
        `本应用禁止暴露在 tailnet 中。`,
    );
  }

  const dataDir =
    overrides.dataDir ??
    (process.env.TSCONTROLLER_DATA_DIR && process.env.TSCONTROLLER_DATA_DIR.trim() !== ''
      ? path.resolve(process.env.TSCONTROLLER_DATA_DIR.trim())
      : path.join(PROJECT_ROOT, 'data'));
  const config: AppConfig = {
    host,
    port: overrides.port ?? readInt('TSCONTROLLER_PORT', 8787, 1, 65535),
    dataDir,
    tailscaleBin: overrides.tailscaleBin ?? readStr('TSCONTROLLER_TAILSCALE_BIN', DEFAULT_TAILSCALE_BIN),
    dockerPipe: overrides.dockerPipe ?? (readStr('TSCONTROLLER_DOCKER_PIPE', '') || null),
    servePort: overrides.servePort ?? readInt('TSCONTROLLER_SERVE_PORT', 443, 1, 65535),
    autoUnexpose: overrides.autoUnexpose ?? readBool('TSCONTROLLER_AUTO_UNEXPOSE', true),
    // 与其他路径型配置一致：显式环境变量按 cwd 解析；未给出则锚定到 <DATA_DIR>/public。
    snapshotDir:
      overrides.snapshotDir ??
      (process.env.TSCONTROLLER_SNAPSHOT_DIR && process.env.TSCONTROLLER_SNAPSHOT_DIR.trim() !== ''
        ? path.resolve(process.env.TSCONTROLLER_SNAPSHOT_DIR.trim())
        : path.join(dataDir, 'public')),
    snapshotIntervalMs:
      overrides.snapshotIntervalMs ?? readInt('TSCONTROLLER_SNAPSHOT_INTERVAL_MS', 60_000, 0, 86_400_000),
    webRoot:
      overrides.webRoot ??
      (process.env.TSCONTROLLER_WEB_ROOT && process.env.TSCONTROLLER_WEB_ROOT.trim() !== ''
        ? path.resolve(process.env.TSCONTROLLER_WEB_ROOT.trim())
        : path.join(PROJECT_ROOT, 'web', 'dist')),
  };
  return config;
}
