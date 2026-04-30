"use client";

import { useState, useMemo } from "react";
import { type TaskProgress, type FrontendTaskQueueEntry, friendlyToolName } from "@/app/homeHelpers";
import { t } from "@/lib/i18n";
import { statusIcon, statusLabel } from "@/lib/taskUIUtils";
import { getPhaseLabel, isPhaseTerminal } from "@/lib/types";
import styles from "@/styles/flow.module.css";

/* ── Chevron icon ─── */

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* ── Props ─── */

interface TaskProgressBarProps {
  progress: TaskProgress | null;
  locale: string;
  onStop?: () => void;
  onContinue?: () => void;
  onRetry?: () => void;
  /** P1-18: highlight when this task is the foreground task */
  isForeground?: boolean;
}

/* ── Component ─── */

export function TaskProgressBar({ progress, locale, onStop, onContinue, onRetry, isForeground }: TaskProgressBarProps) {
  const [expanded, setExpanded] = useState(false);
  const taskId = progress?.taskId ?? "";
  const phase = progress?.phase ?? "";
  const steps = progress?.steps ?? [];
  const isTerminal = isPhaseTerminal(phase);
  const succeeded = steps.filter((s) => s.status === "succeeded").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const total = steps.length;

  const dotClass = phase === "succeeded"
    ? styles.pulseDotSuccess
    : phase === "failed"
      ? styles.pulseDotFailed
      : isTerminal
        ? styles.pulseDotMuted
        : "";

  const fillClass = phase === "succeeded"
    ? styles.miniProgressFillSuccess
    : phase === "failed"
      ? styles.miniProgressFillFailed
      : "";

  const progressPct = total > 0 ? Math.round(((succeeded + failed) / total) * 100) : (isTerminal ? 100 : 0);

  const shortId = taskId.slice(0, 8);

  if (!progress) return null;

  return (
    <div className={`${styles.tpbProgressBar} ${isForeground ? styles.progressBarForeground ?? "" : ""}`}>
      {/* Collapsed header */}
      <div className={styles.header} onClick={() => setExpanded((p) => !p)}>
        <span className={`${styles.tpbPulseDot} ${dotClass}`} />
        <span className={styles.taskLabel}>
          {t(locale, "taskProgress.task").replace("{id}", shortId)}
        </span>
        {progress.label && <span className={styles.modeBadge}>{progress.label}</span>}
        <span className={styles.phaseText}>{getPhaseLabel(phase, locale)}</span>
        <span className={styles.stepCounter}>
          {total > 0 && (
            <>
              <span className={styles.miniProgress}>
                <span className={`${styles.miniProgressFill} ${fillClass}`} style={{ width: `${progressPct}%` }} />
              </span>
              {t(locale, "taskProgress.stepCount")
                .replace("{done}", String(succeeded))
                .replace("{total}", String(total))}
            </>
          )}
          {total === 0 && !isTerminal && t(locale, "taskProgress.preparing")}
          {total === 0 && isTerminal && t(locale, "taskProgress.done")}
        </span>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}>
          <ChevronIcon />
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className={styles.detail}>
          {steps.length === 0 ? (
            <div className={styles.emptyHint}>
              {t(locale, "taskProgress.noSteps")}
            </div>
          ) : (
            <div className={styles.stepList}>
              {steps.map((s) => (
                <div key={s.id}>
                  <div className={styles.stepItem}>
                    <span className={`${styles.stepIcon} ${s.status === "succeeded" || s.status === "failed" ? styles.stepIconDone : ""}`}>{statusIcon(s.status)}</span>
                    <span className={styles.stepSeq}>{s.seq}</span>
                    <span className={styles.stepToolRef}>{friendlyToolName(locale, s.toolRef)}</span>
                    <span className={`${styles.stepStatus} ${
                      s.status === "succeeded" ? styles.stepStatusSucceeded
                      : s.status === "failed" ? styles.stepStatusFailed
                      : styles.stepStatusRunning
                    }`}>
                      {statusLabel(s.status, locale)}
                    </span>
                  </div>
                  {s.reasoning && (
                    <div className={styles.stepReasoning}>{s.reasoning}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Completion summary */}
          {isTerminal && total > 0 && (
            <div className={styles.completionLine}>
              <span className={`${styles.completionDot} ${phase === "succeeded" ? styles.completionDotOk : styles.completionDotFail}`} />
              {t(locale, "taskProgress.completedSummary")
                .replace("{succeeded}", String(succeeded))
                .replace("{failed}", String(failed))}
            </div>
          )}

          {/* Action buttons */}
          {(onStop || onContinue || onRetry) && (
            <div className={styles.actions}>
              {onStop && (
                <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={onStop}>
                  {t(locale, "common.stop")}
                </button>
              )}
              {onContinue && (
                <button className={styles.actionBtn} onClick={onContinue}>
                  {t(locale, "action.continue")}
                </button>
              )}
              {onRetry && (
                <button className={styles.actionBtn} onClick={onRetry}>
                  {t(locale, "common.retry")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── P1-18: Multi-task progress bars wrapper ─── */

export interface MultiTaskProgressBarProps {
  locale: string;
  /** All queue entries that have attached progress */
  entries: FrontendTaskQueueEntry[];
  /** Currently foreground entry id */
  foregroundEntryId: string | null;
  /** Action callbacks keyed by entryId */
  onStop?: (entryId: string) => void;
  onRetry?: (entryId: string) => void;
}

export function MultiTaskProgressBar({ locale, entries, foregroundEntryId, onStop, onRetry }: MultiTaskProgressBarProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Only entries with progress data
  const withProgress = useMemo(
    () => entries.filter((e) => e.progress != null),
    [entries],
  );

  const sorted = useMemo(() => {
    return [...withProgress].sort((a, b) => {
      if (a.entryId === foregroundEntryId) return -1;
      if (b.entryId === foregroundEntryId) return 1;
      const aActive = ["executing", "ready"].includes(a.status);
      const bActive = ["executing", "ready"].includes(b.status);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return a.position - b.position;
    });
  }, [withProgress, foregroundEntryId]);

  if (withProgress.length === 0) return null;

  // If only 1, render plain TaskProgressBar (backwards compatible)
  if (withProgress.length === 1) {
    const entry = withProgress[0];
    return (
      <TaskProgressBar
        progress={entry.progress!}
        locale={locale}
        isForeground
        onStop={onStop ? () => onStop(entry.entryId) : undefined}
        onRetry={onRetry ? () => onRetry(entry.entryId) : undefined}
      />
    );
  }

  const completedCount = sorted.filter((e) => ["completed", "failed", "cancelled"].includes(e.status)).length;
  const activeCount = sorted.length - completedCount;

  return (
    <div className={styles.multiWrapper}>
      {/* Header */}
      <div className={styles.multiHeader} onClick={() => setCollapsed((p) => !p)}>
        <span className={`${styles.tpbPulseDot} ${activeCount > 0 ? "" : styles.pulseDotMuted}`} />
        <span className={styles.taskLabel}>
          {activeCount > 0
            ? `${activeCount} ${t(locale, "taskProgress.activeTasks")}` 
            : t(locale, "taskProgress.allDone")}
        </span>
        <span className={styles.stepCounter}>
          {completedCount}/{sorted.length} {t(locale, "taskProgress.done")}
        </span>
        <span className={`${styles.chevron} ${collapsed ? "" : styles.chevronOpen}`}>
          <ChevronIcon />
        </span>
      </div>

      {/* Individual bars */}
      {!collapsed && (
        <div className={styles.multiList}>
          {sorted.map((entry) => (
            <TaskProgressBar
              key={entry.entryId}
              progress={entry.progress!}
              locale={locale}
              isForeground={entry.entryId === foregroundEntryId}
              onStop={onStop && !isPhaseTerminal(entry.progress!.phase) ? () => onStop(entry.entryId) : undefined}
              onRetry={onRetry && entry.progress!.phase === "failed" ? () => onRetry(entry.entryId) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Default export for backward compat
export default TaskProgressBar;
