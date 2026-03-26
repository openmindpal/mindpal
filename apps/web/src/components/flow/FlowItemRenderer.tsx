"use client";

import { useState } from "react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import { safeJsonString } from "@/lib/apiError";
import {
  type FlowPlanStep,
  type FlowExecutionReceipt,
  type FlowApprovalNode,
  type FlowPhaseIndicator,
  type FlowArtifactCard,
  type FlowRunSummary,
  friendlyToolName,
} from "@/app/homeHelpers";
import styles from "./FlowItemRenderer.module.css";

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconApproval() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
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

/* ─── Plan Step Renderer ────────────────────────────────────────────────────── */

export function PlanStepRenderer(props: { item: FlowPlanStep; locale: string }) {
  const { item, locale } = props;
  const statusIcon = {
    pending: <IconClock />,
    running: <IconPlay />,
    succeeded: <IconCheck />,
    failed: <IconX />,
    needs_approval: <IconPause />,
  }[item.status];

  const statusClass = {
    pending: styles.statusPending,
    running: styles.statusRunning,
    succeeded: styles.statusSucceeded,
    failed: styles.statusFailed,
    needs_approval: styles.statusNeedsApproval,
  }[item.status];

  const href = item.runId
    ? `/runs/${encodeURIComponent(item.runId)}?lang=${encodeURIComponent(locale)}`
    : undefined;

  return (
    <div className={styles.planStep}>
      <div className={styles.planStepProgress}>
        <span className={styles.planStepIndex}>{item.stepIndex + 1}</span>
        <span className={styles.planStepTotal}>/ {item.totalSteps}</span>
      </div>
      <div className={styles.planStepContent}>
        <div className={styles.planStepHeader}>
          <span className={`${styles.planStepStatus} ${statusClass}`}>
            {statusIcon}
          </span>
          <span className={styles.planStepName}>
            {item.name ?? friendlyToolName(locale, item.toolRef)}
          </span>
        </div>
        <div className={styles.planStepMeta}>
          <span className={styles.planStepToolRef}>{item.toolRef}</span>
          {href && (
            <Link href={href} className={styles.planStepLink}>
              {t(locale, "flowItem.viewRun")} <IconChevronRight />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Execution Receipt Renderer ────────────────────────────────────────────── */

export function ExecutionReceiptRenderer(props: { item: FlowExecutionReceipt; locale: string }) {
  const { item, locale } = props;

  const statusIcon = {
    succeeded: <IconCheck />,
    failed: <IconX />,
    canceled: <IconX />,
    deadletter: <IconX />,
  }[item.status];

  const statusClass = {
    succeeded: styles.statusSucceeded,
    failed: styles.statusFailed,
    canceled: styles.statusFailed,
    deadletter: styles.statusFailed,
  }[item.status];

  const href = `/runs/${encodeURIComponent(item.runId)}?lang=${encodeURIComponent(locale)}`;

  return (
    <div className={styles.execReceipt}>
      <div className={styles.execReceiptHeader}>
        <span className={`${styles.execReceiptStatus} ${statusClass}`}>
          {statusIcon}
          <span>{t(locale, `flowItem.execStatus.${item.status}`)}</span>
        </span>
        <span className={styles.execReceiptTool}>
          {friendlyToolName(locale, item.toolRef)}
        </span>
      </div>

      {item.latencyMs != null && (
        <div className={styles.execReceiptMeta}>
          <span>{t(locale, "flowItem.latency")}: {(item.latencyMs / 1000).toFixed(2)}s</span>
        </div>
      )}

      {item.status === "succeeded" && item.output != null && (
        <div className={styles.execReceiptOutput}>
          <div className={styles.execReceiptOutputLabel}>{t(locale, "flowItem.output")}</div>
          <pre className={styles.execReceiptOutputPre}>
            {typeof item.output === "string" ? item.output : safeJsonString(item.output)}
          </pre>
        </div>
      )}

      {(item.status === "failed" || item.status === "deadletter") && item.error && (
        <div className={styles.execReceiptError}>
          <div className={styles.execReceiptErrorLabel}>{t(locale, "flowItem.error")}</div>
          <pre className={styles.execReceiptErrorPre}>{item.error}</pre>
        </div>
      )}

      <div className={styles.execReceiptActions}>
        <Link href={href} className={styles.execReceiptLink}>
          {t(locale, "flowItem.viewDetails")} <IconChevronRight />
        </Link>
      </div>
    </div>
  );
}

/* ─── Approval Node Renderer ────────────────────────────────────────────────── */

export function ApprovalNodeRenderer(props: { item: FlowApprovalNode; locale: string; onApprove?: () => void; onReject?: () => void }) {
  const { item, locale, onApprove, onReject } = props;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const statusIcon = {
    pending: <IconPause />,
    approved: <IconCheck />,
    rejected: <IconX />,
  }[item.status];

  const statusClass = {
    pending: styles.statusNeedsApproval,
    approved: styles.statusSucceeded,
    rejected: styles.statusFailed,
  }[item.status];

  const href = `/gov/approvals/${encodeURIComponent(item.approvalId)}?lang=${encodeURIComponent(locale)}`;

  return (
    <div className={styles.approvalNode}>
      <div className={styles.approvalNodeHeader}>
        <span className={`${styles.approvalNodeIcon} ${statusClass}`}>
          <IconApproval />
        </span>
        <span className={styles.approvalNodeTitle}>
          {t(locale, `flowItem.approval.${item.status}`)}
        </span>
      </div>

      <div className={styles.approvalNodeContent}>
        <div className={styles.approvalNodeTool}>
          <span className={styles.approvalNodeLabel}>{t(locale, "flowItem.approval.tool")}:</span>
          <span>{friendlyToolName(locale, item.toolRef)}</span>
        </div>
        <div className={styles.approvalNodeTime}>
          <span className={styles.approvalNodeLabel}>{t(locale, "flowItem.approval.requestedAt")}:</span>
          <span>{new Date(item.requestedAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US")}</span>
        </div>
        {item.decidedAt && (
          <div className={styles.approvalNodeTime}>
            <span className={styles.approvalNodeLabel}>{t(locale, "flowItem.approval.decidedAt")}:</span>
            <span>{new Date(item.decidedAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US")}</span>
          </div>
        )}
      </div>

      {item.status === "pending" && (
        <div className={styles.approvalNodeActions}>
          {onApprove && (
            <button className={styles.approvalBtnApprove} onClick={onApprove}>
              <IconCheck /> {t(locale, "flowItem.approval.approve")}
            </button>
          )}
          {onReject && (
            <button className={styles.approvalBtnReject} onClick={onReject}>
              <IconX /> {t(locale, "flowItem.approval.reject")}
            </button>
          )}
          <Link href={href} className={styles.approvalLinkDetail}>
            {t(locale, "flowItem.approval.viewDetail")} <IconChevronRight />
          </Link>
        </div>
      )}

      {item.status !== "pending" && (
        <div className={styles.approvalNodeActions}>
          <Link href={href} className={styles.approvalLinkDetail}>
            {t(locale, "flowItem.approval.viewDetail")} <IconChevronRight />
          </Link>
        </div>
      )}
    </div>
  );
}

/* ─── Phase Indicator Renderer ──────────────────────────────────────────────── */

export function PhaseIndicatorRenderer(props: { item: FlowPhaseIndicator; locale: string }) {
  const { item, locale } = props;

  const phaseIcon = {
    planning: <IconClock />,
    executing: <IconPlay />,
    reviewing: <IconPause />,
    succeeded: <IconCheck />,
    failed: <IconX />,
  }[item.phase];

  const phaseClass = {
    planning: styles.phasePlanning,
    executing: styles.phaseExecuting,
    reviewing: styles.phaseReviewing,
    succeeded: styles.phaseSucceeded,
    failed: styles.phaseFailed,
  }[item.phase];

  return (
    <div className={`${styles.phaseIndicator} ${phaseClass}`}>
      <span className={styles.phaseIcon}>{phaseIcon}</span>
      <span className={styles.phaseLabel}>{t(locale, `flowItem.phase.${item.phase}`)}</span>
    </div>
  );
}

/* ─── Artifact Card Renderer ─────────────────────────────────────────────── */

function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconCode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function IconTable() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function IconExpand() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function ArtifactCardRenderer(props: {
  item: FlowArtifactCard;
  locale: string;
  onExpand?: (data: unknown) => void;
  onOpenInWorkspace?: (url: string) => void;
}) {
  const { item, locale, onExpand, onOpenInWorkspace } = props;
  const [expanded, setExpanded] = useState(false);

  const typeIcon = {
    json: <IconCode />,
    table: <IconTable />,
    chart: <IconChart />,
    markdown: <IconFile />,
    file: <IconFile />,
    text: <IconFile />,
  }[item.artifactType];

  const handleExpand = () => {
    if (onExpand && item.data) {
      onExpand(item.data);
    } else {
      setExpanded(!expanded);
    }
  };

  return (
    <div className={styles.artifactCard}>
      <div className={styles.artifactHeader}>
        <span className={styles.artifactIcon}>{typeIcon}</span>
        <span className={styles.artifactTitle}>{item.title}</span>
        <span className={styles.artifactType}>{item.artifactType}</span>
      </div>

      {item.summary && (
        <div className={styles.artifactSummary}>{item.summary}</div>
      )}

      {/* Preview */}
      {expanded && item.data !== undefined && item.data !== null && (
        <div className={styles.artifactPreview}>
          <pre className={styles.artifactPre}>
            {typeof item.data === "string" ? item.data : safeJsonString(item.data)}
          </pre>
        </div>
      )}

      <div className={styles.artifactActions}>
        {item.data !== undefined && item.data !== null && (
          <button className={styles.artifactBtn} onClick={handleExpand}>
            <IconExpand /> {expanded ? t(locale, "flowItem.artifact.collapse") : t(locale, "flowItem.artifact.expand")}
          </button>
        )}
        {item.url && onOpenInWorkspace && (
          <button className={styles.artifactBtn} onClick={() => onOpenInWorkspace(item.url!)}>
            <IconChevronRight /> {t(locale, "flowItem.artifact.openInWorkspace")}
          </button>
        )}
        {item.runId && (
          <Link
            href={`/runs/${encodeURIComponent(item.runId)}?lang=${encodeURIComponent(locale)}`}
            className={styles.artifactLink}
          >
            {t(locale, "flowItem.viewRun")} <IconChevronRight />
          </Link>
        )}
      </div>
    </div>
  );
}

/* ─── Run Summary Renderer ───────────────────────────────────────────────── */

export function RunSummaryRenderer(props: {
  item: FlowRunSummary;
  locale: string;
  onOpenArtifact?: (artifact: { type: string; title: string; url?: string }) => void;
}) {
  const { item, locale, onOpenArtifact } = props;

  const statusIcon = {
    succeeded: <IconCheck />,
    failed: <IconX />,
    canceled: <IconX />,
  }[item.status];

  const statusClass = {
    succeeded: styles.statusSucceeded,
    failed: styles.statusFailed,
    canceled: styles.statusFailed,
  }[item.status];

  const href = `/runs/${encodeURIComponent(item.runId)}?lang=${encodeURIComponent(locale)}`;

  return (
    <div className={`${styles.runSummary} ${statusClass}`}>
      <div className={styles.runSummaryHeader}>
        <span className={`${styles.runSummaryIcon} ${statusClass}`}>
          {statusIcon}
        </span>
        <span className={styles.runSummaryTitle}>
          {t(locale, `flowItem.runSummary.${item.status}`)}
        </span>
      </div>

      <div className={styles.runSummaryStats}>
        <div className={styles.runSummaryStat}>
          <span className={styles.runSummaryStatLabel}>{t(locale, "flowItem.runSummary.steps")}</span>
          <span className={styles.runSummaryStatValue}>{item.completedSteps}/{item.totalSteps}</span>
        </div>
        {item.totalLatencyMs != null && (
          <div className={styles.runSummaryStat}>
            <span className={styles.runSummaryStatLabel}>{t(locale, "flowItem.runSummary.duration")}</span>
            <span className={styles.runSummaryStatValue}>{(item.totalLatencyMs / 1000).toFixed(1)}s</span>
          </div>
        )}
      </div>

      {item.artifacts && item.artifacts.length > 0 && (
        <div className={styles.runSummaryArtifacts}>
          <div className={styles.runSummaryArtifactsLabel}>{t(locale, "flowItem.runSummary.artifacts")}</div>
          <div className={styles.runSummaryArtifactList}>
            {item.artifacts.map((a, i) => (
              <button
                key={i}
                className={styles.runSummaryArtifactBtn}
                onClick={() => onOpenArtifact?.(a)}
              >
                <IconFile /> {a.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={styles.runSummaryActions}>
        <Link href={href} className={styles.runSummaryLink}>
          {t(locale, "flowItem.viewDetails")} <IconChevronRight />
        </Link>
      </div>
    </div>
  );
}
