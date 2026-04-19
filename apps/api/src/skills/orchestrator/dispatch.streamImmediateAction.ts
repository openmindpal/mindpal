/**
 * Dispatch Stream — Immediate Action Handler
 *
 * 从 dispatch.stream.ts 提取的即时动作（immediate_action）执行路径。
 * 当 auto 模式下 planResult 的工具调用属于"可即时执行"类别时，
 * 跳过 workflow 层，直接在本地执行（NL2UI、内联工具）。
 */
import { sha256Hex } from "../../lib/digest";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { generateUiFromNaturalLanguage } from "../nl2ui-generator/modules/generator";
import { executeInlineTools, formatInlineResultsForLLM } from "./modules/inlineToolExecutor";
import { persistStreamSessionContext } from "./dispatch.streamSessionPersist";
import { invokeModelChatUpstreamStream } from "../model-gateway/modules/invokeChatUpstreamStream";
import type { SessionMessage } from "../../modules/memory/sessionContextRepo";

/* ------------------------------------------------------------------ */
/*  即时动作摘要流式生成                                                    */
/* ------------------------------------------------------------------ */

export async function streamImmediateActionSummary(params: {
  app: any;
  sse: { sendEvent: (event: string, data: any) => void };
  subject: { tenantId: string; spaceId?: string; subjectId: string };
  locale: string;
  message: string;
  toolResultText: string;
  traceId?: string;
  defaultModelRef?: string;
}) {
  const { app, sse, subject, locale, message, toolResultText, traceId, defaultModelRef } = params;
  if (!toolResultText.trim()) return;
  try {
    await invokeModelChatUpstreamStream({
      app,
      subject,
      body: {
        purpose: "orchestrator.dispatch.stream.immediate_action",
        messages: [
          { role: "user", content: message },
          {
            role: "user",
            content: toolResultText + (locale !== "en-US"
              ? "\n\n请基于上面的即时动作执行结果，直接告诉用户已经完成了什么，并用自然语言展示结果。不要提及任务、工作流、步骤编排。"
              : "\n\nBased on the immediate action results above, tell the user clearly what was completed and present the result naturally. Do not mention tasks, workflows, or orchestration."),
          },
        ],
        stream: true,
        ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
      },
      locale,
      traceId,
      onDelta: (text: string) => sse.sendEvent("delta", { text }),
    });
  } catch (err: any) {
    app.log.warn({ err, traceId }, "[dispatch.stream] 即时动作总结流式生成失败");
    sse.sendEvent("delta", {
      text: locale !== "en-US"
        ? "\n\n即时操作已完成，请查看结果。"
        : "\n\nImmediate action completed. Please check the result.",
    });
  }
}

/* ------------------------------------------------------------------ */
/*  即时动作执行主流程                                                      */
/* ------------------------------------------------------------------ */

export async function handleImmediateAction(params: {
  app: any;
  req: any;
  sse: { sendEvent: (event: string, data: any) => void };
  subject: { tenantId: string; spaceId: string; subjectId: string };
  locale: string;
  message: string;
  conversationId: string;
  resolution: {
    separatePipelineTool: { inputDraft: Record<string, unknown> } | null;
    inlineTools: Array<{ toolRef: string; inputDraft: Record<string, unknown> }>;
  };
  toolDiscovery: { tools: any[] };
  authorization: string | null;
  defaultModelRef?: string;
  prevSessionMsgs: SessionMessage[];
  historyLimit: number;
  mode: string;
  planStepCount: number;
}): Promise<void> {
  const {
    app, req, sse, subject, locale, message, conversationId,
    resolution, toolDiscovery, authorization, defaultModelRef,
    prevSessionMsgs, historyLimit, mode, planStepCount,
  } = params;

  req.ctx.audit!.outputDigest = {
    conversationId,
    mode,
    executionClass: "immediate_action",
    suggestedToolCount: planStepCount,
  };
  sse.sendEvent("status", { phase: "executing", executionClass: "immediate_action" });

  // 标记 execution:separate-pipeline 的工具有独立执行管线
  if (resolution.separatePipelineTool) {
    try {
      const nlInput = typeof resolution.separatePipelineTool.inputDraft?.userInput === "string"
        ? resolution.separatePipelineTool.inputDraft.userInput
        : message;
      const cfg = await generateUiFromNaturalLanguage(
        app.db,
        { userInput: nlInput, context: { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId, spaceId: subject.spaceId || undefined } },
        { app, authorization: authorization ?? "", traceId: req.ctx.traceId, defaultModelRef },
      );
      if (cfg) sse.sendEvent("nl2uiResult", { config: cfg });
    } catch (nl2uiErr: any) {
      app.log.error({ traceId: req.ctx.traceId, err: nl2uiErr?.message }, "[dispatch.stream] 即时 NL2UI 执行异常");
    }
  }

  // 内联工具执行
  const inlineResults = resolution.inlineTools.length > 0
    ? await executeInlineTools(resolution.inlineTools, {
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        enabledTools: toolDiscovery.tools,
        app,
        traceId: req.ctx.traceId,
      })
    : [];

  const toolResultText = formatInlineResultsForLLM(inlineResults, locale);
  if (toolResultText) {
    await streamImmediateActionSummary({
      app,
      sse,
      subject: { tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId },
      locale,
      message,
      toolResultText,
      traceId: req.ctx.traceId,
      defaultModelRef,
    });
  } else if (!resolution.separatePipelineTool) {
    sse.sendEvent("delta", {
      text: locale !== "en-US"
        ? "已完成即时操作。"
        : "Immediate action completed.",
    });
  }

  const turn = await createOrchestratorTurn({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId ?? null,
    subjectId: subject.subjectId,
    message: "",
    toolSuggestions: null,
    messageDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
    toolSuggestionsDigest: null,
  });

  // 持久化会话上下文
  try {
    await persistStreamSessionContext({
      prevMessages: prevSessionMsgs, userMessage: message,
      assistantContent: locale !== "en-US" ? "即时操作已完成。" : "Immediate action completed.",
      historyLimit, pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!,
      subjectId: subject.subjectId, sessionId: conversationId,
    });
  } catch (e: any) {
    app.log.warn({ err: e, traceId: req.ctx.traceId }, "[dispatch.stream] 即时动作会话持久化失败");
  }

  sse.sendEvent("done", { turnId: turn.turnId, conversationId, mode, executionClass: "immediate_action" });
}
