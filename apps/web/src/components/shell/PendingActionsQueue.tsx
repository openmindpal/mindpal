"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconChevronRight, IconCheck, IconX, IconRefresh } from "./ShellIcons";
import { formatToolRef, timeAgo } from "./shellUtils";
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

/* ─── Inline Action State ─────────────────────────────────────────────────── */

type InlineActionState = Record<string, "idle" | "loading" | "done" | "error">;

/* ─── Action Item Component ─────────────────────────────────────────────────── */

function ActionItem(props: {
  item: PendingActionItem;
  locale: string;
  actionState: InlineActionState;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  onRetryRun?: (runId: string) => void;
}) {
  const { item, locale, actionState, onApprove, onReject, onRetryRun } = props;

  if (item.type === "approval") {
    const { data } = item;
    const href = `/gov/approvals/${encodeURIComponent(data.approvalId)}?lang=${encodeURIComponent(locale)}`;
    const state = actionState[data.approvalId] ?? "idle";
    return (
      <div className={styles.actionItem}>
        <span className={`${styles.actionIcon} ${styles.actionIconApproval}`} />
        <Link href={href} className={styles.actionContent}>
          <span className={styles.actionLabel}>{formatToolRef(data.toolRef) || t(locale, "pendingActions.type.approval")}</span>
        </Link>
        <span className={styles.actionTime}>{timeAgo(data.requestedAt, locale, "pendingActions")}</span>
        {state === "done" ? (
          <span className={styles.inlineActionDone}>{t(locale, "pendingActions.done")}</span>
        ) : state === "error" ? (
          <span className={styles.inlineActionError}>!</span>
        ) : (
          <span className={styles.inlineActions}>
            <button
              className={`${styles.inlineBtn} ${styles.inlineBtnApprove}`}
              disabled={state === "loading"}
              onClick={(e) => { e.stopPropagation(); onApprove?.(data.approvalId); }}
              title={t(locale, "pendingActions.quickApprove")}
            >
              <IconCheck />
            </button>
            <button
              className={`${styles.inlineBtn} ${styles.inlineBtnReject}`}
              disabled={state === "loading"}
              onClick={(e) => { e.stopPropagation(); onReject?.(data.approvalId); }}
              title={t(locale, "pendingActions.quickReject")}
            >
              <IconX />
            </button>
          </span>
        )}
      </div>
    );
  }

  if (item.type === "failed_run") {
    const { data } = item;
    const href = `/runs/${encodeURIComponent(data.runId)}?lang=${encodeURIComponent(locale)}`;
    const state = actionState[data.runId] ?? "idle";
    return (
      <div className={styles.actionItem}>
        <span className={`${styles.actionIcon} ${styles.actionIconFailed}`} />
        <Link href={href} className={styles.actionContent}>
          <span className={styles.actionLabel}>{t(locale, "pendingActions.type.failedRun")} {data.runId.slice(0, 8)}</span>
        </Link>
        <span className={styles.actionTime}>{timeAgo(data.updatedAt, locale, "pendingActions")}</span>
        {state === "done" ? (
          <span className={styles.inlineActionDone}>{t(locale, "pendingActions.retried")}</span>
        ) : state === "error" ? (
          <span className={styles.inlineActionError}>!</span>
        ) : (
          <span className={styles.inlineActions}>
            <button
              className={`${styles.inlineBtn} ${styles.inlineBtnRetry}`}
              disabled={state === "loading"}
              onClick={(e) => { e.stopPropagation(); onRetryRun?.(data.runId); }}
              title={t(locale, "pendingActions.quickRetry")}
            >
              <IconRefresh />
            </button>
          </span>
        )}
      </div>
    );
  }

  if (item.type === "deadletter") {
    const { data } = item;
    const href = `/gov/workflow/deadletters?lang=${encodeURIComponent(locale)}`;
    return (
      <div className={styles.actionItem}>
        <span className={`${styles.actionIcon} ${styles.actionIconDeadletter}`} />
        <Link href={href} className={styles.actionContent}>
          <span className={styles.actionLabel}>
            {formatToolRef(data.toolRef)} #{data.attempt}
          </span>
        </Link>
        <span className={styles.actionTime}>{timeAgo(data.deadletteredAt, locale, "pendingActions")}</span>
        <Link href={href} className={styles.actionArrow}><IconChevronRight /></Link>
      </div>
    );
  }

  return null;
}

/* ─── Main PendingActionsQueue Component ────────────────────────────────────── */

export default function PendingActionsQueue(props: {
  locale: string;
  onBadgeUpdate?: (count: number) => void;
}) {
  const { locale, onBadgeUpdate } = props;
  const [items, setItems] = useState<PendingActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<InlineActionState>({});

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
      onBadgeUpdate?.(all.length);
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

  /* ─── Inline quick actions ─── */

  const handleApproval = useCallback(async (approvalId: string, decision: "approve" | "reject") => {
    setActionState((s) => ({ ...s, [approvalId]: "loading" }));
    try {
      const res = await apiFetch(`/approvals/${encodeURIComponent(approvalId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ decision, reason: decision === "approve" ? "Quick-approved from tray" : "Quick-rejected from tray" }),
      });
      if (res.ok) {
        setActionState((s) => ({ ...s, [approvalId]: "done" }));
        // Remove from list after brief delay
        setTimeout(() => setItems((prev) => prev.filter((it) => !(it.type === "approval" && it.data.approvalId === approvalId))), 800);
      } else {
        console.error(`[PendingActions] approval decision failed: ${res.status}`);
        setActionState((s) => ({ ...s, [approvalId]: "error" }));
      }
    } catch (err) {
      console.error("[PendingActions] approval decision error:", err);
      setActionState((s) => ({ ...s, [approvalId]: "error" }));
    }
  }, [locale]);

  const handleRetryRun = useCallback(async (runId: string) => {
    setActionState((s) => ({ ...s, [runId]: "loading" }));
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        locale,
      });
      if (res.ok) {
        setActionState((s) => ({ ...s, [runId]: "done" }));
        setTimeout(() => setItems((prev) => prev.filter((it) => !(it.type === "failed_run" && it.data.runId === runId))), 800);
      } else {
        console.error(`[PendingActions] retry run failed: ${res.status}`);
        setActionState((s) => ({ ...s, [runId]: "error" }));
      }
    } catch (err) {
      console.error("[PendingActions] retry run error:", err);
      setActionState((s) => ({ ...s, [runId]: "error" }));
    }
  }, [locale]);

  // Count by type
  return (
    <div className={styles.container}>
      {/* Content */}
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
                  actionState={actionState}
                  onApprove={(id) => handleApproval(id, "approve")}
                  onReject={(id) => handleApproval(id, "reject")}
                  onRetryRun={handleRetryRun}
                />
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
