/** 工具条：刷新 / 重新同步 / 打开管理 API / 同步计划摘要。 */
import type { JSX } from 'react';
import type { MappingCounts, PlanSummary } from '../api';

export interface ToolbarProps {
  plan: PlanSummary | null;
  /** 映射状态计数；用于把「等待审批」这类不体现在 plan 里的状态也提示出来。 */
  counts: MappingCounts | null;
  loading: boolean;
  applying: boolean;
  adminUrl: string | null;
  onRefresh: () => void;
  onApply: () => void;
}

function planText(plan: PlanSummary): string {
  if (plan.inSync) return 'serve 配置与映射库一致';
  return `待挂载 ${String(plan.upserts)} · 待摘除 ${String(plan.removals)} · 被阻止 ${String(plan.blocked)}`;
}

export function Toolbar({ plan, counts, loading, applying, adminUrl, onRefresh, onApply }: ToolbarProps): JSX.Element {
  const awaiting = counts?.['awaiting-approval'] ?? 0;

  return (
    <div className="toolbar">
      <div className="toolbar-actions">
        <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={applying}>
          {applying ? '同步中…' : '重新同步'}
        </button>
        {adminUrl !== null ? (
          <a className="btn btn-ghost" href="/api/system" target="_blank" rel="noreferrer noopener">
            查看 /api/system
          </a>
        ) : null}
      </div>
      {plan !== null ? (
        <div className={`plan-summary ${plan.inSync ? 'plan-ok' : 'plan-dirty'}`}>
          <span className={`dot ${plan.inSync ? 'dot-green' : 'dot-yellow'}`} aria-hidden="true" />
          {planText(plan)}
          {plan.exposures > 0 ? <strong className="plan-danger"> · 管理端口暴露 {String(plan.exposures)} 条</strong> : null}
          {awaiting > 0 ? (
            <strong
              className="plan-calm"
              title="Service 配置已写对，但本节点还不是被承认的 host：去 Tailscale 管理后台批准广告（Services → 该 Service → Service hosts → Approve）"
            >
              {' '}
              · 等待审批 {String(awaiting)} 条
            </strong>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
