import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChatFlowItem, ToolExecState } from "../app/homeHelpers";

/* ─── Persist key (same as legacy localStorage key for data continuity) ─── */
const SESSION_KEY = "mindpal_chat_session";

/* ─── State shape ─── */

interface SessionState {
  /* ── data ── */
  conversationId: string;
  flow: ChatFlowItem[];
  toolExecStates: Record<string, ToolExecState>;
  selectedModelRef: string;

  /* ── actions ── */
  setConversationId: (v: string | ((prev: string) => string)) => void;
  setFlow: (
    updater: ChatFlowItem[] | ((prev: ChatFlowItem[]) => ChatFlowItem[]),
  ) => void;
  setToolExecStates: (
    updater:
      | Record<string, ToolExecState>
      | ((prev: Record<string, ToolExecState>) => Record<string, ToolExecState>),
  ) => void;
  setSelectedModelRef: (v: string | ((prev: string) => string)) => void;
  /** Reset conversation state (called on "New Chat") */
  clearSession: () => void;
}

/* ─── Store ─── */

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      conversationId: "",
      flow: [],
      toolExecStates: {},
      selectedModelRef: "",

      setConversationId: (v) =>
        set((s) => ({
          conversationId: typeof v === "function" ? v(s.conversationId) : v,
        })),

      setFlow: (updater) =>
        set((s) => ({
          flow: typeof updater === "function" ? updater(s.flow) : updater,
        })),

      setToolExecStates: (updater) =>
        set((s) => ({
          toolExecStates:
            typeof updater === "function"
              ? updater(s.toolExecStates)
              : updater,
        })),

      setSelectedModelRef: (v) =>
        set((s) => ({
          selectedModelRef: typeof v === "function" ? v(s.selectedModelRef) : v,
        })),

      clearSession: () =>
        set({ conversationId: "", flow: [], toolExecStates: {} }),
    }),
    {
      name: SESSION_KEY,
      storage: createJSONStorage(() => {
        // SSR guard: during server rendering globalThis.localStorage is undefined
        if (typeof window === "undefined") {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          };
        }
        return localStorage;
      }),
      /** Only persist terminal tool-exec states (done / error) to keep storage lean */
      partialize: (state) => {
        const persistable: Record<string, ToolExecState> = {};
        for (const [k, v] of Object.entries(state.toolExecStates)) {
          if (v.status === "done" || v.status === "error") persistable[k] = v;
        }
        return {
          conversationId: state.conversationId,
          flow: state.flow,
          toolExecStates: persistable,
          selectedModelRef: state.selectedModelRef,
        };
      },
    },
  ),
);
