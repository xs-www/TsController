/**
 * 后端 JSON API 的类型化客户端。
 *
 * 所有类型都刻意与后端契约逐字对齐（字段名不做任何映射），
 * 这样后端一旦改名，这里会立刻出现编译错误而不是运行期静默失效。
 */

/* ------------------------------------------------------------------ */
/* 领域类型                                                            */
/* ------------------------------------------------------------------ */

export type MappingStatus =
  | 'active'
  | 'pending'
  | 'disabled'
  | 'disabled-drift'
  | 'orphaned-target'
  | 'blocked'
  | 'conflict';

export type TargetKind = 'container' | 'host';

export type MappingCounts = Record<MappingStatus, number>;

/** 指向 serve 中某个具体路由位置（端口 + 路径）。 */
export interface RouteRef {
  servePort: number;
  path: string;
}

export interface PlanSummary {
  upserts: number;
  removals: number;
  blocked: number;
  exposures: number;
  inSync: boolean;
}

export interface Exposure {
  servePort: number;
  path: string;
  proxy: string;
}

export interface MappingTarget {
  kind: TargetKind;
  /** 本机端口。 */
  hostPort: number;
  /** "" 或 "/api/agent"。 */
  targetPath: string;
  containerId?: string;
  containerName?: string;
  containerPort?: number;
}

export interface MappingView {
  id: string;
  /** "/worldforge" */
  path: string;
  /** 对外 HTTPS 端口；443 以外的端口必须体现在链接里。 */
  servePort: number;
  target: MappingTarget;
  note: string;
  enabled: boolean;
  /** 该映射当前在 serve 中占用的全部位置（端口 + 路径）。 */
  ownedRoutes: RouteRef[];
  /** ISO 时间字符串。 */
  createdAt: string;
  /** ISO 时间字符串。 */
  updatedAt: string;
  status: MappingStatus;
  /** 期望写进 serve 的地址，如 "http://127.0.0.1:4173"。 */
  desiredProxy: string;
  /** serve 中当前实际地址，null 表示该位置未被占用。 */
  actualProxy: string | null;
  /** 状态的中文说明，可能为 null。 */
  detail: string | null;
}

export interface ContainerPort {
  /** "127.0.0.1" | "0.0.0.0" | "::" */
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp' | 'sctp';
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** "running" | "exited" | ... */
  state: string;
  /** "Up 3 hours" */
  status: string;
  composeProject: string | null;
  composeService: string | null;
  /** 毫秒时间戳。 */
  createdAt: number;
  ports: ContainerPort[];
}

export interface ExternalRoute {
  servePort: number;
  path: string;
  proxy: string | null;
  hostPort: number | null;
  kind: string;
}

export interface SystemSecurity {
  autoUnexpose: boolean;
  exposures: Exposure[];
  /** true 表示管理端口没有被暴露在 tailnet 中。 */
  safe: boolean;
}

export interface SystemSources {
  docker: string;
  tailscale: string;
  dataDir: string;
  /** serve 路由快照的落盘路径；供其它项目只读挂载。 */
  snapshotFile: string;
}

export interface SystemInfo {
  /** 例如 "https://my-laptop.example-tailnet.ts.net"。 */
  baseUrl: string | null;
  dnsName: string | null;
  tailnetIps: string[];
  hostname: string | null;
  /** 例如 "Running"。 */
  backendState: string | null;
  tailscaleVersion: string | null;
  /** 管理界面地址，例如 "http://127.0.0.1:8787"。 */
  adminUrl: string;
  /** 管理界面端口。 */
  adminPort: number;
  /** 新建映射时的默认对外 HTTPS 端口（通常 443）。 */
  servePort: number;
  /** serve 中已声明的全部 HTTPS 端口，升序。 */
  servePorts: number[];
  /** serve 主机名（不含端口），例如 "my-laptop.example-tailnet.ts.net"。 */
  serveHost: string | null;
  sources: SystemSources;
  security: SystemSecurity;
  plan: PlanSummary;
  counts: MappingCounts;
}

export interface ContainersResponse {
  containers: ContainerInfo[];
  source: string;
}

export interface MappingsResponse {
  mappings: MappingView[];
  externalRoutes: ExternalRoute[];
  planSummary: PlanSummary;
  counts: MappingCounts;
}

export interface ApplyResult {
  /** 本次实际挂载的路由位置（端口 + 路径）。 */
  upserted: RouteRef[];
  /** 本次实际摘除的路由位置。 */
  removed: RouteRef[];
  blocked: Array<{ mappingId: string; path: string; reason: string }>;
  exposures: Exposure[];
  errors: string[];
  inSync: boolean;
}

export interface MappingMutationResponse {
  mapping: MappingView;
  apply: ApplyResult;
}

export interface MappingDeleteResponse {
  removed: MappingView | null;
  apply: ApplyResult;
}

export interface ImportResponse {
  imported: MappingView[];
  skipped: Array<{ servePort: number; path: string; reason: string }>;
}

export interface ProxyHandler {
  kind: 'proxy';
  raw: string;
  hostPort: number | null;
  targetPath: string;
  loopback: boolean;
}

export interface OtherHandler {
  kind: 'file' | 'text' | 'other';
  raw: string;
}

export interface ServeRouteView {
  servePort: number;
  host: string;
  path: string;
  handler: ProxyHandler | OtherHandler;
  managed: boolean;
  mappingId: string | null;
}

export interface ServeRoutesResponse {
  /** serve 主机名（不含端口）。 */
  serveHost: string | null;
  /** serve 中已声明的全部 HTTPS 端口，升序。 */
  httpsPorts: number[];
  routes: ServeRouteView[];
}

