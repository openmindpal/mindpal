"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, setLocale } from "@/lib/api";
import { t } from "@/lib/i18n";
import { nextId } from "@/lib/apiError";
import type { ChatFlowItem, ToolExecState, FrontendTaskQueueEntry, FrontendTaskDependency } from "./homeHelpers";

const SESSION_KEY = "mindpal_chat_session";
const TASK_QUEUE_KEY = "mindpal_task_queue_state";
const MODEL_KEY = "mindpal_selected_model";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const EMPTY_SESSION = { conversationId: "", flow: [] as ChatFlowItem[], toolExecStates: {} as Record<string, ToolExecState> };
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
 */
export default function useChatSession({ locale }: { locale: string }) {
  // 同步从 localStorage 恢复会话状态
  const [conversationId, setConversationId] = useState(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) { const s = JSON.parse(raw); return s.conversationId ?? ""; }
    } catch { /* ignore */ }
    return "";
  });
  const [flow, setFlow] = useState<ChatFlowItem[]>(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) { const s = JSON.parse(raw); return Array.isArray(s.flow) ? s.flow : []; }
    } catch { /* ignore */ }
    return [];
  });
  const [toolExecStates, setToolExecStates] = useState<Record<string, ToolExecState>>(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const restored: Record<string, ToolExecState> = {};
        if (s.toolExecStates && typeof s.toolExecStates === "object") {
          for (const [k, v] of Object.entries(s.toolExecStates)) {
            if (v && ((v as ToolExecState).status === "done" || (v as ToolExecState).status === "error")) restored[k] = v as ToolExecState;
          }
        }
        return restored;
      }
    } catch { /* ignore */ }
    return {};
  });
  const [bindings, setBindings] = useState<ModelBinding[]>([]);
  const [selectedModelRef, setSelectedModelRef] = useState<string>("");
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

  /* ─── 持久化会话状态 ─── */
  useEffect(() => {
    try {
      if (flow.length || conversationId) {
        const persistable: Record<string, ToolExecState> = {};
        for (const [k, v] of Object.entries(toolExecStates)) {
          if (v.status === "done" || v.status === "error") persistable[k] = v;
        }
        localStorage.setItem(SESSION_KEY, JSON.stringify({ conversationId, flow, toolExecStates: persistable }));
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch { /* expected: storage may fail silently */ }
  }, [flow, conversationId, toolExecStates]);

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
          const savedModelRef = localStorage.getItem(MODEL_KEY);
          if (savedModelRef && list.some((b: any) => b.modelRef === savedModelRef)) {
            setSelectedModelRef(savedModelRef);
          } else if (list.length > 0) {
            setSelectedModelRef(prev => prev || list[0].modelRef);
          }
        }
      } catch (err) {
        console.warn("[fetchBindings] Failed:", err);
      }
    };
    fetchBindings();
  }, [locale]);

  /* ─── Persist selected model ─── */
  useEffect(() => {
    if (selectedModelRef) {
      try { localStorage.setItem(MODEL_KEY, selectedModelRef); } catch { /* ignore */ }
    }
  }, [selectedModelRef]);

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
  }, [locale]);

  /* ─── Start new conversation ─── */
  const startNew = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setConversationId("");
    setFlow([]);
    setToolExecStates({});
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(TASK_QUEUE_KEY); } catch { /* ignore */ }
  }, []);

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
  }, [locale, restoreTaskQueueState]);

  /* ─── Delete a conversation from backend ─── */
  const deleteConversation = useCallback(async (sessionId: string) => {
    try {
      const res = await apiFetch(`/memory/session-contexts/${encodeURIComponent(sessionId)}`, { method: "DELETE", locale });
      if (!res.ok) {
        console.warn("[deleteConversation] Delete failed:", res.status);
        return false;
      }
      // If deleting the currently loaded conversation, clear it
      if (sessionId === conversationId) {
        startNew();
      }
      return true;
    } catch (err) {
      console.error("[deleteConversation] Delete error:", err);
      return false;
    }
  }, [locale, conversationId, startNew]);

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
