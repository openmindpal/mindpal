"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconDevice, IconCheck, IconX, IconPlay, IconClock, IconRefresh } from "./ShellIcons";
import { formatDuration, formatTime } from "./shellUtils";
import styles from "./DeviceActionsPanel.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

interface DeviceAction {
  executionId: string;
  deviceId: string;
  deviceName: string;
  actionType: string;
  status: "pending" | "running" | "succeeded" | "failed" | "timeout";
  createdAt: string;
  finishedAt?: string;
  latencyMs?: number;
  error?: string;
}

interface DeviceExecutionRecord {
  deviceExecutionId: string;
  deviceId: string;
  toolRef: string;
  status: "pending" | "claimed" | "succeeded" | "failed" | "canceled";
  createdAt: string;
  finishedAt?: string;
  outputDigest?: Record<string, unknown> | null;
  errorCategory?: string | null;
}

function mapExecutionToAction(rec: DeviceExecutionRecord): DeviceAction {
  let status: DeviceAction["status"] = "pending";
  if (rec.status === "succeeded") status = "succeeded";
  else if (rec.status === "failed") status = "failed";
  else if (rec.status === "claimed") status = "running";
  else if (rec.status === "canceled") status = "timeout";

  return {
    executionId: rec.deviceExecutionId,
    deviceId: rec.deviceId,
    deviceName: rec.deviceId.slice(0, 8),
    actionType: rec.toolRef,
    status,
    createdAt: rec.createdAt,
    finishedAt: rec.finishedAt,
    error: rec.errorCategory ?? undefined,
  };
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function DeviceActionsPanel({ locale, onBadgeUpdate }: { locale: string; onBadgeUpdate?: (count: number) => void }) {
  const [actions, setActions] = useState<DeviceAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});

  // Fetch device name map once for friendly display
  useEffect(() => {
    apiFetch("/devices?limit=100", { method: "GET", locale }).then(async (res) => {
      if (res.ok) {
        const data = await res.json() as { devices?: { deviceId: string; name?: string; label?: string }[] };
        const map: Record<string, string> = {};
        for (const d of data.devices ?? []) {
          if (d.name || d.label) map[d.deviceId] = d.name || d.label || "";
        }
        setDeviceNames(map);
      }
    }).catch(() => {});
  }, [locale]);

  const fetchActions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/device-executions?limit=30`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { executions?: DeviceExecutionRecord[] };
        const mapped = (data.executions || []).map(mapExecutionToAction);
        setActions(mapped);
        const pendingCount = mapped.filter((a) => a.status === "pending" || a.status === "running").length;
        onBadgeUpdate?.(pendingCount);
      } else {
        setActions([]);
      }
    } catch (err) {
      console.error("Failed to load device actions:", err);
      setActions([]);
    }
    setLoading(false);
  }, [locale, onBadgeUpdate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial data load
    fetchActions();
  }, [fetchActions]);

  // Auto-refresh every 20 seconds
  useEffect(() => {
    const timer = setInterval(fetchActions, 20_000);
    return () => clearInterval(timer);
  }, [fetchActions]);

  const getStatusIcon = (status: DeviceAction["status"]) => {
    switch (status) {
      case "succeeded": return <IconCheck />;
      case "failed":
      case "timeout": return <IconX />;
      case "running": return <IconPlay />;
      default: return <IconClock />;
    }
  };

  const getStatusClass = (status: DeviceAction["status"]) => {
    switch (status) {
      case "succeeded": return styles.statusSucceeded;
      case "failed":
      case "timeout": return styles.statusFailed;
      case "running": return styles.statusRunning;
      default: return styles.statusPending;
    }
  };

  const fmtTime = (ts: string) => formatTime(ts, locale);

  const resolveDeviceName = (action: DeviceAction) => {
    return deviceNames[action.deviceId] || action.deviceName;
  };


  const getActionLabel = (actionType: string) => {
    const key = `deviceAction.type.${actionType}`;
    const label = t(locale, key);
    return label !== key ? label : actionType;
  };

  return (
    <div className={styles.deviceActionsPanel}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>{t(locale, "deviceAction.title")}</span>
        <button className={styles.refreshBtn} onClick={fetchActions} disabled={loading}>
          <IconRefresh /> {t(locale, "deviceAction.refresh")}
        </button>
      </div>

      {/* Content */}
      <div className={styles.content}>
        {loading && actions.length === 0 ? (
          <div className={styles.loading}>{t(locale, "common.loading")}</div>
        ) : actions.length === 0 ? (
          <div className={styles.empty}>
            <IconDevice />
            <span>{t(locale, "deviceAction.empty")}</span>
          </div>
        ) : (
          <div className={styles.actionList}>
            {actions.map((action) => (
              <div key={action.executionId} className={styles.actionItem}>
                <div className={`${styles.actionStatus} ${getStatusClass(action.status)}`}>
                  {getStatusIcon(action.status)}
                </div>
                <div className={styles.actionContent}>
                  <div className={styles.actionHeader}>
                    <span className={styles.actionDevice}>
                      <IconDevice /> {resolveDeviceName(action)}
                    </span>
                    <span className={styles.actionTime}>{fmtTime(action.createdAt)}</span>
                  </div>
                  <div className={styles.actionType}>{getActionLabel(action.actionType)}</div>
                  <div className={styles.actionMeta}>
                    <span className={`${styles.actionStatusBadge} ${getStatusClass(action.status)}`}>
                      {t(locale, `deviceAction.status.${action.status}`)}
                    </span>
                    {action.latencyMs != null && (
                      <span className={styles.actionLatency}>{formatDuration(action.latencyMs)}</span>
                    )}
                  </div>
                  {action.error && (
                    <div className={styles.actionError}>{action.error}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer link */}
      <div className={styles.footer}>
        <Link href={`/devices?lang=${encodeURIComponent(locale)}`} className={styles.footerLink}>
          {t(locale, "deviceAction.viewAll")}
        </Link>
      </div>
    </div>
  );
}
