import Fastify from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import websocket from "@fastify/websocket";
import type { ApiConfig } from "./config";
import { createRedisClient } from "./modules/redis/client";
import { initServerTimers } from "./lib/serverTimers";
import { initRbacCacheSubscriber, stopRbacCacheSubscriber } from "./modules/auth/authz";
import { createMetricsRegistry } from "./modules/metrics/metrics";
import { structuredLoggingPlugin } from "./plugins/structuredLogging";
import { distributedTracingPlugin } from "./plugins/distributedTracing";
import { apiVersionPlugin } from "./plugins/apiVersioning";
import { realtimeNotificationPlugin } from "./plugins/realtimeNotification";
import { internalRoutes } from "./routes/system/internal";
import { createDbAuthProvider } from "./modules/auth/dbAuthProvider";
import { classifyAndRespond, isPgError } from "./serverErrorMap";
import { registerV1Routes } from "./serverRoutes";

function normalizePayloadDates(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizePayloadDates(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    output[key] = normalizePayloadDates(item, seen);
  }
  return output;
}

export function buildServer(cfg: ApiConfig, deps: { db: Pool; queue: Queue }) {
  const pluginTimeout = Math.max(Number(process.env.FASTIFY_PLUGIN_TIMEOUT_MS ?? 120_000) || 120_000, 60_000);
  const app = Fastify({
    logger: true,
    pluginTimeout,
    forceCloseConnections: true,
    bodyLimit: 30 * 1024 * 1024 /* 30MB，支持 base64 图片附件 */,
  });
  app.decorate("db", deps.db);
  app.decorate("queue", deps.queue);
  app.decorate("redis", createRedisClient(cfg));
  app.decorate("cfg", cfg);
  app.decorate("metrics", createMetricsRegistry());
  app.decorate("authProvider", createDbAuthProvider(deps.db));
  app.redis.on("error", (err) => {
    app.log.error({ err: err.message, stack: err.stack }, "redis connection error");
  });
  // 启动 RBAC 缓存 Pub/Sub 订阅（跨实例缓存失效）
  initRbacCacheSubscriber(app.redis).catch((err: unknown) => {
    app.log.error({ err: (err as Error).message }, "RBAC cache subscriber init failed, operating in degraded mode");
  });
  app.register(websocket);
  app.addContentTypeParser("application/scim+json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch (err) {
      done(err as Error);
    }
  });

  /* P3-01: 结构化日志插件（尽早注册，覆盖所有后续插件和路由） */
  app.register(structuredLoggingPlugin);

  /* P3-14: 分布式追踪插件（在日志之后、路由之前） */
  app.register(distributedTracingPlugin);

  /* P3-02: API 版本化过渡中间件 */
  app.register(apiVersionPlugin);

  /* P3-06a: WebSocket 实时通知插件 */
  app.register(realtimeNotificationPlugin);

  // ── 定时器：审计 outbox、队列 backlog、协同 backlog、Worker 指标 ──
  const timers = initServerTimers({ db: deps.db, queue: deps.queue, redis: app.redis, metrics: app.metrics, log: app.log });

  const corsAllowedMethods = "GET,POST,PUT,DELETE,OPTIONS";
  const corsAllowedHeaders =
    "content-type,authorization,x-tenant-id,x-space-id,x-user-locale,x-space-locale,x-tenant-locale,x-schema-name,x-trace-id,idempotency-key,x-csrf-token";
  // P2-1: 允许前端读取自定义响应头
  const corsExposeHeaders = "x-request-id,x-trace-id,x-ratelimit-remaining,x-ratelimit-reset";

  function isAllowedOrigin(origin: string) {
    const allowed = cfg.cors?.allowedOrigins ?? [];
    return allowed.includes(origin);
  }

  // ── CORS（全局，非 /v1 作用域） ──
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin as string | undefined;
    if (!origin) return;

    if (isAllowedOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("access-control-expose-headers", corsExposeHeaders);
      reply.header("vary", "origin");
    }

    if (req.method === "OPTIONS") {
      if (isAllowedOrigin(origin)) {
        reply.header("access-control-allow-methods", corsAllowedMethods);
        reply.header("access-control-allow-headers", corsAllowedHeaders);
        reply.header("access-control-max-age", "600");
        reply.code(204).send();
      } else {
        reply.code(403).send({ errorCode: "CORS_ORIGIN_DENIED", message: "Origin not allowed" });
      }
      return;
    }
  });

  // ── 全局清理 ──
  let shuttingDown = false;
  app.addHook("onClose", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    timers.stopAll();
    await stopRbacCacheSubscriber();
    const quit = app.redis.quit().catch(() => undefined);
    await Promise.race([
      quit,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    try {
      app.redis.disconnect();
    } catch {}
  });

  // ── 全局 preSerialization: Date → ISO 字符串 ──
  app.addHook("preSerialization", async (_req, _reply, payload) => {
    return normalizePayloadDates(payload);
  });

  // ── 统一错误处理 ──
  app.setErrorHandler(async (err, req, reply) => {
    req.log.error({ err, traceId: req.ctx?.traceId, requestId: req.ctx?.requestId }, "request_error");

    // PG schema mismatch 详细日志
    const pgCode = isPgError(err) ? err.code ?? "" : "";
    if (pgCode === "42P01" || pgCode === "42703") {
      req.log.error(
        {
          pgCode,
          pgMessage: isPgError(err) ? err.message ?? "" : "",
          pgDetail: isPgError(err) ? err.detail ?? "" : "",
          pgTable: isPgError(err) ? err.table ?? "" : "",
          pgColumn: isPgError(err) ? err.column ?? "" : "",
          route: req.routeOptions?.url ?? req.url,
          method: req.method,
          traceId: req.ctx?.traceId,
        },
        `[DB_SCHEMA_MISMATCH] PostgreSQL ${pgCode === "42P01" ? "undefined_table" : "undefined_column"}: ${isPgError(err) ? err.message ?? "" : ""}`,
      );
    }

    const { statusCode, body } = classifyAndRespond(err, req);
    return reply.status(statusCode).send(body);
  });

  // ── P2: 内部通信端点（Worker→API，不走标准认证链路）──
  app.register(internalRoutes);

  // ── 全局 /v1 版本化路由（开发阶段零兼容，所有业务路由统一挂 /v1 前缀） ──
  app.register(registerV1Routes, { prefix: "/v1" });

  return app;
}
