import { Worker } from "bullmq";
import "./otel";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { loadConfig } from "./config";
import { validateEnvironment, formatValidationResult, StructuredLogger, classifyError } from "@openslin/shared";
import { extractTraceContext, injectTraceHeaders } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:main" });
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
import { CRITICAL_EVENT_CHANNELS } from "@openslin/shared";
import { createAgentRunScheduler } from "./workflow/agentRunScheduler";
import { getJobType } from "./jobRepo";

/** 安全执行并记录结构化日志，失败不抛异常 */
async function safeDo(fn: () => Promise<void>, label: string, meta?: Record<string, unknown>): Promise<void> {
  try {
    await fn();
  } catch (e: unknown) {
    _logger.warn(`${label} failed`, { ...meta, error: e instanceof Error ? e.message : String(e) });
  }
}

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
    _logger.error(formatValidationResult(envResult));
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
  } else if (envResult.warnings.length > 0) {
    _logger.warn(formatValidationResult(envResult));
  }

  const cfg = loadConfig(process.env);
  initializeWorkerExtensions();
  const runtime = await createWorkerRuntime(cfg);
  const { pool, queue, redis, redisPub, connection, streamsBus } = runtime;
  const masterKey = cfg.secrets.masterKey;

  // ── P1: Redis Streams — 关键事件可靠消费 ─────────────────────
  // 1) 订阅关键事件 channel（启动读取循环）
  for (const ch of CRITICAL_EVENT_CHANNELS) {
    await streamsBus.subscribe(ch, (payload) => {
      _logger.info("stream.event received", { channel: ch, payload: typeof payload === "object" ? JSON.stringify(payload).slice(0, 200) : String(payload) });
    });
  }
  // 2) 恢复断点消费：处理 Worker 掉线期间积累的未 ACK 消息
  for (const ch of CRITICAL_EVENT_CHANNELS) {
    await streamsBus.resumeFromLastAck(ch, streamsBus.consumerGroup, streamsBus.consumerId);
  }
  _logger.info("Redis Streams critical event consumers initialized", {
    channels: [...CRITICAL_EVENT_CHANNELS],
    consumerGroup: "openslin-worker-group",
  });

  async function syncWorkerCollabStateSafe(params: Parameters<typeof applyWorkerCollabState>[0]) {
    if (!params.tenantId || !params.collabRunId) return;
    try {
      await applyWorkerCollabState({
        ...params,
        redis,
      });
    } catch (e: any) {
      _logger.warn("collab state sync failed", {
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
        await safeDo(
          async () => {
            collabMeta = await resolveCollabMeta(pool, String(data.stepId ?? ""), String(data.runId ?? ""));
            if (collabMeta) await beforeStep(pool, collabMeta, redis);
          },
          "collab step.started event",
          { jobId: String(data?.jobId ?? ""), runId: String(data?.runId ?? ""), stepId: String(data?.stepId ?? "") },
        );
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
            _logger.warn("redis incr step:success failed", { error: String(e?.message ?? e) });
          });
          redis.incr("worker:tool_execute:success").catch((e: any) => {
            _logger.warn("redis incr tool_execute:success failed", { error: String(e?.message ?? e) });
          });
        } catch (e) {
          redis.incr("worker:workflow:step:error").catch((e2: any) => {
            _logger.warn("redis incr step:error failed", { error: String(e2?.message ?? e2) });
          });
          redis.incr("worker:tool_execute:error").catch((e2: any) => {
            _logger.warn("redis incr tool_execute:error failed", { error: String(e2?.message ?? e2) });
          });
          throw e;
        }
        await safeDo(
          async () => { if (collabMeta) await afterStep(pool, collabMeta, redis); },
          "collab step completed/failed event",
          { runId: String(data?.runId ?? "") },
        );
        await safeDo(
          async () => {
            const jobType = await getJobType(pool, String(data.jobId ?? ""));
            if (jobType === "agent.run" || jobType === "agent.dispatch" || jobType === "agent.dispatch.upgrade") {
              await scheduleNextAgentRunStep({ jobId: String(data.jobId ?? ""), runId: String(data.runId ?? "") });
            }
          },
          "scheduleNextAgentRunStep",
          { jobId: String(data?.jobId ?? ""), runId: String(data?.runId ?? "") },
        );
        await safeDo(
          async () => { await afterRunStatusSync(pool, { runId: String(data.runId ?? "") }, collabMeta, redis); },
          "collab run status sync",
          { runId: String(data?.runId ?? "") },
        );
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
    const svcErr = classifyError(err);
    _logger.error("job failed", {
      queueJobId: job?.id ?? null,
      jobId,
      runId,
      stepId,
      attemptsMade,
      maxAttempts,
      isFinalAttempt: attemptsMade >= maxAttempts,
      errorMessage: svcErr.message,
      errorCode: svcErr.code,
      errorCategory: svcErr.category,
    });

    try {
      if (!job) return;
      if (job.name !== "step") return;
      if (!stepId || !runId || !jobId) return;

      if (attemptsMade < maxAttempts) return;
      await markWorkflowStepDeadletter({ pool, jobId, runId, stepId, queueJobId: String(job.id), err });
    } catch (e) {
      _logger.error("deadletter mark failed", { err: (e as Error)?.message });
    }
  });

  /* ── P0-04: Worker Graceful Shutdown ───────────────────────────────── */
  const WORKER_SHUTDOWN_TIMEOUT_MS = cfg.shutdownTimeoutMs;
  let workerShuttingDown = false;

  async function gracefulWorkerShutdown(signal: string) {
    if (workerShuttingDown) return;
    workerShuttingDown = true;
    _logger.info(`${signal} received — starting graceful shutdown`, { timeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS });

    const forceTimer = setTimeout(() => {
      _logger.error(`Shutdown timeout exceeded (${WORKER_SHUTDOWN_TIMEOUT_MS}ms) — forcing exit`);
      process.exit(1);
    }, WORKER_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 1) 停止所有 ticker
      // 1) 等待 BullMQ Worker 当前 Job 完成并关闭
      _logger.info("Closing BullMQ worker (waiting for current job)...");
      await worker.close();

      // 2) 关闭后台资源（ticker / queue / redis / health / db）
      await shutdownWorkerRuntime(runtime);

      _logger.info("Graceful shutdown complete");
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (e: any) {
      _logger.error("Graceful shutdown error", { err: e?.message });
      clearTimeout(forceTimer);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => gracefulWorkerShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulWorkerShutdown("SIGINT"));
}

main().catch((err) => {
  _logger.error("main() fatal error", { err: (err as Error)?.message, stack: (err as Error)?.stack });
  process.exit(1);
});
