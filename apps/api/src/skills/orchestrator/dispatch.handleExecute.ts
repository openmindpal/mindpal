/**
 * Dispatch — Execute Mode Handler (非流式)
 *
 * 单智能体执行模式：创建 Task + Run，启动 Agent Loop
 * Agent Loop 替代旧的「一次规划 + 机械 cursor++ 执行」模式
 */
import type { DispatchContext, DispatchResponse } from "./dispatch.schema";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { appendStepToRun, createJobRun } from "../../modules/workflow/jobRepo";
import { upsertTaskState } from "../../modules/memory/repo";
import type { WorkflowQueue } from "../../modules/workflow/queue";
import { requirePermission } from "../../modules/auth/guard";
import { validateToolInput } from "../../modules/tools/validate";
import {
  admitAndBuildStepEnvelope,
  buildStepInputPayload,
  generateIdempotencyKey,
  resolveAndValidateTool,
  submitStepToExistingRun,
} from "../../kernel/executionKernel";
import { runPlanningPipeline } from "../../kernel/planningKernel";
import { runAgentLoop } from "../../kernel/agentLoop";
import { generateUiFromNaturalLanguage } from "../nl2ui-generator/modules/generator";
import { createTask } from "../task-manager/modules/taskRepo";
import { analyzeUserIntent, separateToolSuggestions } from "./modules/intentIntegration";
import { parseAndAnchorUserIntentions } from "../../kernel/intentAnchoringService";

