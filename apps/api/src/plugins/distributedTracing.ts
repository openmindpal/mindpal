/**
 * P3-14: Fastify 分布式追踪插件
 *
 * 功能：
 * - 每个 HTTP 请求自动创建 OTel Span
 * - 请求完成时附加 status_code / method / route 属性
 * - 错误请求自动 recordException
 * - 响应中回写 x-trace-id / x-span-id 头（可视化友好）
 * - 安全降级：OTel 未启用时为 noop
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { context, trace, SpanStatusCode, propagation } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

const tracer = trace.getTracer("mindpal-api-http");

function isOtelEnabled(): boolean {
  const v = String(process.env.OTEL_ENABLED ?? "").toLowerCase();
  return v === "1" || v === "true";
}

export const distributedTracingPlugin: FastifyPluginAsync<{
  /** 忽略追踪的路径前缀 */
  ignorePaths?: string[];
}> = async (app, opts) => {
  const ignorePaths = new Set(opts.ignorePaths ?? ["/healthz", "/health/live", "/readyz", "/metrics"]);

  // ── 请求进入：创建 span ──
  app.addHook("onRequest", async (req, reply) => {
    // 跳过忽略路径
    const path = req.url.split("?")[0] ?? req.url;
    if (ignorePaths.has(path)) return;

    if (!isOtelEnabled()) {
      // 即使 OTel 未启用也回写 x-trace-id（来自请求头）
      const clientTraceId = req.headers["x-trace-id"] as string | undefined;
      if (clientTraceId) {
        reply.header("x-trace-id", clientTraceId);
      }
      return;
    }

    // 从传入请求头提取 trace context（支持 W3C TraceContext / Jaeger propagation）
    const parentCtx = propagation.extract(context.active(), req.headers);

    const span = tracer.startSpan(
      `${req.method} ${path}`,
      {
        attributes: {
          "http.method": req.method,
          "http.url": req.url,
          "http.target": path,
          "http.user_agent": req.headers["user-agent"] ?? "",
          "net.peer.ip": req.ip,
        },
      },
      parentCtx,
    );

    // 存储 span 到请求上下文
    const spanCtx = trace.setSpan(parentCtx, span);
    req._otelSpan = span;
    req._otelContext = spanCtx;

    // 将 traceId / spanId 回写到响应头
    const sc = span.spanContext();
    reply.header("x-trace-id", sc.traceId);
    reply.header("x-span-id", sc.spanId);

    // 同步到 req.ctx.traceId 供业务代码使用
    if (req.ctx) {
      req.ctx.traceId = sc.traceId;
    }
  });

  // ── 请求完成：结束 span ──
  app.addHook("onResponse", async (req, reply) => {
    const span = req._otelSpan;
    if (!span) return;

    span.setAttribute("http.status_code", reply.statusCode);

    // 标记路由模式（如 /entities/:entityId）
    const routePattern =
      (req.routeOptions?.url as string | undefined) ??
      ((req as unknown as Record<string, unknown>).routerPath as string | undefined);
    if (routePattern) {
      span.setAttribute("http.route", routePattern);
      // 更新 span name 为路由模式（更有辨识度）
      span.updateName(`${req.method} ${routePattern}`);
    }

    const durationMs = Date.now() - (req._startTime ?? Date.now());
    span.setAttribute("http.duration_ms", durationMs);

    if (reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${reply.statusCode}` });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  });

  // ── 错误处理：记录异常到 span ──
  app.addHook("onError", async (req, _reply, error) => {
    const span = req._otelSpan;
    if (!span) return;

    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

    // 附加错误属性
    if ('code' in error) span.setAttribute("error.code", String(error.code));
    if ('errorCode' in error) span.setAttribute("error.errorCode", String((error as unknown as { errorCode: string }).errorCode));
  });
};

/**
 * 在当前请求 span 上下文中执行异步函数（子 span）。
 * 用于在请求处理中创建嵌套的业务级 span。
 *
 * @example
 * ```ts
 * const result = await withRequestSpan(req, "db.query.entities", async (span) => {
 *   span.setAttribute("db.table", "entities");
 *   return await db.query(...);
 * });
 * ```
 */
export async function withRequestSpan<T>(
  req: FastifyRequest,
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parentCtx = req._otelContext ?? context.active();
  const span = tracer.startSpan(name, {}, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);

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

/**
 * 获取当前请求的 traceId（从 OTel span 或 x-trace-id 头）。
 */
export function getRequestTraceId(req: FastifyRequest): string | undefined {
  const span = req._otelSpan;
  if (span) return span.spanContext().traceId;
  return req?.ctx?.traceId || (req?.headers?.["x-trace-id"] as string | undefined);
}
