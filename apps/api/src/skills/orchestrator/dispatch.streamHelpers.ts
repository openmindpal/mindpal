/**
 * Dispatch Stream Helpers
 *
 * 共享的 SSE Agent Loop 回调工厂 + 总结流式生成
 * 消灭 dispatch.stream.ts / dispatch.streamAnswer.ts 之间的重复代码
 */
import { invokeModelChatUpstreamStream } from "../model-gateway/modules/invokeChatUpstreamStream";
import { getArtifactContent } from "../artifact-manager/modules/artifactRepo";
import type { AgentLoopResult } from "../../kernel/agentLoop";
import { emitTaskEvent } from "../../lib/sessionEventBus";

/* ------------------------------------------------------------------ */
/*  类型定义                                                            */
/* ------------------------------------------------------------------ */

export interface SseHandle {
  sendEvent(event: string, data: any): void;
}

/**
 * 多路复用 SSE 句柄：支持通过 sessionEventBus 推送事件。
 * 当 sessionId 存在时，事件同时通过持久 SSE 连接推送（携带 taskId）。
 */
export interface MultiplexedSseHandle extends SseHandle {
  /** 会话 ID（用于 sessionEventBus 多路复用） */
  sessionId?: string;
  /** 租户 ID（用于 sessionEventBus 复合键路由） */
  tenantId?: string;
  /** 任务 ID（用于事件路由标记） */
  taskId?: string | null;
}

/** 创建一个多路复用包装器，同时写入直连 SSE 和 sessionEventBus */
export function wrapSseWithEventBus(
  sse: SseHandle,
  tenantId?: string,
  sessionId?: string,
  taskId?: string | null,
): MultiplexedSseHandle {
  return {
    tenantId,
    sessionId,
    taskId,
    sendEvent(event: string, data: any) {
      // 1. 写入直连 SSE（兼容模式）
      sse.sendEvent(event, data);
      // 2. 同时写入 sessionEventBus（多路复用模式）
      if (sessionId && tenantId) {
        emitTaskEvent(sessionId, tenantId, taskId ?? "", event, data);
      }
    },
  };
}

export interface StepNarrationParams {
  app: any;
  sse: SseHandle;
  subject: { tenantId: string; spaceId?: string; subjectId: string };
  locale: string;
  message: string;
  runId: string;
  defaultModelRef?: string;
  traceId?: string;
  requestId?: string;
  /** 多任务支持：关联的 taskId（用于事件路由） */
  taskId?: string | null;
  /** 多任务支持：会话 ID（用于 sessionEventBus） */
  sessionId?: string;
}

