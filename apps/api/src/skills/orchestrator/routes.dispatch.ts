/**
 * Unified Dispatch Route — 瘦主入口
 *
 * POST /orchestrator/dispatch — 统一分流入口
 * POST /orchestrator/dispatch/classify — 仅分类不执行
 * POST /orchestrator/dispatch/stream — 流式 SSE 版本
 *
 * 具体业务逻辑拆分至:
 *   dispatch.handleAnswer.ts   — answer 模式
 *   dispatch.handleExecute.ts  — execute 模式
 *   dispatch.handleCollab.ts   — collab 模式
 *   dispatch.handleIntervene.ts — intervene 模式
 *   dispatch.classify.ts       — classify 路由
 *   dispatch.stream.ts         — 流式 SSE 路由
 *   dispatch.streamAnswer.ts   — 流式 answer 模式
 *   dispatch.streamHelpers.ts  — 共享 SSE 回调
 *   dispatch.helpers.ts        — 工具函数
 *   dispatch.schema.ts         — Schema + 类型
 */
import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { sha256Hex } from "../../lib/digest";
import {
  classifyIntentFast,
  classifyIntentTwoLevel,
  intentDecisionToClassification,
  reviewIntentDecision,
  type IntentMode,
  type IntentClassification,
} from "./modules/intentClassifier";
import { AUTO_EXECUTION_THRESHOLD, FAST_RULE_HIGH_CONFIDENCE, shouldAutoEnterExecute } from "./dispatch.executionPolicy";
import { getPromptInjectionModeFromEnv, scanPromptInjection, summarizePromptInjection } from "../safety-policy/modules/promptInjectionGuard";

/* ================================================================== */
/*  P1-6: 并行双路决策 + 熔断机制                                         */
/* ================================================================== */

const PARALLEL_CLASSIFY = {
  /** 启用并行双路（fast + two_level 同时跑，以 two_level 为准，fast 作影子） */
  ENABLED: (process.env.PARALLEL_CLASSIFY_ENABLED ?? "0") === "1",
  /** 熔断器：连续失败次数阈值 */
  CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env.PARALLEL_CB_THRESHOLD ?? "5", 10),
  /** 熔断后冷却时间 (ms) */
  CIRCUIT_BREAKER_COOLDOWN_MS: parseInt(process.env.PARALLEL_CB_COOLDOWN_MS ?? "60000", 10),
};

/** 熔断器状态（进程内单例） */
const _circuitBreaker = {
  consecutiveFailures: 0,
  lastFailureAt: 0,
  isOpen: false,
};

function cbRecordSuccess() {
  _circuitBreaker.consecutiveFailures = 0;
  _circuitBreaker.isOpen = false;
}

function cbRecordFailure() {
  _circuitBreaker.consecutiveFailures++;
  _circuitBreaker.lastFailureAt = Date.now();
  if (_circuitBreaker.consecutiveFailures >= PARALLEL_CLASSIFY.CIRCUIT_BREAKER_THRESHOLD) {
    _circuitBreaker.isOpen = true;
  }
}

function cbIsAvailable(): boolean {
  if (!_circuitBreaker.isOpen) return true;
  // 冷却期过后允许半开探测
  if (Date.now() - _circuitBreaker.lastFailureAt > PARALLEL_CLASSIFY.CIRCUIT_BREAKER_COOLDOWN_MS) {
    _circuitBreaker.isOpen = false;
    _circuitBreaker.consecutiveFailures = 0;
    return true;
  }
  return false;
}

import { dispatchRequestSchema, type DispatchContext } from "./dispatch.schema";
import { handleAnswerMode } from "./dispatch.handleAnswer";
import { handleExecuteMode } from "./dispatch.handleExecute";
import { handleCollabMode } from "./dispatch.handleCollab";
import { handleInterveneMode } from "./dispatch.handleIntervene";
import { registerClassifyRoute } from "./dispatch.classify";
import { registerStreamRoute } from "./dispatch.stream";
import { getSessionContext } from "../../modules/memory/sessionContextRepo";

// 类型导出
export type { DispatchRequest, DispatchResponse } from "./dispatch.schema";

