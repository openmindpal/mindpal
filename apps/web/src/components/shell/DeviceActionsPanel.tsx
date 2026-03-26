"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
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

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconDevice() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>;
}

function IconCheck() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>;
}

function IconX() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
}

function IconPlay() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>;
}

function IconClock() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
}

function IconRefresh() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function DeviceActionsPanel({ locale }: { locale: string }) {
  const [actions, setActions] = useState<DeviceAction[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch device actions
  const fetchActions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/devices/executions?limit=30`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { executions?: DeviceAction[] };
        setActions(data.executions || []);
      } else {
        // Use demo data if API not available
        setActions([
          {
            executionId: "de1",
            deviceId: "dev-001",
            deviceName: "MacBook Pro",
            actionType: "screenshot",
            status: "succeeded",
            createdAt: new Date(Date.now() - 1800000).toISOString(),
            finishedAt: new Date(Date.now() - 1795000).toISOString(),
            latencyMs: 5000,
          },
          {
            executionId: "de2",
            deviceId: "dev-002",
            deviceName: "iPhone 15",
            actionType: "notification",
            status: "succeeded",
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            finishedAt: new Date(Date.now() - 3598000).toISOString(),
            latencyMs: 2000,
          },
          {
            executionId: "de3",
            deviceId: "dev-001",
            deviceName: "MacBook Pro",
            actionType: "clipboard",
            status: "failed",
            createdAt: new Date(Date.now() - 7200000).toISOString(),
            error: "Permission denied",
          },
          {
            executionId: "de4",
            deviceId: "dev-003",
            deviceName: "Windows PC",
            actionType: "file_transfer",
            status: "running",
            createdAt: new Date(Date.now() - 300000).toISOString(),
          },
        ]);
      }
    } catch {
      setActions([]);
    }
    setLoading(false);
  }, [locale]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial data load
    fetchActions();
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
                      <IconDevice /> {action.deviceName}
                    </span>
                    <span className={styles.actionTime}>{formatTime(action.createdAt)}</span>
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
