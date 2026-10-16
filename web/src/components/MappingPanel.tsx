/** 映射面板：表格展示、编辑、启停、删除受管映射。 */
import { useState, type JSX } from 'react';
import { ERROR_CODE_LABEL } from '../api';
import type { MappingCounts, MappingInput, MappingMutationResponse, MappingStatus, MappingView, PlanSummary } from '../api';
import { CopyButton } from './CopyButton';
import { formatRouteLabel, formatTime, groupByStatus, joinUrl } from '../utils';

/**
 * 写操作的结果反馈：`data` 有值表示成功（已刷新数据），否则用 `code`/`message`
 * 描述失败原因，供调用方决定是否弹出「接管确认」。
 */
export interface ApiResult<T> {
  data?: T;
  code?: string;
  message?: string;
}

/** 与「建立映射」一致的结果反馈结构（见 ContainerPanel）。 */
export type MutationResult = ApiResult<MappingMutationResponse>;

export interface MappingPanelProps {
  mappings: MappingView[];
  counts: MappingCounts | null;
  planSummary: PlanSummary | null;
  loading: boolean;
  /** TsController 管理端口，用于本地拦截非法目标端口。 */
  adminPort: number;
  /** serve 主机名（不含端口），用于拼出访问地址。 */
  serveHost: string | null;
  busy: boolean;
  updateMapping: (id: string, input: MappingInput) => Promise<MutationResult>;
  deleteMapping: (id: string) => Promise<ApiResult<unknown>>;
  setEnabled: (id: string, enabled: boolean) => Promise<MutationResult>;
  onNotify: (level: 'info' | 'success' | 'warn' | 'error', title: string, message?: string) => void;
  onCopied: (ok: boolean, label: string, value: string) => void;
}

interface StatusMeta {
  label: string;
  cls: string;
  hint: string;
}

/** 状态徽标的文案、配色与含义说明。 */
const STATUS_META: Record<MappingStatus, StatusMeta> = {
  active: { label: '已生效', cls: 'status-active', hint: 'serve 配置与期望一致' },
  pending: { label: '待同步', cls: 'status-pending', hint: 'serve 配置缺失或指向别处，需要「重新同步」' },
  disabled: { label: '已禁用', cls: 'status-disabled', hint: '在 TsController 中被禁用，serve 中已无该路径' },
  'disabled-drift': { label: '禁用漂移', cls: 'status-drift', hint: '已禁用但 serve 中仍有残留路由' },
  'orphaned-target': { label: '目标失联', cls: 'status-orphan', hint: '目标容器没有运行中的容器发布该端口' },
  blocked: { label: '被阻止', cls: 'status-blocked', hint: '该映射会暴露管理端口，被安全策略拒绝' },
  conflict: { label: '路径冲突', cls: 'status-conflict', hint: '期望路径被外部未托管路由占用' },
};

function StatusBadge({ status, detail }: { status: MappingStatus; detail: string | null }): JSX.Element {
  const meta = STATUS_META[status];
  return (
    <span className={`status ${meta.cls}`} title={detail ?? meta.hint}>
      {meta.label}
    </span>
  );
}

function targetText(m: MappingView): string {
  const t = m.target;
  if (t.kind === 'container') {
    const name = t.containerName ?? t.containerId?.slice(0, 12) ?? '未知容器';
    const from = t.containerPort === undefined ? '?' : String(t.containerPort);
    return `${name} · ${from} → ${String(t.hostPort)}`;
  }
  return `宿主端口 ${String(t.hostPort)}`;
}

