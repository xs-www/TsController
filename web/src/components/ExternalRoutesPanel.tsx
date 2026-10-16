/** 未托管路由面板：接管用户此前手工用 `tailscale serve` 配置的路由。 */
import { useState, type JSX } from 'react';
import type { ExternalRoute, ImportResponse, RouteRef } from '../api';
import type { ApiResult } from './MappingPanel';
import { formatRouteLabel, formatTarget, serviceShortName } from '../utils';

export interface ExternalRoutesPanelProps {
  routes: ExternalRoute[];
  loading: boolean;
  busy: boolean;
  importRoutes: (routes?: RouteRef[]) => Promise<ApiResult<ImportResponse>>;
  onNotify: (level: 'info' | 'success' | 'warn' | 'error', title: string, message?: string) => void;
}

/**
 * 从 Service 配置读出的路由只带根 handler、且**目标路径读不回来**。
 *
 * 这不是可以隐藏的实现细节：接管后目标路径会是空串，第一次「应用」会按映射库
 * 重写这条路由——如果原本带着路径，那一次重写就是真实的语义变化。因此必须写在界面上。
 */
const SERVICE_CONFIG_LOSSY_NOTE =
  '这条路由是从 Tailscale Service 配置读出的，读出的 handler 树是有损的：只有根路径、目标路径无法恢复。因此「接管」会以空目标路径纳入管理，第一次「应用」会按映射库重写它——若原本带目标路径，请接管后在编辑行里补回。';

/** 路由位置的稳定键（Service + 端口 + 路径），用于「接管中」状态与 React key。 */
function routeKey(r: { service: string | null; servePort: number; path: string }): string {
  return `${r.service ?? '-'}|${r.servePort}|${r.path}`;
}

/** 非本机代理路由也可读地标注出来。 */
function hostText(r: ExternalRoute): string {
  if (r.host === null) return r.proxy === null ? '（非代理 handler）' : '（主机未知）';
  return r.host;
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
    // 路由身份是 (service, servePort, path)：漏掉 service 会去接管另一条同名路由。
    void importRoutes([{ service: route.service, servePort: route.servePort, path: route.path }])
      .then((result) => {
        if (result.data !== undefined) {
          const ok = result.data.imported;
          const skipped = result.data.skipped;
          if (ok.length > 0) {
            const first = ok[0];
            const target =
              first === undefined ? '' : ` → ${formatTarget(first.target)}${first.target.targetPath}`;
            onNotify(
              'success',
              '已接管路由',
              `${ok.map((m) => formatRouteLabel(m.servePort, m.path, m.service)).join(', ')}${target}`,
            );
          } else {
            onNotify(
              'warn',
              '未能接管该路由',
              skipped.map((s) => `${formatRouteLabel(s.servePort, s.path, s.service)}：${s.reason}`).join('；') ||
                '原因未知',
            );
          }
        }
      })
      .finally(() => {
        setPending(null);
      });
  };

  const lossy = routes.filter((r) => r.fromServiceConfig).length;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>未托管路由</h2>
        <span className="panel-meta">
          共 {routes.length} 条 · 这些是 serve 中已存在、但 TsController 还不认识的路由
          {lossy > 0 ? ` · 其中 ${String(lossy)} 条来自 Service 配置（目标路径不可恢复）` : ''}
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
              <th>Service</th>
              <th>端口</th>
              <th>路径</th>
              <th>代理目标主机</th>
              <th>代理目标</th>
              <th>handler 类型</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => {
              const rows: JSX.Element[] = [
                <tr key={`${routeKey(r)}|${r.proxy ?? r.kind}`}>
                  <td>
                    {r.service === null ? (
                      <span className="pill pill-grey" title="节点级路由">
                        节点级
                      </span>
                    ) : (
                      <span className="pill pill-blue" title={r.serviceInfo?.dnsName ?? r.service}>
                        {serviceShortName(r.service)}
                      </span>
                    )}
                  </td>
                  <td className="mono">{String(r.servePort)}</td>
                  <td className="mono">
                    {r.path}
                    {r.fromServiceConfig ? (
                      <span className="badge badge-calm" title={SERVICE_CONFIG_LOSSY_NOTE}>
                        Service 配置
                      </span>
                    ) : null}
                  </td>
                  <td className="mono">{hostText(r)}</td>
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
                </tr>,
              ];
              // 有损这一点必须显式写在界面上，而不是藏在 tooltip 里：
              // 它决定了接管后第一次「应用」会不会改写目标路径。
              if (r.fromServiceConfig) {
                rows.push(
                  <tr key={`${routeKey(r)}:lossy`} className="lossy-row">
                    <td colSpan={7}>
                      <span className="badge badge-calm">目标路径不可恢复</span>
                      <span className="muted small"> {SERVICE_CONFIG_LOSSY_NOTE}</span>
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
