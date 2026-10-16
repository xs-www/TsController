/** 未托管路由面板：接管用户此前手工用 `tailscale serve` 配置的路由。 */
import { useState, type JSX } from 'react';
import type { ExternalRoute, ImportResponse, RouteRef } from '../api';
import type { ApiResult } from './MappingPanel';
import { formatRouteLabel } from '../utils';

export interface ExternalRoutesPanelProps {
  routes: ExternalRoute[];
  loading: boolean;
  busy: boolean;
  importRoutes: (routes?: RouteRef[]) => Promise<ApiResult<ImportResponse>>;
  onNotify: (level: 'info' | 'success' | 'warn' | 'error', title: string, message?: string) => void;
}

/** 路由位置的稳定键，用于「接管中」状态与 React key。 */
function routeKey(r: { servePort: number; path: string }): string {
  return `${r.servePort}|${r.path}`;
}

export function ExternalRoutesPanel({
  routes,
  loading,
  busy,
  importRoutes,
  onNotify,
}: ExternalRoutesPanelProps): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);

  const takeover = (route: ExternalRoute): void => {
    setPending(routeKey(route));
    void importRoutes([{ servePort: route.servePort, path: route.path }])
      .then((result) => {
        if (result.data !== undefined) {
          const ok = result.data.imported;
          const skipped = result.data.skipped;
          if (ok.length > 0) {
            onNotify(
              'success',
              '已接管路由',
              `${ok.map((m) => formatRouteLabel(m.servePort, m.path)).join(', ')} → 127.0.0.1:${String(ok[0]?.target.hostPort ?? '')}`,
            );
          } else {
            onNotify(
              'warn',
              '未能接管该路由',
              skipped.map((s) => `${formatRouteLabel(s.servePort, s.path)}：${s.reason}`).join('；') || '原因未知',
            );
          }
        }
      })
      .finally(() => {
        setPending(null);
      });
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>未托管路由</h2>
        <span className="panel-meta">
          共 {routes.length} 条 · 这些是 serve 中已存在、但 TsController 还不认识的路由
        </span>
      </header>

      {routes.length === 0 ? (
        <p className="empty">
          {loading
            ? '正在读取 serve 配置…'
            : '没有未托管的路由。serve 中的每条路径都由 TsController 管理，或当前没有任何路由。'}
        </p>
      ) : (
        <table className="simple-table">
          <thead>
            <tr>
              <th>端口</th>
              <th>路径</th>
              <th>代理目标</th>
              <th>handler 类型</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={`${routeKey(r)}|${r.proxy ?? r.kind}`}>
                <td className="mono">{String(r.servePort)}</td>
                <td className="mono">{r.path}</td>
                <td className="mono">{r.proxy ?? <span className="muted">（非代理 handler）</span>}</td>
                <td>
                  <span className="pill pill-grey">{r.kind}</span>
                  {r.hostPort === null ? null : (
                    <span className="muted small mono"> :{String(r.hostPort)}</span>
                  )}
                </td>
                <td className="col-actions">
                  <button
                    type="button"
                    className="btn btn-mini btn-primary"
                    disabled={busy || pending !== null || r.proxy === null}
                    title={
                      r.proxy === null
                        ? '非本机代理路由无法接管'
                        : '把这条路由写入映射库，之后由 TsController 管理'
                    }
                    onClick={() => {
                      takeover(r);
                    }}
                  >
                    {pending === routeKey(r) ? '接管中…' : '接管'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