/** 行内编辑表单：路径、本机端口、目标路径、备注。 */
function EditRow({
  mapping,
  busy,
  adminPort,
  onSave,
  onCancel,
}: {
  mapping: MappingView;
  busy: boolean;
  adminPort: number;
  onSave: (input: MappingInput) => Promise<MutationResult>;
  onCancel: () => void;
}): JSX.Element {
  const [path, setPath] = useState(mapping.path);
  const [servePort, setServePort] = useState(String(mapping.servePort));
  const [hostPort, setHostPort] = useState(String(mapping.target.hostPort));
  const [targetPath, setTargetPath] = useState(mapping.target.targetPath);
  const [note, setNote] = useState(mapping.note);
  const [pendingTakeover, setPendingTakeover] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (confirmTakeover: boolean): Promise<void> => {
    const parsedPort = Number(hostPort);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      setError('本机端口必须是 1-65535 的整数');
      return;
    }
    const parsedServePort = Number(servePort);
    if (!Number.isInteger(parsedServePort) || parsedServePort <= 0 || parsedServePort > 65535) {
      setError('对外端口必须是 1-65535 的整数');
      return;
    }
    if (parsedPort === adminPort) {
      setError(`端口 ${String(adminPort)} 是 TsController 管理端口，禁止映射`);
      return;
    }
    if (parsedServePort === adminPort) {
      setError(`对外端口 ${String(adminPort)} 与管理端口同号，请换一个`);
      return;
    }
    if (path.trim() === '' || !path.trim().startsWith('/')) {
      setError('路径必须以 "/" 开头');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await onSave({
        path: path.trim(),
        hostPort: parsedPort,
        servePort: parsedServePort,
        targetPath,
        note,
        kind: mapping.target.kind,
        ...(mapping.target.kind === 'container' && mapping.target.containerId !== undefined
          ? { containerId: mapping.target.containerId }
          : {}),
        ...(mapping.target.kind === 'container' && mapping.target.containerName !== undefined
          ? { containerName: mapping.target.containerName }
          : {}),
        ...(mapping.target.kind === 'container' && mapping.target.containerPort !== undefined
          ? { containerPort: mapping.target.containerPort }
          : {}),
        ...(confirmTakeover ? { confirmTakeover: true } : {}),
      });
      if (result.data?.mapping !== undefined) {
        setPendingTakeover(null);
        return;
      }
      if (result.code === 'takeover-required') {
        setPendingTakeover(result.message ?? '该路径已被一条未托管的 serve 路由占用');
        return;
      }
      setPendingTakeover(null);
      setError(
        result.data !== undefined
          ? '保存接口返回了意外的响应（缺少 mapping 字段），请刷新后重试'
          : (result.code !== undefined && ERROR_CODE_LABEL[result.code] !== undefined
              ? `${ERROR_CODE_LABEL[result.code]}：`
              : '') + (result.message ?? '保存失败'),
      );
    } finally {
      setSaving(false);
    }
  };

  const disabled = busy || saving;

  return (
    <>
      <tr className="row-open">
        <td>
          <input
            className="input mono"
            value={path}
            aria-label="路径"
            onChange={(e) => {
              setPath(e.target.value);
            }}
          />
        </td>
        <td>
          <div className="edit-target">
            <span className="muted small">对外端口</span>
            <input
              className="input mono input-port"
              value={servePort}
              inputMode="numeric"
              aria-label="对外端口"
              title="该映射挂在哪一个对外 HTTPS 端口上"
              onChange={(e) => {
                setServePort(e.target.value);
              }}
            />
            <span className="muted small">{mapping.target.kind === 'container' ? '容器' : '宿主'}端口</span>
            <input
              className="input mono input-port"
              value={hostPort}
              inputMode="numeric"
              aria-label="本机端口"
              onChange={(e) => {
                setHostPort(e.target.value);
              }}
            />
            <span className="muted small">目标路径</span>
            <input
              className="input mono"
              value={targetPath}
              placeholder="留空表示不追加"
              aria-label="目标路径"
              onChange={(e) => {
                setTargetPath(e.target.value);
              }}
            />
          </div>
        </td>
        <td>
          <StatusBadge status={mapping.status} detail={mapping.detail} />
        </td>
        <td className="mono small">
          <div>{mapping.desiredProxy}</div>
          <div className="muted">{mapping.actualProxy ?? '—'}</div>
        </td>
        <td>
          <input
            className="input"
            value={note}
            placeholder="备注"
            aria-label="备注"
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </td>
        <td className="col-toggle">{mapping.enabled ? '启用' : '禁用'}</td>
        <td className="col-actions">
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-mini btn-primary"
              disabled={disabled}
              onClick={() => {
                void save(false);
              }}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn btn-mini" disabled={saving} onClick={onCancel}>
              取消
            </button>
          </div>
        </td>
      </tr>
      {pendingTakeover !== null || error !== null ? (
        <tr className="row-form">
          <td colSpan={7}>
            {pendingTakeover !== null ? (
              <div className="inline-confirm" role="alert">
                <p>
                  路径 <code className="mono">{path.trim()}</code> 当前被一条未托管的 serve 路由占用：{pendingTakeover}
                </p>
                <p className="muted">接管后该路径将由 TsController 管理，原 handler 会被覆盖。</p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={disabled}
                    onClick={() => {
                      void save(true);
                    }}
                  >
                    确认接管并保存
                  </button>
                  <button
                    type="button"
                    className="btn"
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
          </td>
        </tr>
      ) : null}
    </>
  );
}

function MappingRow({
  mapping,
  editing,
  busy,
  serveHost,
  adminPort,
  onStartEdit,
  onStopEdit,
  updateMapping,
  deleteMapping,
  setEnabled,
  onNotify,
  onCopied,
}: {
  mapping: MappingView;
  editing: boolean;
  busy: boolean;
  /** serve 主机名（不含端口）。 */
  serveHost: string | null;
  adminPort: number;
  onStartEdit: () => void;
  onStopEdit: () => void;
  updateMapping: MappingPanelProps['updateMapping'];
  deleteMapping: MappingPanelProps['deleteMapping'];
  setEnabled: MappingPanelProps['setEnabled'];
  onNotify: MappingPanelProps['onNotify'];
  onCopied: MappingPanelProps['onCopied'];
}): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fullUrl = joinUrl(serveHost, mapping.servePort, mapping.path);

  if (editing) {
    return (
      <EditRow
        mapping={mapping}
        busy={busy}
        adminPort={adminPort}
        onCancel={onStopEdit}
        onSave={async (input) => {
          const result = await updateMapping(mapping.id, input);
          const updated = result.data?.mapping;
          if (updated !== undefined) {
            onNotify(
              'success',
              '映射已更新',
              `${formatRouteLabel(updated.servePort, updated.path)} → ${updated.desiredProxy}`,
            );
            onStopEdit();
          }
          return result;
        }}
      />
    );
  }

  return (
    <tr>
      <td>
        <div className="path-cell">
          <code className="mono path-text">{formatRouteLabel(mapping.servePort, mapping.path)}</code>
          <CopyButton
            value={fullUrl ?? mapping.path}
            label="复制 URL"
            className="btn btn-mini btn-ghost"
            title={fullUrl ?? 'tailnet 地址未知，将复制路径'}
            onResult={(ok, v) => {
              onCopied(ok, '访问地址', v);
            }}
          />
          {mapping.ownedRoutes.length > 1 ? (
            <span
              className="muted small"
              title={`曾占用位置：${mapping.ownedRoutes.map((r) => formatRouteLabel(r.servePort, r.path)).join(', ')}`}
            >
              占用 {mapping.ownedRoutes.length} 条
            </span>
          ) : null}
        </div>
      </td>
      <td>
        <div className="mono">{targetText(mapping)}</div>
        <div className="muted small">
          {mapping.target.kind === 'container' ? '容器' : '宿主'} · 目标路径 {mapping.target.targetPath === '' ? '（不追加）' : mapping.target.targetPath}
        </div>
      </td>
      <td>
        <StatusBadge status={mapping.status} detail={mapping.detail} />
      </td>
      <td className="mono small">
        <div title="期望写入 serve 的地址">{mapping.desiredProxy}</div>
        <div className="muted" title="serve 中当前的地址">
          {mapping.actualProxy ?? '（未占用）'}
        </div>
      </td>
      <td className="note-cell">
        <div className={mapping.note === '' ? 'muted' : ''}>{mapping.note === '' ? '（无备注）' : mapping.note}</div>
        {mapping.detail !== null ? <div className="detail-text small">{mapping.detail}</div> : null}
        <div className="muted small" title={`创建 ${mapping.createdAt} / 更新 ${mapping.updatedAt}`}>
          更新于 {formatTime(mapping.updatedAt)}
        </div>
      </td>
      <td className="col-toggle">
        <label className="switch" title={mapping.enabled ? '点击禁用' : '点击启用'}>
          <input
            type="checkbox"
            checked={mapping.enabled}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked;
              void setEnabled(mapping.id, next).then((result) => {
                if (result.data !== undefined) {
                  onNotify('success', next ? '映射已启用' : '映射已禁用', result.data.mapping?.path ?? mapping.path);
                }
              });
            }}
          />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">{mapping.enabled ? '启用' : '禁用'}</span>
        </label>
      </td>
      <td className="col-actions">
        {confirmDelete ? (
          <div className="row-actions">
            <span className="small">确认删除？</span>
            <button
              type="button"
              className="btn btn-mini btn-danger"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false);
                void deleteMapping(mapping.id).then((result) => {
                  if (result.data !== undefined) {
                    onNotify('success', '映射已删除', mapping.path);
                  }
                });
              }}
            >
              删除
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <div className="row-actions">
            <button type="button" className="btn btn-mini" onClick={onStartEdit}>
              编辑
            </button>
            <button
              type="button"
              className="btn btn-mini btn-danger-ghost"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              删除
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function MappingPanel({
  mappings,
  counts,
  planSummary,
  loading,
  adminPort,
  serveHost,
  busy,
  updateMapping,
  deleteMapping,
  setEnabled,
  onNotify,
  onCopied,
}: MappingPanelProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const groups = groupByStatus(mappings);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>端口映射</h2>
        <span className="panel-meta">
          共 {mappings.length} 条
          {counts !== null
            ? ` · 已生效 ${String(counts.active)} · 待同步 ${String(counts.pending)} · 被阻止 ${String(counts.blocked)} · 冲突 ${String(
                counts.conflict,
              )}`
            : ''}
          {planSummary !== null && !planSummary.inSync ? ` · 需同步 ${String(planSummary.upserts + planSummary.removals)} 项` : ''}
        </span>
      </header>

      {mappings.length === 0 ? (
        <p className="empty">
          {loading ? '正在读取映射…' : '还没有任何映射。请在下方容器面板里点「建立映射」，或接管一条既有的 serve 路由。'}
        </p>
      ) : (
        <table className="mapping-table">
          <thead>
            <tr>
              <th>路由（端口 + 路径）</th>
              <th>目标</th>
              <th>状态</th>
              <th>期望 / 实际代理</th>
              <th>备注</th>
              <th className="col-toggle">启用</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const meta = STATUS_META[group.status];
              const rows: JSX.Element[] = [
                <tr key={`${group.status}:head`} className="group-row">
                  <td colSpan={7}>
                    <span className={`status ${meta.cls}`}>{meta.label}</span>
                    <span className="muted small">
                      {' '}
                      {String(group.items.length)} 条 · {meta.hint}
                    </span>
                  </td>
                </tr>,
              ];
              for (const m of group.items) {
                rows.push(
                  <MappingRow
                    key={m.id}
                    mapping={m}
                    editing={editingId === m.id}
                    busy={busy}
                    serveHost={serveHost}
                    adminPort={adminPort}
                    onStartEdit={() => {
                      setEditingId(m.id);
                    }}
                    onStopEdit={() => {
                      setEditingId(null);
                    }}
                    updateMapping={updateMapping}
                    deleteMapping={deleteMapping}
                    setEnabled={setEnabled}
                    onNotify={onNotify}
                    onCopied={onCopied}
                  />,
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
