/**
 * runs/query.ts — 查询路由（列表/详情/搜索/回放）
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { StructuredLogger } from "@openslin/shared";
import type { RunSummaryDTO, RunDetailDTO, RunStepDTO } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "routes:runs:query" });
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { getRunForSpace, listRuns, listSteps } from "../../modules/workflow/jobRepo";
import { buildRunReplay } from "../../modules/workflow/replayRepo";
import { getTaskState } from "../../modules/memory/repo";

/* ─── Shared mapper helpers ─────────────────────────────────────────── */

function mapRowToSummary(r: any): RunSummaryDTO {
  const plan = r.plan ?? {};
  const planSteps: { stepId?: string; toolRef?: string; name?: string }[] = Array.isArray(plan.steps) ? plan.steps : [];
  const currentStepIdx = typeof r.current_step_seq === "number" ? r.current_step_seq - 1 : 0;
  const planStep = planSteps[currentStepIdx] ?? null;

  const artifacts = r.artifacts_digest ?? {};
  const cursor = typeof artifacts.cursor === "number" ? artifacts.cursor : (r.succeeded_steps ?? 0);
  const maxSteps = typeof artifacts.maxSteps === "number" ? artifacts.maxSteps : (planSteps.length || r.total_steps || 0);

  const durationRaw = r.duration_ms ?? null;
  const durationMs = durationRaw !== null ? Math.round(Number(durationRaw)) : null;

  return {
    runId: r.run_id,
    status: r.status ?? "unknown",
    phase: r.phase ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    traceId: r.trace_id ?? null,
    trigger: r.trigger ?? null,
    jobType: r.job_type ?? null,
    progress: {
      current: cursor,
      total: maxSteps,
      percentage: maxSteps > 0 ? Math.round((cursor / maxSteps) * 100) : 0,
    },
    currentStep: r.current_step_id
      ? {
          stepId: r.current_step_id,
          seq: r.current_step_seq,
          status: r.current_step_status,
          toolRef: r.current_tool_ref ?? planStep?.toolRef ?? null,
          name: planStep?.name ?? null,
          attempt: r.current_attempt ?? 1,
        }
      : null,
    durationMs,
    outputDigest: null,
    errorDigest: r.current_error_category || r.current_last_error_digest
      ? {
          errorCategory: r.current_error_category ?? null,
          message: r.current_last_error_digest ?? null,
        }
      : null,
  };
}

function mapStepToDTO(s: any): RunStepDTO {
  const startedAt = s.startedAt ?? s.started_at;
  const finishedAt = s.finishedAt ?? s.finished_at;
  let stepDuration: number | null = null;
  if (startedAt && finishedAt) {
    stepDuration = Math.round(new Date(finishedAt).getTime() - new Date(startedAt).getTime());
  }
  return {
    stepId: s.stepId ?? s.step_id,
    seq: s.seq,
    status: s.status,
    toolRef: s.toolRef ?? s.tool_ref ?? null,
    inputDigest: s.inputDigest ?? s.input_digest ?? null,
    outputDigest: s.outputDigest ?? s.output_digest ?? null,
    errorCategory: s.errorCategory ?? s.error_category ?? null,
    durationMs: stepDuration,
    createdAt: s.createdAt ?? s.created_at,
    updatedAt: s.updatedAt ?? s.updated_at,
  };
}

