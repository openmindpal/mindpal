"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
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

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconPlay() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
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

function getPhaseIcon(phase: string) {
  switch (phase) {
    case "executing":
    case "running":
      return <IconPlay />;
    case "needs_approval":
    case "needs_device":
    case "needs_arbiter":
      return <IconPause />;
    default:
      return <IconClock />;
  }
}

function getPhaseClass(phase: string): string {
  switch (phase) {
    case "executing":
    case "running":
      return styles.phaseExecuting;
    case "needs_approval":
    case "needs_device":
    case "needs_arbiter":
      return styles.phaseBlocked;
    case "reviewing":
      return styles.phaseReviewing;
    default:
      return styles.phasePending;
  }
}

function timeAgo(dateStr: string, locale: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return t(locale, "activeRuns.justNow");
  if (diffMin < 60) return t(locale, "activeRuns.minutesAgo").replace("{n}", String(diffMin));
  if (diffHr < 24) return t(locale, "activeRuns.hoursAgo").replace("{n}", String(diffHr));
  return t(locale, "activeRuns.daysAgo").replace("{n}", String(Math.floor(diffHr / 24)));
}

/* ─── Run Item Component ────────────────────────────────────────────────────── */

function RunItem(props: { run: ActiveRun; locale: string; onSelect?: (runId: string) => void }) {
  const { run, locale, onSelect } = props;
  const runHref = `/runs/${encodeURIComponent(run.runId)}?lang=${encodeURIComponent(locale)}`;

  const handleClick = (e: React.MouseEvent) => {
    if (onSelect) {
      e.preventDefault();
      onSelect(run.runId);
    }
  };

  return (
    <Link href={runHref} className={styles.runItem} onClick={handleClick}>
      <div className={styles.runHeader}>
        <span className={`${styles.phaseIndicator} ${getPhaseClass(run.phase)}`}>
          {getPhaseIcon(run.phase)}
        </span>
        <span className={styles.runPhase}>{t(locale, `activeRuns.phase.${run.phase}`)}</span>
        <span className={styles.runTime}>{timeAgo(run.updatedAt, locale)}</span>
      </div>

      {run.currentStep && (
        <div className={styles.stepInfo}>
          <span className={styles.stepName}>
            {run.currentStep.name ?? formatToolRef(run.currentStep.toolRef)}
          </span>
          {run.currentStep.attempt > 1 && (
            <span className={styles.stepAttempt}>
              #{run.currentStep.attempt}
            </span>
          )}
        </div>
      )}

      <div className={styles.runFooter}>
        <div className={styles.progressBar}>
          <div
            className={styles.progressFill}
            style={{ width: `${run.progress.percentage}%` }}
          />
        </div>
        <span className={styles.progressText}>
          {run.progress.current}/{run.progress.total}
        </span>
        <span className={styles.runArrow}>
          <IconChevronRight />
        </span>
      </div>
    </Link>
  );
}

/* ─── Main ActiveRunList Component ──────────────────────────────────────────── */

export default function ActiveRunList(props: {
  locale: string;
  onSelectRun?: (runId: string) => void;
  collapsed?: boolean;
}) {
  const { locale, onSelectRun, collapsed } = props;
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await apiFetch("/runs/active?limit=10", { locale, cache: "no-store" });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const data = await res.json();
      setRuns((data.activeRuns as ActiveRun[]) ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "fetch_error");
    } finally {
      setLoading(false);
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

  if (collapsed) return null;

  const toggleExpand = () => setExpanded((e) => !e);

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
        <span className={styles.headerTitle}>{t(locale, "activeRuns.title")}</span>
        {runs.length > 0 && (
          <span className={styles.headerCount}>{runs.length}</span>
        )}
      </button>

      {/* Content */}
      {expanded && (
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
                <RunItem key={run.runId} run={run} locale={locale} onSelect={onSelectRun} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