export async function handleExecuteMode(ctx: DispatchContext): Promise<DispatchResponse> {
  const { app, req, subject, body, locale, message, conversationId, classification, messageDigest, piSummary, authorization, traceId } = ctx;

  // 创建 Task
  const task = await createTask({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    title: message.slice(0, 100),
    createdBySubjectId: subject.subjectId,
  });

  // 创建 Job + Run
  const jobRun = await createJobRun({
    pool: app.db,
    tenantId: subject.tenantId,
    jobType: "agent.dispatch",
    runToolRef: "orchestrator.dispatch@1",
    inputDigest: {
      taskId: task.taskId,
      goalDigest: messageDigest,
      mode: "execute",
      constraints: body.constraints,
      agentLoop: true,
    },
    createdBySubjectId: subject.subjectId,
    trigger: "dispatch",
  });

  const runId = jobRun.run.runId;
  const jobId = jobRun.job.jobId;

  // 初始化任务状态
  await upsertTaskState({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    runId,
    phase: "planning",
    plan: {
      taskId: task.taskId,
      goal: message,
      mode: "execute",
      constraints: body.constraints ?? {},
      agentLoop: true,
    },
  });

  // P0-2: 自动解析并锚定用户显式指令（禁令/约束等）
  try {
    const anchors = await parseAndAnchorUserIntentions({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      message,
      taskId: task.taskId,
      conversationId,
    });
    if (anchors.length > 0) {
      app.log.info({ 
        runId, 
        taskId: task.taskId, 
        anchorCount: anchors.length,
        types: anchors.map(a => a.instructionType) 
      }, "[dispatch] 已锚定用户显式指令");
    }
  } catch (err: any) {
    // 意图锚定失败不影响主流程，仅记录警告
    app.log.warn({ err: err?.message, runId }, "[dispatch] 意图锚定失败（不影响执行）");
  }

  let phase: string = "executing";
  let nl2uiConfig: any = null;

  // ━━━ 当传入预生成的 toolSuggestions 时，直接创建 steps 执行 ━━━
  const prebuiltSuggestions = Array.isArray(body.toolSuggestions) && body.toolSuggestions.length > 0
    ? body.toolSuggestions
    : null;

  if (prebuiltSuggestions) {
    // 使用意图分析 Skill 替代硬编码的 NL2UI 检测
    let intentResult: Awaited<ReturnType<typeof analyzeUserIntent>> | null = null;
    
    // 如果没有预生成建议，调用 intent.analyze
    if (!prebuiltSuggestions || prebuiltSuggestions.length === 0) {
      intentResult = await analyzeUserIntent(app.db, message, subject, app);
    }

    // 分离 NL2UI 和 Worker 工具建议
    const { nl2uiSuggestions, workerSuggestions } = separateToolSuggestions(prebuiltSuggestions);

    app.log.info({ 
      runId, 
      taskId: task.taskId, 
      nl2uiCount: nl2uiSuggestions.length, 
      workerCount: workerSuggestions.length,
      detectedIntent: intentResult?.intent 
    }, "[dispatch] 处理工具建议");

    // NL2UI 内联执行
    if (nl2uiSuggestions.length > 0) {
      const nlInput = nl2uiSuggestions[0].inputDraft?.userInput;
      try {
        nl2uiConfig = await generateUiFromNaturalLanguage(app.db,
          { userInput: typeof nlInput === "string" ? nlInput : message, context: { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId, spaceId: subject.spaceId || undefined } },
          { app, authorization: authorization ?? "", traceId });
      } catch (e: any) {
        app.log.warn({ error: e?.message }, "[dispatch] NL2UI inline execution failed");
      }
      if (nl2uiConfig && workerSuggestions.length === 0) {
        phase = "succeeded";
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId,
          phase: "succeeded",
          plan: { taskId: task.taskId, goal: message, mode: "execute", nl2ui: true, agentLoop: false },
          clearBlockReason: true,
          clearNextAction: true,
          clearApprovalStatus: true,
        });
      }
    }

    // 仅为非 NL2UI 工具创建 Worker steps
    if (workerSuggestions.length > 0) {
      let firstOutcome: "queued" | "needs_approval" = "queued";
      for (let i = 0; i < workerSuggestions.length; i++) {
        const suggestion = workerSuggestions[i];
        const resolved = await resolveAndValidateTool({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          rawToolRef: suggestion.toolRef,
        });
        const inputDraft = suggestion.inputDraft ?? {};
        validateToolInput(resolved.version.inputSchema, inputDraft);

        const opDecision = await requirePermission({
          req,
          resourceType: resolved.resourceType,
          action: resolved.action,
        });
        const admitted = await admitAndBuildStepEnvelope({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          resolved,
          opDecision,
        });
        const idempotencyKey = generateIdempotencyKey({
          resolved,
          prefix: "dispatch-upgrade",
          runId,
          seq: i + 1,
        });
        const stepInput = buildStepInputPayload({
          kind: "agent.dispatch.upgrade",
          resolved,
          admitted,
          input: inputDraft,
          idempotencyKey,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          traceId,
          extra: { actorRole: "executor", source: "auto-upgrade" },
        });

        if (i === 0) {
          const firstResult = await submitStepToExistingRun({
            pool: app.db,
            queue: app.queue as WorkflowQueue,
            tenantId: subject.tenantId,
            resolved,
            opDecision,
            stepInput,
            runId,
            jobId,
            jobType: "agent.dispatch",
            masterKey: app.cfg.secrets.masterKey,
          });
          firstOutcome = firstResult.outcome;
        } else {
          // P0-1 FIX: 所有后续步骤也必须通过统一执行内核，确保治理一致性
          const subsequentResult = await submitStepToExistingRun({
            pool: app.db,
            queue: app.queue as WorkflowQueue,
            tenantId: subject.tenantId,
            resolved,
            opDecision,
            stepInput,
            runId,
            jobId,
            jobType: "agent.dispatch",
            masterKey: app.cfg.secrets.masterKey,
          });
          // 记录后续步骤的结果（但不影响第一个步骤的outcome）
          if (subsequentResult.outcome === "needs_approval" && firstOutcome !== "needs_approval") {
            firstOutcome = "needs_approval";
          }
        }
      }

      if (workerSuggestions.length > 0) {
        phase = firstOutcome === "needs_approval" ? "needs_approval" : "executing";
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId,
          phase,
          approvalStatus: phase === "needs_approval" ? "pending" : undefined,
          clearBlockReason: phase !== "needs_approval",
          clearNextAction: phase !== "needs_approval",
          clearApprovalStatus: phase !== "needs_approval",
          plan: {
            taskId: task.taskId,
            goal: message,
            mode: "execute",
            constraints: body.constraints ?? {},
            toolSuggestions: workerSuggestions.map(s => ({ toolRef: s.toolRef })),
            agentLoop: false,
          },
        });
      }
    }
  } else {
    // 无预生成 suggestions → 走原有逻辑

    // 快速规划检测是否有 nl2ui 需求
    const quickPlan = await runPlanningPipeline({
      app,
      pool: app.db,
      subject,
      spaceId: subject.spaceId,
      locale,
      authorization,
      traceId,
      userMessage: message,
      maxSteps: 1,
      purpose: "dispatch.execute.nl2ui_check",
      plannerRole: "executor",
      actorRole: "executor",
    });

    const hasNl2ui = quickPlan.planSteps.some(s => s.toolRef.startsWith("nl2ui.generate"));
    if (hasNl2ui) {
      try {
        nl2uiConfig = await generateUiFromNaturalLanguage(app.db,
          { userInput: message, context: { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId, spaceId: subject.spaceId || undefined } },
          { app, authorization: authorization ?? "", traceId });
      } catch {}
      if (nl2uiConfig) {
        phase = "succeeded";
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId,
          phase,
          clearBlockReason: true,
          clearNextAction: true,
          clearApprovalStatus: true,
        });
      }
    }

    // 如果不是纯 NL2UI 任务，启动 Agent Loop（异步执行）
    if (!nl2uiConfig) {
      const maxIterations = body.constraints?.maxSteps ?? 10;
      const maxWallTimeMs = body.constraints?.maxWallTimeMs ?? 10 * 60 * 1000;

      const agentLoopPromise = runAgentLoop({
        app,
        pool: app.db,
        queue: app.queue as WorkflowQueue,
        subject: { ...subject, spaceId: subject.spaceId! },
        locale,
        authorization,
        traceId,
        goal: message,
        runId,
        jobId,
        taskId: task.taskId,
        maxIterations,
        maxWallTimeMs,
        executionConstraints: {
          allowedTools: body.constraints?.allowedTools,
          allowWrites: body.constraints?.allowWrites,
        },
        defaultModelRef: body.defaultModelRef,
      });

      // 早期失败检测：短暂等待 500ms，捕捉同步初始化错误（如 DB 连接失败、参数校验错误等）
      // 若 500ms 内未报错，则认为 loop 已正常启动，当坞后台运行
      const EARLY_CHECK_MS = 500;
      const earlyCheck = new Promise<"started">((resolve) => setTimeout(() => resolve("started"), EARLY_CHECK_MS));
      const earlyResult = await Promise.race([
        agentLoopPromise.then((result) => {
          app.log.info({ runId, loopId: result.loopId, endReason: result.endReason, taskId: task.taskId }, "[dispatch] Agent Loop 完成");
          return "completed" as const;
        }),
        earlyCheck,
      ]).catch((err: any) => {
        app.log.error({ err, runId, taskId: task.taskId }, "[dispatch] Agent Loop 早期失败（启动阶段异常）");
        return "early_error" as const;
      });

      if (earlyResult === "early_error") {
        phase = "error";
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId,
          phase: "error",
          clearBlockReason: true,
          clearNextAction: true,
          clearApprovalStatus: true,
        });
      } else if (earlyResult === "started") {
        // loop 还在后台运行，挂载异常捕获
        agentLoopPromise.catch((err: any) => {
          app.log.error({ err, runId, taskId: task.taskId }, "[dispatch] Agent Loop 异常结束");
        });
      }
      // earlyResult === "completed" 表示 loop 已在 500ms 内完成，无需额外处理
    }
  }

  // 生成回复文本
  const zh = locale.startsWith("zh");
  const executionReplyText = nl2uiConfig
    ? (zh ? "页面已生成，请查看。" : "Page generated. Please check the result.")
    : (zh
      ? `收到你的请求「${message.slice(0, 80)}」，Agent Loop 已启动，正在智能分析并逐步执行。每一步都会由 AI 分析执行结果后决定下一步操作。`
      : `Received your request. Agent Loop started — AI will analyze each step's result before deciding the next action.`);

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
    mode: "execute",
    turnId: turn.turnId,
    taskId: task.taskId,
    runId,
    jobId,
    phase,
    classification: { mode: classification.mode, confidence: classification.confidence, reason: classification.reason },
    agentLoop: true,
    safetySummary: { promptInjection: piSummary },
  };

  return {
    mode: "execute",
    classification,
    conversationId,
    replyText: executionReplyText,
    taskId: task.taskId,
    runId,
    jobId,
    phase: nl2uiConfig ? "succeeded" : phase,
    taskState: {
      phase: nl2uiConfig ? "succeeded" : phase,
      stepCount: 0,
      currentStep: 0,
      needsApproval: false,
    },
    turnId: turn.turnId,
    nl2uiResult: nl2uiConfig ?? undefined,
  };
}
