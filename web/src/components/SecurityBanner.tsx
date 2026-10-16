/** 安全横幅：管理端口是否被 serve 暴露到 tailnet。 */
import type { JSX } from 'react';
import type { SystemInfo } from '../api';

export interface SecurityBannerProps {
  system: SystemInfo | null;
  onCopied: (ok: boolean, label: string, value: string) => void;
}

export function SecurityBanner({ system }: SecurityBannerProps): JSX.Element | null {
  if (system === null) return null;
  const { security, adminPort } = system;

  if (security.safe) {
    return (
      <section className="banner banner-safe" role="status">
        <span className="banner-icon" aria-hidden="true">
          ✓
        </span>
        <div>
          <strong>管理面未暴露在 tailnet 中</strong>
          <p>
            当前 serve 配置里没有任何指向管理端口 <code>{String(adminPort)}</code> 的路由，
            tailnet 内的其它设备无法访问本管理界面。
            {security.autoUnexpose ? '自动摘除已开启，一旦出现此类路由会被立即清理。' : '注意：自动摘除当前是关闭状态。'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="banner banner-danger" role="alert">
      <span className="banner-icon" aria-hidden="true">
        !
      </span>
      <div>
        <strong>严重风险：管理界面正在被暴露给 tailnet</strong>
        <p>
          检测到 {security.exposures.length} 条 serve 路由指向 TsController 管理端口{' '}
          <code>{String(adminPort)}</code>。任何能访问你 tailnet 的设备都可以通过这些地址打开本管理界面，
          并用它改写你的端口路由。请立即在 Tailscale 管理后台或执行 <code>tailscale serve</code> 摘除这些路由。
          {security.autoUnexpose ? '（自动摘除已开启，可尝试「重新同步」触发清理。）' : '（自动摘除已关闭，需要手工处理。）'}
        </p>
        <ul className="exposure-list">
          {security.exposures.map((e) => (
            <li key={`${e.servePort}|${e.path}|${e.proxy}`}>
              <code className="exposure-path">{e.servePort === 443 ? e.path : `:${e.servePort}${e.path}`}</code>
              <span className="arrow" aria-hidden="true">
                →
              </span>
              <code className="exposure-proxy">{e.proxy}</code>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
