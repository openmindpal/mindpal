/**
 * taskUIUtils — shared UI helpers for task/run status display.
 * Centralises shortId, statusTone, formatTime, pickStr, statusIcon, statusLabel
 * that were previously duplicated across multiple files.
 */

import { TERMINAL_RUN_STATUSES } from "@/app/homeHelpers";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { t } from "@/lib/i18n";

/* ── Primitive helpers ─── */

export function pickStr(v: unknown): string {
  return v != null ? String(v) : "";
}

export function shortId(v: unknown): string {
  const s = typeof v === "string" ? v : pickStr(v);
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/* ── Status tone (for Badge component) ─── */

export function statusTone(s: string): "neutral" | "success" | "warning" | "danger" {
  if (s === "succeeded" || s === "completed") return "success";
  if (TERMINAL_RUN_STATUSES.has(s) || s === "cancelled") return "danger";
  if (s === "running" || s === "queued" || s === "pending" || s === "created" || s === "compensating" || s === "needs_approval") return "warning";
  return "neutral";
}

/* ── Time formatting ─── */

export function formatTime(v: unknown, locale: string): string {
  const formatted = fmtDateTime(v, locale);
  if (formatted !== "—") return formatted;
  const s = pickStr(v);
  return s || "—";
}

/* ── Status icon (merged: queue statuses + run statuses) ─── */

export function statusIcon(status: string): string {
  switch (status) {
    case "executing":
    case "running":    return "\u23f3";
    case "queued":     return "\ud83d\udccb";
    case "ready":      return "\u25b6\ufe0f";
    case "paused":     return "\u23f8\ufe0f";
    case "completed":
    case "succeeded":  return "\u2705";
    case "failed":     return "\u274c";
    case "cancelled":
    case "canceled":
    case "deadletter": return "\u26d4";
    case "preempted":  return "\u23cf\ufe0f";
    default:           return "\u2753";
  }
}

/* ── Status label (merged: taskDock keys + run.phase keys) ─── */

const RUN_PHASE_KEYS: Record<string, string> = {
  succeeded: "run.phase.succeeded",
  failed: "run.phase.failed",
  running: "run.phase.running",
  canceled: "run.phase.canceled",
  deadletter: "taskProgress.status.deadletter",
};

export function statusLabel(status: string, locale: string): string {
  // Try queue-style key first (taskDock.status.*)
  const queueKey = `taskDock.status.${status}`;
  const queueLabel = t(locale, queueKey);
  if (queueLabel !== queueKey) return queueLabel;

  // Fall back to run-phase key
  const runKey = RUN_PHASE_KEYS[status];
  if (runKey) return t(locale, runKey);

  return status;
}

/* ── Dependency type helpers ─── */

/** 依赖类型 i18n 键映射 */
export const DEP_TYPE_KEYS: Record<string, string> = {
  finish_to_start: "taskDock.depType.finish_to_start",
  output_to_input: "taskDock.depType.output_to_input",
  cancel_cascade: "taskDock.depType.cancel_cascade",
};

/** 依赖类型的友好标签 */
export function depTypeLabel(depType: string, locale: string): string {
  return DEP_TYPE_KEYS[depType] ? t(locale, DEP_TYPE_KEYS[depType]) : depType;
}
