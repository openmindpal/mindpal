/**
 * Agent Loop — 工具执行 + 步骤等待
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentDecision, ExecutionConstraints } from "./loopTypes";
import type { WorkflowQueue } from "../modules/workflow/queue";
import { Errors } from "../lib/errors";
import { authorize } from "../modules/auth/authz";
import { buildAbacEvaluationRequestFromContext } from "../modules/auth/guard";
import { validateToolInput } from "../modules/tools/validate";
import {
  admitAndBuildStepEnvelope,
  buildStepInputPayload,
  generateIdempotencyKey,
  resolveAndValidateTool,
  submitStepToExistingRun,
} from "./executionKernel";
import { isToolAllowedByConstraints } from "./loopThinkDecide";
import { getSharedSubClient } from "./loopRedisClient";

async function requireLoopPermission(params: {
  pool: Pool;
  subjectId: string;
  tenantId: string;
  spaceId: string;
  resourceType: string;
  action: string;
  traceId: string | null;
  runId: string;
  jobId: string;
}) {
  const decision = await authorize({
    pool: params.pool,
    subjectId: params.subjectId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    resourceType: params.resourceType,
    action: params.action,
    abacRequest: buildAbacEvaluationRequestFromContext({
      subject: {
        subjectId: params.subjectId,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
      },
      resourceType: params.resourceType,
      action: params.action,
      environment: {
        userAgent: "agent-loop/internal",
        deviceType: "server",
        attributes: {
          runtime: "agent_loop",
          runId: params.runId,
          jobId: params.jobId,
          ...(params.traceId ? { traceId: params.traceId } : {}),
        },
      },
    }),
  });
  if (decision.decision !== "allow") throw Errors.forbidden();
  return decision;
}

/* ================================================================== */
/*  Act — 执行单步工具调用                                               */
/* ================================================================== */

export async function executeToolCall(params: {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  traceId: string | null;
  runId: string;
  jobId: string;
  decision: AgentDecision;
  seq: number;
  executionConstraints?: ExecutionConstraints;
}): Promise<{ stepId: string; ok: boolean; error?: string }> {
  const { app, pool, queue, tenantId, spaceId, subjectId, traceId, runId, jobId, decision, seq, executionConstraints } = params;
  const rawToolRef = decision.toolRef ?? "";
  if (!rawToolRef) return { stepId: "", ok: false, error: "missing_tool_ref" };
  const inputDraft = decision.inputDraft ?? {};
  try {
    const resolved = await resolveAndValidateTool({
      tenantId,
      pool,
      spaceId,
      rawToolRef,
    });
    const allowed = isToolAllowedByConstraints(resolved, executionConstraints);
    if (!allowed.ok) {
      return { stepId: "", ok: false, error: allowed.reason };
    }
    validateToolInput(resolved.version.inputSchema, inputDraft);
    await requireLoopPermission({
      pool,
      subjectId,
      tenantId,
      spaceId,
      resourceType: "tool",
      action: "execute",
      traceId,
      runId,
      jobId,
    });
    const opDecision = await requireLoopPermission({
      pool,
      subjectId,
      tenantId,
      spaceId,
      resourceType: resolved.resourceType,
      action: resolved.action,
      traceId,
      runId,
      jobId,
    });
    const admitted = await admitAndBuildStepEnvelope({
      pool,
      tenantId,
      spaceId,
      subjectId,
      resolved,
      opDecision,
    });
    const stepInput = buildStepInputPayload({
      kind: "agent.loop.step",
      resolved,
      admitted,
      input: inputDraft,
      idempotencyKey: generateIdempotencyKey({ resolved, prefix: "agent-loop", runId, seq }),
      tenantId,
      spaceId,
      subjectId,
      traceId: traceId ?? "",
      extra: {
        actorRole: "executor",
        agentReasoning: decision.reasoning.slice(0, 500),
      },
    });
    const submitResult = await submitStepToExistingRun({
      pool,
      queue,
      tenantId,
      resolved,
      opDecision,
      stepInput,
      runId,
      jobId,
      jobType: "agent.run",
      masterKey: app.cfg.secrets.masterKey,
    });
    return { stepId: submitResult.stepId, ok: true };
  } catch (err: any) {
    if (err?.httpStatus) {
      return { stepId: "", ok: false, error: `governance_error: ${err.errorCode ?? err.message}` };
    }
    app.log.warn({ err: err?.message, runId, toolRef: rawToolRef }, "[AgentLoop] 工具调用准入失败");
    return { stepId: "", ok: false, error: `governance_unavailable:${err?.message ?? "unknown"}` };
  }
}

