/**
 * Dispatch Stream — Answer Mode
 *
 * 流式 answer 模式：完整上下文 + 真流式 LLM 调用
 * 仅处理对话与即时动作，不在前端/answer 层自动升级为 workflow
 */
import crypto from "node:crypto";
import { redactValue, parseDocument, dataUrlToBuffer, StructuredLogger, resolveNumber } from "@openslin/shared";
import { shouldRequireApproval } from "@openslin/shared/approvalDecision";

const _logger = new StructuredLogger({ module: "api:dispatch.streamAnswer" });
import { orchestrateChatTurn, discoverEnabledTools, buildSystemPrompt, summarizeDroppedMessages, fallbackTruncateSummary, recallRelevantMemory, recallRecentTasks, recallRelevantKnowledge, type ContextMeta, shouldTriggerEventDrivenSummary } from "./modules/orchestrator";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { getSessionContext, upsertSessionContext, type SessionMessage } from "../../modules/memory/sessionContextRepo";
import { digestParams, sha256Hex } from "../../lib/digest";
import { generateUiFromNaturalLanguage, prefetchNl2UiContext } from "../nl2ui-generator/modules/generator";
import { parseToolCallsFromOutput } from "../../lib/llm";
import { invokeModelChatUpstreamStream } from "../model-gateway/modules/invokeChatUpstreamStream";
import { ToolCallFilter } from "./dispatch.helpers";
import { type SseHandle, wrapSseWithEventBus } from "./dispatch.streamHelpers";
import type { DispatchRequest } from "./dispatch.schema";
import { executeInlineTools, formatInlineResultsForLLM, loadInlineWritableEntities } from "./modules/inlineToolExecutor";
import { resolveExecutionClassFromSuggestions } from "./dispatch.executionPolicy";

/* ------------------------------------------------------------------ */
/*  流式 answer 模式入口                                                */
/* ------------------------------------------------------------------ */

