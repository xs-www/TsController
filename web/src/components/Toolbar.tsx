/** 工具条：刷新 / 重新同步 / 打开管理 API / 同步计划摘要。 */
import type { JSX } from 'react';
import type { PlanSummary } from '../api';

export interface ToolbarProps {
  plan: PlanSummary | null;
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

export function Toolbar({ plan, loading, applying, adminUrl, onRefresh, onApply }: ToolbarProps): JSX.Element {
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
        </div>
      ) : null}
    </div>
  );
}
