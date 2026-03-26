"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import styles from "./PendingActionsQueue.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type PendingApproval = {
  approvalId: string;
  runId: string;
  stepId: string | null;
  status: string;
  toolRef: string | null;
  requestedAt: string;
};

type FailedRun = {
  runId: string;
  status: string;
  updatedAt: string;
  traceId: string | null;
};

type DeadletterStep = {
  runId: string;
  stepId: string;
  toolRef: string | null;
  status: string;
  attempt: number;
  deadletteredAt: string;
};

type PendingActionItem =
  | { type: "approval"; data: PendingApproval }
  | { type: "failed_run"; data: FailedRun }
  | { type: "deadletter"; data: DeadletterStep };

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconApproval() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function IconError() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconDeadletter() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* ─── Utility Functions ─────────────────────────────────────────────────────── */

function formatToolRef(toolRef: string | null): string {
  if (!toolRef) return "-";
  const at = toolRef.lastIndexOf("@");
  return at > 0 ? toolRef.slice(0, at) : toolRef;
}

function timeAgo(dateStr: string, locale: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return t(locale, "pendingActions.justNow");
  if (diffMin < 60) return t(locale, "pendingActions.minutesAgo").replace("{n}", String(diffMin));
  if (diffHr < 24) return t(locale, "pendingActions.hoursAgo").replace("{n}", String(diffHr));
  return t(locale, "pendingActions.daysAgo").replace("{n}", String(Math.floor(diffHr / 24)));
}

/* ─── Action Item Component ─────────────────────────────────────────────────── */

function ActionItem(props: { item: PendingActionItem; locale: string }) {
  const { item, locale } = props;

  if (item.type === "approval") {
    const { data } = item;
    const href = `/gov/approvals/${encodeURIComponent(data.approvalId)}?lang=${encodeURIComponent(locale)}`;
    return (
      <Link href={href} className={styles.actionItem}>
        <span className={`${styles.actionIcon} ${styles.actionIconApproval}`}>
          <IconApproval />
        </span>
        <div className={styles.actionContent}>
          <span className={styles.actionType}>{t(locale, "pendingActions.type.approval")}</span>
          <span className={styles.actionDetail}>{formatToolRef(data.toolRef)}</span>
        </div>
        <span className={styles.actionTime}>{timeAgo(data.requestedAt, locale)}</span>
        <span className={styles.actionArrow}><IconChevronRight /></span>
      </Link>
    );
  }

  if (item.type === "failed_run") {
    const { data } = item;
    const href = `/runs/${encodeURIComponent(data.runId)}?lang=${encodeURIComponent(locale)}`;
    return (
      <Link href={href} className={styles.actionItem}>
        <span className={`${styles.actionIcon} ${styles.actionIconFailed}`}>
          <IconError />
        </span>
        <div className={styles.actionContent}>
          <span className={styles.actionType}>{t(locale, "pendingActions.type.failedRun")}</span>
          <span className={styles.actionDetail}>{data.runId.slice(0, 8)}...</span>
        </div>
        <span className={styles.actionTime}>{timeAgo(data.updatedAt, locale)}</span>
        <span className={styles.actionArrow}><IconChevronRight /></span>
      </Link>
    );
  }

  if (item.type === "deadletter") {
    const { data } = item;
    const href = `/gov/workflow/deadletters?lang=${encodeURIComponent(locale)}`;
    return (
      <Link href={href} className={styles.actionItem}>
        <span className={`${styles.actionIcon} ${styles.actionIconDeadletter}`}>
          <IconDeadletter />
        </span>
        <div className={styles.actionContent}>
          <span className={styles.actionType}>{t(locale, "pendingActions.type.deadletter")}</span>
          <span className={styles.actionDetail}>
            {formatToolRef(data.toolRef)} #{data.attempt}
          </span>
        </div>
        <span className={styles.actionTime}>{timeAgo(data.deadletteredAt, locale)}</span>
        <span className={styles.actionArrow}><IconChevronRight /></span>
      </Link>
    );
  }

  return null;
}

/* ─── Main PendingActionsQueue Component ────────────────────────────────────── */

