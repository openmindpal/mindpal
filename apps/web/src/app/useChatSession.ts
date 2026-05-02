"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, setLocale } from "@/lib/api";
import { t } from "@/lib/i18n";
import { nextId } from "@/lib/apiError";
import { useSessionStore } from "@/store/sessionStore";
import type { ChatFlowItem, ToolExecState, FrontendTaskQueueEntry, FrontendTaskDependency } from "./homeHelpers";

const TASK_QUEUE_KEY = "mindpal_task_queue_state";

const EMPTY_TASK_QUEUE = { pendingEntries: [] as FrontendTaskQueueEntry[], dependencies: [] as FrontendTaskDependency[] };

/** P3-13: 读取保存的任务队列状态 */
export function readSavedTaskQueueState(): {
  pendingEntries: FrontendTaskQueueEntry[];
  dependencies: FrontendTaskDependency[];
} {
  try {
    const raw = localStorage.getItem(TASK_QUEUE_KEY);
    if (!raw) return EMPTY_TASK_QUEUE;
    const saved = JSON.parse(raw);
    return {
      pendingEntries: Array.isArray(saved.pendingEntries) ? saved.pendingEntries : [],
      dependencies: Array.isArray(saved.dependencies) ? saved.dependencies : [],
    };
  } catch {
    return EMPTY_TASK_QUEUE; // expected: JSON.parse may throw
  }
}

export interface ModelBinding {
  modelRef: string;
  provider: string;
  model: string;
  baseUrl?: string | null;
}

/**
 * useChatSession — manages conversation ID, flow, session persistence,
 * model bindings, and startNew.
 *
 * State is backed by Zustand sessionStore (with persist middleware).
 * This hook only retains behaviour logic, refs, and derived values.
 */
