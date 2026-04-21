"use client";

/**
 * ChatFlow/ChatMessages — 消息列表渲染组件
 *
 * 封装消息流的滚动管理和条件渲染逻辑，
 * 从 HomeChatShell 接收 flow 数据并委托给 ChatFlowRenderer。
 */

import { useEffect, useRef } from "react";
import ChatFlowRenderer from "../ChatFlowRenderer";

export interface ChatMessagesProps {
  locale: string;
  flow: any[];
  busy: boolean;
  nl2uiLoading: boolean;
  toolExecStates: any;
  directiveNav: any;
  savedPages: any;
  savingPageId: string | null;
  send: (msg?: string) => Promise<void>;
  executeToolInline: (toolRef: string, params: any) => Promise<any>;
  openDirective: (d: any) => void;
  openInWorkspace: (info: { kind: string; name: string; url: string }) => void;
  saveAsPage: (id: string) => void;
  setMaximizedNl2ui: (v: any) => void;
  onApprovalDecision: (approvalId: string, decision: "approve" | "reject") => Promise<void>;
  hasMounted: boolean;
}

export default function ChatMessages(props: ChatMessagesProps) {
  const { locale, flow, busy, hasMounted } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  const hasMessages = hasMounted && flow.length > 0;

  useEffect(() => {
    if (!scrollRef.current) return;
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!scrollRef.current) return;
      if (!initialScrollDoneRef.current) {
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
        initialScrollDoneRef.current = true;
      } else {
        const el = scrollRef.current;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 150) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    });
  }, [flow, hasMounted]);

  useEffect(() => {
    return () => { if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current); };
  }, []);

  /** Reset scroll tracking (e.g., when loading a different conversation) */
  const resetScroll = () => { initialScrollDoneRef.current = false; };

  if (!hasMessages) return null;

  return (
    <ChatFlowRenderer
      locale={locale}
      flow={flow}
      busy={busy}
      nl2uiLoading={props.nl2uiLoading}
      toolExecStates={props.toolExecStates}
      directiveNav={props.directiveNav}
      savedPages={props.savedPages}
      savingPageId={props.savingPageId}
      scrollRef={scrollRef}
      send={props.send}
      executeToolInline={props.executeToolInline}
      openDirective={props.openDirective}
      openInWorkspace={props.openInWorkspace}
      saveAsPage={props.saveAsPage}
      setMaximizedNl2ui={props.setMaximizedNl2ui}
      onApprovalDecision={props.onApprovalDecision}
    />
  );
}

export { ChatMessages };
