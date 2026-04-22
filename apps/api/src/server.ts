import Fastify from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { ZodError } from "zod";
import websocket from "@fastify/websocket";
import type { ApiConfig } from "./config";
import { Errors, isAppError, ServiceError, ErrorCategory, classifyError, toHttpResponse } from "./lib/errors";
import { createRedisClient } from "./modules/redis/client";
import { initServerTimers } from "./lib/serverTimers";
import { initRbacCacheSubscriber, stopRbacCacheSubscriber } from "./modules/auth/authz";
import { getBuiltinSkills, runStartupConsistencyCheck } from "./lib/skillPlugin";
import { initBuiltinSkills, checkSkillLayerConsistency } from "./skills/registry";
import { createMetricsRegistry } from "./modules/metrics/metrics";
import { structuredLoggingPlugin } from "./plugins/structuredLogging";
import { distributedTracingPlugin } from "./plugins/distributedTracing";
import { apiVersionPlugin } from "./plugins/apiVersioning";
import { realtimeNotificationPlugin } from "./plugins/realtimeNotification";
import { autoDiscoverAndRegisterTools } from "./modules/tools/toolAutoDiscovery";
import { runBoundaryScan, formatBoundaryScanReport } from "./lib/startupBoundaryScan";
import { internalRoutes } from "./routes/internal";
import { createDbAuthProvider } from "./modules/auth/dbAuthProvider";

// ── Middleware (3 阶段) ──
import { authMiddleware } from "./middleware/authMiddleware";
import { observabilityMiddleware } from "./middleware/observabilityMiddleware";
import { contextMiddleware } from "./middleware/contextMiddleware";

