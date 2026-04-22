"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconDevice, IconCheck, IconX, IconPlay, IconClock, IconRefresh } from "./ShellIcons";
import { formatDuration, formatTime, formatErrorCategory, formatToolRefLocalized, shortId } from "./shellUtils";
import { useBottomPanel } from "./useBottomPanel";
import { PanelLoading, PanelError, PanelEmpty } from "./PanelState";
import styles from "@/styles/shell.module.css";

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
  deviceName?: string;
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
    deviceName: rec.deviceName || `#${rec.deviceId.slice(0, 8)}`,
    actionType: rec.toolRef,
    status,
    createdAt: rec.createdAt,
    finishedAt: rec.finishedAt,
    error: rec.errorCategory ?? undefined,
  };
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function DeviceActionsPanel({ locale, onBadgeUpdate }: { locale: string; onBadgeUpdate?: (count: number) => void }) {
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({});
  const deviceNameCache = useRef<Record<string, string>>({});
  const badgeRef = useRef(onBadgeUpdate);
  badgeRef.current = onBadgeUpdate;

  const fetchActions = useCallback(async (): Promise<DeviceAction[]> => {
    const res = await apiFetch(`/device-executions?limit=30`, { method: "GET", locale });
    if (res.ok) {
      const data = await res.json() as { executions?: DeviceExecutionRecord[] };
      const mapped = (data.executions || []).map(mapExecutionToAction);
      const pendingCount = mapped.filter((a) => a.status === "pending" || a.status === "running").length;
      badgeRef.current?.(pendingCount);
      return mapped;
    }
    throw new Error("fetch_error");
  }, [locale]);

  const { items: actions, loading, error, reload } = useBottomPanel<DeviceAction>({
    fetchFn: fetchActions,
    refreshInterval: 20_000,
  });

  // On-demand device name loading: extract unknown deviceIds from current items, batch-query only missing ones
  useEffect(() => {
    const unknownIds = actions
      .map(item => item.deviceId)
      .filter(id => id && !deviceNameCache.current[id]);

    if (unknownIds.length === 0) return;

    const uniqueIds = [...new Set(unknownIds)];
    apiFetch(`/devices?ids=${uniqueIds.join(",")}&fields=id,name`, { method: "GET", locale })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json() as { devices?: { deviceId: string; id?: string; name?: string; label?: string }[] };
        const devices = data.devices || [];
        for (const d of devices) {
          const did = d.deviceId || d.id || "";
          if (did) deviceNameCache.current[did] = d.name || d.label || did;
        }
        setDeviceNames({ ...deviceNameCache.current });
      })
      .catch(() => { /* Graceful degradation: display deviceId prefix */ });
  }, [actions, locale]);

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
      case "succeeded": return styles.dapStatusSucceeded;
      case "failed":
      case "timeout": return styles.dapStatusFailed;
      case "running": return styles.dapStatusRunning;
      default: return styles.dapStatusPending;
    }
  };

  const fmtTime = (ts: string) => formatTime(ts, locale);

  const resolveDeviceName = (action: DeviceAction) => {
    return deviceNames[action.deviceId] || action.deviceName;
  };

  const getActionLabel = (actionType: string) => {
    const name = actionType.includes("@") ? actionType.slice(0, actionType.lastIndexOf("@")) : actionType;

    // 优先查找设备操作专用翻译
    const deviceKey = `deviceAction.tool.${name}`;
    const deviceLabel = t(locale, deviceKey);
    if (deviceLabel !== deviceKey) return deviceLabel;

    // 次选旧的 type 翻译
    const typeKey = `deviceAction.type.${name}`;
    const typeLabel = t(locale, typeKey);
    if (typeLabel !== typeKey) return typeLabel;

    // 最终通用工具翻译
    return formatToolRefLocalized(actionType, locale);
  };

  return (
    <div className={styles.deviceActionsPanel}>
      {/* Header */}
      <div className={styles.dapHeader}>
        <span className={styles.dapTitle}>{t(locale, "deviceAction.title")}</span>
        <button className={styles.dapRefreshBtn} onClick={reload} disabled={loading}>
          <IconRefresh /> {t(locale, "deviceAction.refresh")}
        </button>
      </div>

      {/* Content */}
      <div className={styles.dapContent}>
        {loading && actions.length === 0 ? (
          <PanelLoading message={t(locale, "common.loading")} />
        ) : error ? (
          <PanelError message={error} onRetry={reload} />
        ) : actions.length === 0 ? (
          <PanelEmpty message={t(locale, "deviceAction.empty")} />
        ) : (
          <div className={styles.dapActionList}>
            {actions.map((action) => (
              <div key={action.executionId} className={styles.dapActionItem}>
                <div className={`${styles.actionStatus} ${getStatusClass(action.status)}`}>
                  {getStatusIcon(action.status)}
                </div>
                <div className={styles.dapActionContent}>
                  <div className={styles.actionHeader}>
                    <span className={`${styles.actionDevice} ${styles.truncate}`}>
                      <IconDevice /> {resolveDeviceName(action)}
                    </span>
                    <span className={`${styles.dapActionTime} ${styles.monoText}`}>{fmtTime(action.createdAt)}</span>
                  </div>
                  <div className={styles.actionType}>{getActionLabel(action.actionType)}</div>
                  <div className={styles.actionMeta}>
                    <span className={`${styles.actionStatusBadge} ${getStatusClass(action.status)}`}>
                      {t(locale, `deviceAction.status.${action.status}`)}
                    </span>
                    {action.latencyMs != null && (
                      <span className={`${styles.actionLatency} ${styles.monoText}`}>{formatDuration(action.latencyMs)}</span>
                    )}
                  </div>
                  {action.error && (
                    <div className={styles.actionError}>{formatErrorCategory(action.error, locale)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer link */}
      <div className={styles.dapFooter}>
        <Link href={`/devices?lang=${encodeURIComponent(locale)}`} className={styles.footerLink}>
          {t(locale, "deviceAction.viewAll")}
        </Link>
      </div>
    </div>
  );
}
