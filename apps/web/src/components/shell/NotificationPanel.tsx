"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
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

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconBell() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>;
}

function IconShield() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
}

function IconAlert() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
}

function IconCheck() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
}

function IconInfo() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>;
}

function IconRefresh() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
}

function IconCheckAll() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>;
}

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function NotificationPanel({ locale }: { locale: string }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  // Demo data (in real implementation, this would fetch from API)
  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      // Try to fetch from API
      const res = await apiFetch(`/notifications?limit=50`, { method: "GET", locale });
      if (res.ok) {
        const data = await res.json() as { notifications?: NotificationItem[] };
        setNotifications(data.notifications || []);
      } else {
        // Use demo data if API not available
        setNotifications([
          {
            id: "n1",
            type: "audit",
            title: t(locale, "notification.audit.title"),
            message: t(locale, "notification.audit.example"),
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            read: false,
            url: "/gov/audit",
          },
          {
            id: "n2",
            type: "approval",
            title: t(locale, "notification.approval.title"),
            message: t(locale, "notification.approval.example"),
            createdAt: new Date(Date.now() - 7200000).toISOString(),
            read: false,
            url: "/gov/approvals",
          },
          {
            id: "n3",
            type: "policy_reject",
            title: t(locale, "notification.policyReject.title"),
            message: t(locale, "notification.policyReject.example"),
            createdAt: new Date(Date.now() - 86400000).toISOString(),
            read: true,
          },
          {
            id: "n4",
            type: "system",
            title: t(locale, "notification.system.title"),
            message: t(locale, "notification.system.example"),
            createdAt: new Date(Date.now() - 172800000).toISOString(),
            read: true,
          },
        ]);
      }
    } catch {
      // Use demo data on error
      setNotifications([]);
    }
    setLoading(false);
  }, [locale]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial data load
    loadNotifications();
  }, [loadNotifications]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const getTypeIcon = (type: NotificationItem["type"]) => {
    switch (type) {
      case "audit": return <IconShield />;
      case "policy_reject": return <IconAlert />;
      case "approval": return <IconCheck />;
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
