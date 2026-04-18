/**
 * P2: Internal API Routes — Worker→API 内部通信端点
 *
 * 这些端点不走标准的认证/审计中间件链路，而是通过
 * x-internal-secret header 进行内部身份验证。
 *
 * 当前端点：
 *   POST /internal/loop-resume             — 恢复中断的 Agent Loop
 *   POST /internal/tool-discovery/rescan   — 手动触发 Skill 包重新扫描
 *   GET  /internal/health                  — 节点可达性检查
 *   POST /internal/alertmanager-webhook     — Alertmanager 告警接收
 */
import type { FastifyPluginAsync } from "fastify";
import { runAgentLoop, type AgentLoopParams } from "../kernel/agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";
import { rescanAndRegisterTools } from "../modules/tools/toolAutoDiscovery";
import { invalidateToolCatalogQueryCache } from "../modules/agentContext";

/* ================================================================== */
/*  Configuration                                                       */
/* ================================================================== */

/** 用于 Worker→API 内部通信的共享密钥 */
function getInternalSecret(): string {
  return process.env.INTERNAL_API_SECRET ?? process.env.API_SECRET ?? "";
}

/* ================================================================== */
/*  Payload Types (mirrors loopResumeHandler.ts LoopResumePayload)      */
/* ================================================================== */

interface LoopResumeBody {
  loopId: string;
  runId: string;
  jobId: string;
  taskId: string | null;
  tenantId: string;
  spaceId: string | null;
  goal: string;
  maxIterations: number;
  maxWallTimeMs: number;
  subjectPayload: Record<string, unknown>;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  defaultModelRef: string | null;
  executionConstraints?: {
    allowedTools?: string[];
    allowWrites?: boolean;
  } | null;
  resumeState: {
    iteration: number;
    currentSeq: number;
    succeededSteps: number;
    failedSteps: number;
    observations: any[];
    lastDecision: any;
    toolDiscoveryCache?: any;
    memoryContext?: string | null;
    taskHistory?: string | null;
    knowledgeContext?: string | null;
  };
}

/* ================================================================== */
/*  Helpers                                                              */
/* ================================================================== */

/** 从 subjectPayload 重建 LlmSubject */
function rebuildSubject(body: LoopResumeBody) {
  const p = body.subjectPayload ?? {};
  return {
    subjectId: String(p.subjectId ?? "system"),
    tenantId: body.tenantId,
    spaceId: body.spaceId ?? String(p.spaceId ?? ""),
  };
}

/* ================================================================== */
/*  Route Plugin                                                         */
/* ================================================================== */