export default function PendingActionsQueue(props: {
  locale: string;
  collapsed?: boolean;
}) {
  const { locale, collapsed } = props;
  const [items, setItems] = useState<PendingActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [approvalsRes, runsRes, deadlettersRes] = await Promise.all([
        apiFetch("/approvals?status=pending&limit=10", { locale, cache: "no-store" }),
        apiFetch("/runs?status=failed&limit=10", { locale, cache: "no-store" }),
        apiFetch("/governance/workflow/deadletters?limit=10", { locale, cache: "no-store" }),
      ]);

      const all: PendingActionItem[] = [];

      if (approvalsRes.ok) {
        const data = await approvalsRes.json();
        const approvals = (data.items as PendingApproval[]) ?? [];
        for (const a of approvals) {
          all.push({ type: "approval", data: a });
        }
      }

      if (runsRes.ok) {
        const data = await runsRes.json();
        const runs = (data.runs as FailedRun[]) ?? [];
        for (const r of runs) {
          all.push({ type: "failed_run", data: r });
        }
      }

      if (deadlettersRes.ok) {
        const data = await deadlettersRes.json();
        const deadletters = (data.deadletters as DeadletterStep[]) ?? [];
        for (const d of deadletters) {
          all.push({ type: "deadletter", data: d });
        }
      }

      // Sort by time (most recent first)
      all.sort((a, b) => {
        const timeA = a.type === "approval" ? a.data.requestedAt : a.type === "failed_run" ? a.data.updatedAt : a.data.deadletteredAt;
        const timeB = b.type === "approval" ? b.data.requestedAt : b.type === "failed_run" ? b.data.updatedAt : b.data.deadletteredAt;
        return new Date(timeB).getTime() - new Date(timeA).getTime();
      });

      setItems(all.slice(0, 15));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "fetch_error");
    } finally {
      setLoading(false);
    }
  }, [locale]);

  // Initial fetch
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const timer = setInterval(fetchAll, 30_000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  if (collapsed) return null;

  const toggleExpand = () => setExpanded((e) => !e);

  // Count by type
  const approvalCount = items.filter((i) => i.type === "approval").length;
  const failedCount = items.filter((i) => i.type === "failed_run").length;
  const deadletterCount = items.filter((i) => i.type === "deadletter").length;

  return (
    <div className={styles.container}>
      {/* Header */}
      <button className={styles.header} onClick={toggleExpand}>
        <span className={styles.headerIcon}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className={styles.headerTitle}>{t(locale, "pendingActions.title")}</span>
        {items.length > 0 && (
          <div className={styles.headerBadges}>
            {approvalCount > 0 && (
              <span className={`${styles.headerBadge} ${styles.headerBadgeApproval}`} title={t(locale, "pendingActions.type.approval")}>
                {approvalCount}
              </span>
            )}
            {failedCount > 0 && (
              <span className={`${styles.headerBadge} ${styles.headerBadgeFailed}`} title={t(locale, "pendingActions.type.failedRun")}>
                {failedCount}
              </span>
            )}
            {deadletterCount > 0 && (
              <span className={`${styles.headerBadge} ${styles.headerBadgeDeadletter}`} title={t(locale, "pendingActions.type.deadletter")}>
                {deadletterCount}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Content */}
      {expanded && (
        <div className={styles.content}>
          {loading && (
            <div className={styles.loadingState}>
              <span className={styles.spinner} />
              <span>{t(locale, "pendingActions.loading")}</span>
            </div>
          )}

          {!loading && error && (
            <div className={styles.errorState}>
              <span>{t(locale, "pendingActions.error")}</span>
              <button className={styles.retryBtn} onClick={fetchAll}>
                {t(locale, "pendingActions.retry")}
              </button>
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className={styles.emptyState}>
              <span>{t(locale, "pendingActions.empty")}</span>
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className={styles.actionList}>
              {items.map((item, idx) => (
                <ActionItem
                  key={`${item.type}_${item.type === "approval" ? item.data.approvalId : item.type === "failed_run" ? item.data.runId : item.data.stepId}_${idx}`}
                  item={item}
                  locale={locale}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