export interface AuditEvent {
  at: string;
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface AuditResponse {
  events: AuditEvent[];
}

/** 写操作的入参（创建时 path/hostPort 必填，更新时为部分更新）。 */
export interface MappingInput {
  path?: string;
  hostPort?: number;
  /** 对外 HTTPS 端口；省略即由后端用默认端口。 */
  servePort?: number;
  targetPath?: string;
  kind?: TargetKind;
  containerId?: string;
  containerName?: string;
  containerPort?: number;
  note?: string;
  enabled?: boolean;
  confirmTakeover?: boolean;
}

export interface ApiErrorBody {
  error: string;
  code: string;
}

/** 已知的 409/400 业务错误码（仅用于提示文案，不做强制收窄）。 */
export const KNOWN_ERROR_CODES = [
  'exposes-admin',
  'serve-port-is-admin',
  'duplicate-path',
  'takeover-required',
  'invalid-path',
  'invalid-port',
  'invalid-serve-port',
  'invalid-target-path',
  'not-found',
] as const;

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

/** 错误码 → 中文提示前缀。 */
export const ERROR_CODE_LABEL: Record<string, string> = {
  'exposes-admin': '禁止：目标端口是 TsController 管理端口',
  'serve-port-is-admin': '禁止：对外端口与管理端口同号',
  'duplicate-path': '路径重复',
  'takeover-required': '需要确认接管',
  'invalid-path': '路径非法',
  'invalid-port': '端口非法',
  'invalid-serve-port': '对外端口非法',
  'invalid-target-path': '目标路径非法',
  'not-found': '目标不存在',
  'bad-host': '请求来源非法',
  'forbidden-host': '只接受来自本机的请求',
  'not-found-route': '接口不存在',
};

/* ------------------------------------------------------------------ */
/* ApiError                                                            */
/* ------------------------------------------------------------------ */

/** 后端返回 `{ error, code }` 时抛出的错误；网络/解析失败时 code 为 'network'。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 是否带有某个业务错误码。 */
  is(code: string): boolean {
    return this.code === code;
  }
}

function errorBody(value: unknown): ApiErrorBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec['error'] !== 'string') return null;
  return { error: rec['error'], code: typeof rec['code'] === 'string' ? rec['code'] : 'error' };
}

/** 把任意抛出物转换成用户可读的错误对象。 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiError('请求已取消', 0, 'aborted');
  }
  return new ApiError(err instanceof Error ? err.message : String(err), 0, 'network');
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

/** 默认的同步（非异步）请求体类型。 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(`无法连接管理接口 ${path}：${err instanceof Error ? err.message : String(err)}`, 0, 'network');
  }

  const parsed = await readBody(res);
  if (!res.ok) {
    const parsedError = errorBody(parsed);
    if (parsedError) throw new ApiError(parsedError.error, res.status, parsedError.code);
    throw new ApiError(`请求 ${method} ${path} 失败：HTTP ${res.status}`, res.status, 'http-' + String(res.status));
  }
  return parsed;
}

export interface ApiClient {
  system(signal?: AbortSignal): Promise<SystemInfo>;
  containers(signal?: AbortSignal): Promise<ContainersResponse>;
  mappings(signal?: AbortSignal): Promise<MappingsResponse>;
  serveRoutes(signal?: AbortSignal): Promise<ServeRoutesResponse>;
  audit(limit?: number, signal?: AbortSignal): Promise<AuditResponse>;
  createMapping(input: MappingInput, signal?: AbortSignal): Promise<MappingMutationResponse>;
  updateMapping(id: string, input: MappingInput, signal?: AbortSignal): Promise<MappingMutationResponse>;
  deleteMapping(id: string, signal?: AbortSignal): Promise<MappingDeleteResponse>;
  setEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<MappingMutationResponse>;
  importRoutes(routes?: RouteRef[], signal?: AbortSignal): Promise<ImportResponse>;
  apply(signal?: AbortSignal): Promise<ApplyResult>;
}

export function createApi(base = ''): ApiClient {
  const url = (path: string) => `${base}${path}`;
  return {
    system: (signal) => send('GET', url('/api/system'), undefined, signal) as Promise<SystemInfo>,
    containers: (signal) => send('GET', url('/api/containers'), undefined, signal) as Promise<ContainersResponse>,
    mappings: (signal) => send('GET', url('/api/mappings'), undefined, signal) as Promise<MappingsResponse>,
    serveRoutes: (signal) => send('GET', url('/api/serve/routes'), undefined, signal) as Promise<ServeRoutesResponse>,
    audit: (limit = 50, signal) =>
      send('GET', url(`/api/audit?limit=${String(limit)}`), undefined, signal) as Promise<AuditResponse>,
    createMapping: (input, signal) =>
      send('POST', url('/api/mappings'), input, signal) as Promise<MappingMutationResponse>,
    updateMapping: (id, input, signal) =>
      send('PATCH', url(`/api/mappings/${encodeURIComponent(id)}`), input, signal) as Promise<MappingMutationResponse>,
    deleteMapping: (id, signal) =>
      send('DELETE', url(`/api/mappings/${encodeURIComponent(id)}`), undefined, signal) as Promise<MappingDeleteResponse>,
    setEnabled: (id, enabled, signal) =>
      send('POST', url(`/api/mappings/${encodeURIComponent(id)}/enabled`), { enabled }, signal) as Promise<MappingMutationResponse>,
    importRoutes: (routes, signal) =>
      send('POST', url('/api/mappings/import'), routes === undefined ? {} : { routes }, signal) as Promise<ImportResponse>,
    apply: (signal) => send('POST', url('/api/apply'), {}, signal) as Promise<ApplyResult>,
  };
}

/** 全局默认客户端：所有请求都走同源相对路径，由 Vite proxy 或后端静态服务承接。 */
export const api: ApiClient = createApi();