export const internalRoutes: FastifyPluginAsync = async (app) => {

  /* ── 全局 Hook：x-internal-secret 校验 ── */
  app.addHook("onRequest", async (req, reply) => {
    const secret = getInternalSecret();
    if (!secret) {
      app.log.error("[internal] INTERNAL_API_SECRET/API_SECRET 未配置，拒绝内部请求");
      return reply.status(503).send({ error: "service_unavailable", message: "internal secret is not configured" });
    }

    const provided = req.headers["x-internal-secret"] as string | undefined;
    if (provided !== secret) {
      app.log.warn(
        { source: req.headers["x-source"], ip: req.ip },
        "[internal] Unauthorized internal request",
      );
      return reply.status(403).send({ error: "forbidden", message: "invalid internal secret" });
    }
  });

  /* ──────────────────────────────────────────────────────────────────
   * POST /internal/loop-resume
   *
   * Worker 的 loopResumeHandler 通过 HTTP 调用此端点，
   * 让当前 API 节点恢复一个中断的 Agent Loop。
   *
   * 流程：
   *   1. 校验 payload
   *   2. 重建 AgentLoopParams（从 checkpoint payload 恢复 subject/state）
   *   3. 异步启动 runAgentLoop（fire-and-forget）
   *   4. 立即返回 202 Accepted
   * ────────────────────────────────────────────────────────────────── */
  app.post<{ Body: LoopResumeBody }>("/internal/loop-resume", async (req, reply) => {
    const body = req.body as LoopResumeBody;

    // 基本校验
    if (!body?.loopId || !body?.runId || !body?.goal) {
      return reply.status(400).send({
        error: "bad_request",
        message: "loopId, runId, and goal are required",
      });
    }

    if (!body.resumeState || typeof body.resumeState.iteration !== "number") {
      return reply.status(400).send({
        error: "bad_request",
        message: "resumeState with valid iteration is required",
      });
    }

    const subject = rebuildSubject(body);

    const checkpointRes = await app.db.query<{
      tenant_id: string;
      space_id: string | null;
      run_id: string;
      job_id: string;
      task_id: string | null;
      goal: string;
      max_iterations: number;
      max_wall_time_ms: string;
      subject_payload: any;
      decision_context: any;
    }>(
      `SELECT tenant_id, space_id, run_id, job_id, task_id, goal, max_iterations, max_wall_time_ms, subject_payload, decision_context
       FROM agent_loop_checkpoints
       WHERE loop_id = $1
       LIMIT 1`,
      [body.loopId],
    );
    if (!checkpointRes.rowCount) {
      return reply.status(404).send({ error: "not_found", message: "checkpoint not found" });
    }
    const checkpoint = checkpointRes.rows[0];
    const expectedConstraints = (checkpoint.decision_context as any)?.executionConstraints ?? null;
    const sameConstraints = JSON.stringify(expectedConstraints ?? null) === JSON.stringify(body.executionConstraints ?? null);
    const sameSubject = JSON.stringify(checkpoint.subject_payload ?? {}) === JSON.stringify(body.subjectPayload ?? {});
    const checkpointMatches = sameConstraints
      && sameSubject
      && String(checkpoint.tenant_id ?? "") === body.tenantId
      && String(checkpoint.space_id ?? "") === String(body.spaceId ?? "")
      && String(checkpoint.run_id ?? "") === body.runId
      && String(checkpoint.job_id ?? "") === body.jobId
      && String(checkpoint.task_id ?? "") === String(body.taskId ?? "")
      && String(checkpoint.goal ?? "") === body.goal
      && Number(checkpoint.max_iterations ?? 0) === Number(body.maxIterations ?? 0)
      && Number(checkpoint.max_wall_time_ms ?? 0) === Number(body.maxWallTimeMs ?? 0);
    if (!checkpointMatches) {
      app.log.warn({ loopId: body.loopId, runId: body.runId }, "[internal] loop resume payload mismatch with checkpoint");
      return reply.status(409).send({ error: "payload_mismatch", message: "loop resume payload does not match checkpoint" });
    }

    app.log.info(
      {
        loopId: body.loopId,
        runId: body.runId,
        tenantId: body.tenantId,
        iteration: body.resumeState.iteration,
        source: req.headers["x-source"],
      },
      "[internal] Resuming agent loop from checkpoint",
    );

    // 标记 checkpoint 为 resuming（幂等）
    try {
      await app.db.query(
        `UPDATE agent_loop_checkpoints
         SET status = 'resuming', heartbeat_at = now(), updated_at = now()
         WHERE loop_id = $1 AND status IN ('running', 'interrupted', 'resuming')`,
        [body.loopId],
      );
    } catch (e: any) {
      app.log.warn({ err: e?.message, loopId: body.loopId }, "[internal] Failed to update checkpoint status");
    }

    // 重建 AgentLoopParams
    const loopParams: AgentLoopParams = {
      app,
      pool: app.db,
      queue: app.queue as WorkflowQueue,
      subject: {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
      },
      locale: body.locale ?? "en-US",
      authorization: body.authorization ?? null,
      traceId: body.traceId ?? null,
      goal: body.goal,
      runId: body.runId,
      jobId: body.jobId,
      taskId: body.taskId ?? "",
      maxIterations: body.maxIterations ?? 15,
      maxWallTimeMs: body.maxWallTimeMs ?? 10 * 60 * 1000,
      defaultModelRef: body.defaultModelRef ?? undefined,
      executionConstraints: body.executionConstraints ?? undefined,
      resumeLoopId: body.loopId,
      resumeState: body.resumeState,
    };

    // Fire-and-forget：异步启动 loop，不阻塞 HTTP 响应
    runAgentLoop(loopParams).then(
      (result) => {
        app.log.info(
          {
            loopId: body.loopId,
            runId: body.runId,
            ok: result.ok,
            endReason: result.endReason,
            iterations: result.iterations,
          },
          "[internal] Resumed agent loop completed",
        );
      },
      (err) => {
        app.log.error(
          { err: err?.message, loopId: body.loopId, runId: body.runId },
          "[internal] Resumed agent loop failed",
        );
        // 回退 checkpoint 状态，让 Supervisor 下次 tick 重试
        app.db.query(
          "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1 AND status = 'resuming'",
          [body.loopId],
        ).catch(() => {});
      },
    );

    return reply.status(202).send({
      ok: true,
      loopId: body.loopId,
      runId: body.runId,
      message: "loop resume dispatched",
    });
  });

  /* ──────────────────────────────────────────────────────────────────
   * POST /internal/tool-discovery/rescan
   *
   * 手动触发 skills/ 目录重新扫描，发现运行期新增的 Skill 包
   * 并将其注册到 tool_definitions 表。
   *
   * 完成后自动失效 Agent Loop 的工具发现缓存，
   * 确保下次 Agent 决策时能立即看到新工具。
   * ────────────────────────────────────────────────────────────────── */
  app.post("/internal/tool-discovery/rescan", async (req, reply) => {
    const startedAt = Date.now();
    app.log.info("[internal] Tool discovery rescan triggered");

    try {
      const result = await rescanAndRegisterTools(app.db);
      // 失效 Agent Loop 工具缓存
      invalidateToolCatalogQueryCache();

      const durationMs = Date.now() - startedAt;
      app.log.info(
        { registered: result.registered, skipped: result.skipped, durationMs },
        "[internal] Tool discovery rescan completed",
      );

      return reply.status(200).send({
        ok: true,
        registered: result.registered,
        skipped: result.skipped,
        durationMs,
        cacheInvalidated: true,
      });
    } catch (e: any) {
      app.log.error({ err: e?.message }, "[internal] Tool discovery rescan failed");
      return reply.status(500).send({
        ok: false,
        error: "rescan_failed",
        message: e?.message ?? "unknown error",
      });
    }
  });

  /* ──────────────────────────────────────────────────────────────────
   * GET /internal/health
   *
   * 供 Worker 检查 API 节点可达性。
   * ────────────────────────────────────────────────────────────────── */
  app.get("/internal/health", async () => {
    return { ok: true, ts: Date.now() };
  });

  /* ──────────────────────────────────────────────────────────────────
   * POST /internal/alertmanager-webhook
   *
   * P3-16: Alertmanager Webhook 接收端点
   * 接收 Prometheus Alertmanager 的告警通知，记录到日志并触发指标计数。
   * ────────────────────────────────────────────────────────────────── */
  app.post("/internal/alertmanager-webhook", async (req, reply) => {
    const body = req.body as any;
    const alerts = Array.isArray(body?.alerts) ? body.alerts : [];

    for (const alert of alerts) {
      const alertName = alert?.labels?.alertname ?? "unknown";
      const severity = alert?.labels?.severity ?? "unknown";
      const status = alert?.status ?? "unknown"; // firing | resolved
      const component = alert?.labels?.component ?? "unknown";

      // 记录指标
      app.metrics.incAlertFired({ alert: alertName });

      // 结构化日志
      const logMsg = `[AlertManager] ${status.toUpperCase()} ${alertName} (${severity}) [${component}]`;
      const logExtra = {
        alertName,
        severity,
        status,
        component,
        summary: alert?.annotations?.summary,
        description: alert?.annotations?.description,
        startsAt: alert?.startsAt,
        endsAt: alert?.endsAt,
      };

      if (severity === "critical" && status === "firing") {
        app.log.error(logExtra, logMsg);
      } else if (status === "resolved") {
        app.log.info(logExtra, logMsg);
      } else {
        app.log.warn(logExtra, logMsg);
      }
    }

    return reply.status(200).send({ ok: true, processed: alerts.length });
  });
};