// ── 路由分组入口 ──
import { registerAllRoutes } from "./routes/index";

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
  app.redis.on("error", () => undefined);
  // 启动 RBAC 缓存 Pub/Sub 订阅（跨实例缓存失效）
  initRbacCacheSubscriber(app.redis).catch(() => {});
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
    "content-type,authorization,x-tenant-id,x-space-id,x-user-locale,x-space-locale,x-tenant-locale,x-schema-name,x-trace-id,idempotency-key";
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
  app.addHook("onClose", async () => {
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
    const pgCode = typeof (err as any)?.code === "string" ? String((err as any).code) : "";

    // 42P01/42703: 输出详细缺失表/列名到日志，加速问题定位
    if (pgCode === "42P01" || pgCode === "42703") {
      const pgMessage = (err as any)?.message ?? "";
      const pgDetail = (err as any)?.detail ?? "";
      const pgTable = (err as any)?.table ?? "";
      const pgColumn = (err as any)?.column ?? "";
      req.log.error(
        {
          pgCode,
          pgMessage,
          pgDetail,
          pgTable,
          pgColumn,
          route: req.routeOptions?.url ?? req.url,
          method: req.method,
          traceId: req.ctx?.traceId,
        },
        `[DB_SCHEMA_MISMATCH] PostgreSQL ${pgCode === "42P01" ? "undefined_table" : "undefined_column"}: ${pgMessage}`,
      );
    }

    // ZodError → ServiceError(INVALID_REQUEST)
    if (err instanceof ZodError) {
      const svcErr = new ServiceError({
        category: ErrorCategory.INVALID_REQUEST,
        code: "BAD_REQUEST",
        httpStatus: 400,
        message: "参数校验失败",
        details: { zodIssues: err.issues },
      });
      const resp = toHttpResponse(svcErr);
      return reply.status(resp.statusCode).send({
        ...resp.body,
        traceId: req.ctx?.traceId,
        requestId: req.ctx?.requestId,
      });
    }

    // AppError（继承自 ServiceError）→ 保留 i18n 格式
    if (isAppError(err)) {
      const status = err.httpStatus;
      const auditSafetySummary = (() => {
        const digest = req.ctx?.audit?.outputDigest as any;
        if (!digest || typeof digest !== "object") return undefined;
        const ss = digest.safetySummary;
        if (!ss || typeof ss !== "object" || Array.isArray(ss)) return undefined;
        return ss;
      })();
      const payload: any = {
        errorCode: err.errorCode,
        message: err.messageI18n,
        traceId: req.ctx?.traceId,
        requestId: req.ctx?.requestId,
      };
      if (auditSafetySummary) payload.safetySummary = auditSafetySummary;
      return reply.status(status).send(payload);
    }

    // PG 错误 → 对应 AppError
    const appErr =
      pgCode === "22P02"
        ? Errors.badRequest("ID 格式非法")
        : pgCode === "23503"
          ? Errors.badRequest("关联记录不存在")
          : pgCode === "42P01" || pgCode === "42703"
            ? Errors.serviceNotReady(`数据库结构未初始化或版本不匹配 (${pgCode === "42P01" ? "缺少表" : "缺少列"}: ${(err as any)?.message?.match(/(?:relation|column)\s+"([^"]+)"/)?.[1] ?? "unknown"})`)
            : null;

    if (appErr) {
      return reply.status(appErr.httpStatus).send({
        errorCode: appErr.errorCode,
        message: appErr.messageI18n,
        traceId: req.ctx?.traceId,
        requestId: req.ctx?.requestId,
      });
    }

    // 兜底：通过 classifyError 统一分类
    const svcErr = classifyError(err);
    const resp = toHttpResponse(svcErr);
    return reply.status(resp.statusCode).send({
      ...resp.body,
      traceId: req.ctx?.traceId,
      requestId: req.ctx?.requestId,
    });
  });

  // ── P2: 内部通信端点（Worker→API，不走标准认证链路）──
  app.register(internalRoutes);

  // ── 全局 /v1 版本化路由（开发阶段零兼容，所有业务路由统一挂 /v1 前缀） ──
  app.register(async (scoped) => {
    // 中间件按阶段注册（顺序重要）
    authMiddleware(scoped);        // Phase 1: 认证与授权
    observabilityMiddleware(scoped); // Phase 2: 审计、DLP、指标
    contextMiddleware(scoped);     // Phase 3: 业务上下文、租户隔离/配额

    // ── 分组路由注册 ──
    await registerAllRoutes(scoped);

    // ── Built-in Skill Routes (auto-discovered) ────────────────────
    const skillLoadResult = await initBuiltinSkills();
    if (skillLoadResult.degraded) {
      app.log.error(`[SkillRegistry] DEGRADED: ${skillLoadResult.errors.length} plugin(s) failed to load`);
      for (const e of skillLoadResult.errors) app.log.error(`  - ${e}`);
    }

    const startupCheck = runStartupConsistencyCheck();
    if (startupCheck.warnings.length > 0) {
      for (const w of startupCheck.warnings) app.log.warn(w);
    }
    if (!startupCheck.ok) {
      for (const e of startupCheck.errors) app.log.error(e);
      throw new Error(`[startup] Skill registry consistency check failed: ${startupCheck.errors.join("; ")}`);
    }
    app.log.info(startupCheck.summary, "[startup] Skill registry consistency check passed");

    // ── Skill Layer Consistency Check ─────────────────────────────
    const layerCheck = await checkSkillLayerConsistency();
    if (!layerCheck.ok) {
      app.log.warn({ mismatches: layerCheck.layerMismatches, orphans: layerCheck.orphanedDirs }, layerCheck.summary);
    } else {
      app.log.info(layerCheck.summary);
    }

    try {
      const srcRoot = __dirname;
      const scanResult = runBoundaryScan(srcRoot);
      if (!scanResult.ok || scanResult.warnings.length > 0) {
        app.log.warn(formatBoundaryScanReport(scanResult));
      }
      app.log.info(
        { scannedFiles: scanResult.scannedFiles, violations: scanResult.violations.length, ok: scanResult.ok },
        "[startup] Module boundary scan completed",
      );
    } catch (e: any) {
      app.log.warn({ err: e?.message }, "[startup] Module boundary scan skipped (non-fatal)");
    }

    // ── Built-in Skill Routes（统一注册在 /v1 作用域下） ────────
    const registeredSkills: string[] = [];
    for (const [name, skill] of getBuiltinSkills()) {
      scoped.register(skill.routes);
      registeredSkills.push(name);
    }
    app.log.info({ registeredSkills: registeredSkills.length, skills: registeredSkills }, "[startup] Built-in skills registered");

    try {
      const discovery = await autoDiscoverAndRegisterTools(app.db);
      app.log.info({ registered: discovery.registered, skipped: discovery.skipped }, "[startup] Tool discovery completed");
    } catch (e: any) {
      app.log.error({ err: e }, "[startup] Tool discovery failed (non-fatal)");
    }

    try {
      const bindingRes = await app.db.query<{ model_ref: string; status: string }>(
        `SELECT model_ref, status FROM provider_bindings WHERE status = 'enabled' LIMIT 10`
      );
      const enabledCount = bindingRes.rowCount ?? 0;
      if (enabledCount === 0) {
        app.log.warn(
          "[startup] ⚠️ 未找到任何已启用的模型绑定 (provider_bindings)\u3002" +
          "编排/意图分类/工具建议等功能将无法正常工作。" +
          "请通过 [设置 > 模型接入] 配置至少一个模型绑定。"
        );
      } else {
        const refs = bindingRes.rows.map(r => r.model_ref);
        app.log.info({ count: enabledCount, models: refs }, "[startup] Model bindings check passed");
      }
    } catch (e: any) {
      app.log.warn({ err: e?.message }, "[startup] Model bindings check skipped (table may not exist)");
    }
  }, { prefix: "/v1" });

  return app;
}
