/** 容器面板：列出容器与已发布端口，可就地建立映射。 */
import { useEffect, useId, useState, type JSX } from 'react';
import { ERROR_CODE_LABEL } from '../api';
import type { ContainerInfo, ContainerPort, MappingInput, MappingMutationResponse, ServiceInfo } from '../api';
import type { ApiResult } from './MappingPanel';
import {
  defaultPathFor,
  formatRouteLabel,
  formatTarget,
  formatTimestamp,
  isWildcardHost,
  normalizePathInput,
  normalizeServiceInput,
  serviceShortName,
} from '../utils';

/** 统一的「创建映射」结果反馈，由 App 负责真正发请求。 */
export type CreateMappingResult = ApiResult<MappingMutationResponse>;

export interface CreateMappingFn {
  (input: MappingInput): Promise<CreateMappingResult>;
}

export interface ContainerPanelProps {
  containers: ContainerInfo[];
  loading: boolean;
  adminPort: number;
  /** 新建映射时预填的对外 HTTPS 端口。 */
  defaultServePort: number;
  /** 当前节点上的 Tailscale Service，用于快速选择。 */
  services: ServiceInfo[];
  /** 本节点是否具备充当 Service host 的身份前提（无 tag 时为 false）。 */
  canHostService: boolean;
  busy: boolean;
  createMapping: CreateMappingFn;
  onNotify: (level: 'info' | 'success' | 'warn' | 'error', title: string, message?: string) => void;
}

/** 端口监听全部网卡时的黄色警示文案。 */
const WILDCARD_WARNING = '该端口监听全部网卡，tailnet 内设备可绕过本工具直连 100.x 地址';

/** 本节点是用户账号身份（无 tag）时的说明：Service 模式在当前节点上不可能成立。 */
const NO_TAG_WARNING =
  '本节点是用户账号身份（无 tag），不可能充当 Service host；请在已打 tag 的常开设备（例如 NAS）上运行 TsController，或在 Tailscale 管理后台给本机打 tag 后重新登录。';

interface InlineFormProps {
  container: ContainerInfo;
  port: ContainerPort;
  defaultServePort: number;
  services: ServiceInfo[];
  canHostService: boolean;
  busy: boolean;
  onCancel: () => void;
  createMapping: CreateMappingFn;
  onCreated: (mapping: { servePort: number; path: string; service: string | null }) => void;
}

