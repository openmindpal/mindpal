"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import { apiFetch } from "@/lib/api";
import type { IntentMode } from "@/lib/types";
import { type RecentEntry, TERMINAL_RUN_STATUSES, NAV_ITEMS, loadRecent, addRecent } from "./homeHelpers";
import type { FlowMessage } from "./homeHelpers";
import StatusBar from "@/components/shell/StatusBar";
import RecentAndFavorites from "@/components/shell/RecentAndFavorites";
import BottomTray from "@/components/shell/BottomTray";
import TaskProgressBar from "@/components/flow/TaskProgressBar";
import { MultiTaskProgressBar } from "@/components/flow/TaskProgressBar";
import { IconChevronLeft, IconChevronRight, IconSearch, IconMenu, IconPlus } from "./HomeIcons";
import CommandPalette from "./CommandPalette";
import useSplitLayout from "./useSplitLayout";
import useWorkspaceTabs from "./useWorkspaceTabs";
import useVoiceInput from "./useVoiceInput";
import useVoiceTTS from "./useVoiceTTS";
import useAttachments from "./useAttachments";
import useChatSession from "./useChatSession";
import useTaskManager from "./useTaskManager";
import useToolExecution from "./useToolExecution";
import useSendMessage from "./useSendMessage";
import useSessionSSE from "./useSessionSSE";
import useSessionTaskQueue from "./useSessionTaskQueue";
import TaskDock from "./TaskDock";
import useDirectives from "./useDirectives";
import useNl2uiActions from "./useNl2uiActions";
import LeftPanel from "./LeftPanel";
import ChatFlowRenderer from "./ChatFlowRenderer";
import ChatInputArea from "./ChatInputArea";
import ConversationHistory from "./ConversationHistory";
import Nl2uiOverlay from "./Nl2uiOverlay";
import styles from "./page.module.css";

/* ─── (streamTextIntoFlow removed — real streaming via SSE delta events) ─── */

/* ─── Component ────────────────────────────────────────────────────────── */

