/**
 * 管理界面根组件。
 *
 * 职责：
 * 1. 统一拉取 system / containers / mappings 三个数据切片，并用「请求序号」防止竞态；
 * 2. 把 API 错误统一转成顶部 toast（含 `{ error, code }`）；
 * 3. 把 ApplyResult 的 upserted / removed / blocked / errors 逐条反馈给用户。
 *
 * 界面本身只监听回环地址（由后端保证），这里所有请求都走同源相对路径。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ApiError, ERROR_CODE_LABEL, api, toApiError } from './api';
import type {
  ApplyResult,
  AuditEvent,
  ContainerInfo,
  ImportResponse,
  MappingDeleteResponse,
  MappingInput,
  MappingsResponse,
  MappingMutationResponse,
  RouteRef,
  ServeRouteView,
  SystemInfo,
} from './api';
import { formatRouteLabel } from './utils';
import { SecurityBanner } from './components/SecurityBanner';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { ContainerPanel } from './components/ContainerPanel';
import { MappingPanel } from './components/MappingPanel';
import type { ApiResult } from './components/MappingPanel';
import { ExternalRoutesPanel } from './components/ExternalRoutesPanel';
import { ToastStack } from './components/Toast';
import type { ToastDetailItem, ToastItem, ToastLevel } from './components/Toast';
import './styles.css';

/** 数据切片标识。 */
type Slice = 'system' | 'containers' | 'mappings' | 'serve' | 'audit';

/** 管理端口的兜底占位值（system 尚未加载时使用；真实值一定来自后端）。 */
const ADMIN_PORT_FALLBACK = 8787;

/** 单个面板的数据载荷。 */
interface Payload {
  system: SystemInfo;
  containers: { containers: ContainerInfo[]; source: string };
  mappings: MappingsResponse;
  serve: { serveHost: string | null; httpsPorts: number[]; routes: ServeRouteView[] };
  audit: { events: AuditEvent[] };
}

let toastSeq = 0;

