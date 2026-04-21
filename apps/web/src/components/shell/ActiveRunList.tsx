"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconX } from "./ShellIcons";
import { formatToolRefLocalized, shortId, timeAgo, preloadToolNames } from "./shellUtils";
import { useBottomPanel, type ActionStatus } from "./useBottomPanel";
import { PanelLoading, PanelError, PanelEmpty } from "./PanelState";
import shared from "./bottomTray.shared.module.css";
import styles from "./ActiveRunList.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type ActiveRun = {
  runId: string;
  status: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  traceId: string | null;
  progress: {
    current: number;
    total: number;
    percentage: number;
  };
  currentStep: {
    stepId: string;
    seq: number;
    status: string;
    toolRef: string | null;
    name: string | null;
    attempt: number;
  } | null;
};

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function dotClass(phase: string): string {
  switch (phase) {
    case "executing": case "running":
      return `${shared.statusDotGreen} ${shared.statusDotPulse}`;
    case "needs_approval": case "needs_device": case "needs_arbiter":
      return shared.statusDotOrange;
    default:
      return "";
  }
}

/* ─── Run Item Component ────────────────────────────────────────────────────── */

function RunItem(props: {
  run: ActiveRun;
  locale: string;
  cancelState: ActionStatus;
  cancelError?: string;
  onCancel: (runId: string) => void;
}) {
  const { run, locale, cancelState, cancelError, onCancel } = props;
  const runHref = `/runs/${encodeURIComponent(run.runId)}?lang=${encodeURIComponent(locale)}`;
  const stepLabel = run.currentStep
    ? `${run.currentStep.name ?? formatToolRefLocalized(run.currentStep.toolRef, locale)}`
    : null;

  return (
    <div className={styles.runItem}>
      {/* Status dot */}
      <span className={`${shared.statusDot} ${styles.statusDotAlign} ${dotClass(run.phase)}`} />

      {/* Info block (clickable link) */}
      <Link href={runHref} className={styles.runInfo}>
        {/* Row 1: ID + phase + step count */}
        <div className={styles.runRow1}>
          <span className={shared.monoText}>#{shortId(run.runId)}</span>
          <span className={styles.runPhase}>{t(locale, `activeRuns.phase.${run.phase}`)}</span>
          <span className={styles.runStepCount}>
            {t(locale, "activeRuns.step")} {run.progress.current}/{run.progress.total}
          </span>
        </div>
        {/* Row 2: tool/step name (if available) */}
        {stepLabel && (
          <div className={styles.runRow2}>
            <span className={shared.truncate}>{stepLabel}</span>
            {run.currentStep!.attempt > 1 && (
              <span className={styles.stepAttempt}>
                {t(locale, "activeRuns.retry")} #{run.currentStep!.attempt}
              </span>
            )}
          </div>
        )}
        {/* Row 3: progress bar */}
        <div className={styles.runRow3}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${run.progress.percentage}%` }} />
          </div>
          <span className={styles.progressText}>{run.progress.percentage}%</span>
        </div>
      </Link>

      {/* Right: time + cancel */}
      <div className={styles.runActions}>
        <span className={styles.runTime}>{timeAgo(run.updatedAt, locale, "activeRuns")}</span>
        {cancelState === "done" ? (
          <span className={styles.cancelDone}>{t(locale, "activeRuns.cancelled")}</span>
        ) : cancelState === "error" ? (
          <button
            className={`${shared.actionBtn} ${styles.cancelBtnDanger}`}
            onClick={(e) => { e.stopPropagation(); onCancel(run.runId); }}
            title={cancelError || t(locale, "activeRuns.cancelFailed")}
          >
            <IconX />
          </button>
        ) : (
          <button
            className={`${shared.actionBtn} ${styles.cancelBtnDanger}`}
            disabled={cancelState === "loading"}
            onClick={(e) => { e.stopPropagation(); onCancel(run.runId); }}
            title={t(locale, "activeRuns.cancel")}
          >
            <IconX />
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main ActiveRunList Component ──────────────────────────────────────────── */

export default function ActiveRunList(props: {
  locale: string;
  onBadgeUpdate?: (count: number) => void;
}) {
  const { locale, onBadgeUpdate } = props;

  const fetchFn = useCallback(async (): Promise<ActiveRun[]> => {
    const res = await apiFetch("/runs/active?limit=10", { locale, cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return (data.activeRuns as ActiveRun[]) ?? [];
  }, [locale]);

  const {
    items: runs,
    loading,
    error,
    reload,
    actionStates,
    setActionState,
    resetActionState,
  } = useBottomPanel<ActiveRun>({
    fetchFn,
    refreshInterval: 10000,
    enabled: true,
  });

  // Preload tool display names from backend metadata
  useEffect(() => { preloadToolNames(); }, []);

  // Sync badge count
  useEffect(() => {
    onBadgeUpdate?.(runs.length);
  }, [runs.length, onBadgeUpdate]);

  // Cancel error messages stored alongside state
  const cancelErrors: Record<string, string> = {};

  const handleCancel = useCallback(async (runId: string) => {
    setActionState(runId, "loading");
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", locale });
      if (res.ok) {
        setActionState(runId, "done");
      } else if (res.status === 409) {
        // 409: run already terminated — mark as "done" (已终止)
        setActionState(runId, "done");
      } else {
        setActionState(runId, "error");
        resetActionState(runId, 3000);
      }
    } catch (err) {
      setActionState(runId, "error");
      cancelErrors[runId] = err instanceof Error ? err.message : "network_error";
      resetActionState(runId, 3000);
    }
  }, [locale, setActionState, resetActionState]);

  return (
    <div className={shared.panelWrap}>
      {loading && <PanelLoading message={t(locale, "activeRuns.loading")} />}

      {!loading && error && (
        <PanelError message={t(locale, "activeRuns.error")} onRetry={reload} />
      )}

      {!loading && !error && runs.length === 0 && (
        <PanelEmpty message={t(locale, "activeRuns.empty")} />
      )}

      {!loading && !error && runs.length > 0 && (
        <div className={styles.runList}>
          {runs.map((run) => (
            <RunItem
              key={run.runId}
              run={run}
              locale={locale}
              cancelState={(actionStates[run.runId] ?? "idle") as ActionStatus}
              cancelError={cancelErrors[run.runId]}
              onCancel={handleCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
