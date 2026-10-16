/** 统一的顶部反馈：错误、告警、成功提示与 apply 结果明细。 */
import type { JSX } from 'react';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

/** 结果明细条目（例如 ApplyResult.upserted / .errors 的逐条展示）。 */
export interface ToastDetailItem {
  text: string;
  kind?: 'ok' | 'bad' | 'note';
}

export interface ToastItem {
  id: number;
  level: ToastLevel;
  title: string;
  message?: string;
  /** 错误码，形如 `exposes-admin`；有值时会显示为徽标。 */
  code?: string;
  details?: ToastDetailItem[];
}

export interface ToastProps {
  items: ToastItem[];
  onDismiss: (id: number) => void;
  onClear: () => void;
}

export function ToastStack({ items, onDismiss, onClear }: ToastProps): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="操作反馈">
      {items.length > 1 ? (
        <button type="button" className="toast-clear" onClick={onClear}>
          全部关闭（{items.length}）
        </button>
      ) : null}
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.level}`} role={item.level === 'error' ? 'alert' : 'status'}>
          <div className="toast-head">
            <span className="toast-title">{item.title}</span>
            {item.code !== undefined && item.code !== '' ? <code className="code-badge">{item.code}</code> : null}
            <button type="button" className="toast-close" aria-label="关闭" onClick={() => onDismiss(item.id)}>
              ×
            </button>
          </div>
          {item.message !== undefined && item.message !== '' ? <p className="toast-message">{item.message}</p> : null}
          {item.details !== undefined && item.details.length > 0 ? (
            <ul className="toast-details">
              {item.details.map((d, i) => (
                <li key={`${String(i)}-${d.text}`} className={`detail-${d.kind ?? 'note'}`}>
                  {d.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
