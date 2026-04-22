"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconBell, IconShield, IconAlert, IconCheckLg, IconInfo, IconRefresh, IconCheckAll } from "./ShellIcons";
import { formatErrorCategory } from "./shellUtils";
import { useBottomPanel } from "./useBottomPanel";
import { PanelLoading, PanelError, PanelEmpty } from "./PanelState";
import styles from "@/styles/shell.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────────────── */

interface NotificationItem {
  id: string;
  type: "audit" | "event" | "policy_reject" | "approval" | "system";
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  url?: string;
  meta?: Record<string, unknown>;
}

interface OutboxRecord {
  outboxId: string;
  channel: string;
  deliveryStatus: string;
  templateId: string;
  templateVersion: number;
  recipientRef: string;
  createdAt: string;
  updatedAt: string;
  lastErrorCategory?: string | null;
}

function mapOutboxToNotification(rec: OutboxRecord): NotificationItem {
  let type: NotificationItem["type"] = "system";
  if (rec.lastErrorCategory) {
    type = "policy_reject";
  } else if (rec.deliveryStatus === "queued") {
    type = "approval";
  } else if (rec.channel === "email" || rec.channel === "sms") {
    type = "event";
  }

  return {
    id: rec.outboxId,
    type,
    title: `${rec.channel} - ${rec.recipientRef}`,
    message: rec.deliveryStatus,
    createdAt: rec.createdAt,
    read: rec.deliveryStatus === "sent" || rec.deliveryStatus === "canceled",
    url: "/gov/notifications",
  };
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function NotificationPanel({ locale, onBadgeUpdate }: { locale: string; onBadgeUpdate?: (count: number) => void }) {
  const [localItems, setLocalItems] = useState<NotificationItem[] | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const badgeRef = useRef(onBadgeUpdate);
  badgeRef.current = onBadgeUpdate;

  const fetchNotifications = useCallback(async (): Promise<NotificationItem[]> => {
    const res = await apiFetch(`/notifications/outbox?limit=50`, { method: "GET", locale });
    if (res.ok) {
      const data = await res.json() as { outbox?: OutboxRecord[] };
      const mapped = (data.outbox || []).map(mapOutboxToNotification);
      const unread = mapped.filter((n) => !n.read).length;
      badgeRef.current?.(unread);
      return mapped;
    }
    throw new Error("fetch_error");
  }, [locale]);

  const { items: fetchedItems, loading, error, reload } = useBottomPanel<NotificationItem>({
    fetchFn: fetchNotifications,
    refreshInterval: 30_000,
  });

  // Use localItems override when available (for optimistic updates), else use fetched items
  const notifications = localItems ?? fetchedItems;

  // Sync localItems back to null when fetchedItems changes (after reload)
  // so that fresh data from server takes precedence
  const prevFetchedRef = useRef(fetchedItems);
  if (prevFetchedRef.current !== fetchedItems) {
    prevFetchedRef.current = fetchedItems;
    if (localItems !== null) setLocalItems(null);
  }

  // Mark all as read with optimistic update + rollback on failure
  const markAllRead = useCallback(async () => {
    const previousItems = [...notifications];
    setLocalItems(notifications.map(n => ({ ...n, read: true })));
    badgeRef.current?.(0);
    try {
      await apiFetch("/notifications/inbox/read-all", { method: "POST", locale });
    } catch (err) {
      // Rollback on failure
      console.error("[NotificationPanel] markAllRead API error:", err);
      setLocalItems(previousItems);
      const unread = previousItems.filter(n => !n.read).length;
      badgeRef.current?.(unread);
    }
  }, [notifications, locale]);

  const markRead = useCallback((id: string) => {
    const updated = notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
    setLocalItems(updated);
    const unread = updated.filter((n) => !n.read).length;
    badgeRef.current?.(unread);
    apiFetch(`/notifications/inbox/${encodeURIComponent(id)}/read`, { method: "POST", locale }).catch(() => {});
  }, [notifications, locale]);

  const getTypeIcon = (type: NotificationItem["type"]) => {
    switch (type) {
      case "audit": return <IconShield />;
      case "policy_reject": return <IconAlert />;
      case "approval": return <IconCheckLg />;
      case "event": return <IconBell />;
      default: return <IconInfo />;
    }
  };

  const getTypeClass = (type: NotificationItem["type"]) => {
    switch (type) {
      case "audit": return styles.typeAudit;
      case "policy_reject": return styles.typePolicyReject;
      case "approval": return styles.typeApproval;
      case "event": return styles.typeEvent;
      default: return styles.typeSystem;
    }
  };

  const formatTimeAgo = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}${t(locale, "notification.timeAgo.min")}`;
    if (diffHours < 24) return `${diffHours}${t(locale, "notification.timeAgo.hour")}`;
    return `${diffDays}${t(locale, "notification.timeAgo.day")}`;
  };

  const filteredNotifications = filter === "unread"
    ? notifications.filter((n) => !n.read)
    : notifications;

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className={styles.notificationPanel}>
      {/* Header */}
      <div className={styles.npHeader}>
        <div className={styles.npHeaderLeft}>
          <span className={styles.npTitle}>{t(locale, "notification.title")}</span>
          {unreadCount > 0 && (
            <span className={styles.unreadBadge}>{unreadCount}</span>
          )}
        </div>
        <div className={styles.npHeaderActions}>
          <select
            className={styles.filterSelect}
            value={filter}
            onChange={(e) => setFilter(e.target.value as "all" | "unread")}
          >
            <option value="all">{t(locale, "notification.filter.all")}</option>
            <option value="unread">{t(locale, "notification.filter.unread")}</option>
          </select>
          {unreadCount > 0 && (
            <button className={styles.markAllBtn} onClick={markAllRead}>
              <IconCheckAll /> {t(locale, "notification.markAllRead")}
            </button>
          )}
          <button className={styles.npRefreshBtn} onClick={reload} disabled={loading}>
            <IconRefresh />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={styles.npContent}>
        {loading && notifications.length === 0 ? (
          <PanelLoading message={t(locale, "common.loading")} />
        ) : error ? (
          <PanelError message={error} onRetry={reload} />
        ) : filteredNotifications.length === 0 ? (
          <PanelEmpty message={t(locale, filter === "unread" ? "notification.noUnread" : "notification.empty")} />
        ) : (
          <div className={styles.notificationList}>
            {filteredNotifications.map((notification) => (
              <div
                key={notification.id}
                className={`${styles.notificationItem} ${!notification.read ? styles.unread : ""}`}
                onClick={() => markRead(notification.id)}
              >
                <div className={`${styles.notificationIcon} ${getTypeClass(notification.type)}`}>
                  {getTypeIcon(notification.type)}
                </div>
                <div className={styles.notificationContent}>
                  <div className={styles.notificationHeader}>
                    <span className={`${styles.notificationTitle} ${styles.truncate}`}>{notification.title}</span>
                    <span className={`${styles.notificationTime} ${styles.monoText}`}>{formatTimeAgo(notification.createdAt)}</span>
                  </div>
                  <div className={styles.notificationMessage}>{notification.message}</div>
                  {notification.url && (
                    <Link
                      href={`${notification.url}?lang=${encodeURIComponent(locale)}`}
                      className={styles.notificationLink}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t(locale, "notification.viewDetails")}
                    </Link>
                  )}
                </div>
                {!notification.read && <div className={styles.unreadDot} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