/* ================================================================== */
/*  等待步骤完成 (Redis Pub/Sub 事件驱动 + DB 轮询兜底)                    */
/* ================================================================== */

// P0-6 FIX: 区分"真正终态"和"阻塞态"—— Agent Loop 需在两种情况下都被唤醒
const STEP_REAL_TERMINAL = new Set(["succeeded", "failed", "deadletter", "canceled"]);
const STEP_BLOCKING_STATUSES = new Set(["needs_approval", "needs_device", "needs_arbiter", "paused"]);
/** Agent Loop 需关注的所有"停止轮询"状态 = 终态 + 阻塞态 */
const STEP_SETTLE_STATUSES = new Set([...STEP_REAL_TERMINAL, ...STEP_BLOCKING_STATUSES]);

/** 从 DB 查询 step 是否已达终态或阻塞态 */
export async function queryStepTerminal(
  pool: Pool,
  stepId: string,
): Promise<{ status: string; outputDigest: any; output: any; errorCategory: string | null } | null> {
  const res = await pool.query<{ status: string; output_digest: any; output: any; error_category: string | null }>(
    "SELECT status, output_digest, output, error_category FROM steps WHERE step_id = $1 LIMIT 1",
    [stepId],
  );
  if (res.rowCount) {
    const row = res.rows[0];
    if (STEP_SETTLE_STATUSES.has(row.status)) {
      return { status: row.status, outputDigest: row.output_digest, output: row.output, errorCategory: row.error_category };
    }
  }
  return null;
}

export async function waitForStepCompletion(
  pool: Pool,
  stepId: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ status: string; outputDigest: any; output: any; errorCategory: string | null }> {
  // 先检查是否已经完成
  const immediate = await queryStepTerminal(pool, stepId);
  if (immediate) return immediate;

  if (signal?.aborted) {
    return { status: "canceled", outputDigest: null, output: null, errorCategory: "interrupted" };
  }

  // 尝试通过 Redis Pub/Sub 等待事件通知，同时保留 DB 轮询兆底
  const channel = `step:done:${stepId}`;
  const fallbackPollMs = 5_000;

  return new Promise<{ status: string; outputDigest: any; output: any; errorCategory: string | null }>((resolve) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    // 2.1 FIX: 使用模块级懒单例 Redis 连接，避免每次调用创建新连接
    let subRegistered = false;
    // P0-5 FIX: 保存 listener 引用，cleanup 时必须 removeListener 防止内存泄漏
    let messageHandler: ((_ch: string, _msg: string) => void) | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = () => {
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
      // P0-5 FIX: 先移除 listener，再取消订阅
      if (subRegistered) {
        getSharedSubClient().then(c => {
          if (c && messageHandler) c.removeListener("message", messageHandler);
          c?.unsubscribe(channel).catch(() => {});
        }).catch(() => {});
        messageHandler = null;
        subRegistered = false;
      }
    };

    const settle = (result: { status: string; outputDigest: any; output: any; errorCategory: string | null }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // 超时兆底
    timeoutTimer = setTimeout(() => {
      settle({ status: "timeout", outputDigest: null, output: null, errorCategory: "step_timeout" });
    }, timeoutMs);

    // AbortSignal 监听
    abortHandler = () => settle({ status: "canceled", outputDigest: null, output: null, errorCategory: "interrupted" });
    signal?.addEventListener("abort", abortHandler, { once: true });

    // DB 轮询兆底（防止 Redis 消息丢失）
    fallbackTimer = setInterval(() => {
      if (settled) return;
      queryStepTerminal(pool, stepId)
        .then((r) => { if (r) settle(r); })
        .catch(() => { /* ignore, will retry next tick */ });
    }, fallbackPollMs);

    // Redis Pub/Sub 事件驱动（复用共享连接）
    (async () => {
      try {
        const client = await getSharedSubClient();
        if (!client || settled) return;
        subRegistered = true;
        await client.subscribe(channel);
        // P0-5 FIX: 使用命名函数引用，cleanup 时可精确 removeListener 防止内存泄漏
        messageHandler = (_ch: string, _msg: string) => {
          if (_ch !== channel || settled) return;
          queryStepTerminal(pool, stepId)
            .then((r) => { if (r) settle(r); })
            .catch(() => {});
        };
        client.on("message", messageHandler);
      } catch {
        // Redis 订阅失败，依赖 DB 轮询兆底
      }
    })();
  });
}