export const runsQueryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /runs/active - 获取当前用户进行中的任务列表
   * 返回 phase 为 planning/executing/reviewing/needs_approval 的 Run
   * 包括每个 Run 的当前 Step 信息
   */
  app.get("/runs/active", async (req) => {
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_READ });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(50).optional(),
      })
      .parse(req.query);

    // Query runs with non-terminal status and their latest step info
    const res = await app.db.query(
      `
      WITH active_runs AS (
        SELECT
          r.run_id,
          r.tenant_id,
          r.status,
          r.trigger,
          r.started_at,
          r.finished_at,
          r.created_at,
          r.updated_at,
          (s1.input->>'spaceId') AS space_id,
          COALESCE(s1.input->>'traceId', s1.input->>'trace_id') AS trace_id
        FROM runs r
        JOIN steps s1 ON s1.run_id = r.run_id AND s1.seq = 1
        WHERE r.tenant_id = $1
          AND (s1.input->>'spaceId') = $2
          AND r.status IN ('queued', 'running', 'paused', 'needs_approval', 'needs_device', 'needs_arbiter')
        ORDER BY r.updated_at DESC
        LIMIT $3
      ),
      task_states AS (
        SELECT DISTINCT ON (run_id)
          run_id,
          phase,
          plan,
          artifacts_digest,
          updated_at AS task_updated_at
        FROM memory_task_states
        WHERE tenant_id = $1 AND space_id = $2 AND deleted_at IS NULL
        ORDER BY run_id, updated_at DESC
      ),
      current_steps AS (
        SELECT DISTINCT ON (s.run_id)
          s.run_id,
          s.step_id,
          s.seq,
          s.status AS step_status,
          s.tool_ref,
          s.attempt,
          s.error_category,
          s.last_error_digest,
          s.updated_at AS step_updated_at
        FROM steps s
        WHERE EXISTS (SELECT 1 FROM active_runs ar WHERE ar.run_id = s.run_id)
        ORDER BY s.run_id, s.seq DESC
      ),
      step_counts AS (
        SELECT
          s.run_id,
          COUNT(*)::int AS total_steps,
          COUNT(*) FILTER (WHERE s.status = 'succeeded')::int AS succeeded_steps
        FROM steps s
        WHERE EXISTS (SELECT 1 FROM active_runs ar WHERE ar.run_id = s.run_id)
        GROUP BY s.run_id
      ),
      job_info AS (
        SELECT DISTINCT ON (j.run_id)
          j.run_id,
          j.job_type
        FROM jobs j
        WHERE j.tenant_id = $1
          AND EXISTS (SELECT 1 FROM active_runs ar WHERE ar.run_id = j.run_id)
        ORDER BY j.run_id, j.created_at DESC
      )
      SELECT
        ar.run_id,
        ar.status,
        ar.trigger,
        ar.created_at,
        ar.updated_at,
        ar.space_id,
        ar.trace_id,
        ts.phase,
        ts.plan,
        ts.artifacts_digest,
        cs.step_id AS current_step_id,
        cs.seq AS current_step_seq,
        cs.step_status AS current_step_status,
        cs.tool_ref AS current_tool_ref,
        cs.attempt AS current_attempt,
        cs.error_category AS current_error_category,
        cs.last_error_digest AS current_last_error_digest,
        sc.total_steps,
        sc.succeeded_steps,
        ji.job_type,
        CASE WHEN ar.finished_at IS NOT NULL AND ar.started_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (ar.finished_at::timestamptz - ar.started_at::timestamptz)) * 1000
          ELSE NULL
        END AS duration_ms
      FROM active_runs ar
      LEFT JOIN task_states ts ON ts.run_id = ar.run_id
      LEFT JOIN current_steps cs ON cs.run_id = ar.run_id
      LEFT JOIN step_counts sc ON sc.run_id = ar.run_id
      LEFT JOIN job_info ji ON ji.run_id = ar.run_id
      ORDER BY ar.updated_at DESC
      `,
      [subject.tenantId, subject.spaceId, q.limit ?? 20],
    );

    const activeRuns: RunSummaryDTO[] = res.rows.map((r: any) => {
      const dto = mapRowToSummary(r);
      // active runs default phase to 'executing' if not set
      if (!dto.phase) dto.phase = "executing";
      return dto;
    });

    req.ctx.audit!.outputDigest = { count: activeRuns.length };
    return { activeRuns };
  });

  app.get("/runs", async (req) => {
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_READ });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        status: z.string().optional(),
        updatedFrom: z.string().optional(),
        updatedTo: z.string().optional(),
      })
      .parse(req.query);
    if (q.updatedFrom && Number.isNaN(new Date(q.updatedFrom).getTime())) throw Errors.badRequest("updatedFrom 非法");
    if (q.updatedTo && Number.isNaN(new Date(q.updatedTo).getTime())) throw Errors.badRequest("updatedTo 非法");
    const rows = await listRuns(app.db, subject.tenantId, {
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
      status: q.status,
      spaceId: subject.spaceId,
      updatedFrom: q.updatedFrom,
      updatedTo: q.updatedTo,
    });
    const runs = rows.map(mapRowToSummary);
    return { runs };
  });

  app.get("/runs/:runId", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_READ });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    const steps = await listSteps(app.db, run.runId);

    const succeededCount = steps.filter((s: any) => String(s.status) === "succeeded").length;
    const totalSteps = steps.length;

    // 尝试从 memory_task_states 读取 blockReason
    let blockReason: string | null = null;
    let taskStatePhase: string | null = null;
    let nextAction: string | null = null;
    try {
      const ts = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: params.runId });
      if (ts) {
        blockReason = ts.blockReason ?? null;
        taskStatePhase = ts.phase ?? null;
        nextAction = ts.nextAction ?? null;
      }
    } catch (e) {
      // 降级：memory_task_states 读取失败不影响主响应
      _logger.warn("getTaskState failed", { runId: params.runId, err: (e as Error)?.message });
    }

    // 计算 durationMs
    let durationMs: number | null = null;
    if (run.startedAt && run.finishedAt) {
      durationMs = Math.round(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
    }

    // 查找当前步骤（最后一个非终态步骤，或最后一个步骤）
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;

    // 构建错误摘要（从最后一个失败步骤提取）
    const failedStep = steps.find((s: any) => s.errorCategory || s.lastErrorDigest) ?? null;
    const errorDigest = failedStep
      ? { errorCategory: failedStep.errorCategory ?? null, message: failedStep.lastErrorDigest ?? null }
      : null;

    const stepsDTO: RunStepDTO[] = steps.map(mapStepToDTO);

    // 构建 RunDetailDTO
    const detail: RunDetailDTO = {
      runId: run.runId,
      status: run.status,
      phase: taskStatePhase ?? run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      traceId: run.traceId ?? null,
      trigger: run.trigger ?? null,
      jobType: null,
      progress: {
        current: succeededCount,
        total: totalSteps,
        percentage: totalSteps > 0 ? Math.round((succeededCount / totalSteps) * 100) : 0,
      },
      currentStep: lastStep
        ? {
            stepId: lastStep.stepId,
            seq: lastStep.seq,
            status: lastStep.status,
            toolRef: lastStep.toolRef ?? null,
            name: null,
            attempt: lastStep.attempt ?? 1,
          }
        : null,
      durationMs,
      outputDigest: null,
      errorDigest,
      steps: stepsDTO,
      blockReason,
      nextAction,
      createdBySubjectId: run.createdBySubjectId ?? null,
      idempotencyKey: run.idempotencyKey ?? null,
    };

    return {
      ...detail,
      // 向后兼容：保留原有顶层字段供前端 pollTaskState 直接读取
      run,
      steps,
      stepCount: totalSteps,
      currentStep: succeededCount,
    };
  });

  // P1-3: 统一 TaskState 视图 API（轻量级，供前端轮询）
  app.get("/task-states/:runId", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_READ });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    // 优先从 memory_task_states 读取富信息 TaskState
    const ts = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: params.runId });
    if (!ts) {
      // 降级：从 run + steps 组装基本信息
      const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
      if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
      const steps = await listSteps(app.db, run.runId);
      return {
        runId: run.runId,
        status: run.status,
        phase: run.status,
        stepCount: steps.length,
        currentStep: steps.filter((s: any) => String(s.status) === "succeeded").length,
        needsApproval: run.status === "needs_approval",
        blockReason: null,
        role: null,
        nextAction: null,
        evidence: null,
        approvalStatus: null,
      };
    }

    // 从 memory_task_states 返回完整视图
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    const steps = run ? await listSteps(app.db, run.runId) : [];
    return {
      runId: params.runId,
      status: run?.status ?? ts.phase,
      phase: ts.phase,
      stepCount: steps.length,
      currentStep: steps.filter((s: any) => String(s.status) === "succeeded").length,
      needsApproval: run?.status === "needs_approval",
      blockReason: ts.blockReason,
      role: ts.role,
      nextAction: ts.nextAction,
      evidence: ts.evidence,
      approvalStatus: ts.approvalStatus,
      taskSummary: ts.taskSummary,
    };
  });

  app.get("/runs/:runId/replay", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "run.replay" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_READ });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const visible = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!visible) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    const replay = await buildRunReplay({ pool: app.db, tenantId: subject.tenantId, runId: params.runId, limit: 500 });
    if (!replay) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    req.ctx.audit!.outputDigest = { replayedRunId: replay.run.runId, stepCount: replay.steps.length, timelineCount: replay.timeline.length };
    return replay;
  });
};
