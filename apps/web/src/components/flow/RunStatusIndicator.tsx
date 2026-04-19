"use client";

import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { t } from "@/lib/i18n";
import { type TaskState, getPhaseLabel, isPhaseTerminal, isPhaseBlocking } from "@/lib/types";
import styles from "./RunStatusIndicator.module.css";

interface RunStatusIndicatorProps {
  taskState: TaskState | null | undefined;
  locale: string;
  taskId?: string;
  runId?: string;
  showProgress?: boolean;
  compact?: boolean;
  onStop?: () => void;
  onContinue?: () => void;
  onRetry?: () => void;
}

export default function RunStatusIndicator({
  taskState,
  locale,
  taskId,
  runId,
  showProgress = true,
  compact = false,
  onStop,
  onContinue,
  onRetry,
}: RunStatusIndicatorProps) {
  const phase = taskState?.phase ?? "";
  const stepCount = taskState?.stepCount;
  const currentStep = taskState?.currentStep;
  const needsApproval = taskState?.needsApproval;
  const blockReason = taskState?.blockReason;

  const isTerminal = isPhaseTerminal(phase);
  const isBlocking = isPhaseBlocking(phase);

  const phaseLabel = getPhaseLabel(phase, locale);

  const phaseColor = isTerminal
    ? phase === "succeeded"
      ? styles.phaseSuccess
      : phase === "failed"
        ? styles.phaseFailed
        : styles.phaseMuted
    : isBlocking
      ? styles.phaseBlocking
      : styles.phaseRunning;

  const reasons: Record<string, string> = {
    approval_required: "runStatus.blockReason.approval_required",
    waiting_device: "runStatus.blockReason.waiting_device",
    waiting_arbiter: "runStatus.blockReason.waiting_arbiter",
    guard_blocked: "runStatus.blockReason.guard_blocked",
    plan_failed: "runStatus.blockReason.plan_failed",
    tool_not_enabled: "runStatus.blockReason.tool_not_enabled",
    tool_not_found: "runStatus.blockReason.tool_not_found",
    capability_envelope_mismatch: "runStatus.blockReason.capability_envelope_mismatch",
    rate_limited: "runStatus.blockReason.rate_limited",
    dependency_failed: "runStatus.blockReason.dependency_failed",
    timeout: "runStatus.blockReason.timeout",
    manual_pause: "runStatus.blockReason.manual_pause",
    collab_role_unavailable: "runStatus.blockReason.collab_role_unavailable",
    webhook_pending: "runStatus.blockReason.webhook_pending",
    resource_limit: "runStatus.blockReason.resource_limit",
  };
  const blockReasonText = blockReason ? (reasons[blockReason] ? t(locale, reasons[blockReason]) : blockReason) : null;

  const progress = !stepCount || stepCount <= 0
    ? 0
    : Math.min(100, Math.round(((currentStep ?? 0) / stepCount) * 100));

  if (!taskState) return null;

  if (compact) {
    return (
      <span
        className={`${styles.phaseBadge} ${phaseColor}`}
      >
        {!isTerminal && !isBlocking && (
          <span className={styles.pulseDot} />
        )}
        {phaseLabel}
      </span>
    );
  }

  return (
    <div className={`${styles.phasePanel} ${phaseColor}`}>
      <div className={styles.panelHeader}>
        <div className={styles.panelHeaderLeft}>
          {!isTerminal && !isBlocking && (
            <span className={styles.pulseDot} />
          )}
          {isTerminal && phase === "succeeded" && (
            <svg className={styles.statusIcon} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          )}
          {isTerminal && phase === "failed" && (
            <svg className={styles.statusIcon} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          )}
          {isBlocking && (
            <svg className={styles.statusIcon} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          )}
          <span>{phaseLabel}</span>
        </div>

        {(taskId || runId) && (
          <span className={styles.panelMeta}>
            {taskId && t(locale, "runStatus.taskLabel").replace("{id}", taskId.slice(0, 8))}
            {taskId && runId && " | "}
            {runId && t(locale, "runStatus.runLabel").replace("{id}", runId.slice(0, 8))}
          </span>
        )}

        {(onStop || onContinue || onRetry) && !isTerminal && (
          <div className={styles.inlineActions}>
            {onContinue && (isBlocking || phase === "paused") && (
              <button className={`${styles.inlineActionBtn} ${styles.inlineActionContinue}`} onClick={onContinue}>
                {`▶ ${t(locale, "action.continue")}`}
              </button>
            )}
            {onRetry && phase === "failed" && (
              <button className={`${styles.inlineActionBtn} ${styles.inlineActionRetry}`} onClick={onRetry}>
                {`↻ ${t(locale, "common.retry")}`}
              </button>
            )}
            {onStop && (
              <button className={`${styles.inlineActionBtn} ${styles.inlineActionStop}`} onClick={onStop}>
                {`■ ${t(locale, "common.stop")}`}
              </button>
            )}
          </div>
        )}
      </div>

      {blockReasonText && (
        <div className={styles.blockReason}>
          {blockReasonText}
        </div>
      )}

      {showProgress && stepCount && stepCount > 0 && !isTerminal && (
        <div className={styles.progressWrap}>
          <div className={styles.progressMeta}>
            <span>
              {t(locale, "runStatus.stepCounter")
                .replace("{current}", String(currentStep ?? 0))
                .replace("{total}", String(stepCount))}
            </span>
            <span>{progress}%</span>
          </div>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressBar}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {needsApproval && runId && (
        <InlineApprovalCard runId={runId} locale={locale} blockReason={blockReason} />
      )}
    </div>
  );
}

type ApprovalInfo = {
  approvalId: string;
  status: string;
  toolRef?: string;
  runId?: string;
  policySnapshotRef?: string;
  createdAt?: string;
};

function InlineApprovalCard({
  runId,
  locale,
  blockReason,
}: {
  runId: string;
  locale: string;
  blockReason?: string;
}) {
  const [approval, setApproval] = useState<ApprovalInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [decisionResult, setDecisionResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [reason, setReason] = useState("");
  const [fetched, setFetched] = useState(false);

  const fetchApproval = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/approvals?status=pending&limit=5`, { locale });
      if (!res.ok) return;
      const json = (await res.json()) as { items?: ApprovalInfo[] };
      const match = json.items?.find((a) => a.runId === runId && a.status === "pending");
      if (match) setApproval(match);
    } catch { /* ignore */ } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [runId, locale]);

  if (!fetched && !loading) {
    fetchApproval();
  }

  const decide = useCallback(async (decision: "approve" | "reject") => {
    if (!approval) return;
    setDeciding(true);
    setDecisionResult(null);
    try {
      const res = await apiFetch(`/approvals/${encodeURIComponent(approval.approvalId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ decision, reason: reason.trim() || undefined }),
      });
      if (res.ok) {
        setDecisionResult({ ok: true, msg: t(locale, "runStatus.approval.decisionSubmitted") });
        setApproval(null);
      } else {
        const err = await res.json().catch(() => ({})) as { message?: unknown };
        const msg = typeof err.message === "string" ? err.message : typeof err.message === "object" && err.message ? JSON.stringify(err.message) : `HTTP ${res.status}`;
        setDecisionResult({ ok: false, msg });
      }
    } catch (e: unknown) {
      setDecisionResult({ ok: false, msg: String(e) });
    } finally {
      setDeciding(false);
    }
  }, [approval, locale, reason]);

  const toolName = useMemo(() => {
    if (!approval?.toolRef) return null;
    const at = approval.toolRef.lastIndexOf("@");
    return at > 0 ? approval.toolRef.slice(0, at) : approval.toolRef;
  }, [approval?.toolRef]);

  const securitySummary = useMemo(() => {
    if (!blockReason) return null;
    const summaries: Record<string, string> = {
      approval_required: "runStatus.securitySummary.approval_required",
      guard_blocked: "runStatus.securitySummary.guard_blocked",
      waiting_arbiter: "runStatus.securitySummary.waiting_arbiter",
    };
    return summaries[blockReason] ? t(locale, summaries[blockReason]) : null;
  }, [blockReason, locale]);

  return (
    <div className={styles.approvalCard}>
      {securitySummary && (
        <div className={styles.approvalSummary}>
          <span className={styles.approvalSummaryStrong}>{t(locale, "runStatus.securityPrefix")}</span>
          {securitySummary}
        </div>
      )}

      {loading && (
        <div className={`${styles.approvalState} ${styles.approvalStateLoading}`}>
          {t(locale, "runStatus.approval.loading")}
        </div>
      )}

      {!loading && !approval && !decisionResult && (
        <div className={`${styles.approvalState} ${styles.approvalStateEmpty}`}>
          {t(locale, "runStatus.approval.empty")}
        </div>
      )}

      {decisionResult && (
        <div
          className={`${styles.approvalState} ${
            decisionResult.ok ? styles.approvalStateSuccess : styles.approvalStateError
          }`}
        >
          {decisionResult.msg}
        </div>
      )}

      {approval && (
        <>
          <div className={styles.approvalMeta}>
            {toolName && (
              <span>
                <span className={styles.approvalMetaMuted}>{t(locale, "runStatus.approval.tool")}</span>
                <span>{toolName}</span>
              </span>
            )}
            <span>
              <span className={styles.approvalMetaMuted}>ID: </span>
              <span className={styles.approvalMetaMono}>{approval.approvalId.slice(0, 10)}…</span>
            </span>
            {approval.createdAt && (
              <span>
                <span className={styles.approvalMetaMuted}>{t(locale, "runStatus.approval.at")}</span>
                {fmtDateTime(approval.createdAt, locale)}
              </span>
            )}
          </div>

          <input
            className={styles.approvalReasonInput}
            placeholder={t(locale, "runStatus.approval.reasonPlaceholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={deciding}
          />

          <div className={styles.approvalActions}>
            <button
              className={`${styles.approvalAction} ${styles.approveBtn}`}
              onClick={() => decide("approve")}
              disabled={deciding}
            >
              {deciding ? t(locale, "common.processing") : t(locale, "runStatus.approval.approve")}
            </button>
            <button
              className={`${styles.approvalAction} ${styles.rejectBtn}`}
              onClick={() => decide("reject")}
              disabled={deciding}
            >
              {t(locale, "runStatus.approval.reject")}
            </button>
            <a
              href={`/gov/approvals/${encodeURIComponent(approval.approvalId)}?lang=${encodeURIComponent(locale)}`}
              className={`${styles.approvalAction} ${styles.detailLink}`}
            >
              {t(locale, "common.detail")}
            </a>
          </div>
        </>
      )}
    </div>
  );
}

interface ModeSelectorProps {
  mode: "auto" | "answer" | "execute" | "collab";
  onChange: (mode: "auto" | "answer" | "execute" | "collab") => void;
  locale: string;
  disabled?: boolean;
}

export function ModeSelector({ mode, onChange, locale, disabled }: ModeSelectorProps) {
  const modes = [
    { value: "auto", label: t(locale, "chat.mode.auto"), icon: "✨" },
    { value: "answer", label: t(locale, "chat.mode.answerShort"), icon: "💬" },
    { value: "execute", label: t(locale, "chat.mode.executeShort"), icon: "⚡" },
    { value: "collab", label: t(locale, "chat.mode.collabShort"), icon: "👥" },
  ] as const;

  return (
    <div className={styles.modeSelector} role="radiogroup" aria-label="执行模式">
      {modes.map((m) => (
        <button
          key={m.value}
          disabled={disabled}
          onClick={() => onChange(m.value)}
          className={[
            styles.modeButton,
            mode === m.value ? styles.modeButtonActive : "",
            disabled ? styles.modeButtonDisabled : "",
          ].filter(Boolean).join(" ")}
          title={m.label}
          role="radio"
          aria-checked={mode === m.value}
        >
          <span className={styles.modeIcon}>{m.icon}</span>
          {m.label}
        </button>
      ))}
    </div>
  );
}
