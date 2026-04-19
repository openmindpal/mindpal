/**
 * 统一错误分类枚举 —— 用于 Agent Loop 观察、审计日志、可观测性仪表板。
 * 值必须与数据库 steps.error_category 列中的字符串保持一致。
 */
export const ErrorCategory = {
  /** 权限/策略拒绝，不应重试 */
  GOVERNANCE_DENIED: "governance_denied",
  /** 治理系统本身不可用（fail-closed） */
  GOVERNANCE_UNAVAILABLE: "governance_unavailable",
  /** 参数/schema错误，需修正输入 */
  INPUT_VALIDATION_FAILED: "input_validation_failed",
  /** 工具暂时不可用，可重试 */
  TOOL_UNAVAILABLE: "tool_unavailable",
  /** 执行超时，需backoff重试 */
  STEP_TIMEOUT: "step_timeout",
  /** 工具执行内部错误 */
  TOOL_EXECUTION_FAILED: "tool_execution_failed",
  /** 被信号中断 */
  INTERRUPTED: "interrupted",
  /** 进入死信队列 */
  DEADLETTER: "deadletter",
  /** 多Agent协作错误 */
  COLLAB_ERROR: "collab_error",
} as const;

export type ErrorCategoryValue = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * 判断错误分类是否可重试
 */
export function isRetryableError(category: string | null | undefined): boolean {
  if (!category) return false;
  return category === ErrorCategory.TOOL_UNAVAILABLE
    || category === ErrorCategory.STEP_TIMEOUT
    || category === ErrorCategory.TOOL_EXECUTION_FAILED;
}

/**
 * 返回面向 LLM 的可操作性提示
 */
export function errorActionHint(category: string | null | undefined): string {
  switch (category) {
    case ErrorCategory.GOVERNANCE_DENIED:
      return "[权限拒绝-不可重试]";
    case ErrorCategory.GOVERNANCE_UNAVAILABLE:
      return "[治理系统异常-不可重试]";
    case ErrorCategory.INPUT_VALIDATION_FAILED:
      return "[需修正输入]";
    case ErrorCategory.TOOL_UNAVAILABLE:
    case ErrorCategory.STEP_TIMEOUT:
    case ErrorCategory.TOOL_EXECUTION_FAILED:
      return "[可重试]";
    case ErrorCategory.INTERRUPTED:
      return "[已中断]";
    case ErrorCategory.DEADLETTER:
      return "[死信-需人工干预]";
    case ErrorCategory.COLLAB_ERROR:
      return "[协作错误]";
    default:
      return "";
  }
}
