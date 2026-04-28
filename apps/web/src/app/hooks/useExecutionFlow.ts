"use client";

/**
 * useExecutionFlow — 执行流程控制 Hook
 *
 * 封装消息发送调度、工具执行、语音 TTS 自动化等执行链路。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { IntentMode } from "@/lib/types";
import type { FlowMessage } from "../homeHelpers";
import useVoiceInput from "../useVoiceInput";
import useVoiceTTS from "../useVoiceTTS";
import useVideoCapture from "../useVideoCapture";
import useAttachments from "../useAttachments";
import useToolExecution from "../useToolExecution";
import useSendMessage from "../useSendMessage";

export interface UseExecutionFlowParams {
  locale: string;
  conversationId: string;
  setConversationId: React.Dispatch<React.SetStateAction<string>>;
  flow: any[];
  setFlow: React.Dispatch<React.SetStateAction<any[]>>;
  selectedModelRef: string;
  abortRef: React.MutableRefObject<AbortController | null>;
  retryCountRef: React.MutableRefObject<Map<string, number>>;
  lastRetryMsgRef: React.MutableRefObject<string | null>;
  setToolExecStates: React.Dispatch<React.SetStateAction<any>>;
  setNl2uiLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveTask: (v: any) => void;
  setTaskProgress: (v: any) => void;
  pollTaskState: (taskId: string) => Promise<void>;
  activeTaskIds: string[];
}

export function useExecutionFlow(params: UseExecutionFlowParams) {
  const {
    locale, conversationId, setConversationId, flow, setFlow,
    selectedModelRef, abortRef, retryCountRef, lastRetryMsgRef,
    setToolExecStates, setNl2uiLoading, setActiveTask, setTaskProgress,
    pollTaskState, activeTaskIds,
  } = params;

  const [draft, setDraft] = useState("");
  const [execMode, setExecMode] = useState<"auto" | IntentMode>("auto");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    attachments, setAttachments, imageInputRef, docInputRef, audioInputRef, videoInputRef,
    addAttachment, removeAttachment, handleImageSelect, handleDocSelect, handleAudioSelect, handleVideoSelect,
  } = useAttachments({ locale });

  const sendRef = useRef<(msg: string) => void>(() => {});
  const onAutoSend = useCallback((text: string) => {
    setDraft(text);
    setTimeout(() => sendRef.current(text), 0);
  }, []);

  const { voiceListening, voiceInterim, voiceConversation, startVoice, toggleConversation } = useVoiceInput({ locale, setDraft, onAutoSend });
  const { speaking, speak, stopSpeaking, checkTTSReady } = useVoiceTTS();
  const { videoActive, videoStream, videoSupported, startVideo, stopVideo, captureFrame } = useVideoCapture();
  const { executeToolInline } = useToolExecution({ locale, setToolExecStates });

  // TTS readiness check
  const ttsCheckedRef = useRef(false);
  useEffect(() => {
    if (!ttsCheckedRef.current) { ttsCheckedRef.current = true; void checkTTSReady(); }
  }, [checkTTSReady]);

  // Auto-speak after response in voice conversation mode
  const prevBusyRef = useRef(false);
  const voiceConvRef = useRef(false);
  useEffect(() => { voiceConvRef.current = voiceConversation; }, [voiceConversation]);
  useEffect(() => {
    if (prevBusyRef.current && !busy && voiceConvRef.current) {
      const lastAssistant = [...flow].reverse().find(
        (it): it is { kind: "message" } & FlowMessage => it.kind === "message" && it.role === "assistant" && Boolean((it as FlowMessage).text)
      );
      if (lastAssistant?.text) {
        void speak(lastAssistant.text).then(() => { if (voiceConvRef.current) startVoice(); });
      } else if (voiceConvRef.current) startVoice();
    }
    prevBusyRef.current = busy;
  }, [busy, flow, speak, startVoice]);

  const { send } = useSendMessage({
    locale, draft, setDraft, attachments, setAttachments,
    conversationId, setConversationId, execMode, selectedModelRef,
    setBusy, setFlow, setNl2uiLoading,
    setActiveTask, setTaskProgress, pollTaskState,
    inputRef, abortRef, retryCountRef, lastRetryMsgRef,
    activeTaskIds,
  });

  useEffect(() => { sendRef.current = (msg: string) => void send(msg); }, [send]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }, [send]);

  return {
    draft, setDraft, execMode, setExecMode, busy, inputRef,
    attachments, addAttachment, removeAttachment, imageInputRef, docInputRef, audioInputRef, videoInputRef,
    handleImageSelect, handleDocSelect, handleAudioSelect, handleVideoSelect,
    voiceListening, voiceInterim, voiceConversation, speaking,
    startVoice, toggleConversation, stopSpeaking,
    videoActive, videoStream, videoSupported, startVideo, stopVideo, captureFrame,
    executeToolInline, send, onKeyDown,
  };
}
