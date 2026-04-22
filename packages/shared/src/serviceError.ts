/**
 * 统一错误处理
 *
 * 提供跨应用层的统一错误分类、ServiceError 类和辅助函数。
 * 参考自：
 * - apps/runner/src/server.ts (classifyError)
 * - apps/api/src/lib/errors.ts (AppError)
 */

export enum ErrorCategory {
  AUTH_FAILED = "auth_failed",
  POLICY_VIOLATION = "policy_violation",
  RESOURCE_EXHAUSTED = "resource_exhausted",
  INVALID_REQUEST = "invalid_request",
  NOT_FOUND = "not_found",
  INTERNAL = "internal",
  TIMEOUT = "timeout",
}

export class ServiceError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(params: {
    category: ErrorCategory;
    code: string;
    httpStatus: number;
    message: string;
    details?: Record<string, unknown>;
    cause?: Error;
  }) {
    super(params.message);
    this.name = "ServiceError";
    this.category = params.category;
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.details = params.details;
    if (params.cause) this.cause = params.cause;
  }
}

/**
 * 将未知错误分类为 ServiceError。
 *
 * 覆盖场景：
 * - 已是 ServiceError → 直接返回
 * - Error.message 包含 "timeout" → TIMEOUT
 * - Error.message 包含 "policy_violation" → POLICY_VIOLATION
 * - Error.message 包含 "resource_exhausted" / "concurrency_limit" → RESOURCE_EXHAUSTED
 * - Error.message 包含 "unauthorized" / "forbidden" / "auth" → AUTH_FAILED
 * - Error.message 包含 "not_found" / "NOT_FOUND" → NOT_FOUND
 * - Error.message 包含 "invalid" / "bad_request" / "schema" → INVALID_REQUEST
 * - 其余 → INTERNAL
 */
export function classifyError(err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;

  const raw = err instanceof Error ? err.message : String(err ?? "internal");
  const msg = raw.startsWith("concurrency_limit:") ? "resource_exhausted:max_concurrency" : raw;
  const lower = msg.toLowerCase();

  if (lower.includes("timeout")) {
    return new ServiceError({ category: ErrorCategory.TIMEOUT, code: "TIMEOUT", httpStatus: 504, message: msg, cause: err instanceof Error ? err : undefined });
  }
  if (lower.includes("resource_exhausted") || lower.includes("concurrency_limit") || lower.includes("rate_limit")) {
    return new ServiceError({ category: ErrorCategory.RESOURCE_EXHAUSTED, code: "RESOURCE_EXHAUSTED", httpStatus: 429, message: msg, cause: err instanceof Error ? err : undefined });
  }
  if (lower.includes("policy_violation")) {
    return new ServiceError({ category: ErrorCategory.POLICY_VIOLATION, code: "POLICY_VIOLATION", httpStatus: 403, message: msg, cause: err instanceof Error ? err : undefined });
  }
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("auth_failed")) {
    return new ServiceError({ category: ErrorCategory.AUTH_FAILED, code: "AUTH_FAILED", httpStatus: 401, message: msg, cause: err instanceof Error ? err : undefined });
  }
  if (lower.includes("not_found") || lower.includes("not found")) {
    return new ServiceError({ category: ErrorCategory.NOT_FOUND, code: "NOT_FOUND", httpStatus: 404, message: msg, cause: err instanceof Error ? err : undefined });
  }
  if (lower.includes("invalid") || lower.includes("bad_request") || lower.includes("schema")) {
    return new ServiceError({ category: ErrorCategory.INVALID_REQUEST, code: "INVALID_REQUEST", httpStatus: 400, message: msg, cause: err instanceof Error ? err : undefined });
  }

  return new ServiceError({ category: ErrorCategory.INTERNAL, code: "INTERNAL", httpStatus: 500, message: msg, cause: err instanceof Error ? err : undefined });
}

/**
 * 将 ServiceError 转换为 HTTP 响应体。
 */
export function toHttpResponse(err: ServiceError): {
  statusCode: number;
  body: { errorCode: string; message: string; category: string; details?: Record<string, unknown> };
} {
  return {
    statusCode: err.httpStatus,
    body: {
      errorCode: err.code,
      message: err.message,
      category: err.category,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