export default function HomeChat(props: { locale: string }) {
  const locale = props.locale;
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialScrollDoneRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  const [draft, setDraft] = useState("");
  const [execMode, setExecMode] = useState<"auto" | IntentMode>("auto");
  const [busy, setBusy] = useState(false);

  /* ─── Custom hooks ─── */
  const {
    conversationId, setConversationId,
    flow, setFlow,
    toolExecStates, setToolExecStates,
    bindings, selectedModelRef, setSelectedModelRef,
    modelPickerTitle,
    modelPickerOpen, setModelPickerOpen, modelPickerRef,
    abortRef, lastRetryMsgRef, retryCountRef,
    startNew: sessionStartNew,
    loadConversation,
    deleteConversation,
  } = useChatSession({ locale });

  const {
    attachments,
    setAttachments,
    imageInputRef,
    docInputRef,
    audioInputRef,
    videoInputRef,
    removeAttachment,
    handleImageSelect,
    handleDocSelect,
    handleAudioSelect,
    handleVideoSelect,
  } = useAttachments({ locale });
  const sendRef = useRef<(msg: string) => void>(() => {});
  const onAutoSend = useCallback((text: string) => {
    setDraft(text);
    setTimeout(() => sendRef.current(text), 0);
  }, [setDraft]);
  const { voiceListening, voiceInterim, voiceConversation, startVoice, toggleConversation } = useVoiceInput({ locale, setDraft, onAutoSend });
  const { speaking, speak, stopSpeaking, checkTTSReady } = useVoiceTTS();

  const { activeTask, setActiveTask, taskProgress, setTaskProgress, pollTaskState, taskAction, activeTaskIds: taskManagerActiveIds } = useTaskManager({ locale, setFlow, abortRef });
  const { executeToolInline } = useToolExecution({ locale, setToolExecStates });

  const [recent, setRecent] = useState<RecentEntry[]>([]);
  useEffect(() => { setRecent(loadRecent()); }, []);

  const { savingPageId, savedPages, maximizedNl2ui, setMaximizedNl2ui, nl2uiLoading, setNl2uiLoading, saveAsPage } = useNl2uiActions({ locale, setRecent });

  /* ─── P1-16: Session SSE + Task Queue ─── */
  const [tenantId, setTenantId] = useState("");
  const taskQueue = useSessionTaskQueue({ sessionId: conversationId, locale, enabled: true });

  const ttsCheckedRef = useRef(false);
  useEffect(() => {
    if (!ttsCheckedRef.current) {
      ttsCheckedRef.current = true;
      void checkTTSReady();
    }
  }, [checkTTSReady]);

  const prevBusyRef = useRef(false);
  const voiceConvRef = useRef(false);
  useEffect(() => {
    voiceConvRef.current = voiceConversation;
  }, [voiceConversation]);
  useEffect(() => {
    if (prevBusyRef.current && !busy && voiceConvRef.current) {
      const lastAssistant = [...flow].reverse().find(
        (it): it is { kind: "message" } & FlowMessage =>
          it.kind === "message" && it.role === "assistant" && Boolean((it as FlowMessage).text)
      );
      if (lastAssistant?.text) {
        void speak(lastAssistant.text).then(() => {
          if (voiceConvRef.current) {
            startVoice();
          }
        });
      } else if (voiceConvRef.current) {
        startVoice();
      }
    }
    prevBusyRef.current = busy;
  }, [busy, flow, speak, startVoice]);

  const { send } = useSendMessage({
    locale, draft, setDraft, attachments, setAttachments,
    conversationId, setConversationId, execMode, selectedModelRef,
    setBusy, setFlow, setNl2uiLoading,
    setActiveTask, setTaskProgress, pollTaskState,
    inputRef, abortRef, retryCountRef, lastRetryMsgRef,
    // P1-16: 多任务上下文
    activeTaskIds: taskQueue.activeTaskIds.length > 0 ? taskQueue.activeTaskIds : taskManagerActiveIds,
  });

  const { layoutRestored, leftWidth, leftCollapsed, rightCollapsed, isDragging, splitRef, setLeftCollapsed, handleDragStart, toggleLeft, toggleRight } = useSplitLayout();
  const { pinnedTabs, previewTab, activeTabId, setActiveTabId, visibleTab, draggedTabId, dragOverTabId, openInWorkspace, getTabIcon, pinCurrentPreview, unpinTab, closePreview, handleTabDragStart, handleTabDragOver, handleTabDragLeave, handleTabDrop, handleTabDragEnd, handlePreviewDoubleClick } = useWorkspaceTabs({ leftCollapsed, setLeftCollapsed });
  const { directiveNav, openDirective } = useDirectives({ locale, flow, openInWorkspace });

  const [cmdOpen, setCmdOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  /* ── Hydration guard: defer client-only state to avoid SSR mismatch ── */
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
      } catch {
        if (!cancelled) setTenantId("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasMounted, locale]);
  const hasMessages = hasMounted && flow.length > 0;

  /* P1-16: Session SSE (需要 hasMounted) */
  useSessionSSE({
    sessionId: conversationId,
    tenantId,
    locale,
    enabled: !!conversationId && hasMounted && !!tenantId,
    onEvent: taskQueue.handleSSEEvent,
    onSnapshot: taskQueue.applySnapshot,
  });

  const canSend = useMemo(() => Boolean(draft.trim()) || attachments.length > 0, [draft, attachments]);
  const q = useCallback((p: string) => `${p}?lang=${encodeURIComponent(locale)}`, [locale]);

  /* ─── startNew (extends session startNew with task reset) ─── */
  const startNew = useCallback(() => {
    sessionStartNew();
    setActiveTask(null);
    setTaskProgress(null);
    setHistoryOpen(false);
  }, [sessionStartNew, setActiveTask, setTaskProgress]);

  /* ─── Keyboard shortcuts ─── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setCmdOpen((p) => !p); }
      if (e.key === "Escape") {
        if (maximizedNl2ui) { setMaximizedNl2ui(null); return; }
        if (cmdOpen) setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cmdOpen, maximizedNl2ui, setMaximizedNl2ui]);

  useEffect(() => {
    if (!scrollRef.current) return;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!scrollRef.current) return;
      if (!initialScrollDoneRef.current) {
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
        initialScrollDoneRef.current = true;
      } else {
        const el = scrollRef.current;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 150) {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }
      }
    });
  }, [flow, hasMounted]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  /* ─── Key handler ─── */
  useEffect(() => { sendRef.current = (msg: string) => void send(msg); }, [send]);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }, [send]);

  /* ─── Close panel ─── */
  const closePanel = useCallback(() => {
    if (activeTabId === "__preview__") closePreview();
    else if (activeTabId) unpinTab(activeTabId);
  }, [activeTabId, closePreview, unpinTab]);

  /* ─── Open recent in panel ─── */
  const openRecentInPanel = useCallback((entry: RecentEntry) => {
    const url = entry.kind === "page"
      ? `/p/${encodeURIComponent(entry.name)}?lang=${encodeURIComponent(locale)}`
      : `/w/${encodeURIComponent(entry.name)}?lang=${encodeURIComponent(locale)}`;
    openInWorkspace({ kind: entry.kind, name: entry.name, url });
    setRecent(addRecent({ kind: entry.kind, name: entry.name }));
  }, [locale, openInWorkspace]);

  /* ─── CommandPalette select ─── */
  const handleCmdSelect = useCallback((href: string) => {
    setCmdOpen(false);
    router.push(q(href));
  }, [router, q]);

  /* ─── NL2UI card click ─── */
  const handleCardClick = useCallback((card: { title: string; id?: string; [key: string]: any }) => {
    if (!card.title) return;
    if (card.id) {
      const entityUrl = `/entities/${encodeURIComponent(card.entity ?? "unknown")}/${encodeURIComponent(card.id)}?lang=${encodeURIComponent(locale)}`;
      openInWorkspace({ kind: "page", name: card.title, url: entityUrl });
      setRecent(addRecent({ kind: "page", name: card.title }));
    } else {
      void send(card.title);
    }
  }, [locale, send, openInWorkspace]);

  /* ─── Approval decision handler ── */
  const onApprovalDecision = useCallback(async (approvalId: string, decision: "approve" | "reject") => {
    try {
      await apiFetch(`/approvals/${encodeURIComponent(approvalId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ decision, reason: decision === "approve" ? "Approved from chat" : "Rejected from chat" }),
      });
      setFlow((prev) => prev.map((it) => {
        if (it.kind !== "approvalNode") return it;
        const node = it as import("./homeHelpers").FlowApprovalNode;
        if (node.approvalId !== approvalId) return it;
        return { ...node, status: decision === "approve" ? "approved" : "rejected", decidedAt: new Date().toISOString() } as typeof node;
      }));
    } catch (err: any) {
      console.error("[approval] decision failed", err);
    }
  }, [locale, setFlow]);

  /* ──────────────────── RENDER ──────────────────────────────────────────── */

  return (
    <div className={`${styles.page} ${hasMessages ? styles.chatMode : ""}`}>
      {/* ── Top bar ── */}
      <header className={styles.topBar}>
        <Link href={`/?lang=${encodeURIComponent(locale)}`} className={styles.brand}>{t(locale, "app.title")}</Link>
        <div className={styles.topRight}>
          <StatusBar locale={locale} />
          <button className={styles.newChatBtn} onClick={() => setCmdOpen(true)} title={t(locale, "cmdPalette.hint")}>
            <IconSearch /><kbd className={styles.cmdKbd}>Ctrl K</kbd>
          </button>
          {hasMessages && (
            <div className={styles.historyBtnWrap}>
              <button
                className={`${styles.historyBtn} ${historyOpen ? styles.historyBtnActive : ""}`}
                onClick={() => setHistoryOpen((p) => !p)}
                title={t(locale, "chat.history.title")}
              >
                <IconMenu />{t(locale, "chat.history.title")}
              </button>
              <ConversationHistory
                locale={locale}
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                currentConversationId={conversationId}
                onLoad={async (sid) => {
                  const ok = await loadConversation(sid);
                  if (ok) {
                    setActiveTask(null);
                    setTaskProgress(null);
                    initialScrollDoneRef.current = false;
                  }
                  return ok;
                }}
                onDelete={deleteConversation}
              />
            </div>
          )}
          {hasMessages && (
            <button className={styles.newChatBtn} onClick={startNew}><IconPlus />{t(locale, "chat.session.new")}</button>
          )}
          <span className={styles.topSep} />
          <div className={styles.langSwitch}>
            <Link href={`/?lang=zh-CN`} className={locale === "zh-CN" ? styles.langActive : undefined}>{t(locale, "lang.zh")}</Link>
            <Link href={`/?lang=en-US`} className={locale === "en-US" ? styles.langActive : undefined}>{t(locale, "lang.en")}</Link>
          </div>
        </div>
      </header>

      {/* ── Split container ── */}
      <div className={styles.splitContainer} ref={splitRef} style={{ visibility: layoutRestored ? "visible" : "hidden" }}>
        {/* ── Left Content Panel ── */}
        <LeftPanel
          locale={locale}
          leftCollapsed={leftCollapsed}
          rightCollapsed={rightCollapsed}
          leftWidth={leftWidth}
          toggleLeft={toggleLeft}
          pinnedTabs={pinnedTabs}
          previewTab={previewTab}
          activeTabId={activeTabId}
          setActiveTabId={setActiveTabId}
          visibleTab={visibleTab}
          draggedTabId={draggedTabId}
          dragOverTabId={dragOverTabId}
          getTabIcon={getTabIcon}
          handleTabDragStart={handleTabDragStart}
          handleTabDragOver={handleTabDragOver}
          handleTabDragLeave={handleTabDragLeave}
          handleTabDrop={handleTabDrop}
          handleTabDragEnd={handleTabDragEnd}
          handlePreviewDoubleClick={handlePreviewDoubleClick}
          pinCurrentPreview={pinCurrentPreview}
          unpinTab={unpinTab}
          closePreview={closePreview}
          closePanel={closePanel}
          recent={recent}
          openRecentInPanel={openRecentInPanel}
        />

        {/* ── Resize Divider ── */}
        {!leftCollapsed && !rightCollapsed && (
          <div
            className={`${styles.resizeDivider} ${isDragging ? styles.resizeDividerActive : ""}`}
            onMouseDown={handleDragStart}
          />
        )}

        {/* Expand buttons */}
        {leftCollapsed && (
          <button
            className={styles.collapseBtn}
            style={{ position: "relative", top: "auto", transform: "none", alignSelf: "center", borderRadius: "0 6px 6px 0", flexShrink: 0 }}
            onClick={toggleLeft}
            title={t(locale, "panel.expandLeft")}
          >
            <IconChevronRight />
          </button>
        )}
        {rightCollapsed && (
          <button
            className={styles.collapseBtn}
            style={{ position: "relative", top: "auto", transform: "none", alignSelf: "center", borderRadius: "6px 0 0 6px", flexShrink: 0 }}
            onClick={toggleRight}
            title={t(locale, "panel.expandRight")}
          >
            <IconChevronLeft />
          </button>
        )}

        {/* ── Right Chat Side ── */}
        <div className={`${styles.chatSide} ${rightCollapsed ? styles.chatCollapsed : ""}`}>
          {!rightCollapsed && (
            <button
              className={`${styles.collapseBtn} ${styles.collapseBtnRight}`}
              onClick={toggleRight}
              title={t(locale, "panel.collapseRight")}
            >
              <IconChevronRight />
            </button>
          )}
          <main className={styles.main}>
            {/* Welcome */}
            {!hasMessages && (
              <div className={styles.hero}>
                <h1 className={styles.greeting}>{t(locale, "home.welcome")}</h1>
                <p className={styles.subtitle}>{t(locale, "home.subtitle")}</p>
                <p className={styles.hint} style={{ marginTop: 8 }}>{t(locale, "nl2ui.description")}</p>
              </div>
            )}

            {/* P1-16: Task queue dock */}
            {taskQueue.allEntries.length > 0 && (
              <div style={{ padding: "0 16px", marginBottom: 8 }}>
                <TaskDock
                  locale={locale}
                  entries={taskQueue.allEntries}
                  dependencies={taskQueue.queueState.dependencies}
                  foregroundEntryId={taskQueue.queueState.foregroundEntryId}
                  activeCount={taskQueue.queueState.activeCount}
                  queuedCount={taskQueue.queueState.queuedCount}
                  actions={taskQueue.actions}
                  operating={taskQueue.operating}
                />
              </div>
            )}

            {/* Task progress bar (P1-18: multi-task aware) */}
            {taskQueue.allEntries.length > 0 && (
              <div className={styles.taskProgressContainer}>
                <MultiTaskProgressBar
                  locale={locale}
                  entries={taskQueue.allEntries}
                  foregroundEntryId={taskQueue.queueState.foregroundEntryId}
                  onStop={(entryId) => void taskQueue.actions.cancel(entryId)}
                  onRetry={(entryId) => void taskQueue.actions.retry(entryId)}
                />
              </div>
            )}
            {/* Fallback: single-task progress bar (when queue not active) */}
            {taskQueue.allEntries.length === 0 && taskProgress && (
              <div className={styles.taskProgressContainer}>
                <TaskProgressBar
                  progress={taskProgress}
                  locale={locale}
                  onStop={activeTask && !TERMINAL_RUN_STATUSES.has(activeTask.taskState.phase) ? () => void taskAction("stop") : undefined}
                  onContinue={
                    activeTask && !TERMINAL_RUN_STATUSES.has(activeTask.taskState.phase) &&
                    (
                      activeTask.taskState.phase === "waiting" ||
                      (
                        activeTask.taskState.phase === "paused" &&
                        activeTask.taskState.nextAction !== "waiting_for_user_reply" &&
                        activeTask.taskState.nextAction !== "waiting_for_admin_review"
                      )
                    )
                      ? () => void taskAction("continue")
                      : undefined
                  }
                  onRetry={activeTask?.taskState.phase === "failed" ? () => void taskAction("retry") : undefined}
                />
              </div>
            )}

            {/* Chat flow */}
            {hasMessages && (
              <ChatFlowRenderer
                locale={locale}
                flow={flow}
                busy={busy}
                nl2uiLoading={nl2uiLoading}
                toolExecStates={toolExecStates}
                directiveNav={directiveNav}
                savedPages={savedPages}
                savingPageId={savingPageId}
                scrollRef={scrollRef}
                send={send}
                executeToolInline={executeToolInline}
                openDirective={openDirective}
                openInWorkspace={openInWorkspace}
                saveAsPage={saveAsPage}
                setMaximizedNl2ui={setMaximizedNl2ui}
                onApprovalDecision={onApprovalDecision}
              />
            )}

            {/* Input box */}
            <ChatInputArea
              locale={locale}
              hasMessages={hasMessages}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              canSend={canSend}
              execMode={execMode}
              setExecMode={setExecMode}
              inputRef={inputRef}
              onKeyDown={onKeyDown}
              send={() => void send()}
              abortRef={abortRef}
              attachments={attachments}
              removeAttachment={removeAttachment}
              imageInputRef={imageInputRef}
              docInputRef={docInputRef}
              audioInputRef={audioInputRef}
              videoInputRef={videoInputRef}
              handleImageSelect={handleImageSelect}
              handleDocSelect={handleDocSelect}
              handleAudioSelect={handleAudioSelect}
              handleVideoSelect={handleVideoSelect}
              voiceListening={voiceListening}
              voiceInterim={voiceInterim}
              voiceConversation={voiceConversation}
              speaking={speaking}
              startVoice={startVoice}
              toggleConversation={toggleConversation}
              stopSpeaking={stopSpeaking}
              bindings={bindings}
              selectedModelRef={selectedModelRef}
              setSelectedModelRef={setSelectedModelRef}
              modelPickerOpen={modelPickerOpen}
              setModelPickerOpen={setModelPickerOpen}
              modelPickerTitle={modelPickerTitle}
              modelPickerRef={modelPickerRef}
              /* P1-19: Multi-task queue context */
              activeQueueCount={taskQueue.queueState.activeCount}
              queuedCount={taskQueue.queueState.queuedCount}
              showStop={taskQueue.allEntries.length > 0 ? false : undefined}
            />

            {/* Quick nav + Recent (only when empty) */}
            {!hasMessages && (
              <>
                <nav className={styles.quickNav}>
                  {NAV_ITEMS.map((n) => (
                    <Link key={n.key} className={styles.navPill} href={q(n.href)}>
                      {t(locale, `home.quickNav.${n.key}`)}
                    </Link>
                  ))}
                </nav>
                <div className={styles.recentFavSection}>
                  <RecentAndFavorites locale={locale} onOpen={(kind, name, url) => openInWorkspace({ kind: kind as "page" | "workbench", name, url })} />
                </div>
              </>
            )}
          </main>
        </div>
      </div>

      {/* ── NL2UI Maximized Overlay ── */}
      {maximizedNl2ui && (
        <Nl2uiOverlay
          locale={locale}
          maximizedNl2ui={maximizedNl2ui}
          savedPages={savedPages}
          savingPageId={savingPageId}
          saveAsPage={saveAsPage}
          setMaximizedNl2ui={setMaximizedNl2ui}
          handleCardClick={handleCardClick}
        />
      )}

      {/* ── Command Palette ── */}
      <CommandPalette
        locale={locale}
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onSelect={handleCmdSelect}
        recent={recent}
      />

      {/* ── Bottom Tray ── */}
      <BottomTray locale={locale} />
    </div>
  );
}