export default function useChatSession({ locale }: { locale: string }) {
  /* ── Zustand store selectors (state + actions) ── */
  const conversationId = useSessionStore((s) => s.conversationId);
  const setConversationId = useSessionStore((s) => s.setConversationId);
  const flow = useSessionStore((s) => s.flow);
  const setFlow = useSessionStore((s) => s.setFlow);
  const toolExecStates = useSessionStore((s) => s.toolExecStates);
  const setToolExecStates = useSessionStore((s) => s.setToolExecStates);
  const selectedModelRef = useSessionStore((s) => s.selectedModelRef);
  const setSelectedModelRef = useSessionStore((s) => s.setSelectedModelRef);
  const clearSession = useSessionStore((s) => s.clearSession);

  /* ── Local-only state (not persisted) ── */
  const [bindings, setBindings] = useState<ModelBinding[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastRetryMsgRef = useRef<string | null>(null);
  const retryCountRef = useRef<Map<string, number>>(new Map());

  const selectedBinding = useMemo(
    () => bindings.find((b) => b.modelRef === selectedModelRef) ?? bindings[0] ?? null,
    [bindings, selectedModelRef],
  );

  const modelPickerTitle = selectedBinding
    ? `${t(locale, "home.modelPicker")}: ${selectedBinding.provider}:${selectedBinding.model}`
    : t(locale, "home.modelPicker");

  /* ─── Backend session validation ─── */
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/memory/session-contexts/${encodeURIComponent(conversationId)}`, { method: "GET", locale });
        if (cancelled) return;
        if (!res.ok || res.status === 404) {
          console.log("[session-restore] Backend session expired. A new session will be created on the next message.");
        }
      } catch {
        console.warn("[session-restore] Backend validation failed. Keeping local cache.");
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, locale]);

  /* ─── Sync html lang attribute on mount ─── */
  useEffect(() => { setLocale(locale); }, [locale]);

  /* ─── Fetch model bindings ─── */
  useEffect(() => {
    const fetchBindings = async () => {
      try {
        const res = await apiFetch("/models/bindings", { method: "GET", locale });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data.bindings) ? data.bindings : [];
          setBindings(list);
          // Restore persisted model selection or fall back to first binding
          const currentRef = useSessionStore.getState().selectedModelRef;
          if (currentRef && list.some((b: ModelBinding) => b.modelRef === currentRef)) {
            // Already set in store via persist — nothing to do
          } else if (list.length > 0) {
            setSelectedModelRef(list[0].modelRef);
          }
        }
      } catch (err) {
        console.warn("[fetchBindings] Failed:", err);
      }
    };
    fetchBindings();
  }, [locale, setSelectedModelRef]);

  /* ─── Online restore hint ─── */
  useEffect(() => {
    function onOnline() {
      const msg = lastRetryMsgRef.current;
      if (!msg) return;
      setFlow((prev) => [...prev, {
        kind: "error", id: nextId("e"), role: "assistant",
        errorCode: "NETWORK_RESTORED",
        message: t(locale, "chat.network.restored"),
        traceId: "", retryMessage: msg,
        createdAt: Date.now(),
      }]);
    }
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [locale, setFlow]);

  /* ─── Start new conversation ─── */
  const startNew = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearSession();
    try { localStorage.removeItem(TASK_QUEUE_KEY); } catch { /* ignore */ }
  }, [clearSession]);

  /** P3-13: 从后端拉取任务队列状态并保存 */
  const restoreTaskQueueState = useCallback(async (sessionId: string) => {
    try {
      const res = await apiFetch(
        `/orchestrator/task-queue/resumable?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "GET", locale },
      );
      if (!res.ok) return;
      const data = await res.json();
      const state = {
        pendingEntries: data.entries ?? [],
        dependencies: data.dependencies ?? [],
      };
      localStorage.setItem(TASK_QUEUE_KEY, JSON.stringify(state));
      console.log(`[session-restore] Restored task queue: ${state.pendingEntries.length} pending entries`);
    } catch (err) {
      console.warn("[session-restore] Task queue restore failed:", err);
    }
  }, [locale]);

  /* ─── Load a previous conversation from backend ─── */
  const loadConversation = useCallback(async (sessionId: string) => {
    try {
      const res = await apiFetch(`/memory/session-contexts/${encodeURIComponent(sessionId)}`, { method: "GET", locale });
      if (!res.ok) {
        console.warn("[loadConversation] Load failed:", res.status);
        return false;
      }
      const data = await res.json();
      const ctx = data.sessionContext;
      if (!ctx?.context?.messages?.length) {
        console.warn("[loadConversation] Session data is empty");
        return false;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      const restoredFlow: ChatFlowItem[] = ctx.context.messages.map((m: any) => ({
        kind: "message" as const,
        id: nextId("r"),
        role: m.role as "user" | "assistant",
        text: m.content ?? "",
        createdAt: m.at ? Date.parse(m.at) || undefined : undefined,
      }));
      setConversationId(sessionId);
      setFlow(restoredFlow);
      setToolExecStates({});
      restoreTaskQueueState(sessionId).catch(() => {});
      return true;
    } catch (err) {
      console.error("[loadConversation] Load error:", err);
      return false;
    }
  }, [locale, restoreTaskQueueState, setConversationId, setFlow, setToolExecStates]);

  /* ─── Delete a conversation from backend ─── */
  const deleteConversation = useCallback(async (sessionId: string) => {
    try {
      const res = await apiFetch(`/memory/session-contexts/${encodeURIComponent(sessionId)}`, { method: "DELETE", locale });
      if (!res.ok) {
        console.warn("[deleteConversation] Delete failed:", res.status);
        return false;
      }
      // If deleting the currently loaded conversation, clear it
      if (sessionId === useSessionStore.getState().conversationId) {
        startNew();
      }
      return true;
    } catch (err) {
      console.error("[deleteConversation] Delete error:", err);
      return false;
    }
  }, [locale, startNew]);

  return {
    conversationId, setConversationId,
    flow, setFlow,
    toolExecStates, setToolExecStates,
    bindings,
    selectedModelRef, setSelectedModelRef,
    selectedBinding, modelPickerTitle,
    modelPickerOpen, setModelPickerOpen,
    modelPickerRef,
    abortRef, lastRetryMsgRef, retryCountRef,
    startNew,
    loadConversation,
    deleteConversation,
    restoreTaskQueueState,
    readSavedTaskQueueState,
  };
}
