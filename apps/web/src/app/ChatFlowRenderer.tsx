"use client";

import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Image from "next/image";
import Link from "next/link";
import { t } from "@/lib/i18n";
import { safeJsonString } from "@/lib/apiError";
import { type ToolSuggestion } from "@/lib/types";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import {
  type ChatFlowItem, type FlowDirective, type FlowNl2UiResult,
  type FlowApprovalNode, type FlowTaskQueueEvent, type FlowArtifactCard,
  type ToolExecState, type WorkspaceTab,
  friendlyToolName, riskBadgeKey, riskBadgeClass, friendlyOutputSummary,
  friendlyErrorMessage,
} from "./homeHelpers";
import { ApprovalNodeRenderer } from "@/components/flow/FlowItemRenderer";
import { IconExternal, IconPanel } from "./HomeIcons";
import FlowMarkdown from "@/components/flow/FlowMarkdown";
import { FlowToolSuggestions } from "@/components/flow/FlowToolSuggestions";
import { FlowTaskQueueEvent as FlowTaskQueueEventBlock } from "@/components/flow/FlowTaskQueueEvent";
import { FlowNl2uiResult } from "@/components/flow/FlowNl2uiResult";
import { FlowArtifactCard as FlowArtifactCardBlock } from "@/components/flow/FlowArtifactCard";
import styles from "@/styles/page.module.css";

export interface ChatFlowRendererProps {
  locale: string;
  flow: ChatFlowItem[];
  busy: boolean;
  nl2uiLoading: boolean;
  toolExecStates: Record<string, ToolExecState>;
  directiveNav: Record<string, { status: string; hint?: string }>;
  savedPages: Record<string, { pageName: string; pageUrl: string }>;
  savingPageId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  send: (msg?: string, opts?: { appendUser?: boolean }) => void;
  executeToolInline: (flowItemId: string, idx: number, s: ToolSuggestion) => void;
  openDirective: (it: FlowDirective, mode?: "panel" | "navigate") => void;
  openInWorkspace: (tab: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => void;
  saveAsPage: (flowItemId: string, config: Nl2UiConfig, userInput: string) => void;
  setMaximizedNl2ui: (item: FlowNl2UiResult | null) => void;
  onApprovalDecision?: (approvalId: string, decision: "approve" | "reject") => void;
}

export default function ChatFlowRenderer(props: ChatFlowRendererProps) {
  const {
    locale, flow, busy, nl2uiLoading, toolExecStates, directiveNav,
    savedPages, savingPageId, scrollRef,
    send, executeToolInline, openDirective,
    openInWorkspace, saveAsPage, setMaximizedNl2ui,
    onApprovalDecision,
  } = props;

  /* ── Lightbox state ── */
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  /* ── Timestamp tracking (first-seen time per flow item id) ── */
  const [itemTimestamps, setItemTimestamps] = useState<Record<string, number>>({});
  const registerTimestamp = useCallback((id: string) => {
    setItemTimestamps((prev) => {
      if (prev[id] !== undefined) return prev;
      return { ...prev, [id]: Date.now() };
    });
  }, []);

  /* ── Detect last assistant message for streaming cursor ── */
  const lastAssistantId = useMemo(() => {
    for (let i = flow.length - 1; i >= 0; i--) {
      if (flow[i].kind === "message" && flow[i].role === "assistant") return flow[i].id;
    }
    return null;
  }, [flow]);

  /* ── Virtual scrolling (enabled when flow exceeds threshold) ── */
  const VIRTUALIZATION_THRESHOLD = 100;
  const useVirtualization = flow.length > VIRTUALIZATION_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: flow.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
    enabled: useVirtualization,
  });

  /* ── Shared bubble renderer ── */
  const renderBubble = useCallback((it: ChatFlowItem, index: number) => (
    <MemoizedFlowBubble
      key={it.id}
      it={it}
      locale={locale}
      busy={busy}
      isStreaming={busy && it.id === lastAssistantId}
      ts={itemTimestamps[it.id]}
      toolExecStates={toolExecStates}
      directiveNav={directiveNav}
      savedPages={savedPages}
      savingPageId={savingPageId}
      send={send}
      executeToolInline={executeToolInline}
      openDirective={openDirective}
      openInWorkspace={openInWorkspace}
      saveAsPage={saveAsPage}
      setMaximizedNl2ui={setMaximizedNl2ui}
      onApprovalDecision={onApprovalDecision}
      onImageClick={setLightboxSrc}
      registerTimestamp={registerTimestamp}
    />
  ), [locale, busy, lastAssistantId, itemTimestamps, toolExecStates, directiveNav,
      savedPages, savingPageId, send, executeToolInline, openDirective,
      openInWorkspace, saveAsPage, setMaximizedNl2ui, onApprovalDecision, registerTimestamp]);

  /* ── Tail overlay (loading indicators) ── */
  const tailOverlay = (
    <>
      {/* Lightbox overlay */}
      {lightboxSrc && (
        <div className={styles.lightbox} onClick={() => setLightboxSrc(null)}>
          <button className={styles.lightboxClose} onClick={() => setLightboxSrc(null)}>✕</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightboxSrc} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* Loading skeletons */}
      {busy && nl2uiLoading && (
        <div className={styles.nl2uiSkeleton}>
          <div className={styles.nl2uiSkeletonHeader}>
            <div className={styles.nl2uiSkeletonBar} style={{ width: 60 }} />
            <div className={styles.nl2uiSkeletonBar} style={{ width: 48 }} />
            <div className={styles.nl2uiSkeletonBar} style={{ width: 72 }} />
          </div>
          <div className={styles.nl2uiSkeletonBody}>
            <div className={styles.nl2uiSkeletonRow}><div className={styles.nl2uiSkeletonCell} /><div className={styles.nl2uiSkeletonCell} /><div className={styles.nl2uiSkeletonCell} /></div>
            <div className={styles.nl2uiSkeletonRow}><div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} /><div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} /><div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} /></div>
            <div className={styles.nl2uiSkeletonRow}><div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} /><div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} /><div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} /></div>
          </div>
          <div className={styles.nl2uiSkeletonLabel}>
            <span className={styles.nl2uiSkeletonDot} />
            {t(locale, "nl2ui.generating")}
          </div>
        </div>
      )}
      {busy && !nl2uiLoading && <div className={styles.typing}><span /><span /><span /></div>}
    </>
  );

  /* ── Non-virtualized (original) rendering ── */
  if (!useVirtualization) {
    return (
      <div className={styles.chatFlow} ref={scrollRef}>
        {flow.map((it, i) => renderBubble(it, i))}
        {tailOverlay}
      </div>
    );
  }

  /* ── Virtualized rendering ── */
  return (
    <div className={styles.chatFlowVirtual} ref={scrollRef}>
      <div
        className={styles.virtualListContainer}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const it = flow[virtualItem.index];
          return (
            <div
              key={it.id ?? virtualItem.index}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className={styles.virtualListItem}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              {renderBubble(it, virtualItem.index)}
            </div>
          );
        })}
      </div>
      {tailOverlay}
    </div>
  );
}

