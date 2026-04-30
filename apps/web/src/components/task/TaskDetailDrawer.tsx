"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { statusTone, statusIcon, formatTime } from "@/lib/taskUIUtils";
import { friendlyOutputSummary, friendlyErrorMessage, friendlyToolName } from "@/app/homeHelpers";
import { Badge } from "@/components/ui";
import { TaskProgressBar } from "@/components/flow/TaskProgressBar";
import type { TaskProgress, TaskStepEntry } from "@/app/homeHelpers";

/* ── Props ─── */

export interface TaskDetailDrawerProps {
  taskId: string;
  runId?: string;
  locale: string;
  onClose: () => void;
}

/* ── API response shape (subset of RunDetailDTO) ─── */

type RunDetail = {
  runId: string;
  status: string;
  phase: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  jobType: string | null;
  traceId: string | null;
  progress: { current: number; total: number; percentage: number };
  currentStep: { stepId: string; seq: number; status: string; toolRef: string | null; name: string | null; attempt: number } | null;
  errorDigest: { errorCategory: string | null; message: string | null } | null;
  outputDigest: unknown;
  blockReason: string | null;
  steps?: { stepId: string; seq: number; status: string; toolRef: string | null; durationMs: number | null }[];
};

/* ── Helpers ─── */

function fmtDuration(ms: number | null, locale: string): string {
  if (ms == null) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}${t(locale, "taskDetail.sec")}`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}${t(locale, "taskDetail.min")}${s}${t(locale, "taskDetail.sec")}`;
}

function toProgress(d: RunDetail): TaskProgress | null {
  if (!d.steps?.length && !d.currentStep) return null;
  const steps: TaskStepEntry[] = (d.steps ?? []).map((s) => ({
    id: s.stepId,
    seq: s.seq,
    toolRef: s.toolRef ?? "unknown",
    status: s.status as TaskStepEntry["status"],
    ts: Date.now(),
  }));
  return { taskId: d.runId, runId: d.runId, phase: d.phase ?? d.status, steps, createdAt: new Date(d.createdAt).getTime() };
}

const isTerminal = (s: string) => ["succeeded", "completed", "failed", "canceled", "cancelled", "deadletter"].includes(s);
const isRunning = (s: string) => ["running", "executing", "queued", "pending", "created"].includes(s);

/* ── Overlay backdrop ─── */

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.25)", zIndex: 49,
};

const drawerStyle: React.CSSProperties = {
  position: "fixed", right: 0, top: 0, bottom: 0, width: 420,
  background: "var(--bg-surface, #fff)", borderLeft: "1px solid var(--border, #e5e5e5)",
  zIndex: 50, display: "flex", flexDirection: "column", overflow: "hidden",
};

/* ── Component ─── */

