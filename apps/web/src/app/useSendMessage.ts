"use client";

import { useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { errorMessageText, nextId } from "@/lib/apiError";
import type { IntentMode, TaskState } from "@/lib/types";
import type { ChatFlowItem, ChatAttachment, TaskProgress, TaskStepEntry } from "./homeHelpers";
import { handleSSEEvent, type SSEEventContext } from "./sseEventHandler";
import { buildApiAttachments } from "./attachmentBuilder";

export interface UseSendMessageParams {
  locale: string;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  conversationId: string;
  setConversationId: React.Dispatch<React.SetStateAction<string>>;
  execMode: "auto" | IntentMode;
  selectedModelRef: string;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setFlow: React.Dispatch<React.SetStateAction<ChatFlowItem[]>>;
  setNl2uiLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveTask: React.Dispatch<React.SetStateAction<{ taskId: string; runId: string; taskState: TaskState } | null>>;
  setTaskProgress: React.Dispatch<React.SetStateAction<TaskProgress | null>>;
  pollTaskState: (runId: string) => Promise<void>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  abortRef: React.MutableRefObject<AbortController | null>;
  retryCountRef: React.MutableRefObject<Map<string, number>>;
  lastRetryMsgRef: React.MutableRefObject<string | null>;
  /** P1-11: 当前活跃的任务 ID 列表（用于多任务上下文） */
  activeTaskIds?: string[];
}

/**
 * useSendMessage — the core send function, SSE stream parsing,
 * retry logic, and attachment processing.
 */
export default function useSendMessage(params: UseSendMessageParams) {
  const {
    locale, draft, setDraft, attachments, setAttachments,
    conversationId, setConversationId, execMode, selectedModelRef,
    setBusy, setFlow, setNl2uiLoading,
    setActiveTask, setTaskProgress, pollTaskState,
    inputRef, abortRef, retryCountRef, lastRetryMsgRef,
    activeTaskIds,
  } = params;

  const send = useCallback(async (overrideMsg?: string, opts?: { appendUser?: boolean }) => {
    const message = (overrideMsg ?? draft).trim();
    if (!message && attachments.length === 0) return;

    // P1-11: 不再 abort 前一个任务的 SSE 连接。新消息不终止旧任务，而是入队新任务。
    // 保留 abortRef 以便用户主动取消当前请求（而非自动打断）。

    let appendUser = opts?.appendUser !== false;
    const currentAttachments = appendUser ? [...attachments] : [];
    if (appendUser) {
      setDraft("");
      setAttachments([]);
      if (inputRef.current) inputRef.current.style.height = "auto";
    }
    setBusy(true);

    const MAX_RETRIES = 2;
    let retryAttempt = 0;

    for (; retryAttempt <= MAX_RETRIES; retryAttempt++) {

    if (appendUser) {
      const userFlowItem: ChatFlowItem = {
        kind: "message",
        id: nextId("m"),
        role: "user",
        text: message || (
          currentAttachments.length > 0
            ? currentAttachments.map((a) => a.type === "voice" ? `🎤 ${a.name}` : a.type === "video" ? `🎬 ${a.name}` : `📎 ${a.name}`).join(", ")
            : ""
        ),
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
        createdAt: Date.now(),
      };
      setFlow((prev) => [...prev, userFlowItem]);
    }

    setNl2uiLoading(false);

    const replyId = nextId("m");
    setFlow((prev) => [...prev, { kind: "message", id: replyId, role: "assistant", text: "", createdAt: Date.now() }]);

    const controller = new AbortController();
    abortRef.current = controller;

    const dispatchMode = execMode === "auto" ? "auto" : execMode;

    const apiAttachments = await buildApiAttachments(currentAttachments);

    try {
      if (dispatchMode === "auto") {
        console.log("[auto] Skip frontend pre-classification and let dispatch/stream handle the request.");
      }

      const res = await apiFetch(`/orchestrator/dispatch/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "text/event-stream" },
        locale,
        body: JSON.stringify({
          message,
          locale,
          mode: dispatchMode,
          ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
          ...(selectedModelRef ? { defaultModelRef: selectedModelRef } : {}),
          ...(apiAttachments.length > 0 ? { attachments: apiAttachments } : {}),
          // P1-11: 多任务上下文
          ...(activeTaskIds && activeTaskIds.length > 0 ? { activeTaskIds } : {}),
          ...(conversationId.trim() ? { sessionQueueContext: { sessionId: conversationId.trim() } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let e: Record<string, unknown> = {};
        try { e = JSON.parse(errText); } catch { /* expected: errText may not be valid JSON */ }
        const traceId = String(e.traceId ?? "");
        const retryAfterSec = Number(e.retryAfterSec ?? res.headers.get("Retry-After"));
        const retryHint = res.status === 429 && Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? ` (${t(locale, "error.retryIn")} ${Math.ceil(retryAfterSec)}s)` : "";

        const isRetryable = res.status >= 500 || res.status === 429 || !res.ok;
        const msgKey = `${conversationId}:${message.slice(0, 50)}`;
        const currentRetries = retryCountRef.current.get(msgKey) ?? 0;

        if (isRetryable && currentRetries < MAX_RETRIES && retryAttempt < MAX_RETRIES) {
          console.log(`[P0-5] Auto retry ${currentRetries + 1}/${MAX_RETRIES}: "${message.slice(0, 50)}..."`);
          retryCountRef.current.set(msgKey, currentRetries + 1);
          const backoffMs = Math.min(1000 * Math.pow(2, currentRetries), 3000);
          setFlow((prev) => prev.filter((it) => it.id !== replyId));
          await new Promise(r => setTimeout(r, backoffMs));
          appendUser = false;
          continue;
        }

        retryCountRef.current.delete(msgKey);
        setFlow((prev) => prev.filter((it) => it.id !== replyId));
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
          errorCode: String(e.errorCode ?? res.status),
          message: `${errorMessageText(locale, e.message ?? res.statusText)}${retryHint}`,
          traceId, retryMessage: message, createdAt: Date.now(),
        }]);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setFlow((prev) => prev.filter((it) => it.id !== replyId));
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
          errorCode: "STREAM_ERROR",
          message: t(locale, "chat.error.STREAM_ERROR"),
          traceId: "", retryMessage: message, createdAt: Date.now(),
        }]);
        return;
      }

      const decoder = new TextDecoder();
      let sseBuffer = "";
      let accumulatedText = "";
      let streamHasError = false;
      let pendingToolSuggestions: any[] = [];
      let hasNl2uiResult = false;
      let hasTaskCreated = false;
      let hasStructuredFlowItems = false;

      let rafId: number | null = null;
      let pendingText: string | null = null;
      const syncReplyText = (text: string) => {
        pendingText = text;
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (pendingText !== null) {
              const t = pendingText;
              pendingText = null;
              setFlow((prev) => prev.map((it) =>
                it.id === replyId ? { ...it, text: t } : it
              ));
            }
          });
        }
      };
      const flushPendingSync = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (pendingText !== null) {
          const t = pendingText;
          pendingText = null;
          setFlow((prev) => prev.map((it) =>
            it.id === replyId ? { ...it, text: t } : it
          ));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split("\n\n");
        sseBuffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) continue;
          const lines = part.split("\n");
          let evtName = "";
          let evtData = "";
          for (const ln of lines) {
            if (ln.startsWith("event: ")) evtName = ln.slice(7).trim();
            else if (ln.startsWith("data: ")) evtData += (evtData ? "\n" : "") + ln.slice(6);
          }
          if (!evtName || !evtData) continue;

          try {
            const data = JSON.parse(evtData);
            const sseCtx: SSEEventContext = {
              replyId, message, locale, conversationId,
              accumulatedText, syncReplyText,
              setAccumulatedText: (t: string) => { accumulatedText = t; },
              pendingToolSuggestions,
              setPendingToolSuggestions: (s: any[]) => { pendingToolSuggestions = s; },
              streamHasError,
              setStreamHasError: (v: boolean) => { streamHasError = v; },
              hasNl2uiResult,
              setHasNl2uiResult: (v: boolean) => { hasNl2uiResult = v; },
              hasTaskCreated,
              setHasTaskCreated: (v: boolean) => { hasTaskCreated = v; },
              hasStructuredFlowItems,
              setHasStructuredFlowItems: (v: boolean) => { hasStructuredFlowItems = v; },
              setNl2uiLoading, setFlow, setConversationId,
              setActiveTask, setTaskProgress, pollTaskState,
              retryCountRef, lastRetryMsgRef,
              selectedModelRef,
            };
            handleSSEEvent(evtName, data, sseCtx);
          } catch (parseErr) {
            console.warn("[SSE] Failed to parse event data:", evtName, evtData.slice(0, 200), parseErr);
          }
        }
      }

      flushPendingSync();

      if (!accumulatedText && !streamHasError && !hasNl2uiResult && !hasTaskCreated && pendingToolSuggestions.length === 0) {
        setFlow((prev) => prev.map((it) =>
          it.id === replyId
            ? { ...it, text: t(locale, "chat.noResponse") }
            : it
        ));
        lastRetryMsgRef.current = message;
      }

      if (!accumulatedText && (hasNl2uiResult || hasTaskCreated || pendingToolSuggestions.length > 0 || hasStructuredFlowItems)) {
        setFlow((prev) => prev.filter((it) => it.id !== replyId));
      }

      break;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setFlow((prev) => prev.map((it) => {
          if (it.id !== replyId) return it;
          const text = it.kind === "message" ? it.text : "";
          if (!text) return null;
          return { ...it, text: `${text} ${t(locale, "chat.interruptedSuffix")}` };
        }).filter(Boolean) as ChatFlowItem[]);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        lastRetryMsgRef.current = message;
        setFlow((prev) => prev.filter((it) => it.id !== replyId));
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode: "NETWORK_ERROR", message: msg, traceId: "", retryMessage: message, createdAt: Date.now() }]);
      }
      break;
    }
    } // end for retry loop
    abortRef.current = null;
    setBusy(false);
  }, [
    abortRef,
    attachments,
    conversationId,
    draft,
    execMode,
    inputRef,
    lastRetryMsgRef,
    locale,
    pollTaskState,
    retryCountRef,
    selectedModelRef,
    setActiveTask,
    setAttachments,
    setBusy,
    setConversationId,
    setDraft,
    setFlow,
    setNl2uiLoading,
    setTaskProgress,
    activeTaskIds,
  ]);

  return { send };
}

