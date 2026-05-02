/**
 * Dispatch — Answer Mode Handler (非流式)
 *
 * 即时问答模式：走 turn 逻辑，并把即时动作与 workflow 建议分层返回
 */
import crypto from "node:crypto";
import type { DispatchContext, DispatchResponse } from "./dispatch.schema";
import { orchestrateChatTurn, discoverEnabledTools } from "./modules/orchestrator";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { digestParams } from "../../lib/digest";
import { invokeModelChat } from "../../lib/llm";
import { executeInlineTools, formatInlineResultsForLLM, loadInlineWritableEntities } from "./modules/inlineToolExecutor";
import { resolveExecutionClassFromSuggestions } from "./dispatch.executionPolicy";

export async function handleAnswerMode(ctx: DispatchContext): Promise<DispatchResponse> {
  const { app, req, subject, body, locale, message, conversationId, classification, messageDigest, piSummary, authorization, traceId } = ctx;

  const out = await orchestrateChatTurn({
    app,
    pool: app.db,
    subject,
    message,
    locale,
    conversationId,
    authorization,
    traceId,
    defaultModelRef: body.defaultModelRef,
  });

  const toolSuggestions = (out.toolSuggestions ?? []).map((s: any) => ({
    ...s,
    suggestionId: crypto.randomUUID(),
  }));

  // 基于工具元数据动态分类（替代硬编码 PASSIVE_PREFIXES）
  const { tools: enabledTools } = await discoverEnabledTools({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, locale });
  const inlineWritableEntities = await loadInlineWritableEntities(app.db);
  const resolution = await resolveExecutionClassFromSuggestions({
    toolCalls: toolSuggestions.map((s: any) => ({ toolRef: s.toolRef, inputDraft: s.inputDraft ?? {} })),
    enabledTools,
    inlineWritableEntities,
    dbCtx: { pool: app.db, tenantId: subject.tenantId },
  });
  const workerSuggestionKeys = new Set(
    resolution.workflowTools.map((s) => `${s.toolRef}::${JSON.stringify(digestParams(s.inputDraft ?? {}))}`)
  );
  const workerSuggestions = toolSuggestions.filter((s: any) =>
    workerSuggestionKeys.has(`${s.toolRef}::${JSON.stringify(digestParams(s.inputDraft ?? {}))}`)
  );

  // ━━━ 内联执行只读工具并增强回复 ━━━
  let finalReplyText = typeof out.replyText === "string" ? out.replyText : (out.replyText as Record<string, string>)?.[locale] ?? (out.replyText as Record<string, string>)?.["zh-CN"] ?? "";
  if (resolution.inlineTools.length > 0) {
    try {
      const inlineResults = await executeInlineTools(resolution.inlineTools, {
        pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId,
        subjectId: subject.subjectId, enabledTools, app, traceId,
      });
      const toolResultText = formatInlineResultsForLLM(inlineResults, locale);
      if (toolResultText) {
        const followUp = await invokeModelChat({
          app, subject, locale, authorization, traceId,
          purpose: "orchestrator.dispatch.inline_followup",
          messages: [
            { role: "user", content: message },
            { role: "assistant", content: finalReplyText },
            { role: "user", content: toolResultText + (locale !== "en-US"
              ? "\n\n请基于上面的工具返回数据，直接向用户展示结果。用自然语言组织数据，不要提及工具调用过程。如果数据为空，明确告知用户暂无数据。"
              : "\n\nBased on the tool results above, present the data to the user directly. Organize it in natural language. If empty, tell the user clearly.") },
          ],
        });
        if (typeof followUp?.outputText === "string" && followUp.outputText.trim()) {
          finalReplyText = followUp.outputText.trim();
        }
      }
    } catch (inlineErr: any) {
      app.log.warn({ err: inlineErr, traceId }, "[dispatch.handleAnswer] 内联工具执行失败");
    }
  }

  // ━━━ 正常 answer 模式 ━━━
  const turn = await createOrchestratorTurn({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId ?? null,
    subjectId: subject.subjectId,
    message: "",
    toolSuggestions: null,
    messageDigest,
    toolSuggestionsDigest: workerSuggestions.length ? workerSuggestions.map((s: any) => ({
      suggestionId: s.suggestionId,
      toolRef: s.toolRef,
      riskLevel: s.riskLevel,
      approvalRequired: s.approvalRequired,
      idempotencyKey: s.idempotencyKey,
      inputDigest: digestParams(s.inputDraft),
    })) : null,
  });

  const executionClass = resolution.executionClass;
  req.ctx.audit!.outputDigest = {
    mode: "answer",
    executionClass,
    turnId: turn.turnId,
    conversationId,
    classification: { mode: classification.mode, confidence: classification.confidence, reason: classification.reason },
    suggestionCount: workerSuggestions.length,
    safetySummary: { promptInjection: piSummary },
  };

  return {
    mode: "answer",
    executionClass,
    classification,
    conversationId,
    replyText: finalReplyText,
    toolSuggestions: workerSuggestions.length ? workerSuggestions : undefined,
    actionReceipt: workerSuggestions.length > 0
      ? {
          status: "suggested",
          toolCount: workerSuggestions.length,
          summary: locale !== "en-US" ? "检测到需要工作流处理的操作，已保留为可执行建议。" : "Workflow-requiring actions were detected and kept as executable suggestions.",
        }
      : resolution.inlineTools.length > 0
        ? {
            status: "completed",
            toolCount: resolution.inlineTools.length,
            summary: locale !== "en-US" ? "即时操作已完成。" : "Immediate action completed.",
          }
        : undefined,
    turnId: turn.turnId,
    uiDirective: out.uiDirective,
  };
}
