"use client";

import Link from "next/link";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import {
  type FlowApprovalNode,
  friendlyToolName,
} from "@/app/homeHelpers";
import styles from "@/styles/flow.module.css";

/* ─── Icons (used by ApprovalNodeRenderer) ─────────────────────────────────── */

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
        {item.riskLevel && (
          <span className={`${styles.approvalRiskBadge} ${
            item.riskLevel === "high" ? styles.approvalRiskHigh
            : item.riskLevel === "medium" ? styles.approvalRiskMedium
            : styles.approvalRiskLow
          }`}>
            {item.riskLevel === "high" ? t(locale, "flowItem.approval.riskHigh") : item.riskLevel === "medium" ? t(locale, "flowItem.approval.riskMedium") : t(locale, "flowItem.approval.riskLow")}
          </span>
        )}
      </div>

      <div className={styles.approvalNodeContent}>
        {item.humanSummary && (
          <div className={styles.approvalHumanSummary}>{item.humanSummary}</div>
        )}
        <div className={styles.approvalNodeTool}>
          <span className={styles.approvalNodeLabel}>{t(locale, "flowItem.approval.tool")}:</span>
          <span>{friendlyToolName(locale, item.toolRef)}</span>
        </div>
        <div className={styles.approvalNodeTime}>
          <span className={styles.approvalNodeLabel}>{t(locale, "flowItem.approval.requestedAt")}:</span>
          <span>{fmtDateTime(item.requestedAt, locale)}</span>
        </div>
        {item.decidedAt && (
          <div className={styles.approvalNodeTime}>
            <span className={styles.approvalNodeLabel}>{t(locale, "flowItem.approval.decidedAt")}:</span>
            <span>{fmtDateTime(item.decidedAt, locale)}</span>
          </div>
        )}
        {item.inputDigest && Object.keys(item.inputDigest).length > 0 && (
          <details className={styles.approvalInputDigest}>
            <summary>{t(locale, "flowItem.approval.paramSummary")}</summary>
            <pre>{JSON.stringify(item.inputDigest, null, 2)}</pre>
          </details>
        )}
      </div>

      {item.status === "pending" && (
        <div className={styles.approvalNodeActions}>
          {onApprove && (
            <button className={styles.approvalBtnApprove} onClick={onApprove} aria-label={t(locale, "aria.approve")}>
              <IconCheck /> {t(locale, "flowItem.approval.approve")}
            </button>
          )}
          {onReject && (
            <button className={styles.approvalBtnReject} onClick={onReject} aria-label={t(locale, "aria.reject")}>
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
