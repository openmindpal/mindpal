"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconApproval, IconError, IconDevice, IconDeadletter } from "./ShellIcons";
import styles from "@/styles/shell.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type SystemStatus = {
  timestamp: string;
  approvals: { pending: number };
  runs: { failed: number; needsApproval: number };
  deadletter: { count: number };
  devices: { total: number; online: number; offline: number };
};

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
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
