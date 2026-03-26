"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import styles from "./RunHistoryPanel.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

interface RunItem {
  runId: string;
  status: string;
  toolRef: string;
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

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconPlay() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>;
}

function IconCheck() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>;
}

function IconX() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
}

function IconClock() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
}

function IconChevronDown() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>;
}

function IconChevronUp() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15" /></svg>;
}

function IconRefresh() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function RunHistoryPanel({ locale }: { locale: string }) {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(false);

  // Fetch recent runs
  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/runs?limit=20`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { runs?: RunItem[] };
        setRuns(data.runs || []);
      }
    } catch {
      // Ignore
    }
    setLoading(false);
  }, [locale]);

  // Fetch steps for selected run
  const fetchSteps = useCallback(async (runId: string) => {
    setStepsLoading(true);
    try {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { steps?: StepItem[] };
        setSteps(data.steps || []);
      }
    } catch {
      setSteps([]);
    }
    setStepsLoading(false);
  }, [locale]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial data load
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (selectedRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Load steps when run selected
      fetchSteps(selectedRunId);
    } else {
      setSteps([]);
    }
  }, [selectedRunId, fetchSteps]);

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
      case "succeeded": return styles.statusSucceeded;
      case "failed":
      case "deadletter": return styles.statusFailed;
      case "canceled": return styles.statusCanceled;
      case "running": return styles.statusRunning;
      default: return styles.statusPending;
    }
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  const parseToolName = (toolRef: string) => {
    const idx = toolRef.lastIndexOf("@");
    return idx > 0 ? toolRef.slice(0, idx) : toolRef;
  };

  return (
    <div className={styles.runHistoryPanel}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>{t(locale, "runHistory.title")}</span>
        <button className={styles.refreshBtn} onClick={fetchRuns} disabled={loading}>
          <IconRefresh /> {t(locale, "runHistory.refresh")}
        </button>
      </div>

      {/* Content */}
      <div className={styles.content}>
        {/* Run list */}
        <div className={styles.runList}>
          {loading && runs.length === 0 ? (
            <div className={styles.loading}>{t(locale, "common.loading")}</div>
          ) : runs.length === 0 ? (
            <div className={styles.empty}>{t(locale, "runHistory.empty")}</div>
          ) : (
            runs.map((run) => (
              <div
                key={run.runId}
                className={`${styles.runItem} ${selectedRunId === run.runId ? styles.runItemSelected : ""}`}
                onClick={() => setSelectedRunId(selectedRunId === run.runId ? null : run.runId)}
              >
                <div className={styles.runItemMain}>
                  <span className={`${styles.runItemStatus} ${getStatusClass(run.status)}`}>
                    {getStatusIcon(run.status)}
                  </span>
                  <span className={styles.runItemTool}>{parseToolName(run.toolRef)}</span>
                  <span className={styles.runItemTime}>{formatTime(run.createdAt)}</span>
                  <span className={styles.runItemExpand}>
                    {selectedRunId === run.runId ? <IconChevronUp /> : <IconChevronDown />}
                  </span>
                </div>
                
                {/* Step timeline */}
                {selectedRunId === run.runId && (
                  <div className={styles.stepTimeline}>
                    {stepsLoading ? (
                      <div className={styles.stepsLoading}>{t(locale, "common.loading")}</div>
                    ) : steps.length === 0 ? (
                      <div className={styles.stepsEmpty}>{t(locale, "runHistory.noSteps")}</div>
                    ) : (
                      <div className={styles.steps}>
                        {steps.map((step, idx) => (
                          <div key={step.stepId} className={styles.stepItem}>
                            <div className={styles.stepTimestamp}>
                              {step.startedAt ? formatTime(step.startedAt) : "-"}
                            </div>
                            <div className={styles.stepConnector}>
                              <div className={`${styles.stepDot} ${getStatusClass(step.status)}`} />
                              {idx < steps.length - 1 && <div className={styles.stepLine} />}
                            </div>
                            <div className={styles.stepContent}>
                              <div className={styles.stepHeader}>
                                <span className={`${styles.stepStatus} ${getStatusClass(step.status)}`}>
                                  {getStatusIcon(step.status)}
                                </span>
                                <span className={styles.stepTool}>{parseToolName(step.toolRef)}</span>
                                {step.latencyMs != null && (
                                  <span className={styles.stepLatency}>{formatDuration(step.latencyMs)}</span>
                                )}
                              </div>
                              {step.errorCategory && (
                                <div className={styles.stepError}>{step.errorCategory}</div>
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
                      >
                        {t(locale, "runHistory.viewDetails")}
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
