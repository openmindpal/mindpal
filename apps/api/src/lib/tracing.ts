/**
 * Distributed Tracing Utilities — 全链路追踪工具
 *
 * P2-6.7: 确保 traceId 从 API→Worker→Device-Agent→回调全链路贯穿：
 * - BullMQ Job trace carrier 注入/提取
 * - SSE/WebSocket 通道携带 traceId
 * - 跨服务调用 span 创建工具
 * - OTel span 封装（安全降级：OTel 未启用时无操作）
 */
import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import type { Span, SpanOptions } from "@opentelemetry/api";

const tracer = trace.getTracer("openslin-api");

function isOtelEnabled(): boolean {
  const v = String(process.env.OTEL_ENABLED ?? "").toLowerCase();
  return v === "1" || v === "true";
}

// ── BullMQ Job Trace Carrier ────────────────────────────

export function attachJobTraceCarrier<T extends Record<string, any>>(data: T): T {
  if (!isOtelEnabled()) return data;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!Object.keys(carrier).length) return data;
  return { ...data, __trace: carrier };
}

export function extractJobTraceContext(data: any) {
  if (!isOtelEnabled()) return context.active();
  const carrier = data?.__trace;
  if (!carrier || typeof carrier !== "object") return context.active();
  return propagation.extract(context.active(), carrier as any);
}

// ── Span 创建工具 ──────────────────────────────────

/**
 * 创建一个 OTel span，安全包装（OTel 未启用时返回 noop span）。
 */
export function startSpan(name: string, opts?: SpanOptions): Span {
  return tracer.startSpan(name, opts);
}

/**
 * 在 span 上下文中执行函数。
 */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = tracer.startSpan(name);
  const ctx = trace.setSpan(context.active(), span);
  try {
    return await context.with(ctx, () => fn(span));
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

// ── HTTP 请求追踪头注入 ───────────────────────────

/**
 * 生成携带当前 trace context 的 HTTP headers（供跨服务 fetch 调用使用）。
 */
export function getTraceHeaders(traceId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (traceId) headers["x-trace-id"] = traceId;
  if (isOtelEnabled()) {
    propagation.inject(context.active(), headers);
  }
  return headers;
}

// ── WebSocket/SSE traceId 辅助 ──────────────────────

/**
 * 在 WS/SSE 消息中注入 traceId。
 */
export function injectTraceToPayload(payload: Record<string, unknown>, traceId?: string): Record<string, unknown> {
  if (traceId) payload.traceId = traceId;
  if (isOtelEnabled()) {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    if (Object.keys(carrier).length) {
      payload.__traceContext = carrier;
    }
  }
  return payload;
}

/**
 * 从消息 payload 中提取 trace context。
 */
export function extractTraceFromPayload(payload: any) {
  if (!isOtelEnabled()) return context.active();
  const carrier = payload?.__traceContext;
  if (!carrier || typeof carrier !== "object") return context.active();
  return propagation.extract(context.active(), carrier as any);
}

// ── Device-Agent 回调 traceId 传播 ───────────────

/**
 * 为设备执行任务附加 traceId，使得设备回调时可以带回关联。
 */
export function attachTraceToDeviceTask(taskPayload: Record<string, unknown>, traceId?: string): Record<string, unknown> {
  if (traceId) taskPayload.traceId = traceId;
  return taskPayload;
}
