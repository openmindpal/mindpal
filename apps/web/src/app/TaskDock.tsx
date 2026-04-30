"use client";

/**
 * TaskDock — 多任务队列栏组件
 *
 * 显示当前会话的所有任务（活跃/排队/已完成），
 * 支持前台/后台切换、取消、暂停/恢复、查看进度。
 */

import { memo, useCallback, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { statusIcon, statusLabel, depTypeLabel } from "@/lib/taskUIUtils";
import type { FrontendTaskQueueEntry, FrontendTaskDependency } from "./homeHelpers";
import { TERMINAL_QUEUE_STATUSES } from "./homeHelpers";
import type { TaskQueueActions } from "./useSessionTaskQueue";
import DependencyEditor from "@/components/task/DependencyEditor";

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
  onTaskClick?: (taskId: string, runId?: string) => void;
}

/* ── Dependency helpers (kept for getWaitingReason) ── */

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

/* ─── Single task item ─── */

const TaskDockItem = memo(function TaskDockItem({
  entry,
  isForeground,
  locale,
  actions,
  operating,
  waitingReason,
  depIndicators,
  onTaskClick,
}: {
  entry: FrontendTaskQueueEntry;
  isForeground: boolean;
  locale: string;
  actions: TaskQueueActions;
  operating: boolean;
  waitingReason: string | null;
  depIndicators: { upstream: number; downstream: number; blocked: boolean; upstreamNames?: string; downstreamNames?: string };
  onTaskClick?: (taskId: string, runId?: string) => void;
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

  const goalPreview = entry.goal.length > 80 ? entry.goal.slice(0, 77) + "..." : entry.goal;

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
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", cursor: onTaskClick ? "pointer" : undefined }} onClick={() => onTaskClick?.(entry.taskId ?? entry.entryId, entry.runId ?? undefined)}>
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
              {depIndicators.upstream > 0 && <span title={depIndicators.upstreamNames ?? formatText(locale, "taskDock.depIndicator.upstream", { count: depIndicators.upstream })}>↑{depIndicators.upstream}</span>}
              {depIndicators.downstream > 0 && <span title={depIndicators.downstreamNames ?? formatText(locale, "taskDock.depIndicator.downstream", { count: depIndicators.downstream })}>↓{depIndicators.downstream}</span>}
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
            onClick={(e) => { e.stopPropagation(); handleFgToggle(); }}
            disabled={operating}
            title={isForeground ? t(locale, "taskDock.action.moveToBackground") : t(locale, "taskDock.action.bringToForeground")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            {isForeground ? "\u23f9" : "\u25b6"}
          </button>
        )}
        {isExecuting && (
          <button
            onClick={(e) => { e.stopPropagation(); handlePause(); }}
            disabled={operating}
            title={t(locale, "taskDock.action.pause")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            \u23f8
          </button>
        )}
        {isPaused && (
          <button
            onClick={(e) => { e.stopPropagation(); handleResume(); }}
            disabled={operating}
            title={t(locale, "taskDock.action.resume")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            \u25b6
          </button>
        )}
        {entry.status === "failed" && (
          <button
            onClick={(e) => { e.stopPropagation(); handleRetry(); }}
            disabled={operating}
            title={t(locale, "taskDock.action.retry")}
            style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
          >
            \u21bb
          </button>
        )}
        {!isTerminal && (
          <button
            onClick={(e) => { e.stopPropagation(); handleCancel(); }}
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
  onTaskClick,
}: TaskDockProps) {
  const [collapsed, setCollapsed] = useState(false);

  const entryMap = useMemo(() => {
    const m = new Map<string, FrontendTaskQueueEntry>();
    for (const e of entries) m.set(e.entryId, e);
    return m;
  }, [entries]);

  const activeEntries = useMemo(() => entries.filter((e) => !TERMINAL_QUEUE_STATUSES.has(e.status)), [entries]);
  const terminalEntries = useMemo(() => entries.filter((e) => TERMINAL_QUEUE_STATUSES.has(e.status)), [entries]);

  /** 每个任务的依赖指标 */
  const depInfoMap = useMemo(() => {
    const m = new Map<string, { upstream: number; downstream: number; blocked: boolean; upstreamNames?: string; downstreamNames?: string }>();
    for (const e of entries) {
      const upstreamDeps = dependencies.filter(d => d.fromEntryId === e.entryId && d.status !== "overridden");
      const downstreamDeps = dependencies.filter(d => d.toEntryId === e.entryId && d.status !== "overridden");
      const blocked = upstreamDeps.some(d => d.status === "blocked");
      const upstreamNames = upstreamDeps.map(d => { const t = entryMap.get(d.toEntryId); return t ? t.goal.slice(0, 30) : d.toEntryId.slice(0, 8); }).join(", ") || undefined;
      const downstreamNames = downstreamDeps.map(d => { const f = entryMap.get(d.fromEntryId); return f ? f.goal.slice(0, 30) : d.fromEntryId.slice(0, 8); }).join(", ") || undefined;
      m.set(e.entryId, { upstream: upstreamDeps.length, downstream: downstreamDeps.length, blocked, upstreamNames, downstreamNames });
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
              depIndicators={depInfoMap.get(entry.entryId) ?? { upstream: 0, downstream: 0, blocked: false, upstreamNames: undefined, downstreamNames: undefined }}
              onTaskClick={onTaskClick}
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
              depIndicators={depInfoMap.get(entry.entryId) ?? { upstream: 0, downstream: 0, blocked: false, upstreamNames: undefined, downstreamNames: undefined }}
              onTaskClick={onTaskClick}
            />
          ))}
          {terminalEntries.length > 5 && (
            <div style={{ textAlign: "center", fontSize: 11, color: "var(--text-muted, #888)", padding: 4 }}>
              {formatText(locale, "taskDock.completedMore", { count: terminalEntries.length - 5 })}
            </div>
          )}

          {/* P2-09: 依赖管理区域 */}
          <DependencyEditor
            locale={locale}
            dependencies={dependencies}
            activeEntries={activeEntries}
            entryMap={entryMap}
            actions={actions}
            operating={operating}
          />
        </div>
      )}
    </div>
  );
}
