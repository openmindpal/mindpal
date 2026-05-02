/**
 * Agent Loop — 工具执行 + 步骤等待
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AgentDecision, ExecutionConstraints } from "./loopTypes";
import type { WorkflowQueue } from "../modules/workflow/queue";
import { Errors } from "../lib/errors";
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
import { ErrorCategory, StructuredLogger } from "@mindpal/shared";
import type { ToolSemanticMeta, SemanticAuditEntry, FallbackImpact } from "@mindpal/shared";
import { performance } from "node:perf_hooks";
import { authorizeToolExecution, findFallbackTool, AGENT_LOOP_PERMISSION_FALLBACK } from "./loopPermissionUnified";

const _logger = new StructuredLogger({ module: "loopToolExecutor" });

/* ================================================================== */
/*  Schema 兼容性检查                                                    */
/* ================================================================== */

/**
 * 检查 fallback 工具是否与原始工具的 inputSchema 核心字段兼容。
 * 策略：宽松检查 — fallback 工具的 inputSchema 必须能接受原始输入的 required 字段。
 * 不会过于严格（允许 fallback 接受更多字段或更少 optional 字段）。
 */
function checkSchemaCompatibility(
  originalSchema: Record<string, unknown> | undefined,
  fallbackSchema: Record<string, unknown> | undefined,
): { compatible: boolean; reason?: string } {
  // 无 schema 信息时默认兼容（宽松策略）
  if (!originalSchema || !fallbackSchema) return { compatible: true };

  const origProps = (originalSchema.properties ?? {}) as Record<string, unknown>;
  const fbProps = (fallbackSchema.properties ?? {}) as Record<string, unknown>;
  const origRequired = Array.isArray(originalSchema.required) ? originalSchema.required as string[] : [];

  // 核心检查：原始 schema 的 required 字段在 fallback 中必须存在
  const missingRequired: string[] = [];
  for (const field of origRequired) {
    if (!(field in fbProps)) {
      missingRequired.push(field);
    }
  }

  if (missingRequired.length > 0) {
    return {
      compatible: false,
      reason: `Fallback tool missing required input fields: ${missingRequired.join(", ")}`,
    };
  }

  return { compatible: true };
}

/* ================================================================== */
/*  Fallback 影响评估                                                    */
/* ================================================================== */

