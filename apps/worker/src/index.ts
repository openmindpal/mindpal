import { Worker } from "bullmq";
import "./otel";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { loadConfig } from "./config";
import { validateEnvironment, formatValidationResult } from "@openslin/shared";
import { extractJobTraceContext } from "./lib/tracing";
import { dispatchJob } from "./workflow/jobDispatcher";
import { processStep } from "./workflow/processor";
import { markWorkflowStepDeadletter } from "./workflow/deadletter";
import { resolveCollabMeta, beforeStep, afterStep, afterRunStatusSync, type CollabMeta } from "./workflow/collabStepTracker";
import { applyWorkerCollabState } from "./workflow/collabStateSync";
import {
  createWorkerRuntime,
  initializeWorkerExtensions,
  logWorkerProductionBaseline,
  shutdownWorkerRuntime,
} from "./bootstrap/runtime";
import { createAgentRunScheduler } from "./workflow/agentRunScheduler";

/** Worker 作业数据必须符合的基本结构 */
interface WorkflowJobData {
  jobId: string;
  runId: string;
  stepId: string;
  kind?: string;
  [key: string]: unknown;
}

/** 运行时检查 job.data 必要字段，避免 `as any` 隐藏结构缺陷 */
function validateJobData(raw: unknown): WorkflowJobData {
  if (raw == null || typeof raw !== "object") throw new Error("invalid job data: not an object");
  const d = raw as Record<string, unknown>;
  const jobId = d.jobId != null ? String(d.jobId) : "";
  const runId = d.runId != null ? String(d.runId) : "";
  const stepId = d.stepId != null ? String(d.stepId) : "";
  if (!jobId || !runId || !stepId) {
    throw new Error(`invalid job data: missing required fields (jobId=${jobId}, runId=${runId}, stepId=${stepId})`);
  }
  return { ...d, jobId, runId, stepId, kind: d.kind != null ? String(d.kind) : undefined };
}

const tracer = trace.getTracer("openslin-worker");

