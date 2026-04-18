"use client";

/**
 * TaskDock — 多任务队列栏组件
 *
 * 显示当前会话的所有任务（活跃/排队/已完成），
 * 支持前台/后台切换、取消、暂停/恢复、查看进度。
 */

import { memo, useCallback, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import type { FrontendTaskQueueEntry, FrontendQueueStatus, FrontendTaskDependency } from "./homeHelpers";
import { TERMINAL_QUEUE_STATUSES } from "./homeHelpers";
import type { TaskQueueActions } from "./useSessionTaskQueue";

/* ─── Types ─── */

interface TaskDockProps {
  locale: string;
  entries: FrontendTaskQueueEntry[];
  dependencies: FrontendTaskDependency[];
  foregroundEntryId: string | null;
  activeCount: number;
  queuedCount: number;
  actions: TaskQueueActions;
  operating: boolean;
}

/* ── Dependency helpers ── */

const DEP_TYPE_KEYS: Record<string, string> = {
  finish_to_start: "taskDock.depType.finish_to_start",
  output_to_input: "taskDock.depType.output_to_input",
  cancel_cascade: "taskDock.depType.cancel_cascade",
};

const DEP_STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b",
  resolved: "#10b981",
  blocked: "#ef4444",
  overridden: "#9ca3af",
};

function depTypeLabel(depType: string, locale: string) {
  return DEP_TYPE_KEYS[depType] ? t(locale, DEP_TYPE_KEYS[depType]) : depType;
}

function formatText(locale: string, key: string, replacements?: Record<string, string | number>) {
  let value = t(locale, key);
  if (!replacements) return value;
  for (const [token, tokenValue] of Object.entries(replacements)) {
    value = value.replaceAll(`{${token}}`, String(tokenValue));
  }
  return value;
}

/** 获取任务的等待原因 */
function getWaitingReason(
  entryId: string,
  deps: FrontendTaskDependency[],
  entryMap: Map<string, FrontendTaskQueueEntry>,
  locale: string,
): string | null {
  const isZh = locale.startsWith("zh");
  const blocking = deps.filter(d => d.fromEntryId === entryId && (d.status === "pending" || d.status === "blocked"));
  if (blocking.length === 0) return null;

  const reasons = blocking.map(d => {
    const upstream = entryMap.get(d.toEntryId);
    const name = upstream ? upstream.goal.slice(0, 30) : d.toEntryId.slice(0, 8);
    const label = depTypeLabel(d.depType, locale);
    if (d.status === "blocked") {
      return isZh
        ? formatText(locale, "taskDock.waitingReason.blocked", { name, label })
        : `✘ ${name} (${label}, blocked)`;
    }
    return isZh
      ? formatText(locale, "taskDock.waitingReason.pending", { name, label })
      : `⏳ ${name} (${label})`;
  });
  return reasons.join("; ");
}

/* ─── Status helpers ─── */

function statusIcon(status: FrontendQueueStatus): string {
  switch (status) {
    case "executing": return "\u23f3";
    case "queued": return "\ud83d\udccb";
    case "ready": return "\u25b6\ufe0f";
    case "paused": return "\u23f8\ufe0f";
    case "completed": return "\u2705";
    case "failed": return "\u274c";
    case "cancelled": return "\u26d4";
    case "preempted": return "\u23cf\ufe0f";
    default: return "\u2753";
  }
}

function statusLabel(status: FrontendQueueStatus, locale: string): string {
  return t(locale, `taskDock.status.${status}`) ?? status;
}

/* ─── Single task item ─── */