export function App(): JSX.Element {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [mappings, setMappings] = useState<MappingsResponse | null>(null);
  const [serveRoutes, setServeRoutes] = useState<ServeRouteView[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  /** 每次采集递增；旧请求回来后发现序号已过期就直接丢弃。 */
  const seqRef = useRef(0);
  /** 当前在途请求的 AbortController，挂载时创建、卸载时取消。 */
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  /* ------------------------------ toast ------------------------------ */

  const dismissToast = useCallback((id: number): void => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (level: ToastLevel, title: string, message?: string, code?: string, details?: ToastDetailItem[]): void => {
      const id = ++toastSeq;
      const item: ToastItem = {
        id,
        level,
        title,
        ...(message !== undefined && message !== '' ? { message } : {}),
        ...(code !== undefined && code !== '' ? { code } : {}),
        ...(details !== undefined && details.length > 0 ? { details } : {}),
      };
      setToasts((prev) => [item, ...prev].slice(0, 6));
      // error 常驻（需要用户处理），其余 8 秒后自动消失。
      if (level !== 'error') {
        const timer = setTimeout(() => {
          timersRef.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 8000);
        timersRef.current.set(id, timer);
      }
    },
    [],
  );

  const notify = useCallback(
    (level: ToastLevel, title: string, message?: string): void => {
      pushToast(level, title, message);
    },
    [pushToast],
  );

  const notifyError = useCallback(
    (title: string, err: unknown): void => {
      const apiErr: ApiError = toApiError(err);
      if (apiErr.is('aborted')) return;
      const label = ERROR_CODE_LABEL[apiErr.code];
      const message = label !== undefined ? `${label}｜${apiErr.message}` : apiErr.message;
      if (apiErr.status >= 500 || apiErr.code === 'network') {
        pushToast('error', title, message, apiErr.code);
      } else {
        pushToast('warn', title, message, apiErr.code);
      }
    },
    [pushToast],
  );

  /* --------------------------- ApplyResult --------------------------- */

  const reportApply = useCallback(
    (apply: ApplyResult, options?: { successTitle?: string; failureTitle?: string }): void => {
      const details: ToastDetailItem[] = [];
      for (const r of apply.upserted) details.push({ text: `已挂载 ${formatRouteLabel(r.servePort, r.path)}`, kind: 'ok' });
      for (const r of apply.removed) details.push({ text: `已摘除 ${formatRouteLabel(r.servePort, r.path)}`, kind: 'ok' });
      for (const b of apply.blocked) details.push({ text: `被阻止 ${b.path}：${b.reason}`, kind: 'bad' });
      for (const e of apply.exposures)
        details.push({ text: `管理端口暴露 ${formatRouteLabel(e.servePort, e.path)} → ${e.proxy}`, kind: 'bad' });
      for (const e of apply.errors) details.push({ text: `错误：${e}`, kind: 'bad' });

      const bad = apply.errors.length > 0 || apply.blocked.length > 0 || apply.exposures.length > 0;
      if (apply.inSync && !bad) {
        const title = options?.successTitle ?? '已同步';
        const message =
          apply.upserted.length + apply.removed.length === 0
            ? 'serve 配置本来就是最新的，无需改动。'
            : `挂载 ${String(apply.upserted.length)} 条，摘除 ${String(apply.removed.length)} 条。`;
        pushToast('success', title, message, undefined, details);
        return;
      }
      pushToast(
        'error',
        options?.failureTitle ?? '同步未完成',
        apply.inSync ? '配置已收敛，但仍有需要注意的条目：' : '以下条目未能收敛到期望状态：',
        undefined,
        details,
      );
    },
    [pushToast],
  );

  /* ---------------------------- 数据采集 ---------------------------- */

  const loadSlice = useCallback(
    <K extends Slice>(slice: K, seq: number, signal: AbortSignal): Promise<Payload[K] | null> => {
      const request: Promise<Payload[K]> =
        slice === 'system'
          ? (api.system(signal) as Promise<Payload[K]>)
          : slice === 'containers'
            ? (api.containers(signal) as Promise<Payload[K]>)
            : slice === 'mappings'
              ? (api.mappings(signal) as Promise<Payload[K]>)
              : slice === 'serve'
                ? (api.serveRoutes(signal) as Promise<Payload[K]>)
                : (api.audit(50, signal) as Promise<Payload[K]>);
      return request
        .then((data) => {
          if (seq !== seqRef.current) return null;
          if (slice === 'system') setSystem(data as SystemInfo);
          else if (slice === 'containers') setContainers((data as Payload['containers']).containers);
          else if (slice === 'mappings') setMappings(data as MappingsResponse);
          else if (slice === 'serve') setServeRoutes((data as Payload['serve']).routes);
          else setAudit((data as Payload['audit']).events);
          return data;
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return null;
          if (seq !== seqRef.current) return null;
          notifyError(`${slice === 'system' ? '系统信息' : slice === 'containers' ? '容器清单' : slice === 'mappings' ? '映射列表' : slice === 'serve' ? 'serve 路由' : '审计日志'}读取失败`, err);
          return null;
        });
    },
    [notifyError],
  );

  /**
   * 重新拉取 system / containers / mappings（并顺带刷新 serve 路由与审计）。
   *
   * 用「请求序号」而不是 abort 上一次请求来防竞态：旧请求回来时序号已过期，
   * 结果会被直接丢弃；AbortController 只负责在组件卸载时取消在途请求。
   */
  const refreshAll = useCallback((): void => {
    const controller = abortRef.current;
    if (controller === null) return;
    const seq = ++seqRef.current;
    setBusy(true);
    const slices: Slice[] = ['system', 'containers', 'mappings', 'serve', 'audit'];
    void Promise.all(slices.map((s) => loadSlice(s, seq, controller.signal))).then(() => {
      if (seq !== seqRef.current) return;
      setBusy(false);
      setLoadedOnce(true);
      setLastUpdated(new Date().toISOString());
    });
  }, [loadSlice]);

  useEffect(() => {
    // React 19 StrictMode 会挂载两次：每次挂载都换一个新 controller，句柄存在实例上，
    // 这样第一次挂载的 cleanup 不会误伤第二次挂载发出的请求。
    const controller = new AbortController();
    abortRef.current = controller;
    refreshAll();
    return () => {
      controller.abort();
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, [refreshAll]);

  /* ------------------------------ 写操作 ------------------------------ */

  /** 包一层 busy 状态 + 错误转换；`data` 为空表示失败，`code` 供调用方做接管确认。 */
  const mutate = useCallback(
    async <T,>(title: string, run: () => Promise<T>): Promise<ApiResult<T>> => {
      setBusy(true);
      try {
        const data = await run();
        refreshAll();
        return { data };
      } catch (err) {
        const apiErr = toApiError(err);
        notifyError(title, err);
        return { code: apiErr.code, message: apiErr.message };
      } finally {
        setBusy(false);
      }
    },
    [notifyError, refreshAll],
  );

  const createMapping = useCallback(
    (input: MappingInput): Promise<ApiResult<MappingMutationResponse>> =>
      mutate('创建映射失败', () => api.createMapping(input)),
    [mutate],
  );

  const updateMapping = useCallback(
    (id: string, input: MappingInput): Promise<ApiResult<MappingMutationResponse>> =>
      mutate('更新映射失败', () => api.updateMapping(id, input)),
    [mutate],
  );

  const deleteMapping = useCallback(
    (id: string): Promise<ApiResult<MappingDeleteResponse>> => mutate('删除映射失败', () => api.deleteMapping(id)),
    [mutate],
  );

  const setEnabled = useCallback(
    (id: string, enabled: boolean): Promise<ApiResult<MappingMutationResponse>> =>
      mutate(enabled ? '启用映射失败' : '禁用映射失败', () => api.setEnabled(id, enabled)),
    [mutate],
  );

  const importRoutes = useCallback(
    (routes?: RouteRef[]): Promise<ApiResult<ImportResponse>> => mutate('接管路由失败', () => api.importRoutes(routes)),
    [mutate],
  );

  const applyNow = useCallback((): void => {
    setSyncing(true);
    void api
      .apply()
      .then((result) => {
        reportApply(result);
        refreshAll();
      })
      .catch((err: unknown) => {
        notifyError('重新同步失败', err);
      })
      .finally(() => {
        setSyncing(false);
      });
  }, [notifyError, refreshAll, reportApply]);

  const handleCopied = useCallback(
    (ok: boolean, label: string, value: string): void => {
      if (ok) pushToast('info', `已复制${label}`, value);
      else pushToast('warn', '复制失败', `浏览器拒绝了剪贴板访问，请手动复制：${value}`);
    },
    [pushToast],
  );

  /* ------------------------------ 派生值 ------------------------------ */

  const managedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of mappings?.mappings ?? []) {
      for (const r of [...m.ownedRoutes, { servePort: m.servePort, path: m.path }]) {
        keys.add(`${r.servePort}|${r.path.toLowerCase()}`);
      }
    }
    return keys;
  }, [mappings]);

  const serveRows = useMemo(
    () =>
      serveRoutes.map((r) => ({
        route: r,
        proxy: r.handler.kind === 'proxy' ? r.handler.raw : null,
        hostPort: r.handler.kind === 'proxy' ? r.handler.hostPort : null,
        kind: r.handler.kind,
      })),
    [serveRoutes],
  );

  const adminPort = system?.adminPort ?? ADMIN_PORT_FALLBACK;
  const planSummary = mappings?.planSummary ?? system?.plan ?? null;
  const showSkeleton = !loadedOnce && system === null;

  return (
    <div className="app">
      <TopBar system={system} loading={busy} lastUpdated={lastUpdated} onCopied={handleCopied} />

      <main className="main">
        <Toolbar
          plan={planSummary}
          loading={busy}
          applying={syncing}
          adminUrl={system?.adminUrl ?? null}
          onRefresh={refreshAll}
          onApply={applyNow}
        />

        <SecurityBanner system={system} onCopied={handleCopied} />

        {showSkeleton ? <p className="empty">正在读取系统状态…</p> : null}

        <ContainerPanel
          containers={containers}
          loading={busy}
          adminPort={adminPort}
          defaultServePort={system?.servePort ?? 443}
          busy={busy}
          createMapping={createMapping}
          onNotify={notify}
        />

        <MappingPanel
          mappings={mappings?.mappings ?? []}
          counts={mappings?.counts ?? null}
          planSummary={planSummary}
          loading={busy}
          adminPort={adminPort}
          serveHost={system?.serveHost ?? null}
          busy={busy}
          updateMapping={updateMapping}
          deleteMapping={deleteMapping}
          setEnabled={setEnabled}
          onNotify={notify}
          onCopied={handleCopied}
        />

        <ExternalRoutesPanel
          routes={mappings?.externalRoutes ?? []}
          loading={busy}
          busy={busy}
          importRoutes={importRoutes}
          onNotify={notify}
        />

        <section className="panel">
          <header className="panel-head">
            <h2>serve 路由（只读）</h2>
            <span className="panel-meta">
              {system?.serveHost ?? '无 Web 服务'}
              {system && system.servePorts.length > 0 ? ` · HTTPS ${system.servePorts.join(', ')}` : ''} · 共{' '}
              {String(serveRows.length)} 条
            </span>
          </header>
          {serveRows.length === 0 ? (
            <p className="empty">serve 中当前没有任何路由。</p>
          ) : (
            <table className="simple-table">
              <thead>
                <tr>
                  <th>端口</th>
                  <th>路径</th>
                  <th>handler</th>
                  <th>宿主端口</th>
                  <th>归属</th>
                </tr>
              </thead>
              <tbody>
                {serveRows.map((r) => (
                  <tr key={`${r.route.servePort}|${r.route.path}`}>
                    <td className="mono">{String(r.route.servePort)}</td>
                    <td className="mono">{r.route.path}</td>
                    <td className="mono small">{r.proxy ?? r.kind}</td>
                    <td className="mono">{r.hostPort === null ? '—' : String(r.hostPort)}</td>
                    <td>
                      {r.route.managed ? (
                        <span className="pill pill-green">已托管</span>
                      ) : (
                        <span className="pill pill-yellow">未托管</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>审计日志</h2>
            <span className="panel-meta">最近 {String(audit.length)} 条</span>
          </header>
          {audit.length === 0 ? (
            <p className="empty">还没有审计事件。</p>
          ) : (
            <ul className="audit-list">
              {audit.map((e, i) => (
                <li key={`${e.at}-${String(i)}`}>
                  <span className="muted small mono">{new Date(e.at).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span className={`pill ${e.kind.startsWith('exposure') ? 'pill-red' : 'pill-grey'}`}>{e.kind}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="footer">
          <span className="muted small">
            已托管路由 {managedKeys.size} 条 · 管理端口 {String(adminPort)} · 界面只监听本机回环地址，不会暴露在 tailnet 中
          </span>
        </footer>
      </main>

      <ToastStack
        items={toasts}
        onDismiss={dismissToast}
        onClear={() => {
          for (const timer of timersRef.current.values()) clearTimeout(timer);
          timersRef.current.clear();
          setToasts([]);
        }}
      />
    </div>
  );
}
