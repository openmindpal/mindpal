"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

/** Determine aggregate severity: "ok" | "warn" | "error" */
function getSeverity(s: SystemStatus): "ok" | "warn" | "error" {
  const hasDanger = s.runs.failed > 0 || s.deadletter.count > 0;
  if (hasDanger) return "error";
  const hasWarn =
    s.approvals.pending + s.runs.needsApproval > 0 ||
    (s.devices.total > 0 && s.devices.offline > 0);
  if (hasWarn) return "warn";
  return "ok";
}

const dotClass: Record<string, string> = {
  ok: styles.sbDotOk,
  warn: styles.sbDotWarn,
  error: styles.sbDotError,
};

/* ─── Main StatusBar Component ──────────────────────────────────────────────── */

export default function StatusBar(props: { locale: string }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // ── Loading / Error states ────────────────────────────────────────────────
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

  // ── Derived values ────────────────────────────────────────────────────────
  const severity = getSeverity(status);
  const pendingApprovals = status.approvals.pending + status.runs.needsApproval;
  const failedRuns = status.runs.failed;
  const deadletterCount = status.deadletter.count;
  const { online, total, offline } = status.devices;

  // Build hrefs
  const loc = encodeURIComponent(props.locale);
  const approvalsHref = `/gov/approvals?lang=${loc}`;
  const runsHref = `/runs?status=failed&lang=${loc}`;
  const deadletterHref = `/gov/workflow/deadletters?lang=${loc}`;
  const devicesHref = `/gov/devices?lang=${loc}`;

  // Labels
  const labelApprovals = t(props.locale, "statusBar.pendingApprovals");
  const labelErrors = t(props.locale, "statusBar.failedRuns");
  const labelDeadletter = t(props.locale, "statusBar.deadletter");
  const labelDevices = t(props.locale, "statusBar.devices");

  const countCls = (v: number, tone: "danger" | "warning" = "danger") =>
    `${styles.sbPopoverCount} ${v > 0 ? (tone === "danger" ? styles.sbCountDanger : styles.sbCountWarning) : styles.sbCountOk}`;

  return (
    <div className={styles.statusBar} ref={rootRef}>
      {/* Single status indicator */}
      <button
        className={styles.sbIndicator}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="System status"
      >
        <span className={`${styles.sbDot} ${dotClass[severity]}`} />
      </button>

      {/* Popover detail panel */}
      {open && (
        <>
          {/* Invisible backdrop to capture outside clicks */}
          <div className={styles.sbPopoverBackdrop} onClick={() => setOpen(false)} />
          <div className={styles.sbPopover}>
            {/* Pending approvals */}
            <Link href={approvalsHref} className={styles.sbPopoverRow} onClick={() => setOpen(false)}>
              <span className={styles.sbPopoverIcon}><IconApproval /></span>
              <span className={styles.sbPopoverLabel}>{labelApprovals}</span>
              <span className={countCls(pendingApprovals, "warning")}>{pendingApprovals}</span>
            </Link>

            {/* Failed runs */}
            <Link href={runsHref} className={styles.sbPopoverRow} onClick={() => setOpen(false)}>
              <span className={styles.sbPopoverIcon}><IconError /></span>
              <span className={styles.sbPopoverLabel}>{labelErrors}</span>
              <span className={countCls(failedRuns)}>{failedRuns}</span>
            </Link>

            {/* Deadletter queue */}
            <Link href={deadletterHref} className={styles.sbPopoverRow} onClick={() => setOpen(false)}>
              <span className={styles.sbPopoverIcon}><IconDeadletter /></span>
              <span className={styles.sbPopoverLabel}>{labelDeadletter}</span>
              <span className={countCls(deadletterCount)}>{deadletterCount}</span>
            </Link>

            {/* Devices */}
            {total > 0 && (
              <Link href={devicesHref} className={styles.sbPopoverRow} onClick={() => setOpen(false)}>
                <span className={styles.sbPopoverIcon}><IconDevice /></span>
                <span className={styles.sbPopoverLabel}>{labelDevices}</span>
                <span className={countCls(offline, "warning")}>{online}/{total}</span>
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