const TaskDockItem = memo(function TaskDockItem({
  entry,
  isForeground,
  locale,
  actions,
  operating,
  waitingReason,
  depIndicators,
}: {
  entry: FrontendTaskQueueEntry;
  isForeground: boolean;
  locale: string;
  actions: TaskQueueActions;
  operating: boolean;
  waitingReason: string | null;
  depIndicators: { upstream: number; downstream: number; blocked: boolean };
}) {
  const isTerminal = TERMINAL_QUEUE_STATUSES.has(entry.status);
  const isExecuting = entry.status === "executing";
  const isPaused = entry.status === "paused";

  const handleCancel = useCallback(() => {
    void actions.cancel(entry.entryId);
  }, [actions, entry.entryId]);

  const handlePause = useCallback(() => {
    void actions.pause(entry.entryId);
  }, [actions, entry.entryId]);

  const handleResume = useCallback(() => {
    void actions.resume(entry.entryId);
  }, [actions, entry.entryId]);

  const handleRetry = useCallback(() => {
    void actions.retry(entry.entryId);
  }, [actions, entry.entryId]);

  const handleFgToggle = useCallback(() => {
    void actions.setForeground(entry.entryId, !isForeground);
  }, [actions, entry.entryId, isForeground]);

  const goalPreview = entry.goal.length > 60 ? entry.goal.slice(0, 57) + "..." : entry.goal;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 6,
        background: isForeground ? "var(--accent-subtle, rgba(59,130,246,0.08))" : "var(--bg-muted, #f5f5f5)",
        border: isForeground ? "1px solid var(--accent-border, rgba(59,130,246,0.25))" : "1px solid transparent",
        fontSize: 13,
        lineHeight: 1.4,
        opacity: isTerminal ? 0.6 : 1,
        transition: "opacity 0.2s, background 0.2s",
      }}
    >
      {/* Status icon */}
      <span style={{ fontSize: 14, flexShrink: 0 }} title={statusLabel(entry.status, locale)}>
        {statusIcon(entry.status)}
      </span>

      {/* Goal + mode + dep indicators */}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: isForeground ? 600 : 400, flex: 1 }}>
            {goalPreview}
          </span>
          {/* 依赖徽章 */}
          {(depIndicators.upstream > 0 || depIndicators.downstream > 0) && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 2,
              fontSize: 10, padding: "1px 4px", borderRadius: 3,
              background: depIndicators.blocked ? "rgba(239,68,68,0.1)" : "rgba(59,130,246,0.08)",
              color: depIndicators.blocked ? "#ef4444" : "var(--text-muted, #888)",
              flexShrink: 0,
            }}>
              {depIndicators.upstream > 0 && <span title={formatText(locale, "taskDock.depIndicator.upstream", { count: depIndicators.upstream })}>↑{depIndicators.upstream}</span>}
              {depIndicators.downstream > 0 && <span title={formatText(locale, "taskDock.depIndicator.downstream", { count: depIndicators.downstream })}>↓{depIndicators.downstream}</span>}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted, #888)", marginTop: 1 }}>
          {entry.mode} &middot; {statusLabel(entry.status, locale)}
          {entry.priority > 0 && ` \u00b7 P${entry.priority}`}
        </div>
        {/* 等待原因 */}
        {waitingReason && (
          <div style={{
            fontSize: 10, marginTop: 2, padding: "2px 6px",
            borderRadius: 3, background: "rgba(245,158,11,0.08)",
            color: "var(--text-muted, #888)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {t(locale, "taskDock.waitingPrefix")}{waitingReason}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {!isTerminal && (
          <button
            onClick={handleFgToggle}
            disabled={operating}
            title={isForeground ? t(locale, "taskDock.action.moveToBackground") : t(locale, "taskDock.action.bringToForeground")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            {isForeground ? "\u23f9" : "\u25b6"}
          </button>
        )}
        {isExecuting && (
          <button
            onClick={handlePause}
            disabled={operating}
            title={t(locale, "taskDock.action.pause")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            \u23f8
          </button>
        )}
        {isPaused && (
          <button
            onClick={handleResume}
            disabled={operating}
            title={t(locale, "taskDock.action.resume")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            \u25b6
          </button>
        )}
        {entry.status === "failed" && (
          <button
            onClick={handleRetry}
            disabled={operating}
            title={t(locale, "taskDock.action.retry")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            \u21bb
          </button>
        )}
        {!isTerminal && (
          <button
            onClick={handleCancel}
            disabled={operating}
            title={t(locale, "taskDock.action.cancel")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer", color: "var(--danger, #e53e3e)" }}
          >
            \u2715
          </button>
        )}
      </div>
    </div>
  );
});

/* ─── Main component ─── */

export default function TaskDock({
  locale,
  entries,
  dependencies,
  foregroundEntryId,
  activeCount,
  queuedCount,
  actions,
  operating,
}: TaskDockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [depEditing, setDepEditing] = useState(false);
  const [depFrom, setDepFrom] = useState("");
  const [depTo, setDepTo] = useState("");
  const [depType, setDepType] = useState<"finish_to_start" | "output_to_input" | "cancel_cascade">("finish_to_start");
  const [depError, setDepError] = useState<string | null>(null);

  const entryMap = useMemo(() => {
    const m = new Map<string, FrontendTaskQueueEntry>();
    for (const e of entries) m.set(e.entryId, e);
    return m;
  }, [entries]);

  const activeEntries = useMemo(() => entries.filter((e) => !TERMINAL_QUEUE_STATUSES.has(e.status)), [entries]);
  const terminalEntries = useMemo(() => entries.filter((e) => TERMINAL_QUEUE_STATUSES.has(e.status)), [entries]);

  /** 每个任务的依赖指标 */
  const depInfoMap = useMemo(() => {
    const m = new Map<string, { upstream: number; downstream: number; blocked: boolean }>();
    for (const e of entries) {
      const upstream = dependencies.filter(d => d.fromEntryId === e.entryId && d.status !== "overridden");
      const downstream = dependencies.filter(d => d.toEntryId === e.entryId && d.status !== "overridden");
      const blocked = upstream.some(d => d.status === "blocked");
      m.set(e.entryId, { upstream: upstream.length, downstream: downstream.length, blocked });
    }
    return m;
  }, [entries, dependencies]);

  // 不显示空队列 — 放在所有 Hooks 之后以遵守 React Hooks 规则
  if (entries.length === 0) return null;

  const summaryText = formatText(locale, "taskDock.summary", { activeCount, queuedCount });

  return (
    <div
      style={{
        margin: "0 auto",
        width: "100%",
        maxWidth: 720,
        padding: "8px 12px",
        borderRadius: 8,
        background: "var(--bg-surface, #fff)",
        border: "1px solid var(--border-light, #e5e7eb)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        fontSize: 13,
      }}
    >
      {/* Header */}
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
        onClick={() => setCollapsed((p) => !p)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{t(locale, "taskDock.title")}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted, #888)" }}>{summaryText}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {activeCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); void actions.cancelAll(); }}
              disabled={operating}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--danger, #e53e3e)", color: "var(--danger, #e53e3e)", background: "transparent", cursor: "pointer" }}
            >
              {t(locale, "taskDock.action.cancelAll")}
            </button>
          )}
          <span style={{ fontSize: 12, transform: collapsed ? "rotate(-90deg)" : "rotate(0)", transition: "transform 0.2s" }}>\u25bc</span>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
          {activeEntries.map((entry) => (
            <TaskDockItem
              key={entry.entryId}
              entry={entry}
              isForeground={entry.entryId === foregroundEntryId}
              locale={locale}
              actions={actions}
              operating={operating}
              waitingReason={getWaitingReason(entry.entryId, dependencies, entryMap, locale)}
              depIndicators={depInfoMap.get(entry.entryId) ?? { upstream: 0, downstream: 0, blocked: false }}
            />
          ))}
          {terminalEntries.length > 0 && activeEntries.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border-light, #e5e7eb)", margin: "4px 0" }} />
          )}
          {terminalEntries.slice(0, 5).map((entry) => (
            <TaskDockItem
              key={entry.entryId}
              entry={entry}
              isForeground={false}
              locale={locale}
              actions={actions}
              operating={operating}
              waitingReason={null}
              depIndicators={depInfoMap.get(entry.entryId) ?? { upstream: 0, downstream: 0, blocked: false }}
            />
          ))}
          {terminalEntries.length > 5 && (
            <div style={{ textAlign: "center", fontSize: 11, color: "var(--text-muted, #888)", padding: 4 }}>
              {formatText(locale, "taskDock.completedMore", { count: terminalEntries.length - 5 })}
            </div>
          )}
          
          {/* P2-09: 依赖管理区域 */}
          {dependencies.length > 0 && (
            <>
              <div style={{ borderTop: "1px solid var(--border-light, #e5e7eb)", margin: "6px 0 4px" }} />
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted, #888)", marginBottom: 2 }}>
                {formatText(locale, "taskDock.dependencies.title", { count: dependencies.length })}
              </div>
              {dependencies.filter(d => d.status !== "overridden").slice(0, 8).map(dep => {
                const from = entryMap.get(dep.fromEntryId);
                const to = entryMap.get(dep.toEntryId);
                return (
                  <div key={dep.depId} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 4px", borderRadius: 3, background: "var(--bg-muted, #f5f5f5)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: DEP_STATUS_COLORS[dep.status] ?? "#9ca3af", flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {(from?.goal ?? dep.fromEntryId).slice(0, 20)} → {(to?.goal ?? dep.toEntryId).slice(0, 20)}
                    </span>
                    <span style={{ color: "var(--text-muted, #888)", flexShrink: 0 }}>{depTypeLabel(dep.depType, locale)}</span>
                    {dep.status !== "resolved" && (
                      <button
                        onClick={() => { void actions.overrideDep(dep.depId); }}
                        disabled={operating}
                        title={t(locale, "taskDock.action.override")}
                        style={{ fontSize: 10, padding: "0 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
                      >
                        ✓
                      </button>
                    )}
                    <button
                      onClick={() => { void actions.removeDep(dep.depId); }}
                      disabled={operating}
                      title={t(locale, "taskDock.action.remove")}
                      style={{ fontSize: 10, padding: "0 4px", borderRadius: 3, border: "1px solid var(--danger, #e53e3e)", color: "var(--danger, #e53e3e)", background: "transparent", cursor: "pointer" }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </>
          )}
          
          {/* P2-09: 添加依赖按钮 + 输入区 */}
          {activeEntries.length >= 2 && (
            <div style={{ marginTop: 4 }}>
              {!depEditing ? (
                <button
                  onClick={() => { setDepEditing(true); setDepError(null); }}
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
                >
                  {t(locale, "taskDock.action.addDependency")}
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, background: "var(--bg-muted, #f5f5f5)", borderRadius: 6 }}>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      value={depFrom}
                      onChange={(e) => setDepFrom(e.target.value)}
                      style={{ flex: 1, minWidth: 80, fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)" }}
                    >
                      <option value="">{t(locale, "taskDock.select.downstream")}</option>
                      {activeEntries.map(e => (
                        <option key={e.entryId} value={e.entryId}>{e.goal.slice(0, 30)}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 11 }}>→</span>
                    <select
                      value={depTo}
                      onChange={(e) => setDepTo(e.target.value)}
                      style={{ flex: 1, minWidth: 80, fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)" }}
                    >
                      <option value="">{t(locale, "taskDock.select.upstream")}</option>
                      {activeEntries.filter(e => e.entryId !== depFrom).map(e => (
                        <option key={e.entryId} value={e.entryId}>{e.goal.slice(0, 30)}</option>
                      ))}
                    </select>
                    <select
                      value={depType}
                      onChange={(e) => setDepType(e.target.value as any)}
                      style={{ fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)" }}
                    >
                      <option value="finish_to_start">{depTypeLabel("finish_to_start", locale)}</option>
                      <option value="output_to_input">{depTypeLabel("output_to_input", locale)}</option>
                      <option value="cancel_cascade">{depTypeLabel("cancel_cascade", locale)}</option>
                    </select>
                  </div>
                  {depError && <div style={{ fontSize: 10, color: "var(--danger, #e53e3e)" }}>{depError}</div>}
                  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => { setDepEditing(false); setDepError(null); }}
                      style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
                    >
                      {t(locale, "taskDock.action.cancel")}
                    </button>
                    <button
                      disabled={!depFrom || !depTo || operating}
                      onClick={async () => {
                        setDepError(null);
                        const result = await actions.createDep({ fromEntryId: depFrom, toEntryId: depTo, depType });
                        if (result.ok) {
                          setDepEditing(false);
                          setDepFrom("");
                          setDepTo("");
                        } else {
                          setDepError(result.error ?? t(locale, "taskDock.error.failed"));
                        }
                      }}
                      style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--accent-border, #3b82f6)", color: "var(--accent-border, #3b82f6)", background: "transparent", cursor: "pointer" }}
                    >
                      {t(locale, "taskDock.action.confirm")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
