/** 数据获取与变更之后通知 App 的通用回调类型。 */
import type { ApplyResult } from '../api';

export interface ApplyFeedbackOptions {
  /** apply 完全同步时的成功文案。 */
  successTitle: string;
  /** 同步失败/有错误时的失败文案。 */
  failureTitle: string;
}

/** 把 ApplyResult 的 upserted / removed / errors / blocked / exposures 汇报给用户。 */
export type ReportApply = (apply: ApplyResult, options?: Partial<ApplyFeedbackOptions>) => void;

export interface MutationHooks {
  /** 变更成功（或部分成功）后刷新所有面板。 */
  refreshAll: () => void;
  /** 仅刷新映射相关数据。 */
  refreshMappings: () => void;
  /** 展示错误/提示。 */
  notifyError: (title: string, err: unknown) => void;
  notifySuccess: (title: string, message?: string) => void;
  reportApply: ReportApply;
}

export const DEFAULT_APPLY_OPTIONS: ApplyFeedbackOptions = {
  successTitle: '已同步',
  failureTitle: '同步未完成',
};
