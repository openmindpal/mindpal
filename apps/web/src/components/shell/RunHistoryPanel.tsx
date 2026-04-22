"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconPlay, IconCheck, IconX, IconClock, IconChevronDown14, IconChevronUp14, IconRefresh } from "./ShellIcons";
import { formatToolRefLocalized, formatDuration, formatTime, formatErrorCategory, shortId, preloadToolNames } from "./shellUtils";
import { useBottomPanel } from "./useBottomPanel";
import { PanelLoading, PanelError, PanelEmpty } from "./PanelState";
import styles from "@/styles/shell.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

interface RunItem {
  runId: string;
  status: string;
  toolRef?: string;
  jobType?: string;
  trigger?: string;
  currentStep?: { toolRef?: string; name?: string };
  errorDigest?: { errorCategory?: string; message?: string };
  createdAt: string;
  finishedAt?: string;
}

interface StepItem {
  stepId: string;
  runId: string;
  seq: number;
  status: string;
  toolRef: string;
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  errorCategory?: string;
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function RunHistoryPanel({ locale }: { locale: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, StepItem[]>>({});
  const [stepsLoading, setStepsLoading] = useState(false);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const stepCache = useRef<Record<string, StepItem[]>>({});

  const fetchRuns = useCallback(async (): Promise<RunItem[]> => {
    const statusParam = statusFilter !== "all" ? `&status=${encodeURIComponent(statusFilter)}` : "";
    const res = await apiFetch(`/runs?limit=20${statusParam}`, { method: "GET", locale });
    if (res.ok) {
      const data = await res.json() as { runs?: RunItem[] };
      return data.runs || [];
    }
    throw new Error("fetch_error");
  }, [locale, statusFilter]);

  const { items: runs, loading, error, reload } = useBottomPanel<RunItem>({
    fetchFn: fetchRuns,
    refreshInterval: 30_000,
  });

  // Preload tool display names from backend metadata
  useEffect(() => { preloadToolNames(); }, []);

  // Load steps with cache — avoids redundant API calls on re-expand
  const loadSteps = useCallback(async (runId: string) => {
    if (stepCache.current[runId]) {
      setExpandedSteps(prev => ({ ...prev, [runId]: stepCache.current[runId] }));
      setStepsError(null);
      return;
    }
    setStepsLoading(true);
    setStepsError(null);
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { steps?: StepItem[] };
        const steps = data.steps || [];
        stepCache.current[runId] = steps;
        setExpandedSteps(prev => ({ ...prev, [runId]: steps }));
      } else {
        throw new Error("fetch_error");
      }
    } catch {
      setStepsError(runId);
    }
    setStepsLoading(false);
  }, [locale]);

