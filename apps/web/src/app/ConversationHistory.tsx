"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import styles from "./page.module.css";
import type { FrontendTaskQueueEntry } from "./homeHelpers";

type SessionItem = {
  sessionId: string;
  messageCount: number;
  retainedMessageCount?: number;
  isTrimmed?: boolean;
  preview: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

/** P3-12: 任务队列历史概要 */
type TaskHistorySummary = {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  entries: FrontendTaskQueueEntry[];
};

const STATUS_LABELS: Record<string, string> = {
  completed: "✅",
  failed: "❌",
  cancelled: "⛔",
  executing: "▶️",
  queued: "⏳",
  ready: "🟢",
  paused: "⏸️",
  preempted: "⚠️",
};

interface ConversationHistoryProps {
  locale: string;
  open: boolean;
  onClose: () => void;
  currentConversationId: string;
  onLoad: (sessionId: string) => Promise<boolean>;
  onDelete: (sessionId: string) => Promise<boolean>;
}

export default function ConversationHistory({
  locale,
  open,
  onClose,
  currentConversationId,
  onLoad,
  onDelete,
}: ConversationHistoryProps) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTaskHistory, setExpandedTaskHistory] = useState<string | null>(null);
  const [taskHistories, setTaskHistories] = useState<Map<string, TaskHistorySummary>>(new Map());
  const dropdownRef = useRef<HTMLDivElement>(null);

  /* ─── Fetch sessions ─── */
  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/memory/session-contexts?limit=50", { method: "GET", locale });
      if (!res.ok) {
        console.warn("[ConversationHistory] Load failed:", res.status);
        setError(t(locale, "chat.history.loadError"));
        return;
      }
      const data = await res.json();
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (err) {
      console.error("[ConversationHistory] Load error:", err);
      setError(t(locale, "chat.history.loadError"));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  /* ─── Auto fetch on open ─── */
  useEffect(() => {
    if (open) void fetchSessions();
  }, [open, fetchSessions]);

  /* ─── Click outside to close ─── */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the same click event that opened the dropdown from closing it
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 10);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler); };
  }, [open, onClose]);

  /* ─── Escape to close ─── */
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  /* ─── Handle load ─── */
  const handleLoad = useCallback(async (sessionId: string) => {
    if (sessionId === currentConversationId) return;
    setLoadingId(sessionId);
    try {
      const ok = await onLoad(sessionId);
      if (ok) onClose();
    } finally {
      setLoadingId(null);
    }
  }, [currentConversationId, onLoad, onClose]);

  /* ─── Handle delete ─── */
  const handleDelete = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!window.confirm(t(locale, "chat.history.deleteConfirm"))) return;
    setDeletingId(sessionId);
    try {
      const ok = await onDelete(sessionId);
      if (ok) {
        setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      }
    } finally {
      setDeletingId(null);
    }
  }, [locale, onDelete]);

  /* ─── Format relative time ─── */
  const formatTime = useCallback((iso: string) => {
    try {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "—";
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 0) {
        return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      }
      if (diff < 60_000) return t(locale, "chat.history.justNow");
      if (diff < 3600_000) return t(locale, "chat.history.minutesAgo").replace("{count}", String(Math.floor(diff / 60_000)));
      if (diff < 86400_000) return t(locale, "chat.history.hoursAgo").replace("{count}", String(Math.floor(diff / 3600_000)));
      if (diff < 604800_000) return t(locale, "chat.history.daysAgo").replace("{count}", String(Math.floor(diff / 86400_000)));
      return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
    } catch {
      return "—";
    }
  }, [locale]);

  const formatMessageCount = useCallback((session: SessionItem) => {
    if (session.isTrimmed && typeof session.retainedMessageCount === "number") {
      return t(locale, "chat.history.messagesTrimmed")
        .replace("{count}", String(session.messageCount))
        .replace("{retained}", String(session.retainedMessageCount));
    }
    return t(locale, "chat.history.messages").replace("{count}", String(session.messageCount));
  }, [locale]);

  /* P3-12: 获取会话的任务队列历史 */
  const fetchTaskHistory = useCallback(async (sessionId: string) => {
    try {
      const res = await apiFetch(
        `/orchestrator/task-queue/history?sessionId=${encodeURIComponent(sessionId)}&limit=10`,
        { method: "GET", locale },
      );
      if (!res.ok) return;
      const data = await res.json();
      const entries: FrontendTaskQueueEntry[] = Array.isArray(data.entries) ? data.entries : [];
      const summary: TaskHistorySummary = {
        total: data.total ?? entries.length,
        completed: entries.filter((e: any) => e.status === "completed").length,
        failed: entries.filter((e: any) => e.status === "failed").length,
        cancelled: entries.filter((e: any) => e.status === "cancelled").length,
        entries,
      };
      setTaskHistories((prev) => new Map(prev).set(sessionId, summary));
    } catch (err) {
      console.warn("[ConversationHistory] Task history fetch failed:", err);
    }
  }, [locale]);

  if (!open) return null;

  return (
    <div className={styles.historyDropdown} ref={dropdownRef}>
      {/* Header */}
      <div className={styles.historyHeader}>
        <span className={styles.historyTitle}>{t(locale, "chat.history.title")}</span>
        <button
          className={styles.historyRefreshBtn}
          onClick={() => void fetchSessions()}
          disabled={loading}
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {/* List */}
      <div className={styles.historyList}>
        {error && (
          <div className={styles.historyEmpty} style={{ color: "var(--sl-danger, #ef4444)" }}>
            {error}
          </div>
        )}
        {!error && !loading && sessions.length === 0 && (
          <div className={styles.historyEmpty}>{t(locale, "chat.history.empty")}</div>
        )}
        {!error && loading && sessions.length === 0 && (
          <div className={styles.historyEmpty}>{t(locale, "chat.history.loading")}</div>
        )}
        {sessions.map((s) => {
          const isCurrent = s.sessionId === currentConversationId;
          const isDeleting = deletingId === s.sessionId;
          const isLoading = loadingId === s.sessionId;
          return (
            <div
              key={s.sessionId}
              className={`${styles.historyItem} ${isCurrent ? styles.historyItemCurrent : ""}`}
              onClick={() => void handleLoad(s.sessionId)}
              title={s.preview || s.sessionId}
            >
              <div className={styles.historyItemContent}>
                <div className={styles.historyItemPreview}>
                  {isLoading ? t(locale, "chat.history.loading") : (s.preview || s.sessionId.slice(0, 20) + "…")}
                </div>
                <div className={styles.historyItemMeta}>
                  {isCurrent && <span className={styles.historyItemBadge}>{t(locale, "chat.history.current")}</span>}
                  <span>{formatMessageCount(s)}</span>
                  <span>{formatTime(s.updatedAt)}</span>
                </div>
              </div>
              <div className={styles.historyItemActions}>
                {/* P3-12: 任务历史按钮 */}
                <button
                  className={styles.historyDeleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (expandedTaskHistory === s.sessionId) {
                      setExpandedTaskHistory(null);
                    } else {
                      setExpandedTaskHistory(s.sessionId);
                      if (!taskHistories.has(s.sessionId)) {
                        void fetchTaskHistory(s.sessionId);
                      }
                    }
                  }}
                  title={t(locale, "chat.history.taskHistory")}
                >
                  📜
                </button>
                <button
                  className={styles.historyDeleteBtn}
                  onClick={(e) => void handleDelete(e, s.sessionId)}
                  disabled={isDeleting}
                  title={t(locale, "chat.history.delete")}
                >
                  {isDeleting ? "…" : "✕"}
                </button>
              </div>
              {/* P3-12: 任务队列历史展开 */}
              {expandedTaskHistory === s.sessionId && (
                <div style={{ padding: "4px 8px", fontSize: "11px", borderTop: "1px solid var(--sl-border, #e5e7eb)" }}>
                  {taskHistories.has(s.sessionId) ? (
                    (() => {
                      const h = taskHistories.get(s.sessionId)!;
                      if (h.total === 0) return <div style={{ color: "#999" }}>{t(locale, "chat.history.noTasks")}</div>;
                      return (
                        <div>
                          <div style={{ marginBottom: 2 }}>
                            {t(locale, "chat.history.taskSummary")
                              .replace("{total}", String(h.total))
                              .replace("{completed}", String(h.completed))
                              .replace("{failed}", String(h.failed))
                              .replace("{cancelled}", String(h.cancelled))}
                          </div>
                          {h.entries.slice(0, 5).map((entry) => (
                            <div key={entry.entryId} style={{ display: "flex", gap: 4, alignItems: "center", padding: "1px 0" }}>
                              <span>{STATUS_LABELS[entry.status] || "●"}</span>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {entry.goal.slice(0, 40)}
                              </span>
                              <span style={{ color: "#999", fontSize: "10px" }}>{entry.mode}</span>
                            </div>
                          ))}
                          {h.total > 5 && <div style={{ color: "#999" }}>{t(locale, "chat.history.moreTasksPrefix")}{h.total - 5}{t(locale, "chat.history.moreTasksSuffix")}</div>}
                        </div>
                      );
                    })()
                  ) : (
                    <div style={{ color: "#999" }}>{t(locale, "chat.history.loading")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
