/**
 * Tailscale Service 面板。
 *
 * 这里回答的是「本节点上的 Service 现在是什么状态」：MagicDNS 名、对外端口、
 * TailVIP，以及最关键的一项——**本节点是否已被承认为该 Service 的 host**。
 *
 * 后者决定了 serve 配置虽然写对了、对外却仍然不通。那种状态（映射行里的
 * 「等待审批」）不是错误，缺的只是管理后台的一次批准，因此本面板直接给出
 * 可执行的位置与替代方案，而不是让用户对着黄灯猜。
 */
import type { JSX } from 'react';
import type { ServiceInfo } from '../api';
import { CopyButton } from './CopyButton';
import { serviceShortName } from '../utils';

export interface ServicePanelProps {
  services: ServiceInfo[];
  /** 本节点的 tag；空数组 = 本节点不可能充当 Service host。 */
  selfTags: string[];
  /** 本节点是否具备充当 Service host 的身份前提（后端给的结论）。 */
  canHostService: boolean;
  loading: boolean;
  onCopied: (ok: boolean, label: string, value: string) => void;
}

/** 无 tag 时的完整说明：为什么不可用、以及两条可执行的出路。 */
const NO_TAG_HELP =
  '本节点是用户账号身份（无 tag），不可能充当 Service host；请在已打 tag 的常开设备（例如 NAS）上运行 TsController，或在 Tailscale 管理后台给本机打 tag 后重新登录。';

/** 未被承认时的处理办法。 */
const APPROVAL_HELP =
  '本节点尚未被承认为该 Service 的 host，因此 Service 级路由对外暂时不通。请在 Tailscale 管理后台批准广告：Services → 该 Service → Service hosts → Approve；或在 ACL 里配置 autoApprovers.services 让它自动通过。';

export function ServicePanel({
  services,
  selfTags,
  canHostService,
  loading,
  onCopied,
}: ServicePanelProps): JSX.Element | null {
  // 既没有 Service、本节点又没有 tag：整块面板没有信息量，只留一行提示。
  if (services.length === 0 && selfTags.length === 0) {
    return (
      <section className="panel">
        <header className="panel-head">
          <h2>Tailscale Service</h2>
          <span className="panel-meta">本节点不是任何 Service 的 host</span>
        </header>
        <p className="empty">
          {loading ? '正在读取 Service 状态…' : `${NO_TAG_HELP}当前节点上也没有配置任何 Service。`}
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Tailscale Service</h2>
        <span className="panel-meta">
          共 {services.length} 个
          {canHostService ? ` · 本节点 tag：${selfTags.join(', ')}` : ' · 本节点无 tag，不能充当 Service host'}
        </span>
      </header>

      {!canHostService ? (
        <p className="warn-inline" role="note">
          <span className="badge badge-warn">注意</span>
          {NO_TAG_HELP}
        </p>
      ) : null}

      {services.length === 0 ? (
        <p className="empty">
          {loading
            ? '正在读取 Service 状态…'
            : '本节点有 tag 身份，但当前没有配置任何 Tailscale Service。在管理后台定义 Service（Services → 新建）后，可在这里看到它的状态。'}
        </p>
      ) : (
        <ul className="service-list">
          {services.map((s) => {
            const short = serviceShortName(s.name);
            return (
              <li key={s.name} className="service-card">
                <div className="service-head">
                  <strong className="mono">{s.name}</strong>
                  {s.advertised ? (
                    <span className="pill pill-green" title="本节点已被承认为该 Service 的 host，Service 级路由对外可用">
                      已承认
                    </span>
                  ) : (
                    <span className="pill pill-calm" title="广告尚未被批准，Service 级路由对外暂时不通">
                      等待审批
                    </span>
                  )}
                </div>

                <dl className="service-grid">
                  <div>
                    <dt>MagicDNS 名</dt>
                    <dd className="mono">
                      {s.dnsName === null ? (
                        <span className="muted">未知</span>
                      ) : (
                        <>
                          {s.dnsName}
                          <CopyButton
                            value={`https://${s.dnsName}`}
                            label="复制地址"
                            onResult={(ok, v) => {
                              onCopied(ok, `Service ${short} 地址`, v);
                            }}
                          />
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>对外端口</dt>
                    <dd className="mono">
                      {s.servePorts.length === 0 ? (
                        <span className="muted">未配置</span>
                      ) : (
                        s.servePorts.join(', ')
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>TailVIP</dt>
                    <dd className="mono">
                      {s.vipIps.length === 0 ? (
                        <span className="muted">未知</span>
                      ) : (
                        s.vipIps.map((ip) => (
                          <span key={ip} className="service-vip">
                            {ip}
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                </dl>

                {!s.advertised ? (
                  <p className="service-help small" role="note">
                    {APPROVAL_HELP}
                  </p>
                ) : null}

                {s.servePorts.length === 0 ? (
                  <p className="muted small">
                    该 Service 还没有 endpoint 配置：Service 级路由的「对外端口」必须与这里列出的端口一致，
                    否则写入 serve 后依然不会对外可用。
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canHostService && services.length > 0 ? (
        <p className="inline-form-hint muted small">
          Service 的对外名字是 <code className="mono">&lt;service 名&gt;.&lt;MagicDNS 后缀&gt;</code>
          ，与节点级路由的 <code className="mono">&lt;节点名&gt;.&lt;tailnet&gt;.ts.net</code> 是两个不同的主机名；
          两者可以挂相同的端口与路径而互不干扰。
        </p>
      ) : null}
    </section>
  );
}
