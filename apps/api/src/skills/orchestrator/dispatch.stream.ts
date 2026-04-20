/**
 * Dispatch Stream Route
 *
 * POST /orchestrator/dispatch/stream — 统一分流入口（流式 SSE 版本）
 *
 * 激活完整任务管理能力：
 * - 触发 LLM 意图分类（answer/execute/collab）
 * - 自动创建 Task/Run（execute/collab 模式）
 * - 支持闭环执行、审批流、多智能体协作
 * - 保留流式 UX（delta/toolSuggestions/nl2uiResult/done事件）
 */
import crypto from "node:crypto";
import { redactValue, resolveToolAlias, isDeviceToolName, resolveNumber, extractTextContent } from "@openslin/shared";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { sha256Hex } from "../../lib/digest";
import { classifyIntentFast, classifyIntentTwoLevel, reviewIntentDecision, intentDecisionToClassification, type IntentMode, type IntentClassification, GRAY_ZONE } from "./modules/intentClassifier";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { createJobRun } from "../../modules/workflow/jobRepo";
import { upsertTaskState } from "../../modules/memory/repo";
import { getSessionContext, upsertSessionContext, type SessionMessage } from "../../modules/memory/sessionContextRepo";
import type { WorkflowQueue } from "../../modules/workflow/queue";
import type { AgentLoopResult } from "../../kernel/agentLoop";
import { runPlanningPipeline } from "../../kernel/planningKernel";
import { getPromptInjectionModeFromEnv, scanPromptInjection, summarizePromptInjection } from "../safety-policy/modules/promptInjectionGuard";
import { createTask } from "../task-manager/modules/taskRepo";
import { openSse } from "../../lib/sse";
import { openManagedSse } from "../../lib/streamingPipeline";
import { resolveRequestDlpPolicyContext } from "../../lib/dlpPolicy";
import { finalizeAuditForStream } from "../../plugins/audit";
import { Errors } from "../../lib/errors";

import { dispatchRequestSchema } from "./dispatch.schema";
import { buildExecutionReplyText, explainDispatchStreamError, explainPlanningFailure } from "./dispatch.helpers";
import { deriveLoopPresentationStatus, makeOnStepComplete, makeOnLoopEnd, streamLoopSummary, wrapSseWithEventBus } from "./dispatch.streamHelpers";
import { handleStreamAnswerMode } from "./dispatch.streamAnswer";
import { resolveExecutionClassFromSuggestions } from "./dispatch.executionPolicy";
import { discoverEnabledTools, recallRelevantMemory, recallRecentTasks, recallRelevantKnowledge } from "./modules/orchestrator";
import { loadInlineWritableEntities } from "./modules/inlineToolExecutor";
import { getQueueManager, getTaskExecutor } from "./dispatch.streamTaskQueue";
import { persistStreamSessionContext } from "./dispatch.streamSessionPersist";
import { emitTaskEvent, broadcastToSession } from "../../lib/sessionEventBus";
import type { TaskQueueEntry } from "../../kernel/taskQueue.types";
import * as queueRepo from "../../kernel/taskQueueRepo";
import { handleImmediateAction } from "./dispatch.streamImmediateAction";

/* ------------------------------------------------------------------ */
/*  注册流式分流路由                                                     */
/* ------------------------------------------------------------------ */