function ContainerMappingForm({
  container,
  port,
  defaultServePort,
  services,
  canHostService,
  busy,
  onCancel,
  createMapping,
  onCreated,
}: InlineFormProps): JSX.Element {
  const [service, setService] = useState<string>('');
  const [remoteHost, setRemoteHost] = useState<string>('');
  const [path, setPath] = useState<string>(defaultPathFor(container.name));
  const [hostPort, setHostPort] = useState<string>(String(port.hostPort));
  const [servePort, setServePort] = useState<string>(String(defaultServePort));
  const [targetPath, setTargetPath] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [pendingTakeover, setPendingTakeover] = useState<string | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serviceListId = useId();

  useEffect(() => {
    setService('');
    setRemoteHost('');
    setPath(defaultPathFor(container.name));
    setHostPort(String(port.hostPort));
    setServePort(String(defaultServePort));
    setTargetPath('');
    setNote('');
    setPendingTakeover(null);
    setError(null);
  }, [container.id, container.name, port.hostPort, port.containerPort, defaultServePort]);

  /** 归一化后的 Service 名；空串 = 节点级路由。 */
  const normalizedService = normalizeServiceInput(service);
  /** 归一化后的远端主机；空串 = 本机回环。 */
  const trimmedRemoteHost = remoteHost.trim();
  const serviceMode = normalizedService !== '';

  const submit = async (confirmTakeover: boolean): Promise<void> => {
    const parsedPort = Number(hostPort);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      setError('目标端口必须是 1-65535 的整数');
      return;
    }
    const parsedServePort = Number(servePort);
    if (!Number.isInteger(parsedServePort) || parsedServePort <= 0 || parsedServePort > 65535) {
      setError('对外端口必须是 1-65535 的整数');
      return;
    }
    const normalized = normalizePathInput(path);
    if (normalized === '') {
      setError('路径不能为空，且必须以 "/" 开头');
      return;
    }
    setSubmitBusy(true);
    setError(null);
    try {
      const result = await createMapping({
        path: normalized,
        hostPort: parsedPort,
        servePort: parsedServePort,
        targetPath,
        note,
        // 空串一律作为「节点级」显式下发，避免 PATCH 语义下沿用旧 Service。
        service: normalizedService === '' ? null : normalizedService,
        ...(serviceMode && trimmedRemoteHost !== '' ? { remoteHost: trimmedRemoteHost } : {}),
        kind: 'container',
        containerId: container.id,
        containerName: container.name,
        containerPort: port.containerPort,
        ...(confirmTakeover ? { confirmTakeover: true } : {}),
      });
      const mapping = result.data?.mapping;
      if (mapping !== undefined) {
        setPendingTakeover(null);
        onCreated({ servePort: mapping.servePort, path: mapping.path, service: mapping.service });
        return;
      }
      if (result.code === 'takeover-required') {
        setPendingTakeover(result.message ?? '该路径已被一条未托管的 serve 路由占用');
        return;
      }
      setPendingTakeover(null);
      setError(
        result.data !== undefined
          ? '创建接口返回了意外的响应（缺少 mapping 字段），请刷新后重试'
          : (result.code !== undefined && ERROR_CODE_LABEL[result.code] !== undefined
              ? `${ERROR_CODE_LABEL[result.code]}：`
              : '') + (result.message ?? '创建失败'),
      );
    } finally {
      setSubmitBusy(false);
    }
  };

  const disabled = busy || submitBusy;
  /** 预览里的目标地址，与服务端 desiredProxy 的拼法一致。 */
  const previewTarget = formatTarget({
    kind: 'container',
    hostPort: Number.isInteger(Number(hostPort)) ? Number(hostPort) : port.hostPort,
    targetPath,
    ...(serviceMode && trimmedRemoteHost !== '' ? { remoteHost: trimmedRemoteHost } : {}),
  });

  return (
    <div className="inline-form">
      <div className="inline-form-grid">
        <label className="field">
          <span>Tailscale Service（可选）</span>
          <input
            className="input mono"
            value={service}
            placeholder="留空 = 节点级路由；填 dsh 或 svc:dsh"
            list={services.length > 0 ? serviceListId : undefined}
            onChange={(e) => {
              setService(e.target.value);
            }}
          />
          {services.length > 0 ? (
            <datalist id={serviceListId}>
              {services.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.dnsName ?? serviceShortName(s.name)}
                  {s.advertised ? '' : '（等待审批）'}
                </option>
              ))}
            </datalist>
          ) : null}
        </label>
        <label className="field">
          <span>路径</span>
          <input
            className="input mono"
            value={path}
            placeholder="/myapp"
            onChange={(e) => {
              setPath(e.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>对外端口</span>
          <input
            className="input mono"
            inputMode="numeric"
            value={servePort}
            placeholder="443"
            title="该映射挂在哪一个对外 HTTPS 端口上；非 443 端口会出现在访问地址里"
            onChange={(e) => {
              setServePort(e.target.value);
            }}
          />
        </label>
        {serviceMode ? (
          <label className="field">
            <span>代理目标主机</span>
            <input
              className="input mono"
              value={remoteHost}
              placeholder="留空 = 本机 127.0.0.1；Service host 可代理远端主机"
              onChange={(e) => {
                setRemoteHost(e.target.value);
              }}
            />
          </label>
        ) : null}
        <label className="field">
          <span>{serviceMode ? '目标主机端口' : '本机端口'}</span>
          <input
            className="input mono"
            inputMode="numeric"
            value={hostPort}
            title={
              serviceMode
                ? '该端口属于上面那台「代理目标主机」，不是本机'
                : '本机（127.0.0.1）上被代理的端口'
            }
            onChange={(e) => {
              setHostPort(e.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>目标路径（可选）</span>
          <input
            className="input mono"
            value={targetPath}
            placeholder="留空表示不追加"
            onChange={(e) => {
              setTargetPath(e.target.value);
            }}
          />
        </label>
        <label className="field field-wide">
          <span>备注（可选）</span>
          <input
            className="input"
            value={note}
            placeholder="例如：worldforge 开发服务器"
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </label>
      </div>

      {!canHostService ? (
        <p className="warn-inline" role="note">
          <span className="badge badge-warn">注意</span>
          {NO_TAG_WARNING}
        </p>
      ) : null}

      <p className="inline-form-hint">
        将把{' '}
        <code className="mono">
          {serviceMode
            ? `https://${serviceShortName(normalizedService)}.<tailnet>`
            : servePort === '443'
              ? 'https://<tailnet>'
              : `https://<tailnet>:${servePort}`}
          {normalizePathInput(path) || '/…'}
        </code>{' '}
        反向代理到{' '}
        <code className="mono">
          {previewTarget}
          {targetPath === '' ? '' : targetPath}
        </code>
        ，目标容器 <strong>{container.name}</strong> 的 {String(port.containerPort)}/{port.protocol}。
      </p>
      <p className="inline-form-hint muted small">
        注意：<strong>挂载路径在转发时会被剥掉</strong>，所以上面「路径」只是外部别名，决定命中后端哪条路由的是
        「目标路径」。例：路径 <code className="mono">/api/addSchedule</code> + 目标路径{' '}
        <code className="mono">/api/agent/events</code> ⟹ 请求 <code className="mono">/api/addSchedule</code> 到达后端
        <code className="mono">/api/agent/events</code>。
      </p>
      {serviceMode ? (
        <p className="inline-form-hint muted small">
          Service 级路由写进的是 <code className="mono">{normalizedService}</code> 的 serve 配置，
          与节点级路由互不干扰；「目标主机端口」属于上面那台<strong>代理目标主机</strong>。当前节点还必须
          被管理员承认为该 Service 的 host（Services → 该 Service → Service hosts → Approve），
          否则状态是「等待审批」，对外暂时不通。
        </p>
      ) : null}

      {pendingTakeover !== null ? (
        <div className="inline-confirm" role="alert">
          <p>
            路径 <code className="mono">{formatRouteLabel(Number(servePort) || 443, normalizePathInput(path), serviceMode ? normalizedService : null)}</code>{' '}
            当前被一条未托管的 serve 路由占用：
            {pendingTakeover}
          </p>
          <p className="muted">接管后该路径将由 TsController 管理，原 handler 会被覆盖。</p>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={disabled}
              onClick={() => {
                void submit(true);
              }}
            >
              确认接管并创建
            </button>
            <button
              type="button"
              className="btn"
              disabled={disabled}
              onClick={() => {
                setPendingTakeover(null);
              }}
            >
              取消接管
            </button>
          </div>
        </div>
      ) : null}

      {error !== null ? <p className="inline-error">{error}</p> : null}

      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={() => {
            void submit(false);
          }}
        >
          {submitBusy ? '提交中…' : '创建映射'}
        </button>
        <button type="button" className="btn" disabled={submitBusy} onClick={onCancel}>
          收起
        </button>
      </div>
    </div>
  );
}

export function ContainerPanel({
  containers,
  loading,
  adminPort,
  defaultServePort,
  services,
  canHostService,
  busy,
  createMapping,
  onNotify,
}: ContainerPanelProps): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const running = containers.filter((c) => c.state === 'running').length;
  // 运行中的容器排前面，其次按容器名排序，让「可以映射什么」一眼可见。
  const ordered = [...containers].sort((a, b) => {
    const ra = a.state === 'running' ? 0 : 1;
    const rb = b.state === 'running' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Docker 容器</h2>
        <span className="panel-meta">
          共 {containers.length} 个 · 运行中 {running} 个
        </span>
      </header>

      {containers.length === 0 ? (
        <p className="empty">没有发现容器。请确认 Docker 正在运行，或检查上方「Docker 数据源」是否正确。</p>
      ) : (
        <ul className="container-list">
          {ordered.map((c) => {
            const wildcard = c.ports.some((p) => isWildcardHost(p.hostIp));
            return (
              <li key={c.id} className={`container-card ${c.state === 'running' ? '' : 'container-idle'}`}>
                <div className="container-head">
                  <div className="container-title">
                    <strong className="mono">{c.name}</strong>
                    <span className={`pill ${c.state === 'running' ? 'pill-green' : 'pill-grey'}`}>{c.state}</span>
                    {c.composeProject !== null ? (
                      <span className="pill pill-blue" title={c.composeService ?? ''}>
                        compose: {c.composeProject}
                        {c.composeService === null ? '' : ` / ${c.composeService}`}
                      </span>
                    ) : null}
                  </div>
                  <div className="container-sub">
                    <span className="mono muted" title={c.image}>
                      {c.image}
                    </span>
                    <span className="muted">· {c.status}</span>
                    <span className="muted">· 创建于 {formatTimestamp(c.createdAt)}</span>
                    <span className="muted mono" title={c.id}>
                      · {c.id.slice(0, 12)}
                    </span>
                  </div>
                </div>

                {wildcard ? (
                  <p className="warn-inline" role="note">
                    <span className="badge badge-warn">注意</span>
                    {WILDCARD_WARNING}
                  </p>
                ) : null}

                {c.ports.length === 0 ? (
                  <p className="muted small">该容器没有发布任何宿主机端口，无法建立映射。</p>
                ) : (
                  <table className="port-table">
                    <thead>
                      <tr>
                        <th>宿主机绑定</th>
                        <th>容器端口</th>
                        <th className="col-actions">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.ports.flatMap((p) => {
                        const key = `${c.id}:${p.hostIp}:${String(p.hostPort)}:${String(p.containerPort)}:${p.protocol}`;
                        const isOpen = openKey === key;
                        const rows: JSX.Element[] = [
                          <tr key={key} className={isOpen ? 'row-open' : ''}>
                              <td className="mono">
                                {p.hostIp}:{String(p.hostPort)}
                                {isWildcardHost(p.hostIp) ? (
                                  <span className="badge badge-warn" title={WILDCARD_WARNING}>
                                    全网卡
                                  </span>
                                ) : null}
                                {p.hostPort === adminPort ? (
                                  <span className="badge badge-danger" title="这是 TsController 管理端口，禁止建立映射">
                                    管理端口
                                  </span>
                                ) : null}
                              </td>
                              <td className="mono">
                                {String(p.containerPort)}/{p.protocol}
                              </td>
                              <td className="col-actions">
                                <button
                                  type="button"
                                  className="btn btn-mini"
                                  disabled={p.hostPort === adminPort}
                                  onClick={() => {
                                    setOpenKey(isOpen ? null : key);
                                  }}
                                >
                                  {isOpen ? '取消' : '建立映射'}
                                </button>
                              </td>
                            </tr>
                        ];
                        if (isOpen) {
                          rows.push(
                            <tr key={`${key}:form`} className="row-form">
                              <td colSpan={3}>
                                  <ContainerMappingForm
                                    container={c}
                                    port={p}
                                    defaultServePort={defaultServePort}
                                    services={services}
                                    canHostService={canHostService}
                                    busy={busy}
                                    createMapping={createMapping}
                                    onCancel={() => {
                                      setOpenKey(null);
                                    }}
                                    onCreated={(created) => {
                                      setOpenKey(null);
                                      onNotify(
                                        'success',
                                        '映射已创建',
                                        `${formatRouteLabel(created.servePort, created.path, created.service)} 已指向 ${p.hostIp}:${String(p.hostPort)}`,
                                      );
                                    }}
                                  />
                              </td>
                            </tr>,
                          );
                        }
                        return rows;
                      })}
                    </tbody>
                  </table>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {loading && containers.length === 0 ? <p className="muted small">正在读取容器清单…</p> : null}
    </section>
  );
}