/* ─── Memoized single flow bubble (avoids re-rendering unchanged messages during streaming) ─── */
const MemoizedFlowBubble = memo(function FlowBubble({
  it, locale, busy, isStreaming, ts, toolExecStates, directiveNav, savedPages, savingPageId,
  send, executeToolInline, openDirective, openInWorkspace, saveAsPage, setMaximizedNl2ui,
  onApprovalDecision, onImageClick, registerTimestamp,
}: {
  it: ChatFlowItem;
  locale: string;
  busy: boolean;
  isStreaming: boolean;
  ts?: number;
  toolExecStates: Record<string, ToolExecState>;
  directiveNav: Record<string, { status: string; hint?: string }>;
  savedPages: Record<string, { pageName: string; pageUrl: string }>;
  savingPageId: string | null;
  send: (msg?: string, opts?: { appendUser?: boolean }) => void;
  executeToolInline: (flowItemId: string, idx: number, s: ToolSuggestion) => void;
  openDirective: (it: FlowDirective, mode?: "panel" | "navigate") => void;
  openInWorkspace: (tab: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => void;
  saveAsPage: (flowItemId: string, config: Nl2UiConfig, userInput: string) => void;
  setMaximizedNl2ui: (item: FlowNl2UiResult | null) => void;
  onApprovalDecision?: (approvalId: string, decision: "approve" | "reject") => void;
  onImageClick?: (src: string) => void;
  registerTimestamp: (id: string) => void;
}) {
  const isUser = it.kind === "message" && it.role === "user";
  const isAssistantMsg = it.kind === "message" && !isUser;
  const bubbleClasses = [
    styles.bubble,
    isUser ? styles.bubbleUser : styles.bubbleAssistant,
    it.kind === "error" ? styles.bubbleError : "",
    it.kind === "nl2uiResult" ? styles.bubbleNl2ui : "",
    it.kind === "toolSuggestions" ? styles.bubbleToolSuggestion : "",
    it.kind === "approvalNode" ? styles.bubbleApproval : "",
    it.kind === "taskQueueEvent" ? styles.bubbleTaskQueueEvent ?? "" : "",
  ].filter(Boolean).join(" ");

  /* ── Copy & regenerate toolbar state ── */
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (it.kind === "message" && it.role === "assistant") {
      void navigator.clipboard.writeText(it.text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }, [it]);
  const handleRegenerate = useCallback(() => {
    if (it.kind === "message" && it.role === "user") return;
    // Re-send the last user message
    void send(undefined, { appendUser: false });
  }, [send, it]);
  const bubbleRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    registerTimestamp(it.id);
  }, [it.id, registerTimestamp]);

  return (
    <div className={bubbleClasses} ref={bubbleRef}>
      {/* ── Hover toolbar (assistant messages only) ── */}
      {isAssistantMsg && (
        <div className={styles.msgToolbar}>
          <button className={styles.msgToolbarBtn} onClick={handleCopy} title={t(locale, copied ? "chat.action.copied" : "chat.action.copy")}>
            {copied
              ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
          </button>
          <button className={styles.msgToolbarBtn} onClick={handleRegenerate} title={t(locale, "chat.action.regenerate")} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          </button>
        </div>
      )}

      {/* ── Message ── */}
      {it.kind === "message" && (
        <div className={styles.bubbleText}>
          {isUser
            ? it.text
            : <>
                {isStreaming && !it.text ? (
                  <span className={styles.phaseLabel}>
                    {t(locale, `chat.phase.${it.phase || "started"}`) || t(locale, "chat.thinking")}…
                  </span>
                ) : (
                  <><FlowMarkdown text={it.text} locale={locale} onImageClick={onImageClick} />{isStreaming && <span className={styles.streamCursor}>▍</span>}</>
                )}
              </>}
          {it.attachments && it.attachments.length > 0 && (
            <div className={styles.bubbleAttachments}>
              {it.attachments.map((att) => {
                if (att.type === "image" && att.previewUrl) {
                  return (
                    <Image
                      key={att.id}
                      src={att.previewUrl}
                      alt={att.name}
                      className={styles.bubbleAttachImg}
                      width={240}
                      height={180}
                      unoptimized
                      style={{ cursor: "zoom-in" }}
                      onClick={() => onImageClick?.(att.previewUrl!)}
                    />
                  );
                }
                if (att.type === "voice") {
                  return (
                    <span key={att.id} className={styles.bubbleAttachVoice}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                      {att.duration ? `${att.duration}s` : att.name}
                      {att.previewUrl && <audio src={att.previewUrl} controls style={{ height: 28, maxWidth: 160 }} />}
                    </span>
                  );
                }
                if (att.type === "video") {
                  return (
                    <span key={att.id} className={styles.bubbleAttachVoice}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="15" height="14" rx="2" /><polygon points="16 12 21 9 21 15 16 12" /></svg>
                      {att.name}
                      {att.previewUrl && <video src={att.previewUrl} controls style={{ height: 36, maxWidth: 220 }} />}
                    </span>
                  );
                }
                return (
                  <span key={att.id} className={styles.bubbleAttachFile}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    {att.name} ({(att.size / 1024).toFixed(0)}KB)
                  </span>
                );
              })}
            </div>
          )}
          {/* Timestamp */}
          {ts && !isStreaming && <RelativeTime ts={it.createdAt ?? ts} locale={locale} />}
          {/* 模型自动切换通知（轻量化提示） */}
          {it.kind === "message" && it.role === "assistant" && it.modelSwitchNote && !isStreaming && (
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, lineHeight: 1.4 }}>
              {it.modelSwitchNote}
            </div>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {it.kind === "error" && (() => {
        const isNl2uiError = String(it.errorCode ?? "").startsWith("NL2UI_");
        return (
          <div className={styles.bubbleText}>
            {isNl2uiError
              ? <>{it.message || t(locale, "chat.nl2ui.error.default")}</>
              : <>{friendlyErrorMessage(locale, it.errorCode, it.message)}</>}
            {it.traceId ? <span className={styles.traceId}>{t(locale, "chat.requestId")}{it.traceId}</span> : null}
            {it.retryMessage ? (
              <div className={styles.inlineBtnGroup}>
                <button className={styles.inlineBtn} onClick={() => void send(it.retryMessage, { appendUser: false })} disabled={busy}>
                  {t(locale, "runs.action.retry")}
                </button>
              </div>
            ) : null}
          </div>
        );
      })()}

      {/* ── Tool Suggestions ── */}
      {it.kind === "toolSuggestions" && (
        <FlowToolSuggestions
          locale={locale}
          it={it}
          toolExecStates={toolExecStates}
          executeToolInline={executeToolInline}
        />
      )}

      {/* ── UI Directive ── */}
      {it.kind === "uiDirective" && (
        <div className={styles.bubbleText}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(locale, "chat.uiDirective.title")}</div>
          <pre className={styles.preBlock}>{safeJsonString(it.directive)}</pre>
          {it.target && directiveNav[it.id]?.status === "allowed" && (
            <div className={styles.inlineBtnGroup}>
              <button className={styles.inlineBtn} onClick={() => void openDirective(it, "panel")}>
                <IconPanel /> {t(locale, "panel.openInPanel")}
              </button>
              <button className={styles.inlineBtn} onClick={() => void openDirective(it, "navigate")}>
                <IconExternal /> {it.target.kind === "page" ? t(locale, "chat.uiDirective.openPage") : t(locale, "chat.uiDirective.openWorkbench")}
              </button>
            </div>
          )}
          {it.target && directiveNav[it.id]?.status === "blocked" && (
            <span className={styles.hint}>{(directiveNav[it.id] as { hint: string }).hint}</span>
          )}
          {it.target && directiveNav[it.id]?.status === "checking" && (
            <span className={styles.hint}>{t(locale, "chat.uiDirective.checking")}</span>
          )}
        </div>
      )}

      {/* ── NL2UI Result ── */}
      {it.kind === "nl2uiResult" && (
        <FlowNl2uiResult
          locale={locale}
          it={it}
          savedPages={savedPages}
          savingPageId={savingPageId}
          openInWorkspace={openInWorkspace}
          saveAsPage={saveAsPage}
          setMaximizedNl2ui={setMaximizedNl2ui}
        />
      )}

      {/* ── Timestamp for non-message items ── */}
      {it.kind === "error" && ts && <RelativeTime ts={it.createdAt ?? ts} locale={locale} />}

      {/* ── Approval Node (唯一保留的结构化卡片，因有交互按钮) ── */}
      {it.kind === "approvalNode" && (
        <>
          <ApprovalNodeRenderer
            item={it as FlowApprovalNode}
            locale={locale}
            onApprove={onApprovalDecision ? () => onApprovalDecision((it as FlowApprovalNode).approvalId, "approve") : undefined}
            onReject={onApprovalDecision ? () => onApprovalDecision((it as FlowApprovalNode).approvalId, "reject") : undefined}
          />
          {(it as FlowApprovalNode).approvalId && (
            <button className={styles.inlineBtn} style={{ marginTop: 4 }} onClick={() => openInWorkspace({
              kind: "approvalDetail",
              name: `Approval ${(it as FlowApprovalNode).approvalId.slice(0, 8)}`,
              url: `/gov/approvals/${encodeURIComponent((it as FlowApprovalNode).approvalId)}?lang=${encodeURIComponent(locale)}`,
            })}>
              <IconPanel /> {t(locale, "panel.openInPanel")}
            </button>
          )}
        </>
      )}

      {/* ── P1-17: Task Queue Event (多任务队列事件) ── */}
      {it.kind === "taskQueueEvent" && (
        <FlowTaskQueueEventBlock it={it as FlowTaskQueueEvent} locale={locale} />
      )}

      {/* ── Artifact Card (产物卡片：预览 + 下载) ── */}
      {it.kind === "artifactCard" && (
        <FlowArtifactCardBlock it={it as FlowArtifactCard} locale={locale} openInWorkspace={openInWorkspace} />
      )}
    </div>
  );
});

/* ─── Relative Time ─── */
function RelativeTime({ ts, locale }: { ts: number; locale: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const intervalId = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(intervalId);
  }, []);
  const diff = Math.floor((nowMs - ts) / 1000);
  let label: string;
  if (diff < 60) label = t(locale, "chat.time.justNow");
  else if (diff < 3600) label = t(locale, "chat.time.minutesAgo").replace("{n}", String(Math.floor(diff / 60)));
  else if (diff < 86400) label = t(locale, "chat.time.hoursAgo").replace("{n}", String(Math.floor(diff / 3600)));
  else {
    const d = new Date(ts);
    label = t(locale, "chat.time.today").replace("{time}", `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  }
  return <span className={styles.bubbleTimestamp}>{label}</span>;
}
