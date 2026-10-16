/** 顶部信息条：tailnet 地址、管理地址、数据源与 tailscaled 状态。 */
import type { JSX } from 'react';
import type { SystemInfo } from '../api';
import { CopyButton } from './CopyButton';
import { formatTime } from '../utils';

export interface TopBarProps {
  system: SystemInfo | null;
  loading: boolean;
  lastUpdated: string | null;
  onCopied: (ok: boolean, label: string, value: string) => void;
}

function StatePill({ state }: { state: string | null }): JSX.Element {
  if (state === null || state === '') return <span className="pill pill-grey">未知</span>;
  const ok = state.toLowerCase() === 'running';
  return <span className={`pill ${ok ? 'pill-green' : 'pill-red'}`}>{state}</span>;
}

export function TopBar({ system, loading, lastUpdated, onCopied }: TopBarProps): JSX.Element {
  if (system === null) {
    return (
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Ts</span>
          <div>
            <h1>TsController</h1>
            <p className="brand-sub">tailnet ↔ Docker 端口路由控制台</p>
          </div>
        </div>
        <div className="topbar-empty">{loading ? '正在读取系统信息…' : '系统信息不可用'}</div>
      </header>
    );
  }

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">Ts</span>
        <div>
          <h1>TsController</h1>
          <p className="brand-sub">tailnet ↔ Docker 端口路由控制台</p>
        </div>
      </div>

      <dl className="topbar-grid">
        <div className="topbar-cell">
          <dt>tailnet 地址</dt>
          <dd>
            {system.baseUrl === null ? (
              <span className="muted">{system.dnsName ?? '未获取到 tailnet 域名'}</span>
            ) : (
              <>
                <a href={system.baseUrl} target="_blank" rel="noreferrer noopener" className="mono">
                  {system.baseUrl}
                </a>
                <CopyButton value={system.baseUrl} onResult={(ok, v) => onCopied(ok, 'tailnet 地址', v)} />
              </>
            )}
          </dd>
        </div>

        <div className="topbar-cell">
          <dt>管理地址（仅本机）</dt>
          <dd>
            <a href={system.adminUrl} target="_blank" rel="noreferrer noopener" className="mono">
              {system.adminUrl}
            </a>
            <CopyButton value={system.adminUrl} onResult={(ok, v) => onCopied(ok, '管理地址', v)} />
          </dd>
        </div>

        <div className="topbar-cell">
          <dt>Tailscale</dt>
          <dd>
            <StatePill state={system.backendState} />
            <span className="muted mono">
              {system.serveHost ?? '无 Web 服务'}
              {system.tailscaleVersion === null ? '' : ` · v${system.tailscaleVersion}`}
            </span>
          </dd>
        </div>

        <div className="topbar-cell">
          <dt>serve 端口 / 主机名</dt>
          <dd className="mono">
            {system.servePorts.length > 0 ? system.servePorts.join(', ') : String(system.servePort)} ·{' '}
            {system.hostname ?? '未知'}
            {system.tailnetIps.length > 0 ? <span className="muted"> · {system.tailnetIps.join(', ')}</span> : null}
          </dd>
        </div>

        <div className="topbar-cell topbar-wide">
          <dt>Docker 数据源</dt>
          <dd className="mono muted">{system.sources.docker}</dd>
        </div>

        <div className="topbar-cell topbar-wide">
          <dt>Tailscale 数据源</dt>
          <dd className="mono muted">{system.sources.tailscale}</dd>
        </div>

        <div className="topbar-cell topbar-wide">
          <dt>数据目录</dt>
          <dd className="mono muted">
            {system.sources.dataDir}
            {lastUpdated === null ? '' : ` · 更新于 ${formatTime(lastUpdated)}`}
          </dd>
        </div>

        <div className="topbar-cell topbar-wide">
          <dt>路由快照（供其它项目只读挂载）</dt>
          <dd className="mono muted">
            {system.sources.snapshotFile}
            <CopyButton
              value={system.sources.snapshotFile}
              label="复制路径"
              onResult={(ok, v) => onCopied(ok, '快照路径', v)}
            />
          </dd>
        </div>
      </dl>
    </header>
  );
}
