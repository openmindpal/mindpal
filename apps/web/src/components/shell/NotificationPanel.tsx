"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconBell, IconShield, IconAlert, IconCheckLg, IconInfo, IconRefresh, IconCheckAll } from "./ShellIcons";
import styles from "./NotificationPanel.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

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
    message: `Status: ${rec.deliveryStatus}`,
    createdAt: rec.createdAt,
    read: rec.deliveryStatus === "sent" || rec.deliveryStatus === "canceled",
    url: "/gov/notifications",
  };
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function NotificationPanel({ locale, onBadgeUpdate }: { locale: string; onBadgeUpdate?: (count: number) => void }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/notifications/outbox?limit=50`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { outbox?: OutboxRecord[] };
        const mapped = (data.outbox || []).map(mapOutboxToNotification);
        setNotifications(mapped);
        const unread = mapped.filter((n) => !n.read).length;
        onBadgeUpdate?.(unread);
      } else {
        setNotifications([]);
      }
    } catch (err) {
      // Network error — show empty list
      console.error("Failed to load notifications:", err);
      setNotifications([]);
    }
    setLoading(false);
  }, [locale, onBadgeUpdate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial data load
    loadNotifications();
  }, [loadNotifications]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const timer = setInterval(loadNotifications, 30_000);
    return () => clearInterval(timer);
  }, [loadNotifications]);

  const markAllRead = useCallback(async () => {
    // Optimistic UI update
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    onBadgeUpdate?.(0);
    // Sync to backend (fire-and-forget)
    try {
      await apiFetch("/notifications/inbox/read-all", { method: "POST", locale });
    } catch (err) {
      console.error("[NotificationPanel] markAllRead API error:", err);
    }
  }, [locale, onBadgeUpdate]);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, read: true } : n));
      const unread = updated.filter((n) => !n.read).length;
      onBadgeUpdate?.(unread);
      return updated;
    });
    // Sync single read to backend (fire-and-forget)
    apiFetch(`/notifications/inbox/${encodeURIComponent(id)}/read`, { method: "POST", locale }).catch(() => {});
  }, [locale, onBadgeUpdate]);

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

  const formatTime = (ts: string) => {
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
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>{t(locale, "notification.title")}</span>
          {unreadCount > 0 && (
            <span className={styles.unreadBadge}>{unreadCount}</span>
          )}
        </div>
        <div className={styles.headerActions}>
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
          <button className={styles.refreshBtn} onClick={loadNotifications} disabled={loading}>
            <IconRefresh />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={styles.content}>
        {loading && notifications.length === 0 ? (
          <div className={styles.loading}>{t(locale, "common.loading")}</div>
        ) : filteredNotifications.length === 0 ? (
          <div className={styles.empty}>
            <IconBell />
            <span>{t(locale, filter === "unread" ? "notification.noUnread" : "notification.empty")}</span>
          </div>
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
                    <span className={styles.notificationTitle}>{notification.title}</span>
                    <span className={styles.notificationTime}>{formatTime(notification.createdAt)}</span>
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