export const orchestratorDispatchRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /orchestrator/dispatch — 统一分流入口（非流式）
   */
  app.post("/orchestrator/dispatch", async (req, reply) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "dispatch" });
    const decision = await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = dispatchRequestSchema.parse(req.body);
    const locale = body.locale ?? req.ctx.locale ?? "zh-CN";
    const message = body.message.trim();
    const conversationId = body.conversationId?.trim() || crypto.randomUUID();

    // 1. 安全检查：提示注入扫描
    const piMode = getPromptInjectionModeFromEnv();
    const piTarget = "orchestrator:dispatch";
    const piScan = scanPromptInjection(message);
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, false);

    // 2. 意图分类
    const explicitMode = body.mode === "auto" ? undefined : body.mode as IntentMode | undefined;
    const classifyStartMs = Date.now();
    const useFast = !!body.fastClassify;

    // S1: 加载会话历史用于意图分类上下文感知
    const _historyLimit = Math.max(4, Math.min(64, Number(process.env.ORCHESTRATOR_CONVERSATION_WINDOW ?? "30") || 30));
    let _sessionHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const _prevSession = await getSessionContext({
        pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
        subjectId: subject.subjectId, sessionId: conversationId,
      });
      const _prevMsgs = Array.isArray(_prevSession?.context?.messages) ? _prevSession!.context.messages : [];
      _sessionHistory = _prevMsgs.slice(-_historyLimit).map((m) => ({
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string" ? m.content : (m.content as any)?.text ?? "",
      })).filter((m) => m.role === "user" || m.role === "assistant");
    } catch {
      // 加载失败不影响分类
    }

    let classification: IntentClassification;
    let classifierLabel = "fast";

    const _fastFallback: IntentClassification = { mode: "answer", confidence: 0.5, reason: "fast_no_match", needsTask: false, needsApproval: false, complexity: "simple" };

    if (useFast) {
      // 用户显式要求快速分类
      classification = classifyIntentFast(message, explicitMode) ?? _fastFallback;
    } else if (PARALLEL_CLASSIFY.ENABLED && cbIsAvailable()) {
      // P1-6: 并行双路 — fast 立即返回，two_level 异步对比
      const fastResult = classifyIntentFast(message, explicitMode) ?? _fastFallback;
      classification = fastResult; // 先用 fast 结果
      classifierLabel = "parallel_fast";

      // 后台跑 two_level（fire-and-forget模式，只记录不阻塞）
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
      };
      classifyIntentTwoLevel(twoLevelParams).then((llmResult) => {
        cbRecordSuccess();
        // P3-3 shadow evaluation: 记录双路对比指标
        const agree = llmResult.mode === fastResult.mode;
        app.metrics.observeIntentRoute({
          source: "dispatch_shadow", classifier: "two_level",
          mode: llmResult.mode, confidence: llmResult.confidence,
          result: agree ? "shadow_agree" : "shadow_disagree",
          latencyMs: Date.now() - classifyStartMs, selectedMode: llmResult.mode, autoDowngraded: false,
        });
        if (!agree) {
          app.log.info({
            traceId: req.ctx.traceId,
            fastMode: fastResult.mode, fastConf: fastResult.confidence,
            llmMode: llmResult.mode, llmConf: llmResult.confidence,
          }, "[dispatch] parallel classify disagreement (shadow)");
        }
      }).catch(() => { cbRecordFailure(); });
    } else {
      // 标准主链路：two-level + reviewer
      const reviewParams = {
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
      const reviewedDecision = await reviewIntentDecision(
        reviewParams,
        await classifyIntentTwoLevel(reviewParams),
      );
      classification = intentDecisionToClassification(reviewedDecision);
      classifierLabel = reviewedDecision.classifierUsed;
    }
    const classifyLatencyMs = Date.now() - classifyStartMs;

    const isAutoMode = body.mode === "auto" || !body.mode;
    let mode: IntentMode = classification.mode;
    let autoDowngraded = false;
    if (isAutoMode) {
      const canDirectExecute = shouldAutoEnterExecute(classification);
      // S2: fast 规则高置信结果直接信任，不被降级
      const fastHighConfTrust = classification.reason && !classification.reason.startsWith("llm_") && classification.confidence >= FAST_RULE_HIGH_CONFIDENCE;
      if (!canDirectExecute && !fastHighConfTrust && classification.mode !== "answer") autoDowngraded = true;
      mode = (canDirectExecute || fastHighConfTrust) ? classification.mode : "answer";
      app.log.info({
        traceId: req.ctx.traceId,
        classifiedAs: classification.mode,
        confidence: classification.confidence,
        needsTask: classification.needsTask,
        autoExecuteThreshold: AUTO_EXECUTION_THRESHOLD,
        fastHighConfThreshold: FAST_RULE_HIGH_CONFIDENCE,
        fastHighConfTrust,
        selectedMode: mode,
        reason: canDirectExecute ? "high_confidence_task_intent" : fastHighConfTrust ? "fast_rule_high_confidence_trusted" : "default_answer_with_upgrade_fallback",
      }, "[dispatch] auto mode route selected");
    }

    // P0-1: 统一意图路由指标
    app.metrics.observeIntentRoute({
      source: "dispatch",
      classifier: classifierLabel as any,
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

    // 3. 构建共享上下文
    const ctx: DispatchContext = {
      app,
      req,
      subject: { tenantId: subject.tenantId, spaceId: subject.spaceId!, subjectId: subject.subjectId },
      body,
      locale,
      message,
      conversationId,
      classification,
      messageDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
      piSummary,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      traceId: req.ctx.traceId,
    };

    // 4. 根据模式分流
    if (mode === "answer") return handleAnswerMode(ctx);
    if (mode === "execute") return handleExecuteMode(ctx);
    if (mode === "collab") return handleCollabMode(ctx);
    if (mode === "intervene") return handleInterveneMode(ctx);

    throw Errors.badRequest(`Unknown mode: ${mode}`);
  });

  // POST /orchestrator/dispatch/classify
  registerClassifyRoute(app);

  // POST /orchestrator/dispatch/stream
  registerStreamRoute(app);
};
