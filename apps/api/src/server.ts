import Fastify from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { ZodError } from "zod";
import { attachDlpSummary, redactValue, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "@openslin/shared";
import type { ApiConfig } from "./config";
import { Errors, isAppError } from "./lib/errors";
import { resolveRequestLocale } from "./lib/locale";
import { AuditContractError, insertAuditEvent, isHighRiskAuditAction, normalizeAuditErrorCategory } from "./modules/audit/auditRepo";
import { authenticate } from "./modules/auth/authn";
import { ensureSubject } from "./modules/auth/subjectRepo";
import { createRedisClient } from "./modules/redis/client";
import { getUserLocalePreference } from "./modules/memory/userPreferencesRepo";
import { getDeviceByTokenHash } from "./modules/devices/deviceRepo";
import { sha256Hex } from "./modules/devices/crypto";
import { auditRoutes } from "./routes/audit";
import { entityRoutes } from "./routes/entities";
import { effectiveSchemaRoutes } from "./routes/effectiveSchema";
import { healthRoutes } from "./routes/health";
import { jobRoutes } from "./routes/jobs";
import { meRoutes } from "./routes/me";
import { schemaRoutes } from "./routes/schemas";
import { toolRoutes } from "./routes/tools";
import { uiRoutes } from "./routes/ui";
import { workbenchRoutes } from "./routes/workbenches";
import { orchestratorRoutes } from "./routes/orchestrator";
import { connectorRoutes } from "./routes/connectors";
import { secretRoutes } from "./routes/secrets";
import { modelRoutes } from "./routes/models";
import { knowledgeRoutes } from "./routes/knowledge";
import { memoryRoutes } from "./routes/memory";
import { governanceRoutes } from "./routes/governance";
import { channelRoutes } from "./routes/channels";
import { syncRoutes } from "./routes/sync";
import { runRoutes } from "./routes/runs";
import { artifactRoutes } from "./routes/artifacts";
import { backupRoutes } from "./routes/backups";
import { policySnapshotRoutes } from "./routes/policySnapshots";
import { rbacRoutes } from "./routes/rbac";
import { approvalRoutes } from "./routes/approvals";
import { settingsRoutes } from "./routes/settings";
import { taskRoutes } from "./routes/tasks";
import { agentRuntimeRoutes } from "./routes/agentRuntime";
import { collabRuntimeRoutes } from "./routes/collabRuntime";
import { authTokenRoutes } from "./routes/authTokens";
import { oauthRoutes } from "./routes/oauth";
import { deviceRoutes } from "./routes/devices";
import { deviceAgentRoutes } from "./routes/deviceAgent";
import { deviceExecutionRoutes } from "./routes/deviceExecutions";
import { subscriptionRoutes } from "./routes/subscriptions";
import { notificationRoutes } from "./routes/notifications";
import { mediaRoutes } from "./routes/media";
import { keyringRoutes } from "./routes/keyring";
import { replayRoutes } from "./routes/replay";
import { metricsRoutes } from "./routes/metrics";
import { diagnosticsRoutes } from "./routes/diagnostics";
import { triggerRoutes } from "./routes/triggers";
import { createMetricsRegistry } from "./modules/metrics/metrics";
import { dispatchAuditOutboxBatch } from "./modules/audit/outboxRepo";

export function buildServer(cfg: ApiConfig, deps: { db: Pool; queue: Queue }) {
  const app = Fastify({ logger: true });
  app.decorate("db", deps.db);
  app.decorate("queue", deps.queue);
  app.decorate("redis", createRedisClient(cfg));
  app.decorate("cfg", cfg);
  app.decorate("metrics", createMetricsRegistry());
  const auditOutboxEnabled = process.env.AUDIT_OUTBOX_DISPATCHER === "0" ? false : true;
  const auditOutboxIntervalMs = Math.max(250, Number(process.env.AUDIT_OUTBOX_INTERVAL_MS ?? "1000") || 1000);
  const auditOutboxBatch = Math.max(1, Math.min(200, Number(process.env.AUDIT_OUTBOX_BATCH ?? "50") || 50));
  let lastOutboxBacklogAtMs = 0;
  const auditOutboxTimer =
    auditOutboxEnabled
      ? setInterval(() => {
          dispatchAuditOutboxBatch({ pool: app.db, limit: auditOutboxBatch })
            .then((r) => {
              app.metrics.incAuditOutboxDispatch({ result: "ok" }, r.ok);
              app.metrics.incAuditOutboxDispatch({ result: "failed" }, r.failed);
            })
            .catch(() => {
            });
          const now = Date.now();
          const interval = Math.max(1000, Number(process.env.AUDIT_OUTBOX_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
          if (now - lastOutboxBacklogAtMs >= interval) {
            lastOutboxBacklogAtMs = now;
            app.db
              .query("SELECT status, COUNT(*)::int AS c FROM audit_outbox GROUP BY status")
              .then((res) => {
                const map = new Map<string, number>();
                for (const row of res.rows) map.set(String((row as any).status), Number((row as any).c ?? 0));
                const statuses = ["queued", "processing", "succeeded", "failed"];
                for (const s of statuses) app.metrics.setAuditOutboxBacklog({ status: s, count: map.get(s) ?? 0 });
              })
              .catch(() => {
              });
          }
        }, auditOutboxIntervalMs)
      : null;
  if (auditOutboxTimer) auditOutboxTimer.unref();

  const queueBacklogIntervalMs = Math.max(1000, Number(process.env.WORKFLOW_QUEUE_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
  const canReadQueueCounts = Boolean(app.queue && typeof (app.queue as any).getJobCounts === "function");
  const queueBacklogTimer = canReadQueueCounts
    ? setInterval(() => {
        (app.queue as any)
          .getJobCounts("waiting", "active", "delayed", "failed")
          .then((c: any) => {
            const statuses = ["waiting", "active", "delayed", "failed"] as const;
            for (const s of statuses) app.metrics.setWorkflowQueueBacklog({ status: s, count: Number(c?.[s] ?? 0) });
          })
          .catch(() => {
          });
      }, queueBacklogIntervalMs)
    : null;
  if (queueBacklogTimer) queueBacklogTimer.unref();

  const collabBacklogIntervalMs = Math.max(1000, Number(process.env.COLLAB_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
  const collabBacklogTimer = setInterval(() => {
    Promise.all([
      app.db.query("SELECT status, COUNT(*)::int AS c FROM collab_runs GROUP BY status"),
      app.db.query("SELECT type, COUNT(*)::int AS c FROM collab_run_events WHERE created_at > now() - interval '1 hour' GROUP BY type"),
      app.db.query(
        `
          SELECT COALESCE(actor_role,'') AS actor_role, type, COUNT(*)::int AS c
          FROM collab_run_events
          WHERE created_at > now() - interval '1 hour'
            AND type IN ('collab.step.started','collab.step.completed','collab.step.failed','collab.policy.denied','collab.budget.exceeded','collab.run.needs_approval','collab.single_writer.violation')
          GROUP BY COALESCE(actor_role,''), type
        `,
      ),
      app.db.query(
        `
          SELECT AVG(EXTRACT(EPOCH FROM (r.finished_at - r.created_at)) * 1000)::float AS avg_ms
          FROM collab_runs cr
          JOIN runs r ON r.run_id = cr.primary_run_id
          WHERE r.finished_at IS NOT NULL AND r.finished_at > now() - interval '1 hour'
        `,
      ),
      app.db.query(
        `
          WITH d AS (
            SELECT COALESCE(e.actor_role,'') AS actor_role,
                   (EXTRACT(EPOCH FROM (s.finished_at - s.created_at)) * 1000)::float AS dur_ms
            FROM collab_run_events e
            JOIN steps s ON s.step_id = e.step_id
            WHERE e.type = 'collab.step.completed'
              AND s.finished_at IS NOT NULL
              AND s.finished_at > now() - interval '1 hour'
          )
          SELECT actor_role,
                 COUNT(*)::int AS c,
                 COALESCE(SUM(dur_ms), 0)::float AS sum_ms,
                 SUM(CASE WHEN dur_ms <= 5 THEN 1 ELSE 0 END)::int AS le_5,
                 SUM(CASE WHEN dur_ms <= 10 THEN 1 ELSE 0 END)::int AS le_10,
                 SUM(CASE WHEN dur_ms <= 25 THEN 1 ELSE 0 END)::int AS le_25,
                 SUM(CASE WHEN dur_ms <= 50 THEN 1 ELSE 0 END)::int AS le_50,
                 SUM(CASE WHEN dur_ms <= 100 THEN 1 ELSE 0 END)::int AS le_100,
                 SUM(CASE WHEN dur_ms <= 250 THEN 1 ELSE 0 END)::int AS le_250,
                 SUM(CASE WHEN dur_ms <= 500 THEN 1 ELSE 0 END)::int AS le_500,
                 SUM(CASE WHEN dur_ms <= 1000 THEN 1 ELSE 0 END)::int AS le_1000,
                 SUM(CASE WHEN dur_ms <= 2500 THEN 1 ELSE 0 END)::int AS le_2500,
                 SUM(CASE WHEN dur_ms <= 5000 THEN 1 ELSE 0 END)::int AS le_5000,
                 SUM(CASE WHEN dur_ms <= 10000 THEN 1 ELSE 0 END)::int AS le_10000
          FROM d
          GROUP BY actor_role
        `,
      ),
    ])
      .then(([backlogRes, evRes, roleAggRes, durRes, stepDurRes]) => {
        const map = new Map<string, number>();
        for (const row of backlogRes.rows) map.set(String((row as any).status), Number((row as any).c ?? 0));
        const statuses = ["created", "planning", "executing", "needs_approval", "succeeded", "failed", "canceled", "stopped"];
        for (const s of statuses) app.metrics.setCollabRunBacklog({ status: s, count: map.get(s) ?? 0 });

        const evMap = new Map<string, number>();
        for (const row of evRes.rows) evMap.set(String((row as any).type), Number((row as any).c ?? 0));
        const types = [
          "collab.run.created",
          "collab.plan.generated",
          "collab.step.started",
          "collab.step.completed",
          "collab.step.failed",
          "collab.run.needs_approval",
          "collab.policy.denied",
          "collab.budget.exceeded",
          "collab.run.succeeded",
          "collab.run.failed",
          "collab.run.canceled",
          "collab.run.stopped",
        ];
        for (const t of types) app.metrics.setCollabEventCount1h({ type: t, count: evMap.get(t) ?? 0 });

        const avgMs = durRes.rowCount ? Number((durRes.rows[0] as any).avg_ms ?? 0) : 0;
        app.metrics.setCollabRunDurationAvgMs1h({ value: Number.isFinite(avgMs) ? avgMs : 0 });

        const roleStepMap = new Map<string, { started: number; completed: number; failed: number; blocked: Record<string, number>; approval: number; violation: number }>();
        function slot(role: string) {
          const k = role || "";
          const cur = roleStepMap.get(k);
          if (cur) return cur;
          const v = { started: 0, completed: 0, failed: 0, blocked: { policy_denied: 0, budget_exceeded: 0 }, approval: 0, violation: 0 };
          roleStepMap.set(k, v);
          return v;
        }
        for (const row of roleAggRes.rows as any[]) {
          const role = String(row.actor_role ?? "");
          const type = String(row.type ?? "");
          const c = Number(row.c ?? 0);
          const s = slot(role);
          if (type === "collab.step.started") s.started += c;
          else if (type === "collab.step.completed") s.completed += c;
          else if (type === "collab.step.failed") s.failed += c;
          else if (type === "collab.policy.denied") s.blocked.policy_denied += c;
          else if (type === "collab.budget.exceeded") s.blocked.budget_exceeded += c;
          else if (type === "collab.run.needs_approval") s.approval += c;
          else if (type === "collab.single_writer.violation") s.violation += c;
        }
        for (const [role, s] of roleStepMap.entries()) {
          app.metrics.setCollabStepsTotal({ actorRole: role, status: "started", count: s.started });
          app.metrics.setCollabStepsTotal({ actorRole: role, status: "completed", count: s.completed });
          app.metrics.setCollabStepsTotal({ actorRole: role, status: "failed", count: s.failed });
          app.metrics.setCollabBlockedTotal({ actorRole: role, reason: "policy_denied", count: s.blocked.policy_denied });
          app.metrics.setCollabBlockedTotal({ actorRole: role, reason: "budget_exceeded", count: s.blocked.budget_exceeded });
          app.metrics.setCollabBlockedTotal({ actorRole: role, reason: "single_writer_violation", count: s.violation });
          app.metrics.setCollabNeedsApprovalTotal({ actorRole: role, count: s.approval });
        }

        for (const row of stepDurRes.rows as any[]) {
          const role = String(row.actor_role ?? "");
          const count = Number(row.c ?? 0);
          const sumMs = Number(row.sum_ms ?? 0);
          app.metrics.setCollabStepDurationCount1h({ actorRole: role, count });
          app.metrics.setCollabStepDurationSumMs1h({ actorRole: role, sumMs: Number.isFinite(sumMs) ? sumMs : 0 });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "5", count: Number(row.le_5 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "10", count: Number(row.le_10 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "25", count: Number(row.le_25 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "50", count: Number(row.le_50 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "100", count: Number(row.le_100 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "250", count: Number(row.le_250 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "500", count: Number(row.le_500 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "1000", count: Number(row.le_1000 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "2500", count: Number(row.le_2500 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "5000", count: Number(row.le_5000 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "10000", count: Number(row.le_10000 ?? 0) });
          app.metrics.setCollabStepDurationBucket1h({ actorRole: role, le: "+Inf", count });
        }
      })
      .catch(() => {
      });
  }, collabBacklogIntervalMs);
  collabBacklogTimer.unref();

  const workerMetricsIntervalMs = Math.max(1000, Number(process.env.WORKER_METRICS_INTERVAL_MS ?? "10000") || 10000);
  const workerMetricsTimer = setInterval(() => {
    Promise.all([
      app.redis.get("worker:heartbeat:ts"),
      app.redis.get("worker:workflow:step:success"),
      app.redis.get("worker:workflow:step:error"),
      app.redis.get("worker:tool_execute:success"),
      app.redis.get("worker:tool_execute:error"),
    ])
      .then(([hb, ok, err, toolOk, toolErr]) => {
        const ts = hb ? Number(hb) : NaN;
        const ageSec = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 1000) : 1e9;
        app.metrics.setWorkerHeartbeatAgeSeconds({ worker: "workflow", ageSeconds: ageSec });
        app.metrics.setWorkerWorkflowStepCount({ result: "success", count: ok ? Number(ok) : 0 });
        app.metrics.setWorkerWorkflowStepCount({ result: "error", count: err ? Number(err) : 0 });
        app.metrics.setWorkerToolExecuteCount({ result: "success", count: toolOk ? Number(toolOk) : 0 });
        app.metrics.setWorkerToolExecuteCount({ result: "error", count: toolErr ? Number(toolErr) : 0 });
      })
      .catch(() => {
      });
  }, workerMetricsIntervalMs);
  workerMetricsTimer.unref();

  const corsAllowedMethods = "GET,POST,PUT,DELETE,OPTIONS";
  const corsAllowedHeaders =
    "content-type,authorization,x-tenant-id,x-space-id,x-user-locale,x-space-locale,x-tenant-locale,x-schema-name,x-trace-id,idempotency-key";

  function isAllowedOrigin(origin: string) {
    const allowed = cfg.cors?.allowedOrigins ?? [];
    return allowed.includes(origin);
  }

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin as string | undefined;
    if (!origin) return;

    if (isAllowedOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
    }

    if (req.method === "OPTIONS") {
      if (isAllowedOrigin(origin)) {
        reply.header("access-control-allow-methods", corsAllowedMethods);
        reply.header("access-control-allow-headers", corsAllowedHeaders);
        reply.header("access-control-max-age", "600");
      }
      reply.code(204).send();
      return;
    }
  });

  function digestBody(body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const keys = Object.keys(body as any);
    return { keys: keys.slice(0, 50), keyCount: keys.length };
  }

  function digestPayload(payload: unknown) {
    if (typeof payload === "string") return { length: payload.length };
    if (payload && Buffer.isBuffer(payload)) return { length: payload.length };
    return undefined;
  }

  function mergeOutputDigest(existing: unknown, patch: unknown) {
    if (!patch) return existing;
    if (!existing) return patch;
    if (typeof existing !== "object" || Array.isArray(existing)) return existing;
    if (typeof patch !== "object" || Array.isArray(patch)) return existing;
    if (Object.prototype.hasOwnProperty.call(existing, "length")) return existing;
    return { ...(existing as any), ...(patch as any) };
  }

  function resolveAuditCorrelation(req: any) {
    const audit = req?.ctx?.audit as any;
    const runId = String(audit?.runId ?? "").trim() || null;
    const stepId = String(audit?.stepId ?? "").trim() || null;
    const policySnapshotRef = String(audit?.policySnapshotRef ?? "").trim() || null;
    return { runId, stepId, policySnapshotRef };
  }

  function buildAuditContextRequiredResponse(params: { req: any; missing: string[] }) {
    return {
      errorCode: "AUDIT_CONTEXT_REQUIRED",
      message: {
        "zh-CN": "高风险动作缺少审计上下文",
        "en-US": "High-risk action missing audit context",
      },
      details: { missing: params.missing },
      traceId: params.req.ctx.traceId,
      requestId: params.req.ctx.requestId,
    };
  }

  async function tryWriteAuditEvent(params: { req: any; reply: any; result: "success" | "denied" | "error"; latencyMs?: number }) {
    const audit = params.req.ctx.audit;
    const corr = resolveAuditCorrelation(params.req);
    const missing: string[] = [];
    if (isHighRiskAuditAction({ resourceType: audit.resourceType, action: audit.action })) {
      if (!corr.runId) missing.push("runId");
      if (!corr.stepId) missing.push("stepId");
      if (!corr.policySnapshotRef) missing.push("policySnapshotRef");
      if (missing.length > 0) {
        audit.errorCategory = "policy_violation";
        params.reply.status(409);
        return buildAuditContextRequiredResponse({ req: params.req, missing });
      }
    }
    try {
      await insertAuditEvent(app.db, {
        subjectId: params.req.ctx.subject?.subjectId,
        tenantId: params.req.ctx.subject?.tenantId,
        spaceId: params.req.ctx.subject?.spaceId,
        resourceType: audit.resourceType,
        action: audit.action,
        toolRef: audit.toolRef,
        workflowRef: audit.workflowRef,
        policyDecision: audit.policyDecision,
        inputDigest: audit.inputDigest,
        outputDigest: audit.outputDigest,
        idempotencyKey: audit.idempotencyKey,
        result: params.result,
        traceId: params.req.ctx.traceId,
        requestId: params.req.ctx.requestId,
        runId: corr.runId ?? undefined,
        stepId: corr.stepId ?? undefined,
        policySnapshotRef: corr.policySnapshotRef ?? undefined,
        errorCategory: normalizeAuditErrorCategory(audit.errorCategory) ?? undefined,
        latencyMs: params.latencyMs,
      });
      (audit as any).auditWritten = true;
      return null;
    } catch (e: any) {
      if (e instanceof AuditContractError && e.errorCode === "AUDIT_CONTEXT_REQUIRED") {
        audit.errorCategory = "policy_violation";
        params.reply.status(409);
        const missingFromError = Array.isArray((e as any).details?.missing) ? ((e as any).details.missing as string[]) : ["runId", "stepId", "policySnapshotRef"];
        return buildAuditContextRequiredResponse({ req: params.req, missing: missingFromError });
      }
      const mustSucceed = audit.action !== "read";
      if (mustSucceed) {
        audit.skipAuditWrite = true;
        app.metrics.incAuditWriteFailed({ errorCode: "AUDIT_WRITE_FAILED" });
        params.reply.status(500);
        return {
          errorCode: "AUDIT_WRITE_FAILED",
          message: Errors.auditWriteFailed().messageI18n,
          traceId: params.req.ctx.traceId,
          requestId: params.req.ctx.requestId,
        };
      }
      params.req.log.error({ err: e, traceId: params.req.ctx.traceId, requestId: params.req.ctx.requestId }, "audit_write_failed");
      return null;
    }
  }

  app.addHook("onRequest", async (req) => {
    const traceId = (req.headers["x-trace-id"] as string | undefined) ?? uuidv4();
    const requestId = uuidv4();
    const locale = resolveRequestLocale({
      userLocale: req.headers["x-user-locale"] as string | undefined,
      spaceLocale: req.headers["x-space-locale"] as string | undefined,
      tenantLocale: req.headers["x-tenant-locale"] as string | undefined,
      acceptLanguage: req.headers["accept-language"] as string | undefined,
      platformLocale: cfg.platformLocale,
    });
    req.ctx = { traceId, requestId, locale };
  });

  app.addHook("onRequest", async (req) => {
    const subject = await authenticate({ pool: app.db, authorization: req.headers.authorization });
    if (!subject) return;
    req.ctx.subject = subject;
  });

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/device-agent")) return;
    const auth = req.headers.authorization ?? "";
    const token = auth.toLowerCase().startsWith("device ") ? auth.slice("device ".length).trim() : "";
    if (!token) return;
    const device = await getDeviceByTokenHash({ pool: app.db, deviceTokenHash: sha256Hex(token) });
    if (!device) return;
    (req.ctx as any).device = device;
  });

  app.addHook("onRequest", async (req) => {
    const subject = req.ctx.subject;
    if (!subject) return;
    const ensured = await ensureSubject({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    if (!ensured.ok) throw Errors.unauthorized(req.ctx.locale);
  });

  app.addHook("onRequest", async (req) => {
    const subject = req.ctx.subject;
    if (!subject) return;
    const userLocaleHeader = req.headers["x-user-locale"] as string | undefined;
    const spaceLocaleHeader = req.headers["x-space-locale"] as string | undefined;
    const tenantLocaleHeader = req.headers["x-tenant-locale"] as string | undefined;

    let tenantDefaultLocale: string | undefined;
    const tenantRes = await app.db.query("SELECT default_locale FROM tenants WHERE id = $1 LIMIT 1", [subject.tenantId]);
    if (tenantRes.rowCount) tenantDefaultLocale = tenantRes.rows[0].default_locale as string;

    let spaceDefaultLocale: string | undefined;
    if (subject.spaceId) {
      const spaceRes = await app.db.query("SELECT default_locale FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [subject.spaceId, subject.tenantId]);
      if (spaceRes.rowCount) spaceDefaultLocale = spaceRes.rows[0].default_locale as string;
    }

    const userPrefLocale = userLocaleHeader
      ? null
      : await getUserLocalePreference({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });

    req.ctx.locale = resolveRequestLocale({
      userLocale: userLocaleHeader ?? userPrefLocale ?? undefined,
      spaceLocale: spaceLocaleHeader ?? spaceDefaultLocale,
      tenantLocale: tenantLocaleHeader ?? tenantDefaultLocale,
      acceptLanguage: req.headers["accept-language"] as string | undefined,
      platformLocale: cfg.platformLocale,
    });
  });

  app.addHook("onRequest", async (req) => {
    req.ctx.audit ??= {};
    req.ctx.audit.startedAtMs = Date.now();
    req.ctx.audit.inputDigest = digestBody(req.body);
    req.ctx.audit.idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      req.ctx.audit.idempotencyKey;
  });

  app.addHook("onError", async (req, _reply, err) => {
    req.ctx.audit ??= {};
    req.ctx.audit.lastError = err;
  });

  app.addHook("preSerialization", async (req, reply, payload) => {
    const dlpPolicy = resolveDlpPolicyFromEnv(process.env);
    const target = req.ctx.audit?.resourceType && req.ctx.audit?.action ? `${req.ctx.audit.resourceType}:${req.ctx.audit.action}` : "";
    const scanned = redactValue(payload);
    const denied = shouldDenyDlpForTarget({ summary: scanned.summary, target, policy: dlpPolicy });
    if (denied) {
      req.ctx.audit ??= {};
      req.ctx.audit.errorCategory = "policy_violation";
      reply.status(403);
      payload = {
        errorCode: "DLP_DENIED",
        message: Errors.dlpDenied().messageI18n,
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      };
    } else {
      payload = scanned.value;
    }

    if (payload && typeof payload === "object" && !Array.isArray(payload) && !Buffer.isBuffer(payload)) {
      const out: any = payload as any;
      if (out.traceId === undefined) out.traceId = req.ctx.traceId;
      if (out.requestId === undefined) out.requestId = req.ctx.requestId;
    }

    const audit = req.ctx.audit;
    if (!audit?.resourceType || !audit?.action) return payload;

    audit.outputDigest ??= digestPayload(payload) ?? digestBody(payload);
    const redactedIn = redactValue(audit.inputDigest);
    audit.inputDigest = redactedIn.value;
    const redactedOut = redactValue(audit.outputDigest);
    const dlpSummary = denied
      ? { ...scanned.summary, disposition: "deny" as const, redacted: true, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version }
      : scanned.summary.redacted
        ? { ...scanned.summary, disposition: "redact" as const, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version }
        : { ...redactedOut.summary, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version };
    const outWithDlp = attachDlpSummary(redactedOut.value, dlpSummary);
    if (outWithDlp && typeof outWithDlp === "object" && !Array.isArray(outWithDlp) && !Buffer.isBuffer(outWithDlp)) {
      const obj: any = outWithDlp as any;
      if (obj.safetySummary && typeof obj.safetySummary === "object" && !Array.isArray(obj.safetySummary)) {
        const ss: any = obj.safetySummary;
        if (!ss.dlpSummary) ss.dlpSummary = dlpSummary;
        if (!ss.decision) ss.decision = denied ? "denied" : "allowed";
      } else if (obj.safetySummary === undefined) {
        obj.safetySummary = { decision: denied ? "denied" : "allowed", dlpSummary };
      }
    }
    audit.outputDigest = outWithDlp;

    const latencyMs = audit.startedAtMs ? Date.now() - audit.startedAtMs : undefined;
    const result =
      reply.statusCode >= 200 && reply.statusCode < 400
        ? "success"
        : reply.statusCode === 401 || reply.statusCode === 403
          ? "denied"
          : "error";

    if (audit.requireOutbox && result === "success" && !audit.outboxEnqueued) {
      audit.errorCategory ??= "internal_error";
      app.metrics.incAuditWriteFailed({ errorCode: "AUDIT_OUTBOX_REQUIRED" });
      reply.status(500);
      return {
        errorCode: "AUDIT_OUTBOX_REQUIRED",
        message: Errors.auditOutboxRequired().messageI18n,
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      };
    }

    if (audit.skipAuditWrite) return payload;

    const auditWriteOut = await tryWriteAuditEvent({ req, reply, result, latencyMs });
    if (auditWriteOut) {
      if (typeof payload === "string" || Buffer.isBuffer(payload)) {
        reply.header("content-type", "application/json; charset=utf-8");
        return JSON.stringify(auditWriteOut);
      }
      return auditWriteOut;
    }

    return payload;
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const audit = req.ctx.audit;
    if (!audit?.resourceType || !audit?.action) return payload;
    if ((audit as any).auditWritten) return payload;

    audit.outputDigest = mergeOutputDigest(audit.outputDigest, digestPayload(payload) ?? digestBody(payload));

    const latencyMs = audit.startedAtMs ? Date.now() - audit.startedAtMs : undefined;
    const result =
      reply.statusCode >= 200 && reply.statusCode < 400
        ? "success"
        : reply.statusCode === 401 || reply.statusCode === 403
          ? "denied"
          : "error";

    if (audit.requireOutbox && result === "success" && !audit.outboxEnqueued) {
      audit.errorCategory ??= "internal_error";
      app.metrics.incAuditWriteFailed({ errorCode: "AUDIT_OUTBOX_REQUIRED" });
      reply.status(500);
      return {
        errorCode: "AUDIT_OUTBOX_REQUIRED",
        message: Errors.auditOutboxRequired().messageI18n,
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      };
    }

    if (audit.skipAuditWrite) return payload;

    const auditWriteOut = await tryWriteAuditEvent({ req, reply, result, latencyMs });
    if (auditWriteOut) {
      if (typeof payload === "string" || Buffer.isBuffer(payload)) {
        reply.header("content-type", "application/json; charset=utf-8");
        return JSON.stringify(auditWriteOut);
      }
      return auditWriteOut;
    }

    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const startedAtMs = req.ctx.audit?.startedAtMs ?? Date.now();
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    const method = req.method;
    const route =
      ((req as any).routeOptions?.url as string | undefined) ??
      ((req as any).routerPath as string | undefined) ??
      "unmatched";
    app.metrics.observeRequest({ method, route, statusCode: reply.statusCode, latencyMs });

    const pd = req.ctx.audit?.policyDecision as any;
    if (reply.statusCode === 403 && pd && String(pd.decision ?? "") === "deny" && req.ctx.audit?.resourceType && req.ctx.audit?.action) {
      app.metrics.incAuthzDenied({ resourceType: req.ctx.audit.resourceType, action: req.ctx.audit.action });
    }
  });

  app.addHook("onClose", async () => {
    if (auditOutboxTimer) clearInterval(auditOutboxTimer);
    if (queueBacklogTimer) clearInterval(queueBacklogTimer);
    clearInterval(workerMetricsTimer);
    await app.redis.quit();
  });

  app.setErrorHandler(async (err, req, reply) => {
    req.log.error({ err, traceId: req.ctx?.traceId, requestId: req.ctx?.requestId }, "request_error");
    const appErr = err instanceof ZodError ? Errors.badRequest("参数校验失败") : isAppError(err) ? err : Errors.internal();
    const status = appErr.httpStatus;
    const auditSafetySummary = (() => {
      const digest = req.ctx?.audit?.outputDigest as any;
      if (!digest || typeof digest !== "object") return undefined;
      const ss = digest.safetySummary;
      if (!ss || typeof ss !== "object" || Array.isArray(ss)) return undefined;
      return ss;
    })();
    const payload: any = {
      errorCode: appErr.errorCode,
      message: appErr.messageI18n,
      traceId: req.ctx?.traceId,
      requestId: req.ctx?.requestId,
    };
    if (auditSafetySummary) payload.safetySummary = auditSafetySummary;

    return reply.status(status).send(payload);
  });

  app.register(healthRoutes);
  app.register(diagnosticsRoutes);
  app.register(metricsRoutes);
  app.register(meRoutes);
  app.register(authTokenRoutes);
  app.register(collabRuntimeRoutes);
  app.register(auditRoutes);
  app.register(entityRoutes);
  app.register(effectiveSchemaRoutes);
  app.register(jobRoutes);
  app.register(schemaRoutes);
  app.register(toolRoutes);
  app.register(uiRoutes);
  app.register(workbenchRoutes);
  app.register(orchestratorRoutes);
  app.register(connectorRoutes);
  app.register(secretRoutes);
  app.register(modelRoutes);
  app.register(knowledgeRoutes);
  app.register(memoryRoutes);
  app.register(governanceRoutes);
  app.register(channelRoutes);
  app.register(syncRoutes);
  app.register(runRoutes);
  app.register(replayRoutes);
  app.register(artifactRoutes);
  app.register(backupRoutes);
  app.register(policySnapshotRoutes);
  app.register(rbacRoutes);
  app.register(approvalRoutes);
  app.register(settingsRoutes);
  app.register(taskRoutes);
  app.register(agentRuntimeRoutes);
  app.register(triggerRoutes);
  app.register(oauthRoutes);
  app.register(deviceRoutes);
  app.register(deviceAgentRoutes);
  app.register(deviceExecutionRoutes);
  app.register(subscriptionRoutes);
  app.register(notificationRoutes);
  app.register(mediaRoutes);
  app.register(keyringRoutes);

  return app;
}