export async function handleStreamAnswerMode(params: {
  app: any;
  req: any;
  sse: SseHandle;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  body: DispatchRequest;
  locale: string;
  message: string;
  conversationId: string;
  piSummary: any;
  classification?: import("./modules/intentClassifier").IntentClassification;
}): Promise<void> {
  const { app, req, sse: rawSse, subject, body, locale, message, conversationId, piSummary } = params;
  const authorization = (req.headers.authorization as string | undefined) ?? null;
  const traceId = req.ctx.traceId;

  // P1-05: answer 模式通过 sessionEventBus 多路复用推送，taskId=null 标记为非任务对话
  const sessionId = body.sessionQueueContext?.sessionId || conversationId;
  const sse = wrapSseWithEventBus(rawSse, subject.tenantId, sessionId, null);

  sse.sendEvent("safety", { promptInjection: piSummary });
  sse.sendEvent("status", { phase: "thinking" });

  // 1. 分层加载上下文
  const spaceId = subject.spaceId!;
  const auditCtx = traceId ? { traceId, requestId: req.ctx.requestId } : undefined;
  const redactedMsg = redactValue(message);
  const userContent = String(redactedMsg.value ?? "");
  const historyLimit = Math.max(4, Math.min(64, resolveNumber("ORCHESTRATOR_CONVERSATION_WINDOW").value));

  // --- Tier-1: 加载LLM必需的核心上下文（会话历史 + 记忆召回 + 工具发现）---
  // P1-3: 从用户消息中提取多维度查询，激活 additionalQueries 并行检索
  const additionalQueries = extractAdditionalQueries(message);
  const [prevSession, memoryRecall, toolDiscovery] = await Promise.all([
    getSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, sessionId: conversationId }),
    recallRelevantMemory({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, message, auditContext: auditCtx, additionalQueries }),
    discoverEnabledTools({ pool: app.db, tenantId: subject.tenantId, spaceId, locale }),
  ]);

  app.log.info({
    traceId, conversationId,
    hasMemory: !!memoryRecall?.text,
    memoryLen: memoryRecall?.text?.length ?? 0,
    toolCount: toolDiscovery?.tools?.length ?? 0,
  }, "[dispatch.streamAnswer] Tier-1核心上下文加载完成（会话+记忆+工具）");

  // --- Tier-2: 异步启动增强上下文（知识库+任务历史，非必需）---
  const enrichPromise = Promise.all([
    recallRecentTasks({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, auditContext: auditCtx }),
    recallRelevantKnowledge({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, message, auditContext: auditCtx }),
  ]).catch((err) => {
    app.log.warn({ err }, "[dispatch.streamAnswer] enrichment context load failed, proceeding without");
    return [null, null] as const;
  });

  // --- 短等待：给知识库和任务100ms机会到达 ---
  const ENRICH_WAIT_MS = parseInt(process.env.CONTEXT_ENRICH_WAIT_MS ?? "100", 10);
  const enrichTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ENRICH_WAIT_MS));
  const earlyEnrich = await Promise.race([enrichPromise, enrichTimeout]);

  let taskRecall: Awaited<ReturnType<typeof recallRecentTasks>> | null = null;
  let knowledgeRecall: Awaited<ReturnType<typeof recallRelevantKnowledge>> | null = null;
  let knowledgeContext: string = "";

  if (earlyEnrich !== null && Array.isArray(earlyEnrich)) {
    [taskRecall, knowledgeRecall] = earlyEnrich;
    knowledgeContext = knowledgeRecall?.text ?? "";
    app.log.info({ traceId, conversationId, enrichWaitMs: ENRICH_WAIT_MS }, "[dispatch.streamAnswer] Tier-2增强上下文在短等待窗口内到达，将注入prompt");
  } else {
    app.log.info({ traceId, conversationId, enrichWaitMs: ENRICH_WAIT_MS }, "[dispatch.streamAnswer] Tier-2增强上下文未在短等待窗口内到达，LLM流完成后补充");
  }

  sse.sendEvent("status", { phase: "context_ready" });

  const prevMsgs = Array.isArray(prevSession?.context?.messages) ? prevSession.context.messages : [];
  const droppedCount = Math.max(0, prevMsgs.length - (historyLimit - 2));
  const clippedPrev = prevMsgs.slice(droppedCount);
  const droppedMsgs = droppedCount > 0 ? prevMsgs.slice(0, droppedCount) : [];

  // 上下文摘要：主动生成策略（修复上下文断裂问题）
  // - 当消息被截断时：用截断消息生成摘要
  // - 当对话超过阈值轮次但未截断时：也主动生成摘要以维护连续性
  const prevSummary = prevSession?.context?.summary ?? "";
  let newSummary = prevSummary;
  let newSessionState = prevSession?.context?.sessionState;
  const prevTotalTurns = prevSession?.context?.totalTurnCount ?? prevMsgs.length;
  const totalTurnCount = prevTotalTurns + 2;
  const PROACTIVE_SUMMARY_TURN_THRESHOLD = Math.max(4, Number(process.env.ORCHESTRATOR_PROACTIVE_SUMMARY_TURNS ?? "6") || 6);

  if (droppedMsgs.length > 0) {
    // 场景 1：消息被截断 → 用截断消息生成摘要
    const summaryResult = await summarizeDroppedMessages({
      app, subject, dropped: droppedMsgs, prevSummary: prevSummary || undefined,
      locale, authorization, traceId,
    });
    newSummary = summaryResult.summary || fallbackTruncateSummary(droppedMsgs);
    newSessionState = summaryResult.sessionState;
  } else if (shouldTriggerEventDrivenSummary(message, totalTurnCount)) {
    // 场景 2：关键事件触发 → 主动生成摘要
    const triggerInfo = shouldTriggerEventDrivenSummary(message, totalTurnCount);
    app.log.info({
      traceId, conversationId,
      triggerReason: triggerInfo.reason,
      totalTurnCount,
    }, "[context-event-driven] 事件驱动摘要触发");
    
    const earlyMsgs = clippedPrev.slice(0, Math.min(Math.floor(clippedPrev.length / 2), 8));
    if (earlyMsgs.length >= 2) {
      const summaryResult = await summarizeDroppedMessages({
        app, subject, dropped: earlyMsgs, prevSummary: prevSummary || undefined,
        locale, authorization, traceId,
      });
      newSummary = summaryResult.summary;
      newSessionState = summaryResult.sessionState;
    }
  } else if (!prevSummary && totalTurnCount >= PROACTIVE_SUMMARY_TURN_THRESHOLD && clippedPrev.length >= 4) {
    // 场景 3：未截断但对话轮次达到阈值且无摘要 → 从当前窗口前半部分提取摘要
    const earlyMsgs = clippedPrev.slice(0, Math.min(Math.floor(clippedPrev.length / 2), 6));
    if (earlyMsgs.length >= 2) {
      newSummary = fallbackTruncateSummary(earlyMsgs);
      app.log.info({
        traceId, conversationId,
        totalTurnCount, earlyMsgCount: earlyMsgs.length,
        summaryLen: newSummary.length,
      }, "[context-proactive-summary] 主动生成上下文摘要以维护对话连续性");
    }
  }

  app.log.info({
    traceId, conversationId,
    totalMessages: prevMsgs.length, droppedCount, windowSize: clippedPrev.length,
    historyLimit, totalTurnCount, hasSummary: !!newSummary, summaryLen: newSummary.length,
  }, "[context-debug] 对话上下文组装详情（Tier-2增强上下文异步加载中）");

  // 2. 构建系统提示词（记忆和工具已在Tier-1保证加载，始终使用完整prompt）
  const contextMeta: ContextMeta = {
    totalTurnCount,
    windowMessageCount: clippedPrev.length,
    summary: newSummary || undefined,
  };
  const systemPrompt = buildSystemPrompt(
    locale,
    memoryRecall?.text ?? "",
    taskRecall?.text ?? "",
    toolDiscovery?.catalog ?? "",
    contextMeta,
    knowledgeContext || undefined,
  );
  app.log.info({
    traceId, conversationId,
    promptType: "full_enriched",
    hasToolDiscovery: !!(toolDiscovery?.tools?.length),
    hasMemory: !!memoryRecall?.text,
    hasKnowledge: !!knowledgeContext,
    hasTaskRecall: !!taskRecall?.text,
  }, "[dispatch.streamAnswer] 系统提示词构建完成（Tier-1记忆+工具已注入）");
  const modelMessages: { role: string; content: string | Array<{type: string; [k: string]: any}> }[] = [
    { role: "system", content: systemPrompt },
    ...clippedPrev
      .filter((m: any) => m && typeof m === "object")
      .map((m: any) => ({ role: String(m.role ?? "user"), content: String(m.content ?? "") }))
      .filter((m: any) => m.content),
  ];

  // 多模态附件处理
  const imageAttachments = (body.attachments ?? []).filter(a => a.type === "image" && a.dataUrl);
  const voiceAttachments = (body.attachments ?? []).filter(a => a.type === "voice" && a.dataUrl);
  const videoAttachments = (body.attachments ?? []).filter(a => a.type === "video" && a.dataUrl);
  const docAttachments = (body.attachments ?? []).filter(a => a.type === "document");

  let augmentedUserContent = userContent;
  if (docAttachments.length > 0) {
    const docParts: string[] = [];
    for (const doc of docAttachments) {
      if (doc.textContent) {
        docParts.push(`─── 文件: ${doc.name ?? "未命名"} ───\n${doc.textContent.slice(0, 100_000)}`);
      } else if (doc.dataUrl) {
        // 服务端文档解析：将 base64 dataUrl 转为 Buffer 并调用统一解析引擎
        try {
          const { buffer, mimeType: parsedMime } = dataUrlToBuffer(doc.dataUrl);
          const effectiveMime = doc.mimeType || parsedMime;
          const parseResult = await parseDocument({
            buffer,
            mimeType: effectiveMime,
            fileName: doc.name,
          });
          const extractedText = parseResult.text.slice(0, 100_000);
          const meta = parseResult.documentMetadata;
          const metaLine = [meta.title && `标题: ${meta.title}`, meta.pageCount && `页数: ${meta.pageCount}`, meta.wordCount && `字数: ${meta.wordCount}`].filter(Boolean).join(" | ");
          docParts.push(`─── 文件: ${doc.name ?? "未命名"} (解析方式: ${parseResult.stats.parseMethod}) ───${metaLine ? "\n" + metaLine : ""}\n${extractedText}`);
        } catch (parseErr: any) {
          _logger.warn("document parse failed", { fileName: doc.name, mimeType: doc.mimeType, error: parseErr?.message ?? parseErr });
          docParts.push(`[用户上传了文件: ${doc.name ?? "未命名"} (${doc.mimeType})，解析失败: ${String(parseErr?.message ?? "").slice(0, 200)}]`);
        }
      } else {
        docParts.push(`[用户上传了文件: ${doc.name ?? "未命名"} (${doc.mimeType})，未提供内容数据]`);
      }
    }
    augmentedUserContent = (augmentedUserContent ? augmentedUserContent + "\n\n" : "") + docParts.join("\n\n");
  }

  if (imageAttachments.length > 0 || voiceAttachments.length > 0 || videoAttachments.length > 0) {
    const contentParts: Array<{type: string; [k: string]: any}> = [];
    for (const att of imageAttachments) {
      contentParts.push({ type: "image_url", image_url: { url: att.dataUrl!, detail: "auto" } });
    }
    for (const att of voiceAttachments) {
      const format = normalizeAudioAttachmentFormat(att.mimeType, att.name);
      contentParts.push({ type: "input_audio", input_audio: { data: extractBase64Payload(att.dataUrl!), format } });
    }
    for (const att of videoAttachments) {
      contentParts.push({ type: "video_url", video_url: { url: att.dataUrl! } });
    }
    if (augmentedUserContent) {
      contentParts.push({ type: "text", text: augmentedUserContent });
    }
    modelMessages.push({ role: "user", content: contentParts });
  } else {
    modelMessages.push({ role: "user", content: augmentedUserContent });
  }

  // 3. 真流式调用 (使用 tool_call 过滤器)
  let fullText = "";
  let streamError = false;
  let actualModelRef: string | null = null;
  const filter = new ToolCallFilter((text) => sse.sendEvent("delta", { text }));

  sse.sendEvent("status", { phase: "model_calling" });

  try {
    const streamResult = await invokeModelChatUpstreamStream({
      app,
      subject: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, subjectId: subject.subjectId },
      body: {
        purpose: "orchestrator.dispatch.stream",
        messages: modelMessages,
        stream: true,
        ...(body.defaultModelRef ? { constraints: { candidates: [body.defaultModelRef] } } : {}),
      },
      locale,
      traceId: traceId ?? undefined,
      onDelta: (text: string) => {
        fullText += text;
        filter.feed(text);
      },
    });
    filter.flush();
    actualModelRef = streamResult?.routingDecision?.modelRef ?? null;
  } catch (streamErr: any) {
    streamError = true;
    app.log.warn({ err: streamErr, traceId }, "[dispatch.stream] real streaming failed, falling back");
    // P2-2 FIX: 流式降级时通知用户，而非静默切换
    sse.sendEvent("status", { phase: "fallback", reason: "stream_error", message: locale !== "en-US" ? "正在切换到备用通道…" : "Switching to fallback channel…" });
    const out = await orchestrateChatTurn({
      app, pool: app.db, subject, message, locale, conversationId, authorization, traceId,
      persistSession: true, defaultModelRef: body.defaultModelRef,
    });
    const replyText = typeof out.replyText === "string" ? out.replyText
      : (out.replyText as Record<string, string>)?.[locale]
      ?? (out.replyText as Record<string, string>)?.["zh-CN"] ?? "";
    fullText = replyText;
    sse.sendEvent("delta", { text: replyText });
  }

  // --- Tier-2 结果消费：LLM流式调用完成后，补充获取未在短等待窗口内到达的增强上下文 ---
  if (!taskRecall && !knowledgeRecall) {
    const lateEnrich = await enrichPromise;
    if (lateEnrich && Array.isArray(lateEnrich)) {
      [taskRecall, knowledgeRecall] = lateEnrich;
      knowledgeContext = knowledgeRecall?.text ?? "";
    }
    app.log.info({
      traceId, conversationId,
      enrichSource: "late",
      taskRecallLen: taskRecall?.text?.length ?? 0,
      knowledgeContextLen: knowledgeContext.length,
    }, "[context-debug] Tier-2增强上下文延迟加载完成（短等待未命中，LLM流完成后补充）");
  } else {
    app.log.info({
      traceId, conversationId,
      enrichSource: "early",
      taskRecallLen: taskRecall?.text?.length ?? 0,
      knowledgeContextLen: knowledgeContext.length,
    }, "[context-debug] Tier-2增强上下文已在短等待窗口内注入prompt（无需延迟加载）");
  }

  // 4. 持久化会话上下文
  if (!streamError) {
    try {
      const nowIso = new Date().toISOString();
      function coerceRole(v: any): "user" | "assistant" | "system" {
        const r = String(v ?? "");
        if (r === "assistant" || r === "system" || r === "user") return r;
        return "user";
      }
      const assistantRedacted = redactValue(fullText);
      const assistantContent = String(assistantRedacted.value ?? "");
      const nextMsgs: SessionMessage[] = [
        ...clippedPrev.map((m: any) => ({ role: coerceRole(m.role), content: String(m.content ?? ""), at: typeof m.at === "string" ? m.at : undefined })).filter((m: any) => m.content),
        { role: "user", content: userContent, at: nowIso },
        { role: "assistant", content: assistantContent, at: nowIso },
      ];
      const trimmed = nextMsgs.slice(Math.max(0, nextMsgs.length - historyLimit));
      const persistDroppedCount = Math.max(0, nextMsgs.length - historyLimit);
      const persistSummary = newSummary;
      const persistSessionState = newSessionState;
      const ttlDays = Math.max(1, Math.min(30, resolveNumber("ORCHESTRATOR_CONVERSATION_TTL_DAYS").value));
      const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();
      await upsertSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, sessionId: conversationId, context: { v: 2, messages: trimmed, summary: persistSummary || undefined, sessionState: persistSessionState, totalTurnCount }, expiresAt });
      // 带超时保护的 LLM 摘要
      // 注意: summarizeDroppedMessages 内部使用 app.inject() 本地路由，不支持 AbortController，
      // 因此使用 Promise.race 超时。超时后 LLM 调用会在后台完成但结果不会被使用。
      if (persistDroppedCount > 0) {
        const SUMMARY_TIMEOUT_MS = Math.max(3000, Number(process.env.ORCHESTRATOR_SUMMARY_TIMEOUT_MS) || 8000);
        try {
          const asyncSummary = await Promise.race([
            summarizeDroppedMessages({
              app, subject: { tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId },
              dropped: nextMsgs.slice(0, persistDroppedCount), prevSummary: newSummary || undefined,
              locale, authorization, traceId,
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS)),
          ]);
          if (asyncSummary) {
            await upsertSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, sessionId: conversationId, context: { v: 2, messages: trimmed, summary: asyncSummary.summary || undefined, sessionState: asyncSummary.sessionState, totalTurnCount }, expiresAt });
            app.log.info({ traceId, summaryLen: asyncSummary.summary.length }, "[dispatch.stream] LLM 摘要已同步完成并持久化");
          } else {
            app.log.warn({ traceId, timeoutMs: SUMMARY_TIMEOUT_MS }, "[dispatch.stream] LLM 摘要超时，保留截断摘要");
          }
        } catch (e: any) {
          app.log.warn({ err: e, traceId }, "[dispatch.stream] LLM 摘要失败（已保留截断摘要，不影响用户响应）");
        }
      }
    } catch (e: any) {
      app.log.warn({ err: e, traceId }, "[dispatch.stream] session persist failed");
    }
  }

  // 5. 解析工具建议：基于工具元数据动态分类
  const parsed = parseToolCallsFromOutput(fullText);
  
  // P2-3 FIX: 工具调用代码块遗漏修复 - 响应生成阶段强制校验
  // 可通过环境变量关闭（ORCHESTRATOR_TOOL_RETRY=off）或设置超时（ORCHESTRATOR_TOOL_RETRY_TIMEOUT_MS，默认 10s）
  let validatedToolCalls = parsed.toolCalls;
  const toolRetryEnabled = (process.env.ORCHESTRATOR_TOOL_RETRY ?? "on") !== "off";
  const toolRetryTimeoutMs = Math.max(3000, Number(process.env.ORCHESTRATOR_TOOL_RETRY_TIMEOUT_MS) || 10000);

  if (toolRetryEnabled && parsed.toolCalls.length === 0 && (toolDiscovery?.tools?.length ?? 0) > 0) {
    const toolNames = toolDiscovery!.tools.map(t => t.name);
    const mentionedTool = toolNames.find(name => fullText.includes(name));
    
    // 场景 1：回复中提到了工具名称但未生成 tool_call → 强制重试（带超时 + AbortController）
    if (mentionedTool) {
      app.log.warn({ 
        traceId, 
        mentionedTool, 
        replyTextLength: fullText.length 
      }, "[P2-3] 检测到工具提及但缺少 tool_call 代码块，触发强制重试");
      
      const retryAbort = new AbortController();
      const retryTimer = setTimeout(() => retryAbort.abort(), toolRetryTimeoutMs);
      try {
        const retryOut = await invokeModelChatUpstreamStream({
          app,
          subject: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, subjectId: subject.subjectId },
          locale,
          body: {
            purpose: "orchestrator.dispatch.stream.retry",
            messages: [
              ...modelMessages,
              { role: "assistant", content: fullText },
              { 
                role: "user", 
                content: `检测到您提到了工具 ${mentionedTool}，请补充完整的 \`\`\`tool_call\`\`\` 代码块。格式示例：\n\`\`\`tool_call\n[{"toolRef":"${mentionedTool}@v1","inputDraft":{...}}]\n\`\`\``
              },
            ],
            stream: false,
          },
          onDelta: () => {},
          signal: retryAbort.signal,
        });
        clearTimeout(retryTimer);
        if (retryOut) {
          const retryText = typeof retryOut?.outputText === "string" ? retryOut.outputText : "";
          const retryParsed = parseToolCallsFromOutput(retryText);
          if (retryParsed.toolCalls.length > 0) {
            validatedToolCalls = retryParsed.toolCalls;
            app.log.info({ traceId, retryToolCount: retryParsed.toolCalls.length }, "[P2-3] 重试成功，已补全 tool_call");
          }
        }
      } catch (retryErr: any) {
        clearTimeout(retryTimer);
        if (retryAbort.signal.aborted) {
          app.log.warn({ traceId, timeoutMs: toolRetryTimeoutMs }, "[P2-3] 重试超时，LLM 请求已取消");
        } else {
          app.log.error({ err: retryErr, traceId }, "[P2-3] 重试失败");
        }
      }
    }
    
    // 场景 2：上游分类器检测到工具意图但 LLM 回复未包含 tool_call → 二次 LLM 校验（带超时）
    else if (params.classification?.hasToolIntent && parsed.toolCalls.length === 0) {
      app.log.warn({ 
        traceId, 
        replyTextPreview: fullText.slice(0, 100) 
      }, "[P2-3] 上游分类器检测到工具意图但缺少 tool_call 代码块，触发二次校验");
      
      const validationAbort = new AbortController();
      const validationTimer = setTimeout(() => validationAbort.abort(), toolRetryTimeoutMs);
      try {
        const validationOut = await invokeModelChatUpstreamStream({
          app,
          subject: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, subjectId: subject.subjectId },
          locale,
          body: {
            purpose: "orchestrator.dispatch.stream.validation",
            messages: [
              ...modelMessages,
              { role: "assistant", content: fullText },
              { 
                role: "user", 
                content: `请分析您的回复是否需要调用工具来完成任务？如果需要，请生成 \`\`\`tool_call\`\`\` 代码块。可用工具：${toolDiscovery?.catalog ?? ""}`
              },
            ],
            stream: false,
          },
          onDelta: () => {},
          signal: validationAbort.signal,
        });
        clearTimeout(validationTimer);
        if (validationOut) {
          const validationText = typeof validationOut?.outputText === "string" ? validationOut.outputText : "";
          const validationParsed = parseToolCallsFromOutput(validationText);
          if (validationParsed.toolCalls.length > 0) {
            validatedToolCalls = validationParsed.toolCalls;
            app.log.info({ traceId, validationToolCount: validationParsed.toolCalls.length }, "[P2-3] 二次校验成功，已添加工具调用");
          }
        }
      } catch (validationErr: any) {
        clearTimeout(validationTimer);
        if (validationAbort.signal.aborted) {
          app.log.warn({ traceId, timeoutMs: toolRetryTimeoutMs }, "[P2-3] 二次校验超时，LLM 请求已取消");
        } else {
          app.log.error({ err: validationErr, traceId }, "[P2-3] 二次校验失败");
        }
      }
    }
  }
  
  const enabledTools = toolDiscovery?.tools ?? [];
  const enabledToolMap = new Map(enabledTools.map((tool) => [tool.toolRef, tool]));

  // ━━━ 输入补全：为缺少 entityName 的 entity 工具调用自动推断 ━━━
  for (const tc of validatedToolCalls) {
    const tool = enabledToolMap.get(tc.toolRef);
    if (!tool) continue;

    // 仅对 entity 资源类型的工具做补全
    if (tool.def.resourceType !== "entity") continue;

    // 字段归一化：payload/data → patch（entity.update schema 期望 patch）
    if (tool.def.action === "update") {
      if (!tc.inputDraft.patch && (tc.inputDraft.payload || tc.inputDraft.data)) {
        tc.inputDraft.patch = tc.inputDraft.payload ?? tc.inputDraft.data;
        delete tc.inputDraft.payload;
        delete tc.inputDraft.data;
      }
    }

    // entityName 推断：如果缺失但有 id，从 DB 查找
    if (!tc.inputDraft.entityName && tc.inputDraft.id) {
      try {
        const { lookupEntityNameByRecordId } = await import("../../modules/data/dataRepo");
        const inferred = await lookupEntityNameByRecordId({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          id: String(tc.inputDraft.id),
        });
        if (inferred) {
          tc.inputDraft.entityName = inferred;
          app.log.info(
            { traceId, toolRef: tc.toolRef, id: tc.inputDraft.id, entityName: inferred },
            "[dispatch.stream] 自动补全 entityName 成功",
          );
        }
      } catch (e: any) {
        app.log.warn(
          { traceId, toolRef: tc.toolRef, id: tc.inputDraft.id, error: e?.message },
          "[dispatch.stream] 自动补全 entityName 失败",
        );
      }
    }
  }

  const inlineWritableEntities = await loadInlineWritableEntities(app.db);
  const resolution = resolveExecutionClassFromSuggestions({
    toolCalls: validatedToolCalls,
    enabledTools,
    inlineWritableEntities,
  });
  const workflowSuggestions = resolution.workflowTools.map((suggestion) => {
    const tool = enabledToolMap.get(suggestion.toolRef);
    const toolDef = tool?.def;
    return {
      toolRef: suggestion.toolRef,
      inputDraft: suggestion.inputDraft,
      riskLevel: toolDef?.riskLevel ?? "low",
      approvalRequired: toolDef ? shouldRequireApproval(toolDef) : false,
      approvalReason: toolDef?.riskLevel === "high"
        ? `工具 ${suggestion.toolRef} 风险等级为 high，需要审批`
        : (toolDef?.approvalRequired ? `工具 ${suggestion.toolRef} 已配置强制审批` : ""),
      suggestionId: crypto.randomUUID(),
      // scope=write 的工具需要 idempotencyKey，供前端手动执行时使用
      idempotencyKey: toolDef?.scope === "write" ? crypto.randomUUID() : undefined,
    };
  });

  // ━━━ 内联执行只读/安全写入工具并流式回复 ━━━
  if (resolution.inlineTools.length > 0) {
    app.log.info(
      { traceId, inlineTools: resolution.inlineTools.map(t => t.toolRef) },
      "[dispatch.stream] 检测到可内联工具调用，执行内联查询并二次回复",
    );
    sse.sendEvent("status", { phase: "inline_tool_exec" });

    const inlineResults = await executeInlineTools(resolution.inlineTools, {
      pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId,
      subjectId: subject.subjectId, enabledTools, app, traceId,
    });

    // 将工具结果注入 LLM 做二次回复
    const toolResultText = formatInlineResultsForLLM(inlineResults, locale);
    if (toolResultText) {
      sse.sendEvent("status", { phase: "thinking" });
      const followUpFilter = new ToolCallFilter((text) => sse.sendEvent("delta", { text }));
      try {
        await invokeModelChatUpstreamStream({
          app,
          subject: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, subjectId: subject.subjectId },
          body: {
            purpose: "orchestrator.dispatch.stream.inline_followup",
            messages: [
              ...modelMessages,
              { role: "assistant", content: fullText },
              { role: "user", content: toolResultText + (locale !== "en-US"
                ? "\n\n请基于上面的工具返回数据，直接向用户展示结果。用自然语言组织数据，不要提及工具调用过程。如果数据为空，不要报告搜索结果为0或候选条目数量，只需自然地告知用户暂无相关信息并继续对话。"
                : "\n\nBased on the tool results above, present the data to the user directly. Organize it in natural language. If empty, do NOT mention search result counts or candidate numbers — simply tell the user naturally that no relevant information was found and continue the conversation.") },
            ],
            stream: true,
            ...(body.defaultModelRef ? { constraints: { candidates: [body.defaultModelRef] } } : {}),
          },
          locale,
          traceId: traceId ?? undefined,
          onDelta: (text: string) => { followUpFilter.feed(text); },
        });
        followUpFilter.flush();
      } catch (followUpErr: any) {
        // ── 降级：基于 error 对象属性动态构造具体错误描述 ──
        const errName = String(followUpErr?.name ?? "");
        const errCode = String(followUpErr?.code ?? followUpErr?.statusCode ?? "");
        const errMessage = String(followUpErr?.message ?? "");
        app.log.warn({ err: followUpErr, traceId, errName, errCode, errMessage }, "[dispatch.stream] 内联工具二次回复失败");

        // 1. 生成工具结果摘要（工具已执行成功，应向用户展示结果要点）
        const zh = locale !== "en-US";
        const resultSummaryParts: string[] = [];
        for (const r of inlineResults) {
          const toolName = r.toolRef.replace(/@.*$/, "");
          if (r.ok) {
            // 提取摘要：优先取 output 中的关键字段，否则截断前 200 字符
            const raw = typeof r.output === "string" ? r.output
              : (r.output && typeof r.output === "object" ? JSON.stringify(r.output) : "");
            const brief = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
            resultSummaryParts.push(`[${toolName}] ${zh ? "执行成功" : "OK"}${brief ? ": " + brief : ""}`);
          } else {
            resultSummaryParts.push(`[${toolName}] ${zh ? "执行失败" : "Failed"}: ${r.error ?? ""}`);
          }
        }

        // 2. 根据 error 属性动态判断错误类别
        const isTimeout = errCode === "ETIMEDOUT" || errCode === "ESOCKETTIMEDOUT"
          || errName === "AbortError" || errCode === "UND_ERR_CONNECT_TIMEOUT";
        const isStreamDisconnect = errCode === "ECONNRESET" || errCode === "ERR_STREAM_PREMATURE_CLOSE"
          || errName === "ERR_STREAM_DESTROYED";

        let reason: string;
        if (isTimeout) {
          reason = zh ? "模型调用超时" : "model call timed out";
        } else if (isStreamDisconnect) {
          reason = zh ? "响应流中断" : "response stream interrupted";
        } else {
          // 兜底：用 error 自身属性描述，不硬编码关键词
          const detail = errCode ? `${errName || "Error"}/${errCode}` : (errName || errMessage.slice(0, 80) || "unknown");
          reason = zh ? `模型调用异常（${detail}）` : `model call error (${detail})`;
        }

        const header = zh
          ? `工具已执行成功，但结果总结生成失败（${reason}）。以下是工具原始结果摘要：`
          : `Tool executed successfully but summary generation failed (${reason}). Raw result summary:`;

        const fallbackText = resultSummaryParts.length > 0
          ? header + "\n" + resultSummaryParts.join("\n")
          : (zh ? `工具已执行但结果格式化失败（${reason}），请重试。` : `Tool executed but formatting failed (${reason}). Please retry.`);

        sse.sendEvent("delta", { text: "\n\n" + fallbackText });
      }
    }
  }

  if (workflowSuggestions.length > 0) {
    sse.sendEvent("toolSuggestions", {
      suggestions: workflowSuggestions,
    });
  }

  if (resolution.separatePipelineTool) {
    sse.sendEvent("nl2uiStatus", { phase: "started" });
    const keepaliveTimer = setInterval(() => {
      try { sse.sendEvent("keepalive", { ts: Date.now() }); } catch {}
    }, 8_000);
    try {
      const nl2uiPrefetched = await prefetchNl2UiContext(app.db, { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId }, message);
      const nl2uiUserInput = typeof resolution.separatePipelineTool.inputDraft?.userInput === "string" ? resolution.separatePipelineTool.inputDraft.userInput : message;
      const cfg = await generateUiFromNaturalLanguage(
        app.db,
        { userInput: nl2uiUserInput, context: { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId, spaceId: subject.spaceId || undefined } },
        { app, authorization: authorization ?? "", traceId, defaultModelRef: body.defaultModelRef },
        nl2uiPrefetched,
      );
      if (cfg) {
        sse.sendEvent("nl2uiResult", { config: cfg });
      } else {
        app.log.warn({ traceId }, "[NL2UI] generateUiFromNaturalLanguage 返回 null");
        sse.sendEvent("nl2uiError", {
          errorCode: "NL2UI_NO_RESULT",
          message: { "zh-CN": "界面生成未返回结果，请尝试更明确地描述您需要的界面", "en-US": "UI generation returned no result. Please describe the desired UI more specifically." },
          traceId,
        });
      }
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (errObj && typeof errObj === "object" && errObj.statusCode === 429) {
        sse.sendEvent("nl2uiError", (errObj.payload as Record<string, unknown>) ?? { errorCode: "RATE_LIMITED", message: { "zh-CN": "请求过于频繁，请稍后重试", "en-US": "Too many requests" }, traceId });
      } else {
        // 提取具体错误码和详细信息，避免吞掉诊断线索
        const payload = errObj && typeof errObj === "object" ? (errObj.payload as Record<string, unknown> | null) : null;
        const errMessage = err instanceof Error ? err.message : String(err ?? "");
        const errErrorCode = errObj && typeof errObj === "object" ? String(errObj.errorCode ?? "") : "";
        const specificErrorCode = payload?.errorCode ?? (errErrorCode ? String(errErrorCode) : "NL2UI_ERROR");
        const specificMsgZh = (payload?.message as Record<string, string> | undefined)?.["zh-CN"] ?? payload?.message ?? errMessage ?? "界面生成异常";
        const specificMsgEn = (payload?.message as Record<string, string> | undefined)?.["en-US"] ?? "UI generation error";
        app.log.error({
          traceId,
          errorCode: specificErrorCode,
          statusCode: errObj && typeof errObj === "object" ? (errObj.statusCode as number | null) ?? null : null,
          errMessage: errMessage ?? null,
          payloadMessage: typeof specificMsgZh === "string" ? specificMsgZh : JSON.stringify(specificMsgZh),
          stack: err instanceof Error ? err.stack?.split?.("\n")?.slice(0, 3)?.join(" | ") ?? null : null,
        }, "[NL2UI] 界面生成异常 — 详细诊断");
        sse.sendEvent("nl2uiError", {
          errorCode: specificErrorCode,
          message: { "zh-CN": typeof specificMsgZh === "string" ? specificMsgZh : "界面生成异常，请稍后重试", "en-US": typeof specificMsgEn === "string" ? specificMsgEn : "UI generation error" },
          traceId,
        });
      }
    } finally {
      clearInterval(keepaliveTimer);
      sse.sendEvent("nl2uiStatus", { phase: "done" });
    }
  }

  // 完成事件
  const turn = await createOrchestratorTurn({
    pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId,
    message: "", toolSuggestions: null,
    messageDigest: { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) },
    toolSuggestionsDigest: workflowSuggestions.length > 0 ? workflowSuggestions.map((suggestion) => ({
      suggestionId: suggestion.suggestionId,
      toolRef: suggestion.toolRef,
      riskLevel: suggestion.riskLevel,
      approvalRequired: suggestion.approvalRequired,
      inputDigest: digestParams(suggestion.inputDraft ?? {}),
    })) : null,
  });

  sse.sendEvent("done", { turnId: turn.turnId, conversationId, executionClass: resolution.executionClass, ...(actualModelRef ? { actualModelRef } : {}) });
}

