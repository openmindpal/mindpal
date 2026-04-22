/**
 * 统一追踪上下文
 *
 * 提供跨服务的 Trace/Span 上下文传播能力。
 */
import { randomUUID } from "crypto";

export interface TraceContext {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
}

export function createTraceContext(seed?: Partial<TraceContext>): TraceContext {
  return {
    traceId: seed?.traceId ?? randomUUID(),
    spanId: seed?.spanId,
    parentSpanId: seed?.parentSpanId,
  };
}

export function injectTraceHeaders(ctx: TraceContext): Record<string, string> {
  const headers: Record<string, string> = { "x-trace-id": ctx.traceId };
  if (ctx.spanId) headers["x-span-id"] = ctx.spanId;
  if (ctx.parentSpanId) headers["x-parent-span-id"] = ctx.parentSpanId;
  return headers;
}

export function extractTraceContext(headers: Record<string, string | string[] | undefined>): TraceContext {
  const get = (key: string): string | undefined => {
    const v = headers[key];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    traceId: get("x-trace-id") ?? randomUUID(),
    spanId: get("x-span-id"),
    parentSpanId: get("x-parent-span-id"),
  };
}
