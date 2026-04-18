/**
 * Shared utility functions for shell/ sub-panels.
 * Eliminates duplicate formatToolRef / timeAgo / formatDuration / formatTime
 * across ActiveRunList, PendingActionsQueue, RunHistoryPanel, DeviceActionsPanel,
 * RecentAndFavorites, and NotificationPanel.
 */

import { dateValueToMs, fmtDate, fmtShortDateTime } from "@/lib/fmtDateTime";
import { t } from "@/lib/i18n";

/**
 * Extract the tool name from a toolRef string (strip version suffix after '@').
 * e.g. "myTool@1.0.0" → "myTool"
 */
export function formatToolRef(toolRef: string | null): string {
  if (!toolRef) return "-";
  const at = toolRef.lastIndexOf("@");
  return at > 0 ? toolRef.slice(0, at) : toolRef;
}

/**
 * Human-friendly relative time string from an ISO date string.
 * @param prefix  i18n key prefix, e.g. "activeRuns" | "pendingActions" | "notification"
 */
export function timeAgo(dateStr: string, locale: string, prefix: string): string {
  const now = Date.now();
  const then = dateValueToMs(dateStr);
  if (then == null) return "—";
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return t(locale, `${prefix}.justNow`);
  if (diffMin < 60) return t(locale, `${prefix}.minutesAgo`).replace("{n}", String(diffMin));
  if (diffHr < 24) return t(locale, `${prefix}.hoursAgo`).replace("{n}", String(diffHr));
  return t(locale, `${prefix}.daysAgo`).replace("{n}", String(Math.floor(diffHr / 24)));
}

/**
 * Human-friendly relative time string from a Unix timestamp (ms).
 * Used by RecentAndFavorites which stores timestamps as numbers.
 */
export function timeAgoFromTs(ts: number, locale: string, prefix: string): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return t(locale, `${prefix}.justNow`);
  if (diffMin < 60) return t(locale, `${prefix}.minutesAgo`).replace("{n}", String(diffMin));
  if (diffHr < 24) return t(locale, `${prefix}.hoursAgo`).replace("{n}", String(diffHr));
  if (diffDay < 7) return t(locale, `${prefix}.daysAgo`).replace("{n}", String(diffDay));
  return fmtDate(ts, locale);
}

/**
 * Format a duration in milliseconds to human-readable string.
 * e.g. 500 → "500ms", 1500 → "1.5s", 75000 → "1m 15s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Format an ISO date string to a locale-appropriate short date+time.
 */
export function formatTime(ts: string, locale: string): string {
  return fmtShortDateTime(ts, locale);
}