  const toggleRun = useCallback((runId: string) => {
    if (selectedRunId === runId) {
      setSelectedRunId(null);
      setStepsError(null);
    } else {
      setSelectedRunId(runId);
      loadSteps(runId);
    }
  }, [selectedRunId, loadSteps]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "succeeded": return <IconCheck />;
      case "failed":
      case "canceled":
      case "deadletter": return <IconX />;
      case "running":
      case "pending": return <IconPlay />;
      default: return <IconClock />;
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case "succeeded": return styles.rhpStatusSucceeded;
      case "failed":
      case "deadletter": return styles.rhpStatusFailed;
      case "canceled": return styles.statusCanceled;
      case "running": return styles.rhpStatusRunning;
      default: return styles.rhpStatusPending;
    }
  };

  const fmtTime = (ts: string) => formatTime(ts, locale);

  function getRunLabel(run: RunItem): string {
    if (run.jobType) return run.jobType;
    if (run.currentStep?.toolRef) return formatToolRefLocalized(run.currentStep.toolRef, locale);
    if (run.currentStep?.name) return run.currentStep.name;
    if (run.trigger) return run.trigger.length > 30 ? run.trigger.slice(0, 30) + "…" : run.trigger;
    if (run.toolRef) return formatToolRefLocalized(run.toolRef, locale);
    return `#${shortId(run.runId)}`;
  }

  const currentSteps = selectedRunId ? expandedSteps[selectedRunId] : undefined;

  return (
    <div className={styles.runHistoryPanel}>
      {/* Header */}
      <div className={styles.rhpHeader}>
        <span className={styles.rhpTitle}>{t(locale, "runHistory.title")}</span>
        <div className={styles.rhpHeaderActions}>
          <select
            className={styles.statusFilter}
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setSelectedRunId(null); }}
          >
            <option value="all">{t(locale, "runHistory.filter.all")}</option>
            <option value="succeeded">{t(locale, "runHistory.filter.succeeded")}</option>
            <option value="failed">{t(locale, "runHistory.filter.failed")}</option>
            <option value="running">{t(locale, "runHistory.filter.running")}</option>
          </select>
          <button className={styles.rhpRefreshBtn} onClick={reload} disabled={loading}>
            <IconRefresh /> {t(locale, "runHistory.refresh")}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={styles.rhpContent}>
        {loading && runs.length === 0 ? (
          <PanelLoading message={t(locale, "common.loading")} />
        ) : error ? (
          <PanelError message={error} onRetry={reload} />
        ) : runs.length === 0 ? (
          <PanelEmpty message={t(locale, "runHistory.empty")} />
        ) : (
          <div className={styles.rhpRunList}>
            {runs.map((run) => (
              <div
                key={run.runId}
                className={`${styles.rhpRunItem} ${selectedRunId === run.runId ? styles.runItemSelected : ""}`}
                onClick={() => toggleRun(run.runId)}
              >
                <div className={`${styles.runItemMain} ${styles.itemRow}`}>
                  <span className={`${styles.runItemStatus} ${getStatusClass(run.status)}`}>
                    {getStatusIcon(run.status)}
                  </span>
                  <span className={`${styles.runItemTool} ${styles.truncate}`}>{getRunLabel(run)}</span>
                  {run.status === "failed" && run.errorDigest?.message && (
                    <span className={styles.errorHint} title={run.errorDigest.message}>
                      {formatErrorCategory(run.errorDigest.errorCategory, locale) || run.errorDigest.message.slice(0, 20)}
                    </span>
                  )}
                  <span className={`${styles.runItemTime} ${styles.monoText}`}>{fmtTime(run.createdAt)}</span>
                  <span className={styles.runItemExpand}>
                    {selectedRunId === run.runId ? <IconChevronUp14 /> : <IconChevronDown14 />}
                  </span>
                </div>
                
                {/* Step timeline */}
                {selectedRunId === run.runId && (
                  <div className={styles.stepTimeline}>
                    {stepsLoading ? (
                      <PanelLoading message={t(locale, "common.loading")} />
                    ) : stepsError === run.runId ? (
                      <div className={styles.stepsEmpty}>
                        <span>{t(locale, "runHistory.stepsLoadFailed")}</span>
                        <button
                          className={styles.retryBtn}
                          onClick={(e) => { e.stopPropagation(); loadSteps(run.runId); }}
                        >
                          {t(locale, "common.retry")}
                        </button>
                      </div>
                    ) : !currentSteps || currentSteps.length === 0 ? (
                      <PanelEmpty message={t(locale, "runHistory.noSteps")} />
                    ) : (
                      <div className={styles.steps}>
                        {currentSteps.map((step, idx) => (
                          <div key={step.stepId} className={styles.rhpStepItem}>
                            <div className={styles.stepTimestamp}>
                              {step.startedAt ? fmtTime(step.startedAt) : "-"}
                            </div>
                            <div className={styles.stepConnector}>
                              <div className={`${styles.stepDot} ${getStatusClass(step.status)}`} />
                              {idx < currentSteps.length - 1 && <div className={styles.stepLine} />}
                            </div>
                            <div className={styles.rhpStepContent}>
                              <div className={styles.stepHeader}>
                                <span className={`${styles.rhpStepStatus} ${getStatusClass(step.status)}`}>
                                  {getStatusIcon(step.status)}
                                </span>
                                <span className={`${styles.stepTool} ${styles.truncate}`}>{formatToolRefLocalized(step.toolRef, locale)}</span>
                                {step.latencyMs != null && (
                                  <span className={`${styles.stepLatency} ${styles.monoText}`}>{formatDuration(step.latencyMs)}</span>
                                )}
                              </div>
                              {step.errorCategory && (
                                <div className={styles.stepError}>{formatErrorCategory(step.errorCategory, locale)}</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className={styles.stepActions}>
                      <Link
                        href={`/runs/${encodeURIComponent(run.runId)}?lang=${encodeURIComponent(locale)}`}
                        className={styles.viewDetailsLink}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t(locale, "runHistory.viewDetails")}
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
