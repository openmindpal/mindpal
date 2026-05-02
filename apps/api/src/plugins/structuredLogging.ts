/**
 * P3-01: Fastify 结构化日志插件
 *
 * 功能：
 * - 请求级结构化日志（自动注入 traceId/requestId/tenantId）
 * - 请求完成时自动输出访问日志（含状态码、耗时）
 * - 路径级采样（/healthz, /readyz, /metrics 静默）
 * - 敏感字段自动脱敏
 * - 日志输出到 stdout，由 OTel Collector / 外部采集器统一收集
 */
import type { FastifyPluginAsync } from "fastify";
import {
  initializeServiceLogging,
  createModuleLogger,
  createRequestLogContext,
  getRootLogger,
} from "@mindpal/shared";
import type { LogLevel, SamplingRule } from "@mindpal/shared";

export const structuredLoggingPlugin: FastifyPluginAsync<{
  /** 最低日志级别 */
  minLevel?: LogLevel;
  /** 额外采样规则（追加到默认规则之后） */
  extraSamplingRules?: SamplingRule[];
  /** 是否美化输出（开发模式） */
  pretty?: boolean;
}> = async (app, opts) => {
  // 将额外采样规则转换为 Record<string, number>
  const extraSampling: Record<string, number> = {};
  for (const rule of opts.extraSamplingRules ?? []) {
    extraSampling[rule.pathPrefix] = rule.rate;
  }

  // 通过统一工厂初始化日志（封装采样规则合并、脱敏、全局注册）
  const rootLogger = initializeServiceLogging({
    serviceName: "api",
    level: opts.minLevel,
    pretty: opts.pretty,
    samplingRules: Object.keys(extraSampling).length > 0 ? extraSampling : undefined,
  });

  // 创建请求日志器
  const accessLog = createModuleLogger("api:access");

  // ── 请求开始：注入时间戳 ──────────────────────────────
  app.addHook("onRequest", async (req) => {
    req._startTime = Date.now();
  });

  // ── 请求完成：输出访问日志 ──────────────────────────────
  app.addHook("onResponse", async (req, reply) => {
    const startTime = req._startTime ?? Date.now();
    const durationMs = Date.now() - startTime;
    const statusCode = reply.statusCode;
    const method = req.method;
    const url = req.url;
    const path = url.split("?")[0] ?? url;

    const logCtx = createRequestLogContext(req);
    const reqLogger = accessLog.child(logCtx);

    const extra = {
      method,
      path,
      statusCode,
      durationMs,
      contentLength: reply.getHeader("content-length"),
    };

    if (statusCode >= 500) {
      reqLogger.error(`${method} ${path} ${statusCode} ${durationMs}ms`, extra);
    } else if (statusCode >= 400) {
      reqLogger.warn(`${method} ${path} ${statusCode} ${durationMs}ms`, extra);
    } else {
      reqLogger.info(`${method} ${path} ${statusCode} ${durationMs}ms`, extra);
    }
  });

  // ── 错误处理日志 ──────────────────────────────────────
  app.addHook("onError", async (req, _reply, error) => {
    const logCtx = createRequestLogContext(req);
    const errLogger = rootLogger.child({ ...logCtx, module: "api:error" });

    errLogger.error(`Request error: ${error.message}`, {
      errorCode: 'errorCode' in error ? String(error.errorCode) : ('code' in error ? String(error.code) : undefined),
      error: {
        message: error.message,
        stack: error.stack,
        code: 'code' in error ? String(error.code) : undefined,
      },
      method: req.method,
      path: req.url?.split("?")[0],
    });
  });

  rootLogger.info("Structured logging plugin initialized (via initializeServiceLogging)");
};
