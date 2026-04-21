"use client";

/**
 * HomeChatShell — 布局与主流程编排容器
 *
 * 组合各子模块 Hook 和组件，处理顶层状态分发。
 * 这是从 HomeChat 拆分后的新主入口组件。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import { apiFetch } from "@/lib/api";
import { type RecentEntry, TERMINAL_RUN_STATUSES, NAV_ITEMS, addRecent } from "./homeHelpers";
import StatusBar from "@/components/shell/StatusBar";
import RecentAndFavorites from "@/components/shell/RecentAndFavorites";
import BottomTray from "@/components/shell/BottomTray";
import TaskProgressBar from "@/components/flow/TaskProgressBar";
import { MultiTaskProgressBar } from "@/components/flow/TaskProgressBar";
import { IconChevronLeft, IconChevronRight, IconSearch, IconMenu, IconPlus } from "./HomeIcons";
import CommandPalette from "./CommandPalette";
import useSplitLayout from "./useSplitLayout";
import useWorkspaceTabs from "./useWorkspaceTabs";
import useDirectives from "./useDirectives";
import useSessionSSE from "./useSessionSSE";
import useSessionTaskQueue from "./useSessionTaskQueue";
import useTaskManager from "./useTaskManager";
import { useConversation } from "./hooks/useConversation";
import { useExecutionFlow } from "./hooks/useExecutionFlow";
import TaskDock from "./TaskDock";
import LeftPanel from "./LeftPanel";
import ChatFlowRenderer from "./ChatFlowRenderer";
import ChatInputArea from "./ChatInputArea";
import ConversationHistory from "./ConversationHistory";
import Nl2uiOverlay from "./Nl2uiOverlay";
import styles from "./page.module.css";

export default function HomeChatShell(props: { locale: string }) {
  const locale = props.locale;
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  /* ─── Conversation hook ─── */
  const conv = useConversation({ locale });

  /* ─── Task queue ─── */
  const taskQueue = useSessionTaskQueue({ sessionId: conv.conversationId, locale, enabled: true });
  const { activeTask, setActiveTask, taskProgress, setTaskProgress, pollTaskState, taskAction, activeTaskIds: taskManagerActiveIds } = useTaskManager({ locale, setFlow: conv.setFlow, abortRef: conv.abortRef });

  /* ─── Execution flow ─── */
  const exec = useExecutionFlow({
    locale,
    conversationId: conv.conversationId,
    setConversationId: conv.setConversationId,
    flow: conv.flow,
    setFlow: conv.setFlow,
    selectedModelRef: conv.selectedModelRef,
    abortRef: conv.abortRef,
    retryCountRef: conv.retryCountRef,
    lastRetryMsgRef: conv.lastRetryMsgRef,
    setToolExecStates: conv.setToolExecStates,
    setNl2uiLoading: conv.setNl2uiLoading,
    setActiveTask,
    setTaskProgress,
    pollTaskState,
    activeTaskIds: taskQueue.activeTaskIds.length > 0 ? taskQueue.activeTaskIds : taskManagerActiveIds,
  });

  /* ─── SSE ─── */
  const [tenantId, setTenantId] = useState("");
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => setHasMounted(true));
    return () => window.cancelAnimationFrame(frameId);
  }, []);
  useEffect(() => {
    if (!hasMounted) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/me", { locale });
        if (!res.ok) return;
        const json = await res.json();
        const nextTenantId = typeof json?.subject?.tenantId === "string" ? json.subject.tenantId.trim() : "";
        if (!cancelled) setTenantId(nextTenantId);
      } catch { if (!cancelled) setTenantId(""); }
    })();
    return () => { cancelled = true; };
  }, [hasMounted, locale]);

  useSessionSSE({
    sessionId: conv.conversationId,
    tenantId,
    locale,
    enabled: !!conv.conversationId && hasMounted && !!tenantId,
    onEvent: taskQueue.handleSSEEvent,
    onSnapshot: taskQueue.applySnapshot,
  });

  /* ─── Layout hooks ─── */
  const { layoutRestored, leftWidth, leftCollapsed, rightCollapsed, isDragging, splitRef, setLeftCollapsed, handleDragStart, toggleLeft, toggleRight } = useSplitLayout();
  const { pinnedTabs, previewTab, activeTabId, setActiveTabId, visibleTab, draggedTabId, dragOverTabId, openInWorkspace, getTabIcon, pinCurrentPreview, unpinTab, closePreview, handleTabDragStart, handleTabDragOver, handleTabDragLeave, handleTabDrop, handleTabDragEnd, handlePreviewDoubleClick } = useWorkspaceTabs({ leftCollapsed, setLeftCollapsed });
  const { directiveNav, openDirective } = useDirectives({ locale, flow: conv.flow, openInWorkspace });

  const [cmdOpen, setCmdOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasMessages = hasMounted && conv.flow.length > 0;

  const canSend = useMemo(() => Boolean(exec.draft.trim()) || exec.attachments.length > 0, [exec.draft, exec.attachments]);
  const q = useCallback((p: string) => `${p}?lang=${encodeURIComponent(locale)}`, [locale]);

  /* ─── startNew ─── */
  const startNew = useCallback(() => {
    conv.startNew();
    setActiveTask(null);
    setTaskProgress(null);
    setHistoryOpen(false);
  }, [conv.startNew, setActiveTask, setTaskProgress]);

  /* ─── Keyboard shortcuts ─── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setCmdOpen((p) => !p); }
      if (e.key === "Escape") {
        if (conv.maximizedNl2ui) { conv.setMaximizedNl2ui(null); return; }
        if (cmdOpen) setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cmdOpen, conv.maximizedNl2ui, conv.setMaximizedNl2ui]);

  /* ─── Scroll management ─── */
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
  }, [conv.flow, hasMounted]);

  useEffect(() => { return () => { if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current); }; }, []);

  /* ─── Callbacks ─── */
  const closePanel = useCallback(() => {
    if (activeTabId === "__preview__") closePreview();
    else if (activeTabId) unpinTab(activeTabId);
  }, [activeTabId, closePreview, unpinTab]);

  const openRecentInPanel = useCallback((entry: RecentEntry) => {
    const url = entry.kind === "page"
      ? `/p/${encodeURIComponent(entry.name)}?lang=${encodeURIComponent(locale)}`
      : `/w/${encodeURIComponent(entry.name)}?lang=${encodeURIComponent(locale)}`;
    openInWorkspace({ kind: entry.kind, name: entry.name, url });
    conv.setRecent(addRecent({ kind: entry.kind, name: entry.name }));
  }, [locale, openInWorkspace, conv]);

  const handleCmdSelect = useCallback((href: string) => { setCmdOpen(false); router.push(q(href)); }, [router, q]);

  const handleCardClick = useCallback((card: { title: string; id?: string; [key: string]: any }) => {
    if (!card.title) return;
    if (card.id) {
      const entityUrl = `/entities/${encodeURIComponent(card.entity ?? "unknown")}/${encodeURIComponent(card.id)}?lang=${encodeURIComponent(locale)}`;
      openInWorkspace({ kind: "page", name: card.title, url: entityUrl });
      conv.setRecent(addRecent({ kind: "page", name: card.title }));
    } else { void exec.send(card.title); }
  }, [locale, exec.send, openInWorkspace, conv]);

  const onApprovalDecision = useCallback(async (approvalId: string, decision: "approve" | "reject") => {
    try {
      await apiFetch(`/approvals/${encodeURIComponent(approvalId)}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" }, locale,
        body: JSON.stringify({ decision, reason: decision === "approve" ? "Approved from chat" : "Rejected from chat" }),
      });
      conv.setFlow((prev) => prev.map((it) => {
        if (it.kind !== "approvalNode") return it;
        const node = it as any;
        if (node.approvalId !== approvalId) return it;
        return { ...node, status: decision === "approve" ? "approved" : "rejected", decidedAt: new Date().toISOString() };
      }));
    } catch (err: any) { console.error("[approval] decision failed", err); }
  }, [locale, conv.setFlow]);

  /* ──────────────────── RENDER ──────────────────────────────────────────── */
  return (
    <div className={`${styles.page} ${hasMessages ? styles.chatMode : ""}`}>
      <header className={styles.topBar}>
        <Link href={`/?lang=${encodeURIComponent(locale)}`} className={styles.brand}>{t(locale, "app.title")}</Link>
        <div className={styles.topRight}>
          <StatusBar locale={locale} />
          <button className={styles.newChatBtn} onClick={() => setCmdOpen(true)} title={t(locale, "cmdPalette.hint")}>
            <IconSearch /><kbd className={styles.cmdKbd}>Ctrl K</kbd>
          </button>
          {hasMessages && (
            <div className={styles.historyBtnWrap}>
              <button className={`${styles.historyBtn} ${historyOpen ? styles.historyBtnActive : ""}`} onClick={() => setHistoryOpen((p) => !p)} title={t(locale, "chat.history.title")}>
                <IconMenu />{t(locale, "chat.history.title")}
              </button>
              <ConversationHistory locale={locale} open={historyOpen} onClose={() => setHistoryOpen(false)} currentConversationId={conv.conversationId}
                onLoad={async (sid) => { const ok = await conv.loadConversation(sid); if (ok) { setActiveTask(null); setTaskProgress(null); initialScrollDoneRef.current = false; } return ok; }}
                onDelete={conv.deleteConversation} />
            </div>
          )}
          {hasMessages && (<button className={styles.newChatBtn} onClick={startNew}><IconPlus />{t(locale, "chat.session.new")}</button>)}
          <span className={styles.topSep} />
          <div className={styles.langSwitch}>
            <Link href={`/?lang=zh-CN`} className={locale === "zh-CN" ? styles.langActive : undefined}>{t(locale, "lang.zh")}</Link>
            <Link href={`/?lang=en-US`} className={locale === "en-US" ? styles.langActive : undefined}>{t(locale, "lang.en")}</Link>
          </div>
        </div>
      </header>

      <div className={styles.splitContainer} ref={splitRef} style={{ visibility: layoutRestored ? "visible" : "hidden" }}>
        <LeftPanel locale={locale} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} leftWidth={leftWidth} toggleLeft={toggleLeft}
          pinnedTabs={pinnedTabs} previewTab={previewTab} activeTabId={activeTabId} setActiveTabId={setActiveTabId} visibleTab={visibleTab}
          draggedTabId={draggedTabId} dragOverTabId={dragOverTabId} getTabIcon={getTabIcon}
          handleTabDragStart={handleTabDragStart} handleTabDragOver={handleTabDragOver} handleTabDragLeave={handleTabDragLeave}
          handleTabDrop={handleTabDrop} handleTabDragEnd={handleTabDragEnd} handlePreviewDoubleClick={handlePreviewDoubleClick}
          pinCurrentPreview={pinCurrentPreview} unpinTab={unpinTab} closePreview={closePreview} closePanel={closePanel}
          recent={conv.recent} openRecentInPanel={openRecentInPanel} />

        {!leftCollapsed && !rightCollapsed && (
          <div className={`${styles.resizeDivider} ${isDragging ? styles.resizeDividerActive : ""}`} onMouseDown={handleDragStart} />
        )}
        {leftCollapsed && (<button className={styles.collapseBtn} style={{ position: "relative", top: "auto", transform: "none", alignSelf: "center", borderRadius: "0 6px 6px 0", flexShrink: 0 }} onClick={toggleLeft} title={t(locale, "panel.expandLeft")}><IconChevronRight /></button>)}
        {rightCollapsed && (<button className={styles.collapseBtn} style={{ position: "relative", top: "auto", transform: "none", alignSelf: "center", borderRadius: "6px 0 0 6px", flexShrink: 0 }} onClick={toggleRight} title={t(locale, "panel.expandRight")}><IconChevronLeft /></button>)}

        <div className={`${styles.chatSide} ${rightCollapsed ? styles.chatCollapsed : ""}`}>
          {!rightCollapsed && (<button className={`${styles.collapseBtn} ${styles.collapseBtnRight}`} onClick={toggleRight} title={t(locale, "panel.collapseRight")}><IconChevronRight /></button>)}
          <main className={styles.main}>
            {!hasMessages && (<div className={styles.hero}><h1 className={styles.greeting}>{t(locale, "home.welcome")}</h1><p className={styles.subtitle}>{t(locale, "home.subtitle")}</p><p className={styles.hint} style={{ marginTop: 8 }}>{t(locale, "nl2ui.description")}</p></div>)}

            {taskQueue.allEntries.length > 0 && (
              <div style={{ padding: "0 16px", marginBottom: 8 }}>
                <TaskDock locale={locale} entries={taskQueue.allEntries} dependencies={taskQueue.queueState.dependencies}
                  foregroundEntryId={taskQueue.queueState.foregroundEntryId} activeCount={taskQueue.queueState.activeCount}
                  queuedCount={taskQueue.queueState.queuedCount} actions={taskQueue.actions} operating={taskQueue.operating} />
              </div>
            )}

            {taskQueue.allEntries.length > 0 && (
              <div className={styles.taskProgressContainer}>
                <MultiTaskProgressBar locale={locale} entries={taskQueue.allEntries} foregroundEntryId={taskQueue.queueState.foregroundEntryId}
                  onStop={(entryId) => void taskQueue.actions.cancel(entryId)} onRetry={(entryId) => void taskQueue.actions.retry(entryId)} />
              </div>
            )}
            {taskQueue.allEntries.length === 0 && taskProgress && (
              <div className={styles.taskProgressContainer}>
                <TaskProgressBar progress={taskProgress} locale={locale}
                  onStop={activeTask && !TERMINAL_RUN_STATUSES.has(activeTask.taskState.phase) ? () => void taskAction("stop") : undefined}
                  onContinue={activeTask && !TERMINAL_RUN_STATUSES.has(activeTask.taskState.phase) && (activeTask.taskState.phase === "waiting" || (activeTask.taskState.phase === "paused" && activeTask.taskState.nextAction !== "waiting_for_user_reply" && activeTask.taskState.nextAction !== "waiting_for_admin_review")) ? () => void taskAction("continue") : undefined}
                  onRetry={activeTask?.taskState.phase === "failed" ? () => void taskAction("retry") : undefined} />
              </div>
            )}

            {hasMessages && (
              <ChatFlowRenderer locale={locale} flow={conv.flow} busy={exec.busy} nl2uiLoading={conv.nl2uiLoading}
                toolExecStates={conv.toolExecStates} directiveNav={directiveNav} savedPages={conv.savedPages} savingPageId={conv.savingPageId}
                scrollRef={scrollRef} send={exec.send} executeToolInline={exec.executeToolInline} openDirective={openDirective}
                openInWorkspace={openInWorkspace} saveAsPage={conv.saveAsPage} setMaximizedNl2ui={conv.setMaximizedNl2ui} onApprovalDecision={onApprovalDecision} />
            )}

            <ChatInputArea locale={locale} hasMessages={hasMessages} draft={exec.draft} setDraft={exec.setDraft} busy={exec.busy} canSend={canSend}
              execMode={exec.execMode} setExecMode={exec.setExecMode} inputRef={exec.inputRef} onKeyDown={exec.onKeyDown} send={() => void exec.send()}
              abortRef={conv.abortRef} attachments={exec.attachments} removeAttachment={exec.removeAttachment}
              imageInputRef={exec.imageInputRef} docInputRef={exec.docInputRef} audioInputRef={exec.audioInputRef} videoInputRef={exec.videoInputRef}
              handleImageSelect={exec.handleImageSelect} handleDocSelect={exec.handleDocSelect} handleAudioSelect={exec.handleAudioSelect} handleVideoSelect={exec.handleVideoSelect}
              voiceListening={exec.voiceListening} voiceInterim={exec.voiceInterim} voiceConversation={exec.voiceConversation} speaking={exec.speaking}
              startVoice={exec.startVoice} toggleConversation={exec.toggleConversation} stopSpeaking={exec.stopSpeaking}
              bindings={conv.bindings} selectedModelRef={conv.selectedModelRef} setSelectedModelRef={conv.setSelectedModelRef}
              modelPickerOpen={conv.modelPickerOpen} setModelPickerOpen={conv.setModelPickerOpen} modelPickerTitle={conv.modelPickerTitle} modelPickerRef={conv.modelPickerRef}
              activeQueueCount={taskQueue.queueState.activeCount} queuedCount={taskQueue.queueState.queuedCount}
              showStop={taskQueue.allEntries.length > 0 ? false : undefined} />

            {!hasMessages && (
              <>
                <nav className={styles.quickNav}>{NAV_ITEMS.map((n) => (<Link key={n.key} className={styles.navPill} href={q(n.href)}>{t(locale, `home.quickNav.${n.key}`)}</Link>))}</nav>
                <div className={styles.recentFavSection}><RecentAndFavorites locale={locale} onOpen={(kind, name, url) => openInWorkspace({ kind: kind as "page" | "workbench", name, url })} /></div>
              </>
            )}
          </main>
        </div>
      </div>

      {conv.maximizedNl2ui && (
        <Nl2uiOverlay locale={locale} maximizedNl2ui={conv.maximizedNl2ui} savedPages={conv.savedPages} savingPageId={conv.savingPageId}
          saveAsPage={conv.saveAsPage} setMaximizedNl2ui={conv.setMaximizedNl2ui} handleCardClick={handleCardClick} />
      )}

      <CommandPalette locale={locale} open={cmdOpen} onClose={() => setCmdOpen(false)} onSelect={handleCmdSelect} recent={conv.recent} />
      <BottomTray locale={locale} />
    </div>
  );
}
