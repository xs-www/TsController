/**
 * Docker Engine API 的极简客户端。
 *
 * 直接走 Docker 的本地端点（Windows 命名管道 / Unix socket / TCP），
 * 不依赖 docker CLI，因此不需要解析人类可读输出，也不受 CLI 版本输出变化影响。
 */

import http from 'node:http';
import type { Logger } from '../logger.ts';

/** Docker 的本地传输端点描述。 */
export type DockerEndpoint =
  | { kind: 'npipe'; pipe: string }
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number };

/** Windows 上 Docker Desktop 常见的命名管道候选（Linux 容器 / Windows 容器）。 */
const WINDOWS_PIPE_CANDIDATES = [
  'dockerDesktopLinuxEngine',
  'docker_engine',
  'dockerDesktopWindowsEngine',
];

const POSIX_SOCKET_CANDIDATES = ['/var/run/docker.sock', '/run/docker.sock'];

/** 单次端点探测的超时；探测是并发执行的，因此这个值即整体探测耗时上限。 */
const PROBE_TIMEOUT_MS = 2500;
/** 整体探测失败后的负缓存时长，避免 Docker 未运行时界面每次请求都卡一轮超时。 */
const PROBE_FAILURE_TTL_MS = 5000;

/** 把各种写法的管道名归一化成 Node 可用的 `//./pipe/<name>`。 */
export function normalizePipeName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/^npipe:\/\//i, '');
  name = name.replace(/^\\\\\.\\pipe\\/i, '');
  name = name.replace(/^\/\/\.\/pipe\//i, '');
  name = name.replace(/^\/+/, '');
  name = name.replace(/^\.\/pipe\//i, '');
  return name;
}

/**
 * 解析 `DOCKER_HOST` / 显式配置，得到端点列表（按优先级）。
 *
 * **显式配置是权威的**：一旦给了端点，就不再追加平台默认候选。
 * 否则把 `DOCKER_HOST` 指向远程 Engine 的用户，会在远程不可达时被静默地
 * 回落到本机 Docker Desktop —— 那是最难排查的一类问题。
 */
export function resolveEndpoints(configured: string | null, env: NodeJS.ProcessEnv = process.env): DockerEndpoint[] {
  const out: DockerEndpoint[] = [];
  const push = (ep: DockerEndpoint) => {
    if (!out.some((e) => JSON.stringify(e) === JSON.stringify(ep))) out.push(ep);
  };

  const fromHost = (value: string) => {
    const v = value.trim();
    if (/^npipe:/i.test(v)) {
      push({ kind: 'npipe', pipe: normalizePipeName(v) });
    } else if (/^unix:/i.test(v)) {
      push({ kind: 'unix', socketPath: v.replace(/^unix:\/\//i, '').replace(/^unix:/i, '') });
    } else if (/^tcp:|^https?:/i.test(v)) {
      try {
        const url = new URL(v.replace(/^tcp:/i, 'http:'));
        push({ kind: 'tcp', host: url.hostname, port: Number(url.port || 2375) });
      } catch {
        /* 忽略无法解析的 DOCKER_HOST */
      }
    } else {
      push({ kind: 'npipe', pipe: normalizePipeName(v) });
    }
  };

  if (configured) fromHost(configured);
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost) fromHost(dockerHost);
  if (out.length > 0) return out;

  if (process.platform === 'win32') {
    for (const p of WINDOWS_PIPE_CANDIDATES) push({ kind: 'npipe', pipe: p });
  } else {
    for (const s of POSIX_SOCKET_CANDIDATES) push({ kind: 'unix', socketPath: s });
  }
  return out;
}

/** 人类可读的端点描述。 */
export function describeEndpoint(ep: DockerEndpoint): string {
  switch (ep.kind) {
    case 'npipe':
      return `npipe:\\\\.\\pipe\\${ep.pipe}`;
    case 'unix':
      return `unix:${ep.socketPath}`;
    case 'tcp':
      return `tcp:${ep.host}:${ep.port}`;
  }
}

export interface DockerRequestOptions {
  method?: string;
  timeoutMs?: number;
}

/** 底层请求执行器，供真实实现与测试中的假实现共同遵循。 */
export interface DockerTransport {
  /** 发起一次 Engine API 请求并返回解析后的 JSON。 */
  request<T>(path: string, options?: DockerRequestOptions): Promise<T>;
  /** 当前实际使用的端点描述，用于界面展示。 */
  endpoint(): string;
}

export class DockerApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'DockerApiError';
    this.status = status;
  }
}

function rawRequest(
  ep: DockerEndpoint,
  path: string,
  options: DockerRequestOptions,
): Promise<{ status: number; body: string }> {
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    const socketOptions: http.RequestOptions =
      ep.kind === 'npipe'
        ? { socketPath: `//./pipe/${ep.pipe}` }
        : ep.kind === 'unix'
          ? { socketPath: ep.socketPath }
          : { host: ep.host, port: ep.port };

    const req = http.request(
      {
        ...socketOptions,
        path,
        method: options.method ?? 'GET',
        headers: { Host: 'localhost', Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new DockerApiError(`Docker 请求超时（${timeoutMs}ms）：${path}`)));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * 真实 Docker 客户端。
 *
 * 端点解析是惰性的：第一次成功请求的端点会被缓存，后续复用；
 * 失败时会重新探测候选端点，兼容 Docker Desktop 的重启与引擎切换。
 */
export class DockerEngineClient implements DockerTransport {
  readonly #logger: Logger;
  #resolved: DockerEndpoint | null = null;
  readonly #endpoints: DockerEndpoint[];
  /** 上次整体探测失败的原因与时刻，用于负缓存。 */
  #probeFailure: { at: number; error: DockerApiError } | null = null;

  constructor(configured: string | null, logger: Logger, env: NodeJS.ProcessEnv = process.env) {
    this.#logger = logger;
    this.#endpoints = resolveEndpoints(configured, env);
  }

  endpoint(): string {
    return this.#resolved ? describeEndpoint(this.#resolved) : '(未连接)';
  }

  /**
   * 并发探测所有候选端点，取**最先响应**的成功者。
   *
   * 并发而非串行：Windows 上 Docker Desktop 的「Windows 容器引擎」管道常常存在
   * 但不响应，串行探测会被它单独拖满超时。失败结果做 5 秒负缓存，避免 Docker
   * 未运行时界面的每次请求都要等一轮超时。
   */
  async #probe(): Promise<DockerEndpoint> {
    if (this.#probeFailure && Date.now() - this.#probeFailure.at < PROBE_FAILURE_TTL_MS) {
      throw this.#probeFailure.error;
    }

    const failures: string[] = [];

    return new Promise<DockerEndpoint>((resolve, reject) => {
      let pending = this.#endpoints.length;
      let settled = false;

      const fail = (endpoint: DockerEndpoint, reason: unknown): void => {
        failures.push(`${describeEndpoint(endpoint)} → ${(reason as Error).message}`);
        pending -= 1;
        if (pending === 0 && !settled) {
          settled = true;
          const error = new DockerApiError(
            `无法连接 Docker Engine。已尝试：${failures.join('; ')}。` +
              `请确认 Docker Desktop 正在运行，或用 TSCONTROLLER_DOCKER_PIPE / DOCKER_HOST 指定端点。`,
          );
          this.#probeFailure = { at: Date.now(), error };
          reject(error);
        }
      };

      for (const endpoint of this.#endpoints) {
        rawRequest(endpoint, '/version', { timeoutMs: PROBE_TIMEOUT_MS }).then(
          (res) => {
            if (settled) return;
            if (res.status !== 200) {
              fail(endpoint, new Error(`HTTP ${res.status}`));
              return;
            }
            settled = true;
            this.#resolved = endpoint;
            this.#probeFailure = null;
            this.#logger.info('Docker 端点已连接', { endpoint: describeEndpoint(endpoint) });
            resolve(endpoint);
          },
          (err: unknown) => {
            if (settled) return;
            fail(endpoint, err);
          },
        );
      }

      if (pending === 0) {
        settled = true;
        reject(new DockerApiError('没有可用的 Docker 端点候选。'));
      }
    });
  }

  async request<T>(path: string, options: DockerRequestOptions = {}): Promise<T> {
    let ep = this.#resolved ?? (await this.#probe());
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await rawRequest(ep, path, options);
        if (res.status >= 400) {
          throw new DockerApiError(`Docker API ${path} 返回 HTTP ${res.status}: ${res.body.slice(0, 300)}`, res.status);
        }
        return (res.body === '' ? undefined : JSON.parse(res.body)) as T;
      } catch (err) {
        lastError = err as Error;
        // HTTP 状态码是业务错误，重探测没有意义；传输错误才值得重试。
        if (err instanceof DockerApiError && err.status !== null) break;
        this.#logger.warn('Docker 请求失败，重新探测端点', { path, error: (err as Error).message });
        this.#resolved = null;
        ep = await this.#probe();
      }
    }
    throw lastError ?? new DockerApiError(`Docker API ${path} 请求失败`);
  }
}
