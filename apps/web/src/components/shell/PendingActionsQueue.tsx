"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconChevronRight, IconCheck, IconX, IconRefresh } from "./ShellIcons";
import { formatToolRefLocalized, formatErrorCategory, shortId, timeAgo, preloadToolNames } from "./shellUtils";
import { useBottomPanel, type ActionStatus } from "./useBottomPanel";
import { PanelLoading, PanelError, PanelEmpty } from "./PanelState";
import styles from "@/styles/shell.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type PendingApproval = {
  approvalId: string;
  runId: string;
  stepId: string | null;
  status: string;
  toolRef: string | null;
  requestedAt: string;
  humanSummary?: string;
  taskGoal?: string;
};

type FailedRun = {
  runId: string;
  status: string;
  updatedAt: string;
  traceId: string | null;
  jobType?: string;
  trigger?: string;
  currentStep?: { toolRef?: string; name?: string };
  errorDigest?: { errorCategory?: string; message?: string };
};

type DeadletterStep = {
  runId: string;
  stepId: string;
  toolRef: string | null;
  status: string;
  attempt: number;
  deadletteredAt: string;
  errorCategory?: string;
};

type PendingActionItem =
  | { type: "approval"; data: PendingApproval }
  | { type: "failed_run"; data: FailedRun }
  | { type: "deadletter"; data: DeadletterStep };

/* ─── Per-group display limit ─── */

const GROUP_LIMIT = 5;

/* ─── Helper: human-readable label for failed runs ─── */

function getFailedRunLabel(data: FailedRun, locale: string): string {
  if (data.jobType) return `${data.jobType} - ${t(locale, "pendingActions.type.failedRun")}`;
  if (data.currentStep?.toolRef) {
    return `${formatToolRefLocalized(data.currentStep.toolRef, locale)} - ${t(locale, "pendingActions.type.failedRun")}`;
  }
  if (data.trigger) {
    const short = data.trigger.length > 20 ? data.trigger.slice(0, 20) + "…" : data.trigger;
    return `${short} - ${t(locale, "pendingActions.type.failedRun")}`;
  }
  return `${t(locale, "pendingActions.type.failedRun")} #${shortId(data.runId)}`;
}

/* ─── Action Item Component ─────────────────────────────────────────────────── */