export function registerStreamRoute(app: any): void {
  app.post("/orchestrator/dispatch/stream", async (req: any, reply: any) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "dispatch.stream" });
    const decision = await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH_STREAM });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = dispatchRequestSchema.parse(req.body);
    const locale = body.locale ?? req.ctx.locale ?? "zh-CN";
    const message = body.message.trim();
    const conversationId = body.conversationId?.trim() || crypto.randomUUID();
    const explicitMode = body.mode === "auto" ? undefined : body.mode as IntentMode | undefined;
    req.ctx.audit!.inputDigest = {
      mode: body.mode ?? "auto",
      conversationId,
      messageDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
      locale,
      defaultModelRef: body.defaultModelRef ?? null,
      hasConstraints: Boolean(body.constraints),
    };

    // 1. 安全检查
    const piMode = getPromptInjectionModeFromEnv();
    const piTarget = "orchestrator:dispatch.stream";
    const piScan = scanPromptInjection(message);
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, false);

    // 2. 立即打开 SSE（使用 StreamingPipeline 管理连接、心跳、背压）
    const dlpContext = await resolveRequestDlpPolicyContext({
      db: app.db,
      subject,
    });
    const sse = openManagedSse({
      req,
      reply,
      tenantId: subject.tenantId,
      runId: conversationId,
      dlpContext,
      onClose: () => finalizeAuditForStream(app, { req, reply }),
    });

    try {
      sse.sendEvent("ping", { ts: Date.now() });
      sse.sendEvent("status", { phase: "started" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      // 3. P1-4: 意图分类——先用 fast，当置信度不足时异步升级到 TwoLevel
      const classifyStartMs = Date.now();
      const _hasActiveTask = !!(body.activeRunContext || body.activeTaskIds?.length);

      // S1: 加载会话历史用于意图分类上下文感知（解决"我这个不是请求"等澄清语句理解）
      const _historyLimit = Math.max(4, Math.min(64, resolveNumber("ORCHESTRATOR_CONVERSATION_WINDOW").value));
      let _sessionHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      try {
        const _prevSession = await getSessionContext({
          pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
          subjectId: subject.subjectId, sessionId: conversationId,
        });
        const _prevMsgs = Array.isArray(_prevSession?.context?.messages) ? _prevSession!.context.messages : [];
        // 只提取最近 _historyLimit 条，截取 role + content
        _sessionHistory = _prevMsgs.slice(-_historyLimit).map((m) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : extractTextContent(m.content as any),
        })).filter((m) => m.role === "user" || m.role === "assistant");
      } catch {
        // 加载失败不影响分类
      }

      // 提取附件元数据用于多模态意图感知
      const _attachmentsMeta = body.attachments?.map((a) => ({
        type: a.type,
        mimeType: a.mimeType,
        name: a.name,
      }));

      let classification: IntentClassification = classifyIntentFast(message, explicitMode, { hasActiveTask: _hasActiveTask }, _attachmentsMeta)
        ?? { mode: "answer" as IntentMode, confidence: 0.5, reason: "fast_no_match", needsTask: false, needsApproval: false, complexity: "simple" as const };
      let classifierLabel: string = "fast";

      // P1-4: 当 fast 结果置信度低于阈值且非显式指定模式时，升级到 TwoLevel
      const STREAM_UPGRADE_THRESHOLD = parseFloat(process.env.STREAM_CLASSIFY_UPGRADE_THRESHOLD ?? "0.85");
      if (classification.confidence < STREAM_UPGRADE_THRESHOLD && !explicitMode) {
        const twoLevelParams = {
          pool: app.db, app,
          tenantId: subject.tenantId, spaceId: subject.spaceId,
          subjectId: subject.subjectId, message, explicitMode, locale,
          authorization: (req.headers.authorization as string | undefined) ?? null,
          traceId: req.ctx.traceId,
          activeRunContext: body.activeRunContext ? {
            runId: body.activeRunContext.runId,
            taskId: body.activeRunContext.taskId,
            taskTitle: body.activeRunContext.taskTitle ?? "",
            phase: body.activeRunContext.phase ?? "",
          } : undefined,
          activeTaskIds: body.activeTaskIds,
          sessionHistory: _sessionHistory.length > 0 ? _sessionHistory : undefined,
          attachments: _attachmentsMeta,
        };

        // P0: 超时竞争——LLM 分类最多阻塞 CLASSIFY_TIMEOUT ms，超时降级为 fast 结果
        const CLASSIFY_TIMEOUT = parseInt(process.env.INTENT_CLASSIFY_TIMEOUT_MS ?? "300", 10);
        const timeoutFallback = new Promise<null>((resolve) => setTimeout(() => resolve(null), CLASSIFY_TIMEOUT));

        const llmClassifyPromise = (async (): Promise<{ classification: IntentClassification; classifierUsed: string }> => {
          const twoLevelResult = await classifyIntentTwoLevel(twoLevelParams);
          const reviewed = await reviewIntentDecision(twoLevelParams, twoLevelResult);
          return {
            classification: intentDecisionToClassification(reviewed),
            classifierUsed: reviewed.classifierUsed ?? "two_level",
          };
        })();

        try {
          const raceResult = await Promise.race([llmClassifyPromise, timeoutFallback]);

          if (raceResult !== null) {
            // LLM 在超时内返回了结果，使用 LLM 结果
            classification = raceResult.classification;
            classifierLabel = raceResult.classifierUsed;
          } else {
            // 超时降级：使用 fast 分类结果（默认 answer），记录日志
            app.log.warn({ classifyTimeoutMs: CLASSIFY_TIMEOUT, fastMode: classification.mode },
              "[dispatch.stream] intent classify LLM timeout, using fast result");
            // 后台不 await，让 LLM 结果异步完成（用于统计/学习，不阻塞用户）
            llmClassifyPromise.then((result) => {
              app.log.info({ fastMode: classification.mode, llmMode: result.classification.mode, agreed: classification.mode === result.classification.mode },
                "[dispatch.stream] deferred intent classify completed");
            }).catch(() => {/* 静默忽略 */});
          }
        } catch (err: any) {
          app.log.warn({ err: err?.message, traceId: req.ctx.traceId }, "[dispatch.stream] TwoLevel 升级失败，保持 fast 结果");
        }
      }
      const classifyLatencyMs = Date.now() - classifyStartMs;
      const isAutoMode = body.mode === "auto" || !body.mode;
      let mode: IntentMode = classification.mode;
      let autoDowngraded = false;
      if (isAutoMode) {
        // 架构决策：auto 模式强制走 answer，依靠 answer 层的 auto-upgrade 机制
        // （检测 LLM 生成的 tool_call 后自动升级为执行），避免 classifyIntentFast
        // 对"修改""分析"等词的误判导致对话被错误创建为任务
        if (classification.mode !== "answer") autoDowngraded = true;
        mode = "answer";
        app.log.info({
          traceId: req.ctx.traceId,
          classifiedAs: classification.mode,
          confidence: classification.confidence,
          needsTask: classification.needsTask,
          selectedMode: mode,
          reason: "auto_mode_default_answer_with_upgrade_fallback",
        }, "[dispatch.stream] auto mode → answer (auto-upgrade fallback)");
      }

      // P0-1: 统一意图路由指标
      const _routeSource = classifierLabel === "fast" ? "fast_rule"
        : classifierLabel === "llm" ? "llm"
        : "standard_rule"; // two_level / reviewer 均归入 standard_rule
      app.metrics.observeIntentRoute({
        source: _routeSource as any,
        classifier: classifierLabel as "fast" | "llm" | "two_level" | "parallel_fast" | "reviewer",
        mode: classification.mode,
        confidence: classification.confidence,
        result: "ok",
        latencyMs: classifyLatencyMs,
        selectedMode: mode,
        autoDowngraded,
      });
      if (classification.reason) {
        const cBand = classification.confidence >= 0.85 ? "high" : classification.confidence >= 0.65 ? "medium" : "low";
        app.metrics.incIntentRuleMatch({ ruleId: classification.reason, confidence: cBand });
      }

      // S3: 当 fast 高置信短路时，异步跑 TwoLevel 做 shadow 对比记录
      const _wasUpgraded = classification.confidence >= STREAM_UPGRADE_THRESHOLD && !explicitMode;
      const _fastHighConf = classification.confidence >= GRAY_ZONE.HIGH && classifierLabel === "fast";
      if (_fastHighConf && !_wasUpgraded) {
        const _shadowParams = {
          pool: app.db, app,
          tenantId: subject.tenantId, spaceId: subject.spaceId,
          subjectId: subject.subjectId, message, explicitMode, locale,
          authorization: (req.headers.authorization as string | undefined) ?? null,
          traceId: req.ctx.traceId,
          activeRunContext: body.activeRunContext ? {
            runId: body.activeRunContext.runId,
            taskId: body.activeRunContext.taskId,
            taskTitle: body.activeRunContext.taskTitle ?? "",
            phase: body.activeRunContext.phase ?? "",
          } : undefined,
          activeTaskIds: body.activeTaskIds,
          sessionHistory: _sessionHistory.length > 0 ? _sessionHistory : undefined,
        };
        classifyIntentTwoLevel(_shadowParams).then((shadowResult) => {
          const agree = shadowResult.mode === classification.mode;
          app.metrics.observeIntentRoute({
            source: "dispatch_shadow", classifier: "two_level",
            mode: shadowResult.mode, confidence: shadowResult.confidence,
            result: agree ? "shadow_agree" : "shadow_disagree",
            latencyMs: Date.now() - classifyStartMs, selectedMode: shadowResult.mode, autoDowngraded: false,
          });
          if (!agree) {
            app.log.info({
              traceId: req.ctx.traceId,
              fastMode: classification.mode, fastConf: classification.confidence,
              shadowMode: shadowResult.mode, shadowConf: shadowResult.confidence,
            }, "[dispatch.stream] fast vs two_level shadow disagreement");
          }
        }).catch(() => {
          // shadow 失败不影响主流程
        });
      }

      sse.sendEvent("status", { phase: "classified", mode });

      // 4. answer 模式
      if (mode === "answer") {
        await handleStreamAnswerMode({
          app, req, sse, subject: { ...subject, spaceId: subject.spaceId! }, body, locale, message, conversationId, piSummary,
          classification,
        });
        return;
      }

      // 5. execute/collab 模式
      sse.sendEvent("safety", { promptInjection: piSummary });
      sse.sendEvent("status", { phase: "planning" });
      sse.sendEvent("phaseIndicator", { phase: "planning", runId: null });
      const authorization = (req.headers.authorization as string | undefined) ?? null;

      // 5.0 加载会话历史以保证上下文连续性（关键修复：execute/collab 也需要保存对话记录）
      const historyLimit = Math.max(4, Math.min(64, resolveNumber("ORCHESTRATOR_CONVERSATION_WINDOW").value));
      let prevSessionMsgs: SessionMessage[] = [];
      try {
        const prevSession = await getSessionContext({
          pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
          subjectId: subject.subjectId, sessionId: conversationId,
        });
        prevSessionMsgs = Array.isArray(prevSession?.context?.messages) ? prevSession!.context.messages : [];
        app.log.info({
          traceId: req.ctx.traceId, conversationId, mode,
          prevMsgCount: prevSessionMsgs.length,
        }, "[dispatch.stream] execute/collab 模式加载会话历史以保持上下文连续性");
      } catch (sessionErr: any) {
        app.log.warn({ err: sessionErr, traceId: req.ctx.traceId }, "[dispatch.stream] 加载会话历史失败，不影响执行");
      }

      // 5.0.1 并行回忆：记忆 + 任务历史 + 知识库
      let memoryContextText = "";
      let taskContextText = "";
      let knowledgeContextText = "";
      try {
        const [memRecall, taskRecall, knowledgeRecall] = await Promise.all([
          recallRelevantMemory({
            pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
            subjectId: subject.subjectId, message,
            auditContext: req.ctx.traceId ? { traceId: req.ctx.traceId, requestId: req.ctx.requestId } : undefined,
          }),
          recallRecentTasks({
            pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
            subjectId: subject.subjectId,
            auditContext: { traceId: req.ctx.traceId },
          }),
          recallRelevantKnowledge({
            pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
            subjectId: subject.subjectId, message,
            auditContext: { traceId: req.ctx.traceId },
          }),
        ]);
        memoryContextText = memRecall.text;
        taskContextText = taskRecall.text;
        knowledgeContextText = knowledgeRecall.text;
        if (memoryContextText || taskContextText || knowledgeContextText) {
          app.log.info({
            traceId: req.ctx.traceId, conversationId, mode,
            memoryRecallLen: memoryContextText.length,
            taskRecallLen: taskContextText.length,
            knowledgeRecallLen: knowledgeContextText.length,
          }, "[dispatch.stream] execute 路径上下文回忆完成");
        }
      } catch (recallErr: any) {
        app.log.warn({ err: recallErr, traceId: req.ctx.traceId }, "[dispatch.stream] execute 路径上下文回忆失败，不阻塞规划");
      }

      // 5.1 先规划，再决定落到即时动作层还是 workflow 层
      const planResult = await runPlanningPipeline({
        app, pool: app.db, subject, spaceId: subject.spaceId, locale,
        authorization,
        traceId: req.ctx.traceId, userMessage: message,
        plannerRole: "agent", actorRole: "executor",
        purpose: "dispatch.stream.execute", headers: {},
        memoryContext: memoryContextText || undefined,
        taskContext: taskContextText || undefined,
        knowledgeContext: knowledgeContextText || undefined,
      });

      if (isAutoMode && mode === "execute") {
        const [toolDiscovery, inlineWritableEntities] = await Promise.all([
          discoverEnabledTools({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, locale }),
          loadInlineWritableEntities(app.db),
        ]);

        const resolution = resolveExecutionClassFromSuggestions({
          toolCalls: planResult.planSteps.map((s) => ({ toolRef: s.toolRef, inputDraft: s.inputDraft ?? {} })),
          enabledTools: toolDiscovery.tools,
          inlineWritableEntities,
        });

        if (resolution.executionClass === "immediate_action") {
          await handleImmediateAction({
            app, req, sse,
            subject: { tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId },
            locale, message, conversationId,
            resolution, toolDiscovery,
            authorization,
            defaultModelRef: body.defaultModelRef,
            prevSessionMsgs, historyLimit, mode,
            planStepCount: planResult.planSteps.length,
          });
          return;
        }
      }

      // ── D1 守卫：规划失败处理 ──
      // auto 模式下规划失败 → 降级到 answer 模式（answer 模式有完善的 NL2UI / 内联工具 / 对话能力）
      // 用户显式指定 execute 模式 → 保留原有报错行为
      if (!planResult.ok || planResult.planSteps.length === 0) {
        const failCategory = planResult.failureCategory ?? "unknown";
        const failReasonText = explainPlanningFailure(locale, failCategory);
        app.log.warn({
          traceId: req.ctx.traceId, conversationId, mode, failCategory,
          rawSuggestionCount: planResult.rawSuggestionCount ?? null,
          filteredSuggestionCount: planResult.filteredSuggestionCount ?? null,
          isAutoMode,
          willFallbackToAnswer: isAutoMode,
        }, "[dispatch.stream] 规划失败，不进入 workflow 路径");

        // ── 关键修复：auto 模式下降级到 answer，让 NL2UI / 对话能力兜底 ──
        if (isAutoMode) {
          req.ctx.audit!.outputDigest = {
            conversationId,
            mode: "answer",
            executionClass: "fallback_answer",
            fallbackFrom: "execute",
            failCategory,
          };
          app.log.info({
            traceId: req.ctx.traceId, conversationId, failCategory,
            droppedToolCalls: planResult.droppedToolCalls?.map(d => ({ toolRef: d.toolRef, reason: d.reason })) ?? [],
          }, "[dispatch.stream] auto 模式规划失败，降级到 answer 模式（NL2UI / 对话兜底）");
          sse.sendEvent("status", { phase: "classified", mode: "answer", fallbackFrom: "execute", reason: failCategory });
          sse.sendEvent("phaseIndicator", { phase: "thinking", runId: null, mode: "answer", fallbackFrom: "execute", reason: failCategory });
          await handleStreamAnswerMode({
            app, req, sse, subject: { ...subject, spaceId: subject.spaceId! }, body, locale, message, conversationId, piSummary,
            classification,
          });
          return;
        }

        // ── 用户显式指定 execute 模式：保留原有报错行为 ──
        req.ctx.audit!.outputDigest = {
          conversationId,
          mode,
          executionClass: "planning_failed",
          failCategory,
        };
        sse.sendEvent("phaseIndicator", { phase: "failed", runId: null });
        const fallbackText = buildExecutionReplyText({ locale, userMessage: message, planResult, phase: "failed" });
        sse.sendEvent("delta", { text: fallbackText });

        // 记录 turn（无 task/run）
        const failTurn = await createOrchestratorTurn({
          pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null,
          subjectId: subject.subjectId, message: "", toolSuggestions: null,
          messageDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
          toolSuggestionsDigest: null,
        });

        // 持久化会话上下文（让后续 answer 轮能看到这次失败的对话）
        try {
          await persistStreamSessionContext({
            prevMessages: prevSessionMsgs, userMessage: message,
            historyLimit, pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
            subjectId: subject.subjectId, sessionId: conversationId,
          });
        } catch (e: any) {
          app.log.warn({ err: e, traceId: req.ctx.traceId }, "[dispatch.stream] 规划失败场景会话持久化失败");
        }

        sse.sendEvent("done", { turnId: failTurn.turnId, conversationId, mode, planningFailed: true });
        return;
      }

      // 5.2 创建 Task + Job + Run
      const task = await createTask({
        pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId,
        title: message.slice(0, 100), createdBySubjectId: subject.subjectId,
      });

      const maxIterations = body.constraints?.maxSteps ?? 15;
      const maxWallTimeMs = body.constraints?.maxWallTimeMs ?? 10 * 60 * 1000;
      const executionConstraints = {
        allowedTools: body.constraints?.allowedTools,
        allowWrites: body.constraints?.allowWrites,
      };

      const jobRun = await createJobRun({
        pool: app.db, tenantId: subject.tenantId,
        jobType: mode === "collab" ? "agent.collab" : "agent.dispatch",
        runToolRef: `orchestrator.dispatch@1`,
        inputDigest: {
          taskId: task.taskId,
          goalDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
          mode, agentLoop: true, constraints: body.constraints ?? null,
        },
        createdBySubjectId: subject.subjectId,
        trigger: mode === "collab" ? "collab" : "dispatch",
      });

      const runId = jobRun.run.runId;
      const jobId = jobRun.job.jobId;

      // 5.2.1 入队到会话任务队列
      const sessionId = body.sessionQueueContext?.sessionId || conversationId;
      const queueManager = getQueueManager(app);

      // P2-G8: 创建双通道 SSE 句柄（直连 SSE + sessionEventBus）
      const muxSse = wrapSseWithEventBus(sse, subject.tenantId, sessionId, task.taskId);

      // P0-G2: 在 enqueue 之前注册执行上下文，因为 enqueue 可能立即触发 executor.execute()
      const executor = getTaskExecutor(app);
      const completionPromise = executor.prepareAndWait(task.taskId, {
        app,
        pool: app.db,
        queue: app.queue as WorkflowQueue,
        subject: { ...subject, spaceId: subject.spaceId! },
        locale,
        authorization,
        traceId: req.ctx.traceId,
        maxIterations,
        maxWallTimeMs,
        executionConstraints,
        defaultModelRef: body.defaultModelRef,
        requestId: req.id,
        onStepComplete: makeOnStepComplete({
          app, sse, subject, locale, message, runId,
          defaultModelRef: body.defaultModelRef, traceId: req.ctx.traceId, requestId: req.id,
          taskId: task.taskId, sessionId,
        }),
        onLoopEnd: makeOnLoopEnd({ sse, runId, traceId: req.ctx.traceId, requestId: req.id, taskId: task.taskId, sessionId, tenantId: subject.tenantId }),
      });

      // enqueue 内部调用 tryScheduleNext → startExecution → executor.execute()
      // executor.execute() 会查找上面注册的上下文，并使用 SSE 回调启动 AgentLoop
      const enqueueResult = await queueManager.enqueue({
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        sessionId,
        goal: message,
        mode: mode as "execute" | "collab",
        foreground: true,
        createdBySubjectId: subject.subjectId,
        taskId: task.taskId,
        runId,
        jobId,
        metadata: {
          locale, authorization, traceId: req.ctx.traceId,
          maxIterations, maxWallTimeMs, executionConstraints,
          defaultModelRef: body.defaultModelRef,
          spaceId: subject.spaceId,
        },
      });
      const entryId = enqueueResult.entry.entryId;

      // 5.3 保存任务状态
      await upsertTaskState({
        pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId,
        phase: "executing",
        plan: { taskId: task.taskId, goal: message, mode, constraints: body.constraints ?? {}, agentLoop: true },
        artifactsDigest: { taskId: task.taskId, jobId },
      });

      muxSse.sendEvent("taskCreated", {
        taskId: task.taskId, runId, jobId, mode, entryId,
        queueInfo: { entryId, position: enqueueResult.position, activeCount: enqueueResult.activeCount },
        taskState: { phase: "executing", stepCount: 0, currentStep: 0, needsApproval: false },
        executionClass: "workflow",
      });
      req.ctx.audit!.outputDigest = {
        conversationId,
        mode,
        executionClass: "workflow",
        taskId: task.taskId,
        runId,
        jobId,
        plannedStepCount: planResult.planSteps.length,
      };

      // 5.3.1 推送 planStep 结构化卡片到聊天流（含设备可用性预检）
      // 工具别名解析使用 @openslin/shared 共享解析器，不再内联硬编码
      const totalPlanSteps = planResult.planSteps.length;
      const deviceToolSteps: Array<{ idx: number; toolName: string }> = [];
      for (let i = 0; i < totalPlanSteps; i++) {
        const ps = planResult.planSteps[i];
        const toolName = ps.toolRef.replace(/@\d+$/, "");
        if (isDeviceToolName(toolName)) {
          deviceToolSteps.push({ idx: i, toolName: resolveToolAlias(toolName) });
        }
      }

      // 预检设备可用性（批量查询，避免N+1）
      let deviceAvailabilityMap = new Map<string, boolean>();
      if (deviceToolSteps.length > 0 && subject.spaceId) {
        try {
          const uniqueToolNames = [...new Set(deviceToolSteps.map((d) => d.toolName))];
          for (const tn of uniqueToolNames) {
            const deviceCheck = await app.db.query(
              `SELECT device_id FROM device_records d
               JOIN device_policies p ON p.tenant_id = d.tenant_id AND p.device_id = d.device_id
               WHERE d.tenant_id = $1 AND d.space_id = $2 AND d.status = 'active'
                 AND d.last_seen_at > now() - interval '5 minutes'
                 AND p.allowed_tools::jsonb @> $3::jsonb
               LIMIT 1`,
              [subject.tenantId, subject.spaceId, JSON.stringify([tn])],
            );
            deviceAvailabilityMap.set(tn, (deviceCheck.rowCount ?? 0) > 0);
          }
        } catch (deviceCheckErr: any) {
          app.log.warn({ err: deviceCheckErr, traceId: req.ctx.traceId }, "[dispatch.stream] 设备可用性预检失败（非致命）");
        }
      }

      for (let i = 0; i < totalPlanSteps; i++) {
        const ps = planResult.planSteps[i];
        const toolName = ps.toolRef.replace(/@\d+$/, "");
        const normalizedToolName = resolveToolAlias(toolName);
        const isDeviceTool = isDeviceToolName(toolName);
        const deviceAvailable = isDeviceTool ? (deviceAvailabilityMap.get(normalizedToolName) ?? null) : null;
        muxSse.sendEvent("planStep", {
          stepIndex: i,
          totalSteps: totalPlanSteps,
          toolRef: ps.toolRef,
          name: null,
          status: isDeviceTool && deviceAvailable === false ? "device_unavailable" : "pending",
          runId,
          stepId: ps.stepId,
          // 设备工具附加可用性信息
          ...(isDeviceTool ? { deviceInfo: { isDeviceTool: true, deviceAvailable, hint: deviceAvailable === false ? (locale !== "en-US" ? "⚠ 未检测到在线设备，此步骤可能等待设备上线" : "⚠ No active device detected, this step may wait for a device") : null } } : {}),
        });
      }

      // 5.4 即时初始回复
      const initReplyText = buildExecutionReplyText({
        locale, userMessage: message, planResult,
        phase: planResult.planSteps.length > 0 ? "executing" : "failed",
      });
      muxSse.sendEvent("delta", { text: initReplyText });

      // 5.4.1 进入执行阶段
      muxSse.sendEvent("phaseIndicator", { phase: "executing", runId });

      // 5.5 P0-G2: 等待 Executor 完成（AgentLoop 结果通过 waiter 传回）
      // prepareAndWait 已在 enqueue 之前调用，executor.execute() 已被调度器触发
      let loopResult: AgentLoopResult | null = null;
      try {
        loopResult = await completionPromise;
        // 前台任务：由 dispatch 层标记完成（executor 不会自动标记前台任务）
        if (loopResult) {
          await queueManager.markCompleted(entryId).catch(() => {});
        }
      } catch (loopErr: any) {
        app.log.error({ err: loopErr, runId, jobId, taskId: task.taskId, traceId: req.ctx.traceId }, "[dispatch.stream] Agent Loop 异常，终止流程");
        req.ctx.audit!.errorCategory = "internal_error";
        req.ctx.audit!.outputDigest = {
          conversationId,
          mode,
          executionClass: "workflow",
          taskId: task.taskId,
          runId,
          jobId,
          status: "failed",
          reason: "agent_loop_error",
        };
        // 标记队列条目失败
        await queueManager.markFailed(entryId, String(loopErr?.message ?? "agent_loop_error")).catch(() => {});
        try {
          muxSse.sendEvent("phaseIndicator", { phase: "failed", runId });
          muxSse.sendEvent("error", {
            errorCode: "AGENT_LOOP_ERROR",
            message: locale !== "en-US"
              ? "执行过程中出现内部异常，当前任务已停止。你可以稍后重试；如果问题持续存在，请根据请求 ID 排查日志。"
              : "An internal execution error occurred and the current task has been stopped. Please retry later and inspect the logs with the request ID if it persists.",
            traceId: req.ctx.traceId,
          });
        } catch {}
        return;
      }

      // 5.6 流式生成最终总结
      if (loopResult) {
        muxSse.sendEvent("phaseIndicator", { phase: "reviewing", runId });
        await streamLoopSummary({
          app, sse: muxSse, subject, locale, message, loopResult,
          defaultModelRef: body.defaultModelRef, traceId: req.ctx.traceId, requestId: req.id,
          taskId: task.taskId, sessionId,
        });
        // 发射最终阶段指示器
        const finalPhase = deriveLoopPresentationStatus(loopResult);
        req.ctx.audit!.outputDigest = {
          conversationId,
          mode,
          executionClass: "workflow",
          taskId: task.taskId,
          runId,
          jobId,
          status: finalPhase,
          endReason: loopResult.endReason,
          iterations: loopResult.iterations,
          succeededSteps: loopResult.succeededSteps,
          failedSteps: loopResult.failedSteps,
        };
        muxSse.sendEvent("phaseIndicator", { phase: finalPhase, runId });
      } else {
        req.ctx.audit!.errorCategory = "internal_error";
        muxSse.sendEvent("phaseIndicator", { phase: "failed", runId });
      }

      // 5.7 完成事件
      const turn = await createOrchestratorTurn({
        pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId,
        message: "", toolSuggestions: null,
        messageDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
        toolSuggestionsDigest: null,
      });

      // 5.8 持久化会话上下文（关键修复：execute/collab 模式也保存对话记录，保证后续 answer 轮能看到完整历史）
      try {
        // D4: 收集本轮 assistant 回复摘要 — 区分成功/失败场景
        let assistantSummary: string;
        if (loopResult?.ok) {
          assistantSummary = locale !== "en-US" ? `[任务执行完成] ${message.slice(0, 100)}` : `[Task completed] ${message.slice(0, 100)}`;
        } else {
          const endReason = loopResult?.endReason ?? "unknown";
          assistantSummary = locale !== "en-US"
            ? `[任务执行失败] ${endReason}：${message.slice(0, 80)}`
            : `[Task failed] ${endReason}: ${message.slice(0, 80)}`;
        }
        await persistStreamSessionContext({
          prevMessages: prevSessionMsgs, userMessage: message,
          assistantContent: assistantSummary,
          historyLimit, pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
          subjectId: subject.subjectId, sessionId: conversationId,
        });
        app.log.info({
          traceId: req.ctx.traceId, conversationId, mode,
        }, "[dispatch.stream] execute/collab 模式会话上下文已持久化");
      } catch (sessionPersistErr: any) {
        app.log.warn({ err: sessionPersistErr, traceId: req.ctx.traceId }, "[dispatch.stream] execute/collab 会话持久化失败（不影响任务执行）");
      }

      muxSse.sendEvent("done", { turnId: turn.turnId, conversationId, taskId: task.taskId, runId, jobId, mode });
    } catch (err: any) {
      app.log.error({ err, traceId: req.ctx.traceId }, "[dispatch.stream] error");
      sse.sendEvent("error", {
        errorCode: err.statusCode === 429 ? "RATE_LIMITED" : "DISPATCH_STREAM_ERROR",
        message: explainDispatchStreamError(locale, err.payload?.message),
        traceId: req.ctx.traceId,
      });
    } finally {
      sse.close();
    }
  });
}
