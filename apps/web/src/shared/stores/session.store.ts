import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ChatFlowItem {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface SessionState {
  conversationId: string | null;
  flow: ChatFlowItem[];
  toolExecStates: Record<string, 'pending' | 'running' | 'done' | 'error'>;
  selectedModelRef: string;
}

interface SessionActions {
  setConversationId: (id: string | null) => void;
  setFlow: (flow: ChatFlowItem[]) => void;
  appendFlowItem: (item: ChatFlowItem) => void;
  updateToolExecState: (toolId: string, state: 'pending' | 'running' | 'done' | 'error') => void;
  setSelectedModelRef: (ref: string) => void;
  clearSession: () => void;
}

const initialState: SessionState = {
  conversationId: null,
  flow: [],
  toolExecStates: {},
  selectedModelRef: '',
};

export const useSessionStore = create<SessionState & SessionActions>()(
  persist(
    (set) => ({
      ...initialState,

      setConversationId: (id) => set({ conversationId: id }),
      setFlow: (flow) => set({ flow }),
      appendFlowItem: (item) => set((s) => ({ flow: [...s.flow, item] })),
      updateToolExecState: (toolId, state) =>
        set((s) => ({ toolExecStates: { ...s.toolExecStates, [toolId]: state } })),
      setSelectedModelRef: (ref) => set({ selectedModelRef: ref }),
      clearSession: () => set(initialState),
    }),
    {
      name: 'mindpal_chat_session',
      partialize: (state) => ({
        conversationId: state.conversationId,
        selectedModelRef: state.selectedModelRef,
      }),
    },
  ),
);
