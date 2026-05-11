/**
 * serverErrorMap.ts — 统一错误分类与 HTTP 响应映射
 *
 * 将任意错误分类为标准化 HTTP 响应 { statusCode, body }
 */
import { ZodError } from "zod";
import { Errors, isAppError, ServiceError, ErrorCategory, classifyError, toHttpResponse } from "./lib/errors";

/** PostgreSQL error shape (from pg driver) */
interface PgDatabaseError {
  code?: string;
  message?: string;
  detail?: string;
  table?: string;
  column?: string;
}

/** Type guard: checks if an error carries PostgreSQL error metadata */
export function isPgError(err: unknown): err is Error & PgDatabaseError {
  return err instanceof Error && typeof (err as PgDatabaseError).code === "string";
}

export interface ErrorClassifyRequest {
  ctx?: { traceId?: string; requestId?: string; audit?: { outputDigest?: unknown } };
}

/** 将任意错误分类为标准化 HTTP 响应 { statusCode, body } */
export function classifyAndRespond(
  err: unknown,
  req: ErrorClassifyRequest,
): { statusCode: number; body: Record<string, unknown> } {
  const traceId = req.ctx?.traceId;
  const requestId = req.ctx?.requestId;

  // 1. ZodError → 400
  if (err instanceof ZodError) {
    const svcErr = new ServiceError({
      category: ErrorCategory.INVALID_REQUEST,
      code: "BAD_REQUEST",
      httpStatus: 400,
      message: "参数校验失败",
      details: { zodIssues: err.issues },
    });
    const resp = toHttpResponse(svcErr);
    return { statusCode: resp.statusCode, body: { ...resp.body, traceId, requestId } };
  }

  // 2. AppError（继承自 ServiceError）→ 保留 i18n 格式
  if (isAppError(err)) {
    const auditSafetySummary = (() => {
      const digest = req.ctx?.audit?.outputDigest;
      if (!digest || typeof digest !== "object") return undefined;
      const ss = (digest as Record<string, unknown>).safetySummary;
      if (!ss || typeof ss !== "object" || Array.isArray(ss)) return undefined;
      return ss;
    })();
    const body: Record<string, unknown> = {
      errorCode: err.errorCode,
      message: err.messageI18n,
      traceId,
      requestId,
    };
    if (auditSafetySummary) body.safetySummary = auditSafetySummary;
    return { statusCode: err.httpStatus, body };
  }

  // 3. PostgreSQL 错误 → 对应 AppError
  const pgCode = isPgError(err) ? err.code ?? "" : "";
  const pgAppErr =
    pgCode === "22P02"
      ? Errors.badRequest("ID 格式非法")
      : pgCode === "23503"
        ? Errors.badRequest("关联记录不存在")
        : pgCode === "42P01" || pgCode === "42703"
          ? Errors.serviceNotReady(`数据库结构未初始化或版本不匹配 (${pgCode === "42P01" ? "缺少表" : "缺少列"}: ${(err as Error)?.message?.match(/(?:relation|column)\s+"([^"]+)"/)?.[1] ?? "unknown"})`)
          : null;
  if (pgAppErr) {
    return {
      statusCode: pgAppErr.httpStatus,
      body: { errorCode: pgAppErr.errorCode, message: pgAppErr.messageI18n, traceId, requestId },
    };
  }

  // 4. 兜底：通过 classifyError 统一分类
  const svcErr = classifyError(err);
  const resp = toHttpResponse(svcErr);
  return { statusCode: resp.statusCode, body: { ...resp.body, traceId, requestId } };
}