async function resolveApprovalIdForStep(params: {
  app: any;
  tenantId: string;
  runId: string;
  stepId?: string | null;
}): Promise<string | null> {
  const { app, tenantId, runId, stepId } = params;
  if (!stepId) return null;
  try {
    const res = await app.db.query(
      `SELECT approval_id
         FROM approvals
        WHERE tenant_id = $1
          AND run_id = $2
          AND step_id = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, runId, stepId],
    );
    if (!res.rowCount) return null;
    return String(res.rows[0].approval_id ?? "");
  } catch {
    return null;
  }
}

export function normalizeStepPresentationStatus(status: string): string {
  const value = String(status ?? "").trim();
  if (!value) return "failed";
  if (
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled" ||
    value === "deadletter" ||
    value === "needs_approval" ||
    value === "needs_device" ||
    value === "needs_arbiter" ||
    value === "paused"
  ) {
    return value;
  }
  return "failed";
}

export function describeStepPresentationStatus(status: string, zh: boolean): string {
  switch (normalizeStepPresentationStatus(status)) {
    case "succeeded":
      return zh ? "执行成功" : "succeeded";
    case "needs_approval":
      return zh ? "等待审批" : "awaiting approval";
    case "needs_device":
      return zh ? "等待设备结果" : "awaiting device result";
    case "needs_arbiter":
      return zh ? "等待仲裁" : "awaiting arbiter";
    case "paused":
      return zh ? "已暂停" : "paused";
    case "canceled":
      return zh ? "已取消" : "canceled";
    case "deadletter":
      return zh ? "进入死信队列" : "deadletter";
    default:
      return zh ? "执行失败" : "failed";
  }
}

export function deriveLoopPresentationStatus(loopResult: AgentLoopResult): "succeeded" | "paused" | "failed" {
  if (loopResult.endReason === "ask_user") return "paused";
  return loopResult.ok ? "succeeded" : "failed";
}

/* ------------------------------------------------------------------ */
/*  产物类型探测                                                       */
/* ------------------------------------------------------------------ */

function detectArtifactType(digest: Record<string, unknown>): string {
  const ct = String(digest.contentType ?? digest.mimeType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "file";
  if (ct === "application/json" || ct.endsWith("+json")) return "json";
  if (ct === "text/csv" || ct === "text/tab-separated-values") return "table";
  if (ct === "text/markdown" || ct === "text/x-markdown") return "markdown";
  if (ct.startsWith("text/")) return "text";
  const fn = String(digest.fileName ?? "").toLowerCase();
  if (fn.endsWith(".json")) return "json";
  if (fn.endsWith(".csv") || fn.endsWith(".tsv")) return "table";
  if (fn.endsWith(".md")) return "markdown";
  return "file";
}

/* ------------------------------------------------------------------ */
/*  截图工具内联展示                                                     */
/* ------------------------------------------------------------------ */

const SCREENSHOT_TOOLS = [
  "desktop.screen.capture",
  "browser.screenshot",
  "desktop.screenshot",
  "device.desktop.screenshot",
  "device.browser.screenshot",
];

async function inlineScreenshot(
  params: { app: any; sse: SseHandle; tenantId: string; obs: any },
): Promise<void> {
  const { app, sse, tenantId, obs } = params;
  const stepToolName = obs.toolRef.replace(/@\d+$/, "");
  if (!SCREENSHOT_TOOLS.includes(stepToolName)) return;
  if (obs.status !== "succeeded" || !obs.outputDigest?.artifactId) return;
  try {
    const art = await getArtifactContent(app.db, tenantId, String(obs.outputDigest.artifactId));
    if (art?.contentText && art.contentType?.startsWith("image/")) {
      sse.sendEvent("delta", { text: `

![📸 截图](data:${art.contentType};base64,${art.contentText})

` });
    }
  } catch (imgErr: any) {
    app.log.warn({ err: imgErr, artifactId: obs.outputDigest.artifactId }, "[onStepComplete] 截图内联展示失败");
  }
}

/* ------------------------------------------------------------------ */
/*  onStepComplete 回调工厂                                             */
/* ------------------------------------------------------------------ */

export function makeOnStepComplete(params: StepNarrationParams) {
  const { app, sse, subject, locale, message, runId, defaultModelRef, traceId, requestId, taskId, sessionId } = params;
  // 如果提供了 sessionId，使用多路复用包装器
  const muxSse = sessionId ? wrapSseWithEventBus(sse, subject.tenantId, sessionId, taskId) : sse;
  const zh = locale.startsWith("zh");

  return async (obs: any, stepDecision: any): Promise<void> => {
    try {
      // 1. 推送步骤进度事件
      muxSse.sendEvent("stepProgress", {
        runId,
        taskId: taskId ?? null,
        traceId: traceId ?? null,
        requestId: requestId ?? null,
        step: {
          seq: obs.seq,
          stepId: obs.stepId ?? null,
          toolRef: obs.toolRef,
          status: obs.status,
          reasoning: stepDecision.reasoning.slice(0, 300),
          outputDigest: obs.outputDigest ? JSON.stringify(obs.outputDigest).slice(0, 200) : null,
          errorCategory: obs.errorCategory,
        },
      });

      // 1.1 推送 executionReceipt 结构化卡片
      muxSse.sendEvent("executionReceipt", {
        runId,
        stepId: obs.stepId ?? null,
        toolRef: obs.toolRef,
        traceId: traceId ?? null,
        requestId: requestId ?? null,
        status: normalizeStepPresentationStatus(obs.status),
        output: obs.outputDigest ? JSON.stringify(obs.outputDigest).slice(0, 500) : null,
        error: obs.errorCategory ?? null,
        latencyMs: obs.durationMs ?? null,
      });

      // 1.2 检测 needs_approval 状态，发射 approvalNode
      if (obs.status === "needs_approval") {
        const approvalId = await resolveApprovalIdForStep({
          app,
          tenantId: subject.tenantId,
          runId,
          stepId: obs.stepId ?? null,
        });
        muxSse.sendEvent("approvalNode", {
          approvalId: approvalId ?? "",
          runId,
          taskId: taskId ?? null,
          stepId: obs.stepId ?? null,
          toolRef: obs.toolRef,
          traceId: traceId ?? null,
          requestId: requestId ?? null,
          status: "pending",
          requestedAt: new Date().toISOString(),
          decidedAt: null,
        });
      }

      // 1.3 检测产物类型，发射 artifactCard
      if (obs.status === "succeeded" && obs.outputDigest) {
        const digest = obs.outputDigest;
        if (digest.artifactId || digest.fileUrl || digest.url) {
          muxSse.sendEvent("artifactCard", {
            artifactType: detectArtifactType(digest),
            title: digest.title ?? digest.fileName ?? obs.toolRef.replace(/@\d+$/, ""),
            summary: digest.summary ?? null,
            data: digest.data ?? null,
            runId,
            stepId: obs.stepId ?? null,
            traceId: traceId ?? null,
            requestId: requestId ?? null,
            url: digest.fileUrl ?? digest.url ?? null,
          });
        }
      }

      // 2. LLM 智能生成每步对话说明，流式推送到聊天区
      const stepCtx = JSON.stringify({
        step: obs.seq,
        tool: obs.toolRef,
        status: obs.status,
        reasoning: stepDecision.reasoning.slice(0, 300),
        output: obs.outputDigest ? JSON.stringify(obs.outputDigest).slice(0, 300) : null,
        error: obs.errorCategory || null,
      });

      try {
        await invokeModelChatUpstreamStream({
          app,
          subject: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, subjectId: subject.subjectId },
          body: {
            purpose: "orchestrator.dispatch.stream.step_narration",
            messages: [
              { role: "system", content: zh
                ? `你是灵智Mindpal智能体OS的AI助手。用户正在执行多步任务，下面是其中一步的执行结果。请用 1-2 句自然口语向用户汇报这一步做了什么、结果如何。要求：1) 直接说结果，不要前缀"步骤X"；2) 把工具名翻译成用户能懂的操作（如 browser.navigate → "打开了网页"，browser.screenshot → "截了一张图"）；3) 如果成功，提一下关键结果；如果失败，简要说明原因；4) 语气像在旁边实时操作给你看一样自然；5) 控制在 1-2 句话内。`
                : `You are the AI assistant of 灵智Mindpal Agent OS. The user is running a multi-step task. Below is one step's result. Narrate what happened in 1-2 natural sentences. Requirements: 1) Don't prefix with "Step X"; 2) Translate tool names into plain actions (e.g. browser.navigate → "opened a webpage"); 3) Mention key results if succeeded, brief reason if failed; 4) Sound like you're doing it live; 5) Keep to 1-2 sentences.` },
              { role: "user", content: `${zh ? "用户原始请求" : "User request"}：${message.slice(0, 200)}\n\n${zh ? "当前步骤结果" : "Step result"}：${stepCtx}` },
            ],
            stream: true,
            maxTokens: 150,
            ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
          },
          locale,
          traceId: traceId ?? undefined,
          onDelta: (text: string) => {
            muxSse.sendEvent("delta", { text });
          },
        });
        muxSse.sendEvent("delta", { text: "\n\n" });
      } catch {
        // LLM 调用失败时降级为简单文本
        const toolName = obs.toolRef.replace(/@\d+$/, "");
        const normalizedStatus = normalizeStepPresentationStatus(obs.status);
        const emoji =
          normalizedStatus === "succeeded" ? "✅"
            : normalizedStatus === "needs_approval" || normalizedStatus === "needs_device" || normalizedStatus === "needs_arbiter" || normalizedStatus === "paused" ? "⏸️"
            : normalizedStatus === "canceled" ? "🚫"
            : "❌";
        muxSse.sendEvent("delta", { text: `\n\n${emoji} \`${toolName}\` ${describeStepPresentationStatus(normalizedStatus, zh)}\n` });
      }

      // 3. 截图工具内联展示
      await inlineScreenshot({ app, sse: muxSse, tenantId: subject.tenantId, obs });
    } catch {
      // SSE 可能已被客户端断开
    }
  };
}

