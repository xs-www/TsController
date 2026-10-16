/** 复制到剪贴板的小按钮（成功后短暂变成「已复制」）。 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { copyText } from '../utils';

export interface CopyButtonProps {
  /** 要复制的文本；为 null 时按钮禁用。 */
  value: string | null;
  /** 按钮文案，默认「复制」。 */
  label?: string;
  className?: string;
  title?: string;
  /** 复制结果回调，用于弹出 toast。 */
  onResult?: (ok: boolean, value: string) => void;
}

export function CopyButton({ value, label = '复制', className, title, onResult }: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const disabled = value === null || value === '';

  const handleClick = (): void => {
    if (value === null || value === '') return;
    void copyText(value).then((ok) => {
      setCopied(ok);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
      }, 1500);
      onResult?.(ok, value);
    });
  };

  return (
    <button
      type="button"
      className={className ?? 'btn btn-mini'}
      onClick={handleClick}
      disabled={disabled}
      title={title ?? (value ?? '无可复制内容')}
    >
      {copied ? '已复制' : label}
    </button>
  );
}
