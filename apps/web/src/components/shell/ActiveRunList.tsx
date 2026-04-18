"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconX } from "./ShellIcons";
import { formatToolRef, timeAgo } from "./shellUtils";
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

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function dotClass(phase: string): string {
  switch (phase) {
    case "executing": case "running":
      return styles.statusDotRunning;
    case "needs_approval": case "needs_device": case "needs_arbiter":
      return styles.statusDotBlocked;
    default:
      return "";
  }
}

/* ─── Run Item Component ────────────────────────────────────────────────────── */

function RunItem(props: { run: ActiveRun; locale: string; cancelState: string; onCancel: (runId: string) => void }) {
  const { run, locale, cancelState, onCancel } = props;
  const runHref = `/runs/${encodeURIComponent(run.runId)}?lang=${encodeURIComponent(locale)}`;
  const stepLabel = run.currentStep
    ? `${run.currentStep.name ?? formatToolRef(run.currentStep.toolRef)}`
    : null;

  return (
    <div className={styles.runItem}>
      {/* Status dot */}
      <span className={`${styles.statusDot} ${dotClass(run.phase)}`} />

      {/* Info block (clickable link) */}
      <Link href={runHref} className={styles.runInfo}>
        {/* Row 1: ID + phase + step count */}
        <div className={styles.runRow1}>
          <span className={styles.runId}>{shortId(run.runId)}</span>
          <span className={styles.runPhase}>{t(locale, `activeRuns.phase.${run.phase}`)}</span>
          <span className={styles.runStepCount}>
            {t(locale, "activeRuns.step")} {run.progress.current}/{run.progress.total}
          </span>
        </div>
        {/* Row 2: tool/step name (if available) */}
        {stepLabel && (
          <div className={styles.runRow2}>
            <span className={styles.toolName}>{stepLabel}</span>
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
        ) : (
          <button
            className={styles.cancelBtn}
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
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelState, setCancelState] = useState<Record<string, "idle" | "loading" | "done" | "error">>({});

  const fetchRuns = useCallback(async () => {
    try {
      const res = await apiFetch("/runs/active?limit=10", { locale, cache: "no-store" });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const data = await res.json();
      setRuns((data.activeRuns as ActiveRun[]) ?? []);
      const count = ((data.activeRuns as unknown[]) ?? []).length;
      onBadgeUpdate?.(count);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "fetch_error");
    } finally {
      setLoading(false);
    }
  }, [locale]);

  const handleCancel = useCallback(async (runId: string) => {
    setCancelState((s) => ({ ...s, [runId]: "loading" }));
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", locale });
      if (res.ok || res.status === 409) {
        setCancelState((s) => ({ ...s, [runId]: "done" }));
        setTimeout(() => setRuns((prev) => prev.filter((r) => r.runId !== runId)), 800);
      } else {
        setCancelState((s) => ({ ...s, [runId]: "error" }));
      }
    } catch {
      setCancelState((s) => ({ ...s, [runId]: "error" }));
    }
  }, [locale]);

  // Initial fetch
  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const timer = setInterval(fetchRuns, 10_000);
    return () => clearInterval(timer);
  }, [fetchRuns]);

  return (
    <div className={styles.container}>
      {/* Content */}
      <div className={styles.content}>
        {loading && (
          <div className={styles.loadingState}>
            <span className={styles.spinner} />
            <span>{t(locale, "activeRuns.loading")}</span>
          </div>
        )}

        {!loading && error && (
          <div className={styles.errorState}>
            <span>{t(locale, "activeRuns.error")}</span>
            <button className={styles.retryBtn} onClick={fetchRuns}>
              {t(locale, "activeRuns.retry")}
            </button>
          </div>
        )}

        {!loading && !error && runs.length === 0 && (
          <div className={styles.emptyState}>
            <span>{t(locale, "activeRuns.empty")}</span>
          </div>
        )}

        {!loading && !error && runs.length > 0 && (
          <div className={styles.runList}>
            {runs.map((run) => (
              <RunItem key={run.runId} run={run} locale={locale} cancelState={cancelState[run.runId] ?? "idle"} onCancel={handleCancel} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