export default function TaskDetailDrawer({ taskId, runId, locale, onClose }: TaskDetailDrawerProps) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  /* Fetch detail */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    const id = runId ?? taskId;
    apiFetch(`/runs/${encodeURIComponent(id)}`, { locale })
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setDetail(json as RunDetail); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, runId, locale]);

  /* Action helper */
  const act = useCallback(async (url: string, method = "POST") => {
    setActionBusy(true);
    try {
      await apiFetch(url, { method, locale });
      // re-fetch
      const id = runId ?? taskId;
      const r = await apiFetch(`/runs/${encodeURIComponent(id)}`, { locale });
      setDetail(await r.json() as RunDetail);
    } catch { /* swallow */ }
    finally { setActionBusy(false); }
  }, [taskId, runId, locale]);

  const status = detail?.phase ?? detail?.status ?? "";
  const progress = detail ? toProgress(detail) : null;

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />
      <aside style={drawerStyle}>
        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border, #e5e5e5)" }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{t(locale, "taskDetail.title")}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
          {loading && <SkeletonBlock />}

          {!loading && !detail && <p style={{ color: "var(--text-muted)" }}>{t(locale, "taskDetail.notFound")}</p>}

          {!loading && detail && (
            <>
              {/* ── Summary ── */}
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", fontSize: 14 }}>
                <dt style={{ opacity: .6 }}>{t(locale, "taskDetail.status")}</dt>
                <dd style={{ margin: 0 }}><Badge tone={statusTone(status)}>{statusIcon(status)} {statusLabel(status, locale)}</Badge></dd>

                <dt style={{ opacity: .6 }}>{t(locale, "taskDetail.createdAt")}</dt>
                <dd style={{ margin: 0 }}>{formatTime(detail.createdAt, locale)}</dd>

                <dt style={{ opacity: .6 }}>{t(locale, "taskDetail.duration")}</dt>
                <dd style={{ margin: 0 }}>{fmtDuration(detail.durationMs, locale)}</dd>

                {detail.traceId && (<>
                  <dt style={{ opacity: .6 }}>{t(locale, "taskDetail.traceId")}</dt>
                  <dd style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>{detail.traceId}</dd>
                </>)}
              </dl>

              {/* ── Progress ── */}
              {progress && (
                <div style={{ marginTop: 16 }}>
                  <TaskProgressBar progress={progress} locale={locale} />
                </div>
              )}

              {/* ── Result area ── */}
              <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 6, background: "var(--bg-muted, #f5f5f5)", fontSize: 14 }}>
                {isRunning(status) && <p style={{ margin: 0 }}>{t(locale, "taskDetail.executing")}</p>}

                {status === "succeeded" || status === "completed" ? (
                  <p style={{ margin: 0 }}>
                    {detail.currentStep?.toolRef
                      ? friendlyOutputSummary(locale, detail.currentStep.toolRef, detail.outputDigest).text
                      : t(locale, "taskDetail.success")}
                  </p>
                ) : null}

                {(status === "failed" || status === "canceled" || status === "deadletter") && (
                  <div>
                    <p style={{ margin: 0, color: "var(--text-danger, crimson)" }}>
                      {friendlyErrorMessage(locale, detail.errorDigest?.errorCategory ?? "", detail.errorDigest?.message ?? undefined)}
                    </p>
                    {detail.blockReason && <p style={{ margin: "4px 0 0", opacity: .7, fontSize: 13 }}>{detail.blockReason}</p>}
                  </div>
                )}
              </div>

              {/* ── Actions ── */}
              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                {isRunning(status) && detail.runId && (
                  <button disabled={actionBusy} onClick={() => act(`/runs/${encodeURIComponent(detail.runId)}/cancel`)}>
                    {t(locale, "action.cancel")}
                  </button>
                )}
                {status === "paused" && detail.runId && (
                  <button disabled={actionBusy} onClick={() => act(`/tasks/${encodeURIComponent(taskId)}/agent-runs/${encodeURIComponent(detail.runId)}/continue`)}>
                    {t(locale, "action.continue")}
                  </button>
                )}
                {(status === "failed" || status === "canceled") && detail.runId && (
                  <button disabled={actionBusy} onClick={() => act(`/tasks/${encodeURIComponent(taskId)}/agent-runs/${encodeURIComponent(detail.runId)}/continue`)}>
                    {t(locale, "common.retry")}
                  </button>
                )}
              </div>

              {/* ── Deep link ── */}
              {detail.runId && (
                <div style={{ marginTop: 16, fontSize: 13 }}>
                  <Link href={`/runs/${encodeURIComponent(detail.runId)}?lang=${encodeURIComponent(locale)}`}>
                    {t(locale, "taskDetail.viewFullLog")} →
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/* ── Skeleton placeholder ─── */

function SkeletonBlock() {
  const bar: React.CSSProperties = { height: 14, borderRadius: 4, background: "var(--bg-muted, #eee)", marginBottom: 10 };
  return (
    <div style={{ opacity: .6 }}>
      <div style={{ ...bar, width: "60%" }} />
      <div style={{ ...bar, width: "80%" }} />
      <div style={{ ...bar, width: "45%" }} />
      <div style={{ ...bar, width: "70%", marginTop: 20 }} />
      <div style={{ ...bar, width: "90%" }} />
    </div>
  );
}
