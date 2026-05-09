/**
 * retry.ts — 统一重试策略工具
 *
 * 提供轻量级通用重试包装器，支持固定延迟、指数退避、带抖动的指数退避三种策略。
 * 替代各模块分散的自定义重试实现，集中治理重试行为。
 */

export type RetryStrategy = "fixed" | "exponential" | "exponential_jitter";

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 基础延迟（ms），默认 100 */
  baseDelayMs?: number;
  /** 最大延迟上限（ms），默认 30000 */
  maxDelayMs?: number;
  /** 退避策略，默认 exponential_jitter */
  strategy?: RetryStrategy;
  /** 判断错误是否可重试，默认全部可重试；调用方可传入自定义判断函数 */
  isRetryable?: (err: unknown) => boolean;
  /** 重试回调（用于日志/指标） */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

function computeDelay(attempt: number, opts: Required<Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "strategy">>): number {
  const { baseDelayMs, maxDelayMs, strategy } = opts;
  switch (strategy) {
    case "fixed":
      return Math.min(baseDelayMs, maxDelayMs);
    case "exponential":
      return Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
    case "exponential_jitter": {
      const exp = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      return Math.round(exp * (0.5 + Math.random() * 0.5));
    }
    default:
      return baseDelayMs;
  }
}

/**
 * 通用重试包装器
 *
 * @example
 * const result = await withRetry(() => redis.xadd(...), {
 *   maxAttempts: 2,
 *   baseDelayMs: 50,
 *   strategy: "fixed",
 * });
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 100;
  const maxDelayMs = opts?.maxDelayMs ?? 30000;
  const strategy = opts?.strategy ?? "exponential_jitter";
  const canRetry = opts?.isRetryable ?? ((_err: unknown) => true);
  const onRetry = opts?.onRetry;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt >= maxAttempts - 1 || !canRetry(err)) {
        throw err;
      }
      const delayMs = computeDelay(attempt, { baseDelayMs, maxDelayMs, strategy });
      onRetry?.(attempt + 1, err, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