/* ------------------------------------------------------------------ */
/*  onLoopEnd 回调工厂                                                  */
/* ------------------------------------------------------------------ */

export function makeOnLoopEnd(params: {
  sse: SseHandle;
  runId: string;
  traceId?: string;
  requestId?: string;
  taskId?: string | null;
  sessionId?: string;
  tenantId?: string;
}) {
  const { sse, runId, traceId, requestId, taskId, sessionId, tenantId } = params;
  const muxSse = sessionId ? wrapSseWithEventBus(sse, tenantId, sessionId, taskId) : sse;
  return (loopResult: AgentLoopResult): void => {
    try {
      const presentationStatus = deriveLoopPresentationStatus(loopResult);
      muxSse.sendEvent("agentLoopEnd", {
        runId,
        taskId: taskId ?? null,
        traceId: traceId ?? null,
        requestId: requestId ?? null,
        ok: loopResult.ok,
        status: presentationStatus,
        endReason: loopResult.endReason,
        iterations: loopResult.iterations,
        succeededSteps: loopResult.succeededSteps,
        failedSteps: loopResult.failedSteps,
      });

      // 发射 runSummary 结构化卡片
      muxSse.sendEvent("runSummary", {
        runId,
        taskId: taskId ?? null,
        traceId: traceId ?? null,
        requestId: requestId ?? null,
        status: presentationStatus,
        totalSteps: loopResult.iterations,
        completedSteps: loopResult.succeededSteps,
        totalLatencyMs: null, // Agent Loop 不直接跟踪总耗时，由前端计算
        artifacts: [],
      });
    } catch {
      // SSE 可能已被客户端断开
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Agent Loop 完成后流式生成最终总结                                     */
/* ------------------------------------------------------------------ */

export async function streamLoopSummary(params: {
  app: any;
  sse: SseHandle;
  subject: { tenantId: string; spaceId?: string; subjectId: string };
  locale: string;
  message: string;
  loopResult: AgentLoopResult;
  defaultModelRef?: string;
  traceId?: string;
  requestId?: string;
  /** 多任务支持 */
  taskId?: string | null;
  sessionId?: string;
}): Promise<void> {
  const { app, sse, subject, locale, message, loopResult, defaultModelRef, traceId, requestId, taskId, sessionId } = params;
  const muxSse = sessionId ? wrapSseWithEventBus(sse, subject.tenantId, sessionId, taskId) : sse;

  muxSse.sendEvent("status", { phase: "summarizing", taskId: taskId ?? null, traceId: traceId ?? null, requestId: requestId ?? null });
  let deltaSent = false;
  const presentationStatus = deriveLoopPresentationStatus(loopResult);

  const summaryCtx = JSON.stringify({
    status: presentationStatus,
    ok: loopResult.ok,
    endReason: loopResult.endReason,
    iterations: loopResult.iterations,
    succeededSteps: loopResult.succeededSteps,
    failedSteps: loopResult.failedSteps,
    summary: loopResult.message,
  });

  try {
    await invokeModelChatUpstreamStream({
      app,
      subject: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, subjectId: subject.subjectId },
      body: {
        purpose: "orchestrator.dispatch.stream.summary",
        messages: [
          { role: "system", content: locale.startsWith("zh")
            ? `你是灵智Mindpal智能体OS的AI助手。Agent Loop 已执行完毕，请像同一个对话里的助手继续向用户同步进展，而不是写系统报告。要求：1) 先直接回应用户原始诉求是否已完成；2) 用自然口语说明关键结果和仍未完成的点；3) 如果有失败，只解释最关键原因，不要堆术语；4) 若需要用户继续操作，再给出简短下一步；5) 控制在 3 到 6 句话内，语气自然、连续、有人味。`
            : `You are the AI assistant of 灵智Mindpal Agent OS. Agent Loop has completed. Continue the same conversation naturally instead of writing a system report. Requirements: 1) directly tell the user whether their goal was completed; 2) explain the key results and anything still pending in natural language; 3) if something failed, mention only the most important reason without jargon; 4) give a short next step only if the user needs to do something; 5) keep it within 3 to 6 sentences and sound conversational.` },
          { role: "user", content: `${locale.startsWith("zh") ? "原始请求" : "Original request"}：${message}\n\n${locale.startsWith("zh") ? "执行结果" : "Execution result"}：${summaryCtx}` },
        ],
        stream: true,
        maxTokens: 500,
        ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
      },
      locale,
      traceId: traceId ?? undefined,
      onDelta: (text: string) => {
        deltaSent = true;
        muxSse.sendEvent("delta", { text });
      },
    });
  } catch (summaryErr: any) {
    app.log.warn({ err: summaryErr, traceId }, "[dispatch.stream] 总结流式失败");
  }

  // 无论成功或失败，如果没有输出任何 delta，发送降级文本
  if (!deltaSent) {
    app.log.warn({ traceId, loopMessage: loopResult.message?.slice(0, 200) }, "[dispatch.stream] 总结无 delta 输出，触发降级");
    if (loopResult.message) {
      muxSse.sendEvent("delta", { text: loopResult.message });
    }
  }
}
