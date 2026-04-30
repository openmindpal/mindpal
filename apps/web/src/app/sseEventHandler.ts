"use client";

import { nextId } from "@/lib/apiError";
import { errorMessageText } from "@/lib/apiError";
import { t } from "@/lib/i18n";
import type { TaskState } from "@/lib/types";
import type { ChatFlowItem, TaskProgress, TaskStepEntry } from "./homeHelpers";

export interface SSEEventContext {
  replyId: string;
  message: string;
  locale: string;
  conversationId: string;
  accumulatedText: string;
  syncReplyText: (text: string) => void;
  setAccumulatedText: (t: string) => void;
  pendingToolSuggestions: any[];
  setPendingToolSuggestions: (s: any[]) => void;
  streamHasError: boolean;
  setStreamHasError: (v: boolean) => void;
  hasTaskCreated: boolean;
  setHasTaskCreated: (v: boolean) => void;
  hasStructuredFlowItems: boolean;
  setHasStructuredFlowItems: (v: boolean) => void;
  setFlow: React.Dispatch<React.SetStateAction<ChatFlowItem[]>>;
  setConversationId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTask: React.Dispatch<React.SetStateAction<{ taskId: string; runId: string; taskState: TaskState } | null>>;
  setTaskProgress: React.Dispatch<React.SetStateAction<TaskProgress | null>>;
  pollTaskState: (runId: string) => Promise<void>;
  retryCountRef: React.MutableRefObject<Map<string, number>>;
  lastRetryMsgRef: React.MutableRefObject<string | null>;
  /** 用户选定的模型（用于检测是否发生了自动切换） */
  selectedModelRef?: string;
  /** 流式 TTS：每次 delta 增量文本回调 */
  onStreamDelta?: (chunk: string) => void;
  /** 流式 TTS：流结束回调 */
  onStreamDone?: () => void;
}

/**
 * Handle a single SSE event from the orchestrator dispatch stream.
 */