function ActionItem(props: {
  item: PendingActionItem;
  locale: string;
  state: ActionStatus;
  errorMsg?: string;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  onRetryRun?: (runId: string) => void;
}) {
  const { item, locale, state, errorMsg, onApprove, onReject, onRetryRun } = props;

  if (item.type === "approval") {
    const { data } = item;
    const href = `/gov/approvals/${encodeURIComponent(data.approvalId)}?lang=${encodeURIComponent(locale)}`;
    const label = data.humanSummary || data.taskGoal || formatToolRefLocalized(data.toolRef, locale) || t(locale, "pendingActions.type.approval");
    return (
      <div className={styles.paqActionItem}>
        <span className={`${styles.statusDot} ${styles.statusDotOrange}`} />
        <Link href={href} className={styles.paqActionContent}>
          <span className={`${styles.actionLabel} ${styles.truncate}`} title={label}>
            {label}
          </span>
        </Link>
        <span className={styles.paqActionTime}>{timeAgo(data.requestedAt, locale, "pendingActions")}</span>
        {state === "done" ? (
          <span className={`${styles.actionBadge} ${styles.actionBadgeSuccess}`}>
            {t(locale, "pendingActions.done")}
          </span>
        ) : state === "error" ? (
          <span
            className={`${styles.actionBadge} ${styles.actionBadgeError}`}
            title={errorMsg || t(locale, "pendingActions.actionFailed")}
          >!</span>
        ) : (
          <span className={styles.paqInlineActions}>
            <button
              className={`${styles.inlineBtn} ${styles.inlineBtnApprove}`}
              disabled={state === "loading"}
              onClick={(e) => { e.stopPropagation(); onApprove?.(data.approvalId); }}
              title={t(locale, "pendingActions.quickApprove")}
            >
              <IconCheck /><span>{t(locale, "pendingActions.approve")}</span>
            </button>
            <button
              className={`${styles.inlineBtn} ${styles.inlineBtnReject}`}
              disabled={state === "loading"}
              onClick={(e) => { e.stopPropagation(); onReject?.(data.approvalId); }}
              title={t(locale, "pendingActions.quickReject")}
            >
              <IconX /><span>{t(locale, "pendingActions.reject")}</span>
            </button>
          </span>
        )}
      </div>
    );
  }

  if (item.type === "failed_run") {
    const { data } = item;
    const href = `/runs/${encodeURIComponent(data.runId)}?lang=${encodeURIComponent(locale)}`;
    const failedLabel = getFailedRunLabel(data, locale);
    return (
      <div className={styles.paqActionItem}>
        <span className={`${styles.statusDot} ${styles.statusDotRed}`} />
        <Link href={href} className={styles.paqActionContent}>
          <span className={`${styles.actionLabel} ${styles.truncate}`}>
            {failedLabel}
          </span>
        </Link>
        <span className={styles.paqActionTime}>{timeAgo(data.updatedAt, locale, "pendingActions")}</span>
        {state === "done" ? (
          <span className={`${styles.actionBadge} ${styles.actionBadgeSuccess}`}>
            {t(locale, "pendingActions.retried")}
          </span>
        ) : state === "error" ? (
          <span
            className={`${styles.actionBadge} ${styles.actionBadgeError}`}
            title={errorMsg || t(locale, "pendingActions.actionFailed")}
          >!</span>
        ) : (
          <span className={styles.paqInlineActions}>
            <button
              className={`${styles.inlineBtn} ${styles.inlineBtnRetry}`}
              disabled={state === "loading"}
              onClick={(e) => { e.stopPropagation(); onRetryRun?.(data.runId); }}
              title={t(locale, "pendingActions.quickRetry")}
            >
              <IconRefresh /><span>{t(locale, "common.retry")}</span>
            </button>
          </span>
        )}
      </div>
    );
  }

  if (item.type === "deadletter") {
    const { data } = item;
    const href = `/gov/workflow/deadletters?lang=${encodeURIComponent(locale)}`;
    const dlLabel = formatToolRefLocalized(data.toolRef, locale);
    const errorHint = data.errorCategory ? ` (${formatErrorCategory(data.errorCategory, locale)})` : "";
    return (
      <div className={styles.paqActionItem}>
        <span className={`${styles.statusDot} ${styles.statusDotGray}`} />
        <Link href={href} className={styles.paqActionContent}>
          <span className={`${styles.actionLabel} ${styles.truncate}`}>
            {dlLabel} #{data.attempt}{errorHint}
          </span>
        </Link>
        <span className={styles.paqActionTime}>{timeAgo(data.deadletteredAt, locale, "pendingActions")}</span>
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

  // Store error messages for inline actions
  const errorMsgs = useRef<Record<string, string>>({});

  const fetchAllPendingActions = useCallback(async (): Promise<PendingActionItem[]> => {
    const [approvalsRes, runsRes, deadlettersRes] = await Promise.all([
      apiFetch("/approvals?status=pending&limit=10", { locale, cache: "no-store" }),
      apiFetch("/runs?status=failed&limit=10", { locale, cache: "no-store" }),
      apiFetch("/governance/workflow/deadletters?limit=10", { locale, cache: "no-store" }),
    ]);

    const all: PendingActionItem[] = [];

    if (approvalsRes.ok) {
      const data = await approvalsRes.json();
      const approvals = (data.items as PendingApproval[]) ?? [];
      for (const a of approvals) all.push({ type: "approval", data: a });
    }

    if (runsRes.ok) {
      const data = await runsRes.json();
      const runs = (data.runs as FailedRun[]) ?? [];
      for (const r of runs) all.push({ type: "failed_run", data: r });
    }

    if (deadlettersRes.ok) {
      const data = await deadlettersRes.json();
      const deadletters = (data.deadletters as DeadletterStep[]) ?? [];
      for (const d of deadletters) all.push({ type: "deadletter", data: d });
    }

    // Sort by time (most recent first)
    all.sort((a, b) => {
      const timeA = a.type === "approval" ? a.data.requestedAt : a.type === "failed_run" ? a.data.updatedAt : a.data.deadletteredAt;
      const timeB = b.type === "approval" ? b.data.requestedAt : b.type === "failed_run" ? b.data.updatedAt : b.data.deadletteredAt;
      return new Date(timeB).getTime() - new Date(timeA).getTime();
    });

    return all;
  }, [locale]);

  const {
    items,
    loading,
    error,
    reload,
    actionStates,
    setActionState,
    resetActionState,
    itemCount,
  } = useBottomPanel<PendingActionItem>({
    fetchFn: fetchAllPendingActions,
    refreshInterval: 30000,
    enabled: true,
  });

  // Preload tool display names from backend metadata
  useEffect(() => { preloadToolNames(); }, []);

  // Sync badge count (total, not just displayed)
  useEffect(() => {
    onBadgeUpdate?.(itemCount);
  }, [itemCount, onBadgeUpdate]);

  /* ─── Split items into typed groups ─── */
  const groups = useMemo(() => {
    const approvals: PendingActionItem[] = [];
    const failedRuns: PendingActionItem[] = [];
    const deadletters: PendingActionItem[] = [];
    for (const it of items) {
      if (it.type === "approval") approvals.push(it);
      else if (it.type === "failed_run") failedRuns.push(it);
      else deadletters.push(it);
    }
    return [
      { key: "approval" as const, label: t(locale, "pendingActions.group.approval") || "Pending Approvals", items: approvals, dot: styles.statusDotOrange },
      { key: "failed_run" as const, label: t(locale, "pendingActions.group.failedRun") || "Failed Runs", items: failedRuns, dot: styles.statusDotRed },
      { key: "deadletter" as const, label: t(locale, "pendingActions.group.deadletter") || "Deadletter Queue", items: deadletters, dot: styles.statusDotGray },
    ].filter((g) => g.items.length > 0);
  }, [items, locale]);

  // Collapse / expand state per group
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleCollapse = (key: string) => setCollapsed((p) => ({ ...p, [key]: !p[key] }));
  const toggleExpand = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));

  /* ─── Inline quick actions ─── */

  const handleApproval = useCallback(async (approvalId: string, decision: "approve" | "reject") => {
    setActionState(approvalId, "loading");
    try {
      const res = await apiFetch(`/approvals/${encodeURIComponent(approvalId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ decision, reason: decision === "approve" ? t(locale, "pendingActions.quickApproveReason") : t(locale, "pendingActions.quickRejectReason") }),
      });
      if (res.ok) {
        setActionState(approvalId, "done");
      } else {
        const msg = `${decision} failed: ${res.status}`;
        console.error(`[PendingActions] approval decision failed: ${res.status}`);
        errorMsgs.current[approvalId] = msg;
        setActionState(approvalId, "error");
        resetActionState(approvalId, 3000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network_error";
      console.error("[PendingActions] approval decision error:", err);
      errorMsgs.current[approvalId] = msg;
      setActionState(approvalId, "error");
      resetActionState(approvalId, 3000);
    }
  }, [locale, setActionState, resetActionState]);

  const handleRetryRun = useCallback(async (runId: string) => {
    setActionState(runId, "loading");
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        locale,
      });
      if (res.ok) {
        setActionState(runId, "done");
      } else {
        const msg = `retry failed: ${res.status}`;
        console.error(`[PendingActions] retry run failed: ${res.status}`);
        errorMsgs.current[runId] = msg;
        setActionState(runId, "error");
        resetActionState(runId, 3000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network_error";
      console.error("[PendingActions] retry run error:", err);
      errorMsgs.current[runId] = msg;
      setActionState(runId, "error");
      resetActionState(runId, 3000);
    }
  }, [locale, setActionState, resetActionState]);

  /* ─── Helper: get item ID ─── */
  function getItemId(item: PendingActionItem): string {
    return item.type === "approval" ? item.data.approvalId : item.type === "failed_run" ? item.data.runId : item.data.stepId;
  }

  return (
    <div className={styles.panelWrap}>
      {loading && <PanelLoading message={t(locale, "pendingActions.loading")} />}

      {!loading && error && (
        <PanelError message={t(locale, "pendingActions.error")} onRetry={reload} />
      )}

      {!loading && !error && items.length === 0 && (
        <PanelEmpty message={t(locale, "pendingActions.empty")} />
      )}

      {!loading && !error && items.length > 0 && (
        <div className={styles.paqActionList}>
          {groups.map((group) => {
            const isCollapsed = !!collapsed[group.key];
            const isExpanded = !!expanded[group.key];
            const visibleItems = isExpanded ? group.items : group.items.slice(0, GROUP_LIMIT);
            const overflowN = group.items.length - GROUP_LIMIT;
            return (
              <div key={group.key} className={styles.paqGroup}>
                <button
                  className={styles.paqGroupHeader}
                  onClick={() => toggleCollapse(group.key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`${styles.statusDot} ${group.dot}`} />
                  <span className={styles.paqGroupTitle}>{group.label}</span>
                  <span className={styles.paqGroupBadge}>{group.items.length}</span>
                  <span className={`${styles.paqGroupArrow} ${isCollapsed ? "" : styles.paqGroupArrowOpen}`}>
                    <IconChevronRight />
                  </span>
                </button>
                {!isCollapsed && (
                  <>
                    {visibleItems.map((item, idx) => {
                      const id = getItemId(item);
                      return (
                        <ActionItem
                          key={`${item.type}_${id}_${idx}`}
                          item={item}
                          locale={locale}
                          state={(actionStates[id] ?? "idle") as ActionStatus}
                          errorMsg={errorMsgs.current[id]}
                          onApprove={(aid) => handleApproval(aid, "approve")}
                          onReject={(aid) => handleApproval(aid, "reject")}
                          onRetryRun={handleRetryRun}
                        />
                      );
                    })}
                    {!isExpanded && overflowN > 0 && (
                      <button
                        className={styles.paqShowMore}
                        onClick={() => toggleExpand(group.key)}
                      >
                        {(t(locale, "pendingActions.showMore") || "Show more ({n} more)").replace("{n}", String(overflowN))}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
