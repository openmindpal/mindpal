/**
 * Dispatch — Intervene Mode Handler (非流式)
 *
 * 干预模式：用户想修改/停止/调整正在执行的任务
 * 根据 interventionType 映射到 Recovery 或 Replan 操作
 */
import type { DispatchContext, DispatchResponse } from "./dispatch.schema";
import { Errors } from "../../lib/errors";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { handleRecoveryEvent } from "../../kernel/runRecovery";
import { replanFromCurrent } from "../../kernel/runtimeStepManager";
import { runPlanningPipeline } from "../../kernel/planningKernel";
import { runAgentLoop, type AgentLoopParams } from "../../kernel/agentLoop";
import type { WorkflowQueue } from "../../modules/workflow/queue";
import { createTaskQueueManager } from "../../kernel/taskQueueManager";
import { broadcastToSession } from "../../lib/sessionEventBus";

export async function handleInterveneMode(ctx: DispatchContext): Promise<DispatchResponse> {
  const { app, req, subject, body, locale, message, conversationId, classification, messageDigest, piSummary, authorization, traceId } = ctx;

  // 多任务干预：优先使用 classification 中的目标任务信息
  const targetTaskId = classification.targetTaskId;
  const targetEntryId = classification.targetEntryId;
  const interventionType = classification.interventionType;

  // 如果是“取消所有”操作，通过 TaskQueueManager 批量取消
  if (targetTaskId === "*" && interventionType === "cancel") {
    const sessionId = body.sessionQueueContext?.sessionId || conversationId;
    const queueManager = createTaskQueueManager(app.db);
    const cancelledCount = await queueManager.cancelAll(subject.tenantId, sessionId);

    const zh = locale.startsWith("zh");
    const replyText = zh
      ? `已取消会话中所有任务（共 ${cancelledCount} 个）`
      : `Cancelled all tasks in session (${cancelledCount} total)`;

    broadcastToSession(sessionId, subject.tenantId, "allTasksCancelled", { count: cancelledCount });

    const turn = await createOrchestratorTurn({
      pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId, message: "", toolSuggestions: null,
      messageDigest, toolSuggestionsDigest: null,
    });

    return {
      mode: "intervene", classification, conversationId, replyText,
      phase: "cancelled",
      taskState: { phase: "cancelled", needsApproval: false },
      turnId: turn.turnId,
    };
  }

  // 多任务干预：如果有 targetEntryId，通过 TaskQueueManager 操作队列条目
  if (targetEntryId && (interventionType === "pause" || interventionType === "resume" || interventionType === "cancel")) {
    const queueManager = createTaskQueueManager(app.db);
    let result: any = null;
    let phase = "intervening";

    if (interventionType === "pause") {
      result = await queueManager.pause(targetEntryId, { tenantId: subject.tenantId, spaceId: subject.spaceId });
      phase = result ? "paused" : "intervening";
    } else if (interventionType === "resume") {
      result = await queueManager.resume(targetEntryId, { tenantId: subject.tenantId, spaceId: subject.spaceId });
      phase = result ? "executing" : "intervening";
    } else if (interventionType === "cancel") {
      result = await queueManager.cancel(targetEntryId, { tenantId: subject.tenantId, spaceId: subject.spaceId });
      phase = result ? "cancelled" : "intervening";
    }

    const zh = locale.startsWith("zh");
    const replyText = result
      ? (zh ? `已处理干预请求：任务已${interventionType === "pause" ? "暂停" : interventionType === "resume" ? "恢复" : "取消"}` : `Intervention processed: task ${interventionType}d`)
      : (zh ? `干预操作未能完成` : `Intervention failed`);

    const turn = await createOrchestratorTurn({
      pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId, message: "", toolSuggestions: null,
      messageDigest, toolSuggestionsDigest: null,
    });

    return {
      mode: "intervene", classification, conversationId, replyText,
      taskId: targetTaskId ?? undefined,
      phase,
      taskState: { phase, needsApproval: false },
      turnId: turn.turnId,
    };
  }

  // 回退到原有的单任务干预逻辑
  const activeCtx = body.activeRunContext;
  if (!activeCtx) {
    throw Errors.badRequest("intervene 模式需要 activeRunContext");
  }

  const interventionTypeLegacy = classification.interventionType;
  let interventionResult: any = null;
  let phase = "intervening";

  // 根据干预类型分流
  if (interventionTypeLegacy === "pause") {
    interventionResult = await handleRecoveryEvent(
      { action: "pause", runId: activeCtx.runId, tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId, traceId, reason: message },
      app.db, app.queue as WorkflowQueue,
    );
    phase = interventionResult.ok ? "paused" : phase;
  } else if (interventionTypeLegacy === "resume") {
    // P0-5 FIX: ask_user 恢复链路 — 将用户回复传入恢复流程
    interventionResult = await handleRecoveryEvent(
      { action: "resume", runId: activeCtx.runId, tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId, traceId, reason: message },
      app.db, app.queue as WorkflowQueue,
    );
    phase = interventionResult.ok ? "executing" : phase;

    // P0-5 FIX: 如果恢复成功且前置状态是 paused（ask_user 场景），重新启动 Agent Loop
    if (interventionResult.ok && interventionResult.previousStatus === "paused") {
      try {
        // 查找该 run 的 paused checkpoint
        const cpRes = await app.db.query(
          `SELECT loop_id, job_id, task_id, goal, max_iterations, max_wall_time_ms,
                  subject_payload, locale, authorization, trace_id, default_model_ref,
                  iteration, current_seq, succeeded_steps, failed_steps,
                  observations_digest, last_decision,
                  tool_discovery_cache, memory_context, task_history, knowledge_context
           FROM agent_loop_checkpoints
           WHERE run_id = $1 AND status = 'paused'
           ORDER BY updated_at DESC LIMIT 1`,
          [activeCtx.runId],
        );
        if (cpRes.rowCount) {
          const cp = cpRes.rows[0] as any;
          // 标记 checkpoint 为 resuming
          await app.db.query(
            "UPDATE agent_loop_checkpoints SET status = 'resuming', heartbeat_at = now(), updated_at = now() WHERE loop_id = $1 AND status = 'paused'",
            [cp.loop_id],
          );
          // 重建 AgentLoopParams 并 fire-and-forget 启动 Agent Loop
          const subjectPayload = cp.subject_payload ?? {};
          const loopParams: AgentLoopParams = {
            app,
            pool: app.db,
            queue: app.queue as WorkflowQueue,
            subject: {
              subjectId: subjectPayload.subjectId ?? subject.subjectId,
              tenantId: subjectPayload.tenantId ?? subject.tenantId,
              spaceId: subjectPayload.spaceId ?? subject.spaceId,
            },
            locale: cp.locale ?? locale,
            authorization: cp.authorization ?? authorization,
            traceId: cp.trace_id ?? traceId,
            goal: cp.goal,
            runId: activeCtx.runId,
            jobId: cp.job_id,
            taskId: cp.task_id ?? activeCtx.taskId ?? "",
            maxIterations: cp.max_iterations ?? 15,
            maxWallTimeMs: Number(cp.max_wall_time_ms ?? 600000),
            defaultModelRef: cp.default_model_ref ?? undefined,
            resumeLoopId: cp.loop_id,
            resumeState: {
              iteration: cp.iteration ?? 0,
              currentSeq: cp.current_seq ?? 1,
              succeededSteps: cp.succeeded_steps ?? 0,
              failedSteps: cp.failed_steps ?? 0,
              observations: Array.isArray(cp.observations_digest) ? cp.observations_digest : [],
              lastDecision: cp.last_decision ?? null,
              toolDiscoveryCache: cp.tool_discovery_cache ?? undefined,
              memoryContext: cp.memory_context ?? undefined,
              taskHistory: cp.task_history ?? undefined,
              knowledgeContext: cp.knowledge_context ?? undefined,
            },
            userIntervention: message, // 用户的回复作为干预消息传入 Agent Loop
          };
          runAgentLoop(loopParams).catch((err) => {
            app.log.error({ err: err?.message, runId: activeCtx.runId, loopId: cp.loop_id }, "[intervene:resume] Agent Loop 恢复失败");
          });
          app.log.info({ runId: activeCtx.runId, loopId: cp.loop_id }, "[intervene:resume] Agent Loop 已从 checkpoint 恢复");
        }
      } catch (cpErr: any) {
        app.log.warn({ err: cpErr?.message, runId: activeCtx.runId }, "[intervene:resume] checkpoint 恢复失败，降级为纯状态恢复");
      }
    }
  } else if (interventionTypeLegacy === "cancel") {
    interventionResult = await handleRecoveryEvent(
      { action: "cancel", runId: activeCtx.runId, tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId, traceId, reason: message },
      app.db, app.queue as WorkflowQueue,
    );
    phase = interventionResult.ok ? "canceled" : phase;
  } else if (interventionTypeLegacy === "modify_step" || interventionTypeLegacy === "add_step" || interventionTypeLegacy === "remove_step" || interventionTypeLegacy === "change_goal") {
    // 需要重新规划
    const planResult = await runPlanningPipeline({
      app,
      pool: app.db,
      subject,
      spaceId: subject.spaceId,
      locale,
      authorization,
      traceId,
      userMessage: message,
      maxSteps: body.constraints?.maxSteps ?? 10,
      purpose: "dispatch.intervene.replan",
      plannerRole: "executor",
      actorRole: "executor",
    });

    // 获取当前执行进度
    const cursorRes = await app.db.query(
      "SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps WHERE run_id = $1 AND status IN ('succeeded', 'failed')",
      [activeCtx.runId],
    );
    const currentCursor = cursorRes.rows[0]?.max_seq ?? 0;

    const replanResult = await replanFromCurrent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId!,
      runId: activeCtx.runId,
      currentCursor,
      newSteps: planResult.planSteps.map((s) => ({
        actorRole: "executor",
        kind: "tool" as const,
        toolRef: s.toolRef,
        inputDraft: s.inputDraft,
        dependsOn: [],
        approvalRequired: false,
      })),
      reason: `user_intervention: ${interventionTypeLegacy} — ${message.slice(0, 200)}`,
      traceId,
    });

    interventionResult = replanResult;
    phase = replanResult.ok ? "executing" : "failed";

    // 恢复运行（如果之前是暂停/阻塞状态）
    if (replanResult.ok && replanResult.insertedCount > 0) {
      await handleRecoveryEvent(
        { action: "resume", runId: activeCtx.runId, tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId, traceId, reason: "replan_resume" },
        app.db, app.queue as WorkflowQueue,
      ).catch(() => {}); // 如果已经在运行，resume 会失败，忽略
    }
  } else {
    // 未知干预类型 → 尝试中断并恢复
    interventionResult = await handleRecoveryEvent(
      { action: "interrupt", runId: activeCtx.runId, tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId, traceId, reason: message },
      app.db, app.queue as WorkflowQueue,
    );
    phase = interventionResult?.ok ? "stopped" : phase;
  }

  const zh = locale.startsWith("zh");
  const replyText = interventionResult?.ok
    ? (zh ? `已处理你的干预请求：${interventionResult.message}` : `Intervention processed: ${interventionResult.message}`)
    : (zh ? `干预操作未能完成：${interventionResult?.message ?? "未知错误"}` : `Intervention failed: ${interventionResult?.message ?? "unknown error"}`);

  const turn = await createOrchestratorTurn({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId ?? null,
    subjectId: subject.subjectId,
    message: "",
    toolSuggestions: null,
    messageDigest,
    toolSuggestionsDigest: null,
  });

  req.ctx.audit!.outputDigest = {
    mode: "intervene",
    turnId: turn.turnId,
    taskId: activeCtx.taskId,
    runId: activeCtx.runId,
    interventionType: interventionTypeLegacy,
    interventionOk: interventionResult?.ok ?? false,
    phase,
    classification: { mode: classification.mode, confidence: classification.confidence, reason: classification.reason },
    safetySummary: { promptInjection: piSummary },
  };

  return {
    mode: "intervene",
    classification,
    conversationId,
    replyText,
    taskId: activeCtx.taskId,
    runId: activeCtx.runId,
    phase,
    taskState: { phase, needsApproval: false },
    turnId: turn.turnId,
  };
}