export function handleSSEEvent(evtName: string, data: any, ctx: SSEEventContext) {
  const { replyId, message, locale, conversationId } = ctx;

  switch (evtName) {
    case "delta": {
      const deltaText = data.text ?? "";
      ctx.accumulatedText += deltaText;
      ctx.setAccumulatedText(ctx.accumulatedText);
      ctx.syncReplyText(ctx.accumulatedText);
      if (deltaText && ctx.onStreamDelta) ctx.onStreamDelta(deltaText);
      break;
    }
    case "toolSuggestions":
      ctx.pendingToolSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      ctx.setPendingToolSuggestions(ctx.pendingToolSuggestions);
      break;
    case "taskCreated":
      if (data.taskId && data.runId) {
        ctx.hasTaskCreated = true;
        ctx.setHasTaskCreated(true);
        const ts = data.taskState ?? { phase: "queued" };
        ctx.setActiveTask({ taskId: data.taskId, runId: data.runId, taskState: ts });
        ctx.setTaskProgress({
          taskId: data.taskId,
          runId: data.runId,
          phase: ts.phase ?? "queued",
          steps: [],
          createdAt: Date.now(),
          label: data.mode ? String(data.mode) : "execute",
        });
        void ctx.pollTaskState(data.runId);
      }
      break;
    case "stepProgress": {
      const step = data.step;
      if (step && data.runId) {
        const newStep: TaskStepEntry = {
          id: nextId("ts"),
          seq: step.seq,
          toolRef: step.toolRef ?? "unknown",
          status: step.status ?? "running",
          reasoning: step.reasoning?.slice(0, 200),
          ts: Date.now(),
        };
        ctx.setTaskProgress((prev) => {
          if (!prev || prev.runId !== data.runId) return prev;
          const existing = prev.steps.findIndex((s) => s.seq === step.seq);
          const newSteps = [...prev.steps];
          if (existing >= 0) { newSteps[existing] = newStep; } else { newSteps.push(newStep); }
          return { ...prev, phase: "executing", steps: newSteps };
        });
        ctx.setActiveTask((prev) => {
          if (!prev || prev.runId !== data.runId) return prev;
          return { ...prev, taskState: { ...prev.taskState, phase: "executing", currentStep: step.seq } };
        });
      }
      break;
    }
    case "agentLoopEnd": {
      const finalPhase = String(data.status ?? (data.ok ? "succeeded" : "failed"));
      ctx.setTaskProgress((prev) => prev ? { ...prev, phase: finalPhase } : prev);
      ctx.setActiveTask((prev) => {
        if (!prev || prev.runId !== data.runId) return prev;
        return { ...prev, taskState: { ...prev.taskState, phase: finalPhase } };
      });
      break;
    }
    case "error":
      ctx.streamHasError = true;
      ctx.setStreamHasError(true);
      ctx.retryCountRef.current.delete(`${conversationId}:${message.slice(0, 50)}`);
      ctx.setFlow((prev) => prev.filter((it) => it.id !== replyId));
      ctx.setFlow((prev) => [...prev, {
        kind: "error", id: nextId("e"), role: "assistant",
        errorCode: String(data.errorCode ?? "STREAM_ERROR"),
        message: errorMessageText(locale, data.message ?? t(locale, "chat.modelServiceError")),
        traceId: String(data.traceId ?? ""),
        retryMessage: message,
      }]);
      break;
    case "done": {
      if (ctx.onStreamDone) ctx.onStreamDone();
      const doneConvId = data.conversationId;
      if (doneConvId) ctx.setConversationId(doneConvId);
      // Model auto-switch detection: when actual model differs from user selection, add lightweight notification
      const actualModelRef = data.actualModelRef ? String(data.actualModelRef) : null;
      if (actualModelRef && ctx.selectedModelRef && actualModelRef !== ctx.selectedModelRef) {
        const displayName = actualModelRef.replace(/@.*$/, "");
        const note = `\u26A1 ${t(locale, "model.autoSwitchNote").replace("{name}", displayName)}`;
        ctx.setFlow((prev) => prev.map((it) =>
          it.id === replyId && it.kind === "message" ? { ...it, modelSwitchNote: note } : it
        ));
      }
      if (ctx.pendingToolSuggestions.length > 0) {
        const tsId = nextId("ts");
        ctx.setFlow((prev) => [...prev, {
          kind: "toolSuggestions" as const, id: tsId, role: "assistant" as const,
          suggestions: ctx.pendingToolSuggestions, turnId: data.turnId, createdAt: Date.now(),
        }]);
      }
      ctx.retryCountRef.current.delete(`${data.conversationId || conversationId}:${message.slice(0, 50)}`);
      ctx.lastRetryMsgRef.current = ctx.accumulatedText ? null : message;
      break;
    }
    /* ── Structured flow events ── */
    case "planStep": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      break;
    }
    case "executionReceipt": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      break;
    }
    case "approvalNode": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      ctx.setFlow((prev) => [...prev, {
        kind: "approvalNode" as const,
        id: nextId("an"),
        role: "assistant" as const,
        approvalId: data.approvalId ?? "",
        runId: data.runId ?? "",
        stepId: data.stepId ?? undefined,
        toolRef: data.toolRef ?? "unknown",
        status: data.status ?? "pending",
        requestedAt: data.requestedAt ?? new Date().toISOString(),
        decidedAt: data.decidedAt ?? undefined,
        riskLevel: data.riskLevel ?? undefined,
        humanSummary: data.humanSummary ?? undefined,
        inputDigest: data.inputDigest ?? undefined,
      }]);
      break;
    }
    case "phaseIndicator": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      // 更新 reply 气泡的 phase（驱动前端真实阶段翻滚）
      const piPhase = String(data.phase ?? "");
      if (piPhase) {
        ctx.setFlow((prev) => prev.map((it) =>
          it.id === replyId ? { ...it, phase: piPhase } : it
        ));
      }
      break;
    }
    case "status": {
      // 后端实时处理阶段（started/classified/thinking/planning/fallback 等）
      const stPhase = String(data.phase ?? "");
      if (stPhase) {
        ctx.setFlow((prev) => prev.map((it) =>
          it.id === replyId ? { ...it, phase: stPhase } : it
        ));
      }
      break;
    }
    case "artifactCard": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      ctx.setFlow((prev) => [...prev, {
        kind: "artifactCard" as const,
        id: nextId("ac"),
        role: "assistant" as const,
        artifactType: String(data.artifactType ?? "file"),
        title: String(data.title ?? "Artifact"),
        summary: data.summary ? String(data.summary) : null,
        data: data.data ?? null,
        url: data.url ? String(data.url) : null,
        runId: data.runId ? String(data.runId) : null,
      }]);
      break;
    }
    case "runSummary": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      break;
    }
    /* ── Schema-UI events ── */
    case "schemaUiStatus": {
      const phase = String(data.phase ?? "");
      if (phase) {
        ctx.setFlow((prev) => prev.map((it) =>
          it.id === replyId ? { ...it, phase: `schemaUi:${phase}` } : it
        ));
      }
      break;
    }
    case "schemaUiResult": {
      ctx.hasStructuredFlowItems = true;
      ctx.setHasStructuredFlowItems(true);
      ctx.setFlow((prev) => [...prev, {
        kind: "schemaUiResult" as const,
        id: nextId("sui"),
        role: "assistant" as const,
        config: data.config ?? null,
        createdAt: Date.now(),
      }]);
      break;
    }
    case "schemaUiError": {
      // Schema-UI 是非关键附加功能，失败时静默降级，不显示错误气泡
      console.warn("Schema-UI generation failed (non-critical):", data);
      break;
    }
  }
}