function extractBase64Payload(dataUrl: string) {
  const match = /^data:[^;]+;base64,(.+)$/i.exec(String(dataUrl ?? "").trim());
  return match?.[1] ?? String(dataUrl ?? "");
}

function normalizeAudioAttachmentFormat(mimeType?: string, name?: string) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("flac")) return "flac";
  const ext = String(name ?? "").split(".").pop()?.toLowerCase();
  if (ext === "wav" || ext === "mp3" || ext === "ogg" || ext === "webm" || ext === "flac") return ext;
  return "wav";
}

/**
 * P1-3: 从用户消息中提取多维度查询片段，用于激活 additionalQueries 并行记忆检索。
 *
 * 策略：
 * 1. 按中文/英文问号分割，如果有多个问句则每个问句作为独立查询维度
 * 2. 单个问句场景下，按逗号/顿号分割提取短语作为补充查询
 * 3. 返回去重后的额外查询列表（不含主查询本身）
 */
function extractAdditionalQueries(message: string): string[] {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length < 4) return [];

  const queries: string[] = [];

  // 策略 1：按问号分割（支持中英文问号）
  const questionParts = trimmed.split(/[\?\uff1f]/).map(s => s.trim()).filter(s => s.length >= 2);
  if (questionParts.length > 1) {
    // 多问句场景：每个问句作为独立查询维度
    for (const part of questionParts.slice(0, 5)) {
      if (part.length >= 2 && part.length <= 300) {
        queries.push(part);
      }
    }
  } else {
    // 单问句/陈述句场景：按分隔符切分短语
    const segments = trimmed.split(/[,\uff0c\u3001;\uff1b]/).map(s => s.trim()).filter(s => s.length >= 2);
    if (segments.length > 1) {
      for (const seg of segments.slice(0, 5)) {
        if (seg.length >= 2 && seg.length <= 300) {
          queries.push(seg);
        }
      }
    }
  }

  // 去重（不含主消息本身的精确匹配）
  const seen = new Set<string>([trimmed.slice(0, 500)]);
  const result: string[] = [];
  for (const q of queries) {
    if (!seen.has(q)) {
      seen.add(q);
      result.push(q);
    }
  }

  return result;
}
