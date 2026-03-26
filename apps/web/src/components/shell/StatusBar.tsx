"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import styles from "./StatusBar.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type SystemStatus = {
  timestamp: string;
  approvals: { pending: number };
  runs: { failed: number; needsApproval: number };
  deadletter: { count: number };
  devices: { total: number; online: number; offline: number };
};

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconApproval() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function IconError() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconDevice() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function IconDeadletter() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

/* ─── Badge Component ───────────────────────────────────────────────────────── */

function StatusBadge(props: {
  icon: React.ReactNode;
  count: number;
  label: string;
  href: string;
  tone?: "neutral" | "warning" | "danger" | "success";
}) {
  const tone = props.tone ?? (props.count > 0 ? "warning" : "neutral");
  const cls = `${styles.badge} ${styles[`badge_${tone}`]}`;

  return (
    <Link href={props.href} className={cls} title={props.label}>
      <span className={styles.badgeIcon}>{props.icon}</span>
      <span className={styles.badgeCount}>{props.count}</span>
    </Link>
  );
}

function DeviceBadge(props: {
  online: number;
  total: number;
  label: string;
  href: string;
}) {
  const allOnline = props.total > 0 && props.online === props.total;
  const hasOffline = props.total > 0 && props.online < props.total;
  const tone = props.total === 0 ? "neutral" : allOnline ? "success" : hasOffline ? "warning" : "neutral";
  const cls = `${styles.badge} ${styles[`badge_${tone}`]}`;

  return (
    <Link href={props.href} className={cls} title={props.label}>
      <span className={styles.badgeIcon}><IconDevice /></span>
      <span className={styles.badgeCount}>
        {props.online}/{props.total}
      </span>
    </Link>
  );
}

/* ─── Main StatusBar Component ──────────────────────────────────────────────── */

export default function StatusBar(props: { locale: string }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/governance/system-status", { locale: props.locale, cache: "no-store" });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const data = await res.json();
      setStatus(data as SystemStatus);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "fetch_error");
    } finally {
      setLoading(false);
    }
  }, [props.locale]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const timer = setInterval(fetchStatus, 30_000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  // Build hrefs
  const approvalsHref = `/gov/approvals?lang=${encodeURIComponent(props.locale)}`;
  const runsHref = `/runs?status=failed&lang=${encodeURIComponent(props.locale)}`;
  const deadletterHref = `/gov/workflow/deadletters?lang=${encodeURIComponent(props.locale)}`;
  const devicesHref = `/gov/devices?lang=${encodeURIComponent(props.locale)}`;

  // Labels
  const labelApprovals = t(props.locale, "statusBar.pendingApprovals");
  const labelErrors = t(props.locale, "statusBar.failedRuns");
  const labelDeadletter = t(props.locale, "statusBar.deadletter");
  const labelDevices = t(props.locale, "statusBar.devices");

  if (loading) {
    return (
      <div className={styles.statusBar}>
        <span className={styles.loading}>···</span>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className={styles.statusBar}>
        <span className={styles.errorDot} title={error ?? "error"}>!</span>
      </div>
    );
  }

  const pendingApprovals = status.approvals.pending + status.runs.needsApproval;
  const failedRuns = status.runs.failed;
  const deadletterCount = status.deadletter.count;

  return (
    <div className={styles.statusBar}>
      {/* Pending approvals badge */}
      <StatusBadge
        icon={<IconApproval />}
        count={pendingApprovals}
        label={labelApprovals}
        href={approvalsHref}
        tone={pendingApprovals > 0 ? "warning" : "neutral"}
      />

      {/* Failed runs badge */}
      <StatusBadge
        icon={<IconError />}
        count={failedRuns}
        label={labelErrors}
        href={runsHref}
        tone={failedRuns > 0 ? "danger" : "neutral"}
      />

      {/* Deadletter queue badge */}
      {deadletterCount > 0 && (
        <StatusBadge
          icon={<IconDeadletter />}
          count={deadletterCount}
          label={labelDeadletter}
          href={deadletterHref}
          tone="danger"
        />
      )}

      {/* Device status badge */}
      {status.devices.total > 0 && (
        <DeviceBadge
          online={status.devices.online}
          total={status.devices.total}
          label={labelDevices}
          href={devicesHref}
        />
      )}
    </div>
  );
}
