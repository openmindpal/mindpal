"use client";

/**
 * useConversation — 会话状态管理 Hook
 *
 * 封装会话创建、切换、历史加载、删除等操作，
 * 以及相关的 recent entries 管理。
 */

import { useCallback, useEffect, useState } from "react";
import { type RecentEntry, loadRecent, addRecent } from "../homeHelpers";
import useChatSession from "../useChatSession";
import useNl2uiActions from "../useNl2uiActions";

export interface UseConversationParams {
  locale: string;
}

export function useConversation({ locale }: UseConversationParams) {
  const session = useChatSession({ locale });
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration: read localStorage once on mount
  useEffect(() => { setRecent(loadRecent()); }, []);

  const nl2ui = useNl2uiActions({ locale, setRecent });

  const addToRecent = useCallback((entry: { kind: "page" | "workbench"; name: string }) => {
    setRecent(addRecent(entry));
  }, []);

  return {
    // Session state
    conversationId: session.conversationId,
    setConversationId: session.setConversationId,
    flow: session.flow,
    setFlow: session.setFlow,
    toolExecStates: session.toolExecStates,
    setToolExecStates: session.setToolExecStates,
    bindings: session.bindings,
    selectedModelRef: session.selectedModelRef,
    setSelectedModelRef: session.setSelectedModelRef,
    modelPickerTitle: session.modelPickerTitle,
    modelPickerOpen: session.modelPickerOpen,
    setModelPickerOpen: session.setModelPickerOpen,
    modelPickerRef: session.modelPickerRef,
    abortRef: session.abortRef,
    lastRetryMsgRef: session.lastRetryMsgRef,
    retryCountRef: session.retryCountRef,
    startNew: session.startNew,
    loadConversation: session.loadConversation,
    deleteConversation: session.deleteConversation,
    // Recent
    recent,
    setRecent,
    addToRecent,
    // NL2UI
    ...nl2ui,
  };
}
