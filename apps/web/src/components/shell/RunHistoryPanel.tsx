"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconPlay, IconCheck, IconX, IconClock, IconChevronDown14, IconChevronUp14, IconRefresh } from "./ShellIcons";
import { formatToolRef, formatDuration, formatTime } from "./shellUtils";
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

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function RunHistoryPanel({ locale }: { locale: string }) {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Fetch recent runs
  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const statusParam = statusFilter !== "all" ? `&status=${encodeURIComponent(statusFilter)}` : "";
      const res = await apiFetch(`/runs?limit=20${statusParam}`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { runs?: RunItem[] };
        setRuns(data.runs || []);
      }
    } catch {
      // Ignore
    }
    setLoading(false);
  }, [locale, statusFilter]);

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

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const timer = setInterval(fetchRuns, 30_000);
    return () => clearInterval(timer);
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

  const fmtTime = (ts: string) => formatTime(ts, locale);

  return (
    <div className={styles.runHistoryPanel}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>{t(locale, "runHistory.title")}</span>
        <div className={styles.headerActions}>
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
          <button className={styles.refreshBtn} onClick={fetchRuns} disabled={loading}>
            <IconRefresh /> {t(locale, "runHistory.refresh")}
          </button>
        </div>
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
                  <span className={styles.runItemTool}>{formatToolRef(run.toolRef)}</span>
                  <span className={styles.runItemTime}>{fmtTime(run.createdAt)}</span>
                  <span className={styles.runItemExpand}>
                    {selectedRunId === run.runId ? <IconChevronUp14 /> : <IconChevronDown14 />}
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
                              {step.startedAt ? fmtTime(step.startedAt) : "-"}
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
                                <span className={styles.stepTool}>{formatToolRef(step.toolRef)}</span>
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