export function evaluateFallbackImpact(
  originalMeta: ToolSemanticMeta | undefined,
  fallbackMeta: ToolSemanticMeta | undefined,
  _goalId: string,
): FallbackImpact {
  // 无元数据时默认无影响
  if (!originalMeta || !fallbackMeta) {
    return {
      impact: "none",
      originalOperationType: originalMeta?.operationType || "unknown",
      fallbackOperationType: fallbackMeta?.operationType || "unknown",
      reason: "Missing semantic metadata for impact evaluation",
    };
  }

  // 1. 操作类型对等检查 — write→read / delete→non-delete 目标不可达
  if (originalMeta.operationType === "write" && fallbackMeta.operationType === "read") {
    return {
      impact: "goal_unreachable",
      originalOperationType: originalMeta.operationType,
      fallbackOperationType: fallbackMeta.operationType,
      reason: "Write operation fell back to read-only — original goal cannot be achieved",
    };
  }
  if (originalMeta.operationType === "delete" && fallbackMeta.operationType !== "delete") {
    return {
      impact: "goal_unreachable",
      originalOperationType: originalMeta.operationType,
      fallbackOperationType: fallbackMeta.operationType,
      reason: "Delete operation fell back to non-delete — original goal cannot be achieved",
    };
  }

  // 2. 精确度降级检查
  if (originalMeta.precisionLevel === "exact" && fallbackMeta.precisionLevel !== "exact") {
    return {
      impact: "degraded",
      originalOperationType: originalMeta.operationType,
      fallbackOperationType: fallbackMeta.operationType,
      reason: `Precision degraded from ${originalMeta.precisionLevel} to ${fallbackMeta.precisionLevel}`,
    };
  }

  // 3. 操作类型不同但非致命
  if (originalMeta.operationType !== fallbackMeta.operationType) {
    return {
      impact: "degraded",
      originalOperationType: originalMeta.operationType,
      fallbackOperationType: fallbackMeta.operationType,
      reason: `Operation type changed from ${originalMeta.operationType} to ${fallbackMeta.operationType}`,
    };
  }

  return {
    impact: "none",
    originalOperationType: originalMeta.operationType,
    fallbackOperationType: fallbackMeta.operationType,
    reason: "Fallback tool is semantically equivalent",
  };
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
  /** 可选：工具目录元数据，用于权限降级查找同 category 替代 */
  toolCatalog?: Array<{ ref: string; category?: string; requiredAction?: string; semanticMeta?: ToolSemanticMeta }>;
}): Promise<{ stepId: string; ok: boolean; error?: string; executionTimeoutMs?: number; fallbackImpact?: FallbackImpact }> {
  const { app, pool, queue, tenantId, spaceId, subjectId, traceId, runId, jobId, decision, seq, executionConstraints, toolCatalog } = params;
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
    // ── 统一权限检查（合并 ABAC + 治理检查） ──
    const permStart = performance.now();
    let authResult = await authorizeToolExecution({
      pool, subjectId, tenantId, spaceId, traceId, runId, jobId,
      resourceType: resolved.resourceType,
      action: resolved.action,
      toolRef: resolved.toolRef,
      limits: executionConstraints as Record<string, unknown> | undefined,
    });
    if (!authResult.authorized) {
      // ── 权限降级尝试：在工具目录中查找同 category 的低权限替代 ──
      if (AGENT_LOOP_PERMISSION_FALLBACK && toolCatalog?.length) {
        const originalCatalogEntry = toolCatalog.find(t => t.ref === resolved.toolRef);
        const fallbackRef = findFallbackTool(
          resolved.toolRef,
          toolCatalog,
          resolved.action,
          originalCatalogEntry?.semanticMeta,
        );
        if (fallbackRef) {
          // ── Schema 兼容性检查：确保 fallback 工具能接受原始输入的核心字段 ──
          const fallbackResolved = await resolveAndValidateTool({ tenantId, pool, spaceId, rawToolRef: fallbackRef });
          const schemaCheck = checkSchemaCompatibility(
            resolved.version.inputSchema as Record<string, unknown> | undefined,
            fallbackResolved.version.inputSchema as Record<string, unknown> | undefined,
          );
          if (!schemaCheck.compatible) {
            _logger.warn("fallback-schema-incompatible", {
              toolRef: resolved.toolRef, fallbackRef, reason: schemaCheck.reason, runId,
            });
            // Schema 不兼容，不使用此 fallback，继续尝试原始权限拒绝路径
          } else {
          _logger.info("permission-fallback", { toolRef: resolved.toolRef, fallbackRef, runId });
          const fallbackAuth = await authorizeToolExecution({
            pool, subjectId, tenantId, spaceId, traceId, runId, jobId,
            resourceType: fallbackResolved.resourceType,
            action: fallbackResolved.action,
            toolRef: fallbackResolved.toolRef,
            limits: executionConstraints as Record<string, unknown> | undefined,
          });
          if (fallbackAuth.authorized) {
            // ── 语义漂移检测（通过 evaluateFallbackImpact 统一评估） ──
            const originalMeta = originalCatalogEntry?.semanticMeta;
            const fallbackCatalogEntry = toolCatalog.find(t => t.ref === fallbackRef);
            const fallbackMeta = fallbackCatalogEntry?.semanticMeta;
            const fbImpact = evaluateFallbackImpact(originalMeta, fallbackMeta, runId);
            if (fbImpact.impact !== "none") {
              const auditEntry: SemanticAuditEntry = {
                timestamp: new Date().toISOString(),
                originalToolId: resolved.toolRef,
                fallbackToolId: fallbackRef,
                impact: fbImpact,
                goalId: runId,
              };
              _logger.warn("semantic-drift-detected", auditEntry as unknown as Record<string, unknown>);
            }
            // 降级成功：用替代工具继续执行
            Object.assign(resolved, fallbackResolved);
            Object.assign(decision, { toolRef: fallbackRef });
            authResult = fallbackAuth;
            // 将 fallbackImpact 暂存，在返回时一并传递
            (params as any)._fallbackImpact = fbImpact;
          }
          }
        }
      }
      if (!authResult.authorized) {
        // ── 返回结构化降级结果，而非直接抛出错误 ──
        const attemptedFallbacks: string[] = [];
        if (AGENT_LOOP_PERMISSION_FALLBACK && toolCatalog?.length) {
          const originalCat = toolCatalog.find(t => t.ref === resolved.toolRef);
          if (originalCat?.category) {
            toolCatalog
              .filter(t => t.ref !== resolved.toolRef && t.category === originalCat.category)
              .forEach(t => attemptedFallbacks.push(t.ref));
          }
        }
        _logger.warn("no-compatible-fallback", {
          toolRef: resolved.toolRef,
          status: "degraded",
          reason: "no_compatible_fallback",
          attemptedFallbacks,
          runId,
        });
        return {
          stepId: "",
          ok: false,
          error: JSON.stringify({
            status: "degraded",
            reason: "no_compatible_fallback",
            originalTool: resolved.toolRef,
            attemptedFallbacks,
            partialResult: null,
            authError: authResult.errorMessage ?? "权限检查未通过",
          }),
        };
      }
    }
    const permDur = Math.round(performance.now() - permStart);
    _logger.debug("permission-check", { permission_duration_ms: permDur, toolRef: rawToolRef, runId });
    const opDecision = authResult.opDecision!;
    // 权限通过后再做 schema 校验，避免权限拒绝时浪费 schema 解析
    validateToolInput(resolved.version.inputSchema, inputDraft);
    const admitted = await admitAndBuildStepEnvelope({
      pool,
      tenantId,
      spaceId,
      subjectId,
      resolved,
      opDecision,
      preAuthorized: true,
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
    return { stepId: submitResult.stepId, ok: true, executionTimeoutMs: resolved.executionTimeoutMs, fallbackImpact: (params as any)._fallbackImpact };
  } catch (err: any) {
    if (err?.httpStatus) {
      return { stepId: "", ok: false, error: `${ErrorCategory.GOVERNANCE_DENIED}: ${err.errorCode ?? err.message}` };
    }
    app.log.warn({ err: err?.message, runId, toolRef: rawToolRef }, "[AgentLoop] 工具调用准入失败");
    return { stepId: "", ok: false, error: `${ErrorCategory.GOVERNANCE_UNAVAILABLE}:${err?.message ?? "unknown"}` };
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
  const stepWaitStart = performance.now();
  const immediate = await queryStepTerminal(pool, stepId);
  if (immediate) {
    const stepWaitDur = Math.round(performance.now() - stepWaitStart);
    _logger.debug("step-wait-immediate", { step_wait_duration_ms: stepWaitDur, stepId });
    return immediate;
  }

  if (signal?.aborted) {
    return { status: "canceled", outputDigest: null, output: null, errorCategory: ErrorCategory.INTERRUPTED };
  }

  // 尝试通过 Redis Pub/Sub 等待事件通知，同时保留 DB 轮询兆底
  const channel = `step:done:${stepId}`;

  return new Promise<{ status: string; outputDigest: any; output: any; errorCategory: string | null }>((resolve) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    // 2.1 FIX: 使用模块级懒单例 Redis 连接，避免每次调用创建新连接
    let subRegistered = false;
    // P0-5 FIX: 保存 listener 引用，cleanup 时必须 removeListener 防止内存泄漏
    let messageHandler: ((_ch: string, _msg: string) => void) | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = () => {
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
      // P0-5 FIX: 先移除 listener，再取消订阅
      if (subRegistered) {
        getSharedSubClient().then(c => {
          if (c && messageHandler) c.removeListener("message", messageHandler);
          c?.unsubscribe(channel).catch((e2: unknown) => {
            _logger.warn("Redis unsubscribe failed", { err: (e2 as Error)?.message, stepId, channel });
          });
        }).catch((e: unknown) => {
          _logger.warn("getSharedSubClient cleanup failed", { err: (e as Error)?.message, stepId });
        });
        messageHandler = null;
        subRegistered = false;
      }
    };

    const settle = (result: { status: string; outputDigest: any; output: any; errorCategory: string | null }) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stepWaitDur = Math.round(performance.now() - stepWaitStart);
      _logger.debug("step-wait", { step_wait_duration_ms: stepWaitDur, stepId });
      resolve(result);
    };

    // 超时兆底
    timeoutTimer = setTimeout(() => {
      settle({ status: "timeout", outputDigest: null, output: null, errorCategory: ErrorCategory.STEP_TIMEOUT });
    }, timeoutMs);

    // AbortSignal 监听
    abortHandler = () => settle({ status: "canceled", outputDigest: null, output: null, errorCategory: ErrorCategory.INTERRUPTED });
    signal?.addEventListener("abort", abortHandler, { once: true });

    // DB 轮询兜底（防止 Redis 消息丢失）— 递增间隔策略
    let pollCount = 0;
    const getPollInterval = (): number => {
      pollCount++;
      if (pollCount <= 3) return 500;   // 前 1.5 秒：每 500ms 轮询一次
      if (pollCount <= 8) return 1000;  // 接下来 5 秒：每 1s 轮询一次
      return 3000;                       // 之后：每 3s 轮询一次
    };
    const schedulePoll = () => {
      fallbackTimer = setTimeout(() => {
        if (settled) return;
        queryStepTerminal(pool, stepId)
          .then((r) => { if (r) settle(r); else schedulePoll(); })
          .catch(() => { schedulePoll(); });
      }, getPollInterval());
    };
    schedulePoll();

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
            .catch((e: unknown) => { /* DB poll query failed, will retry next tick */ });
        };
        client.on("message", messageHandler);
      } catch (e: unknown) {
        _logger.warn("Redis subscribe failed, falling back to DB poll", { err: (e as Error)?.message, stepId, channel });
      }
    })();
  });
}