async function main() {
  logWorkerProductionBaseline();

  /* ── P0: 启动时环境变量校验 ──────────────────────────────────── */
  const envResult = validateEnvironment("worker");
  if (!envResult.valid) {
    console.error(formatValidationResult(envResult));
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
  } else if (envResult.warnings.length > 0) {
    console.warn(formatValidationResult(envResult));
  }

  const cfg = loadConfig(process.env);
  initializeWorkerExtensions();
  const runtime = await createWorkerRuntime(cfg);
  const { pool, queue, redis, redisPub, connection } = runtime;
  const masterKey = cfg.secrets.masterKey;

  async function syncWorkerCollabStateSafe(params: Parameters<typeof applyWorkerCollabState>[0]) {
    if (!params.tenantId || !params.collabRunId) return;
    try {
      await applyWorkerCollabState({
        ...params,
        redis,
      });
    } catch (e: any) {
      console.warn("[worker] collab state sync failed", {
        collabRunId: params.collabRunId,
        updateType: params.updateType,
        sourceRole: params.sourceRole ?? null,
        error: String(e?.message ?? e),
      });
    }
  }
  const { scheduleNextAgentRunStep } = createAgentRunScheduler({
    pool,
    queue,
    redis,
    syncWorkerCollabStateSafe,
  });

  /** Per-job 超时保护：避免单个 Job 无限阻塞 Worker 线程 */
  function withJobTimeout<T>(promise: Promise<T>, timeoutMs: number, jobId: string): Promise<T> {
    if (timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`job_timeout: job ${jobId} exceeded ${timeoutMs}ms limit`));
      }, timeoutMs);
      timer.unref();
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  const worker = new Worker(
    "workflow",
    async (job) => {
      const data = validateJobData(job.data);
      const jobCtx = extractJobTraceContext(data);
      // per-job 超时：优先从 job.data 读取，否则使用全局配置
      const jobTimeout = Number(data.timeoutMs) || cfg.jobTimeoutMs;
      const jobWork = context.with(jobCtx, async () => {
        // P1-1 FIX: job kind 分发通过 jobDispatcher 路由（含 job.name fallback）
        const jobDeps = { pool, queue, redis: redisPub, masterKey, mediaFsRootDir: cfg.media.fsRootDir };
        const kindOrName = data?.kind || (job.name !== "step" ? job.name : undefined);
        const dispatched = kindOrName ? await dispatchJob({ ...data, kind: kindOrName }, jobDeps) : false;
        if (dispatched) return;
      // P1-4 FIX: collab 事件追踪通过 collabStepTracker 中间件实现
        let collabMeta: CollabMeta | null = null;
        try {
          collabMeta = await resolveCollabMeta(pool, String(data.stepId ?? ""), String(data.runId ?? ""));
          if (collabMeta) await beforeStep(pool, collabMeta, redis);
        } catch (e: any) {
          console.warn("[worker] collab step.started event failed", { jobId: String(data?.jobId ?? ""), runId: String(data?.runId ?? ""), stepId: String(data?.stepId ?? ""), error: String(e?.message ?? e) });
        }
        try {
          const span = tracer.startSpan("workflow.step.process", { attributes: { jobId: String(data.jobId ?? ""), runId: String(data.runId ?? ""), stepId: String(data.stepId ?? ""), kind: "step" } });
          try {
            await context.with(trace.setSpan(context.active(), span), async () => {
              await processStep({ pool, jobId: data.jobId, runId: data.runId, stepId: data.stepId, masterKey, redis: redisPub });
            });
            span.setStatus({ code: SpanStatusCode.OK });
          } catch (e: any) {
            span.recordException(e);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw e;
          } finally {
            span.end();
          }
          redis.incr("worker:workflow:step:success").catch((e: any) => {
            console.warn("[worker] redis incr step:success failed", { error: String(e?.message ?? e) });
          });
          redis.incr("worker:tool_execute:success").catch((e: any) => {
            console.warn("[worker] redis incr tool_execute:success failed", { error: String(e?.message ?? e) });
          });
        } catch (e) {
          redis.incr("worker:workflow:step:error").catch((e2: any) => {
            console.warn("[worker] redis incr step:error failed", { error: String(e2?.message ?? e2) });
          });
          redis.incr("worker:tool_execute:error").catch((e2: any) => {
            console.warn("[worker] redis incr tool_execute:error failed", { error: String(e2?.message ?? e2) });
          });
          throw e;
        }
        try {
          if (collabMeta) await afterStep(pool, collabMeta, redis);
        } catch (e: any) {
          console.warn("[worker] collab step completed/failed event failed", { runId: String(data?.runId ?? ""), error: String(e?.message ?? e) });
        }
        try {
          const jobTypeRes = await pool.query("SELECT job_type FROM jobs WHERE job_id = $1 LIMIT 1", [String(data.jobId ?? "")]);
          const jobType = jobTypeRes.rowCount ? String(jobTypeRes.rows[0].job_type ?? "") : "";
          if (jobType === "agent.run" || jobType === "agent.dispatch" || jobType === "agent.dispatch.upgrade") {
            await scheduleNextAgentRunStep({ jobId: String(data.jobId ?? ""), runId: String(data.runId ?? "") });
          }
        } catch (e: any) {
          console.warn("[worker] scheduleNextAgentRunStep failed", { jobId: String(data?.jobId ?? ""), runId: String(data?.runId ?? ""), error: String(e?.message ?? e) });
        }
        try {
          await afterRunStatusSync(pool, { runId: String(data.runId ?? "") }, collabMeta, redis);
        } catch (e: any) {
          console.warn("[worker] collab run status sync failed", { runId: String(data?.runId ?? ""), error: String(e?.message ?? e) });
        }
      });
      return await withJobTimeout(jobWork, jobTimeout, String(job.id));
    },
    { connection, concurrency: cfg.concurrency },
  );

  worker.on("failed", async (job, err) => {
    const data = job?.data as Record<string, unknown> | undefined;
    const stepId = data?.stepId ? String(data.stepId) : null;
    const runId = data?.runId ? String(data.runId) : null;
    const jobId = data?.jobId ? String(data.jobId) : null;
    const maxAttempts = Number(job?.opts?.attempts ?? 1);
    const attemptsMade = Number(job?.attemptsMade ?? 0);

    // 结构化日志：每次失败都记录，便于排障
    console.error("[worker] job failed", {
      queueJobId: job?.id ?? null,
      jobId,
      runId,
      stepId,
      attemptsMade,
      maxAttempts,
      isFinalAttempt: attemptsMade >= maxAttempts,
      errorMessage: String((err as any)?.message ?? err),
      errorCode: (err as any)?.code ?? null,
    });

    try {
      if (!job) return;
      if (job.name !== "step") return;
      if (!stepId || !runId || !jobId) return;

      if (attemptsMade < maxAttempts) return;
      await markWorkflowStepDeadletter({ pool, jobId, runId, stepId, queueJobId: String(job.id), err });
    } catch (e) {
      console.error("[worker] deadletter mark failed", e);
    }
  });

  /* ── P0-04: Worker Graceful Shutdown ───────────────────────────────── */
  const WORKER_SHUTDOWN_TIMEOUT_MS = cfg.shutdownTimeoutMs;
  let workerShuttingDown = false;

  async function gracefulWorkerShutdown(signal: string) {
    if (workerShuttingDown) return;
    workerShuttingDown = true;
    console.log(`[worker] ${signal} received — starting graceful shutdown (timeout=${WORKER_SHUTDOWN_TIMEOUT_MS}ms)`);

    const forceTimer = setTimeout(() => {
      console.error(`[worker] Shutdown timeout exceeded (${WORKER_SHUTDOWN_TIMEOUT_MS}ms) — forcing exit`);
      process.exit(1);
    }, WORKER_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 1) 停止所有 ticker
      // 1) 等待 BullMQ Worker 当前 Job 完成并关闭
      console.log("[worker] Closing BullMQ worker (waiting for current job)...");
      await worker.close();

      // 2) 关闭后台资源（ticker / queue / redis / health / db）
      await shutdownWorkerRuntime(runtime);

      console.log("[worker] Graceful shutdown complete");
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (e: any) {
      console.error(`[worker] Graceful shutdown error: ${e?.message}`);
      clearTimeout(forceTimer);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => gracefulWorkerShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulWorkerShutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
