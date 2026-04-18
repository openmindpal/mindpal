"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { IconHistory, IconBell, IconDevice, IconPlayLg, IconInbox, IconChevronUp, IconChevronDown } from "./ShellIcons";
import RunHistoryPanel from "./RunHistoryPanel";
import NotificationPanel from "./NotificationPanel";
import DeviceActionsPanel from "./DeviceActionsPanel";
import ActiveRunList from "./ActiveRunList";
import PendingActionsQueue from "./PendingActionsQueue";
import styles from "./BottomTray.module.css";

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type TrayTab = "activeRuns" | "pendingActions" | "runs" | "notifications" | "deviceActions";

interface TabBadgeCounts {
  activeRuns: number;
  pendingActions: number;
  notifications: number;
  deviceActions: number;
}

/* ─── Badge count fetcher (lightweight, single round-trip where possible) ──── */

async function fetchBadgeCounts(locale: string): Promise<TabBadgeCounts> {
  const counts: TabBadgeCounts = { activeRuns: 0, pendingActions: 0, notifications: 0, deviceActions: 0 };
  try {
    const [activeRes, approvalsRes, runsRes, deadlettersRes, notifRes, deviceRes] = await Promise.all([
      apiFetch("/runs/active?limit=1", { locale, cache: "no-store" }).catch(() => null),
      apiFetch("/approvals?status=pending&limit=1", { locale, cache: "no-store" }).catch(() => null),
      apiFetch("/runs?status=failed&limit=1", { locale, cache: "no-store" }).catch(() => null),
      apiFetch("/governance/workflow/deadletters?limit=1", { locale, cache: "no-store" }).catch(() => null),
      apiFetch("/notifications/outbox?limit=50", { locale, cache: "no-store" }).catch(() => null),
      apiFetch("/device-executions?limit=1", { locale, cache: "no-store" }).catch(() => null),
    ]);

    if (activeRes?.ok) {
      const d = await activeRes.json();
      counts.activeRuns = (d.activeRuns as unknown[])?.length ?? d.total ?? 0;
    }

    // Pending actions = approvals + failed runs + deadletters
    if (approvalsRes?.ok) {
      const d = await approvalsRes.json();
      counts.pendingActions += (d.items as unknown[])?.length ?? d.total ?? 0;
    }
    if (runsRes?.ok) {
      const d = await runsRes.json();
      counts.pendingActions += (d.runs as unknown[])?.length ?? d.total ?? 0;
    }
    if (deadlettersRes?.ok) {
      const d = await deadlettersRes.json();
      counts.pendingActions += (d.deadletters as unknown[])?.length ?? d.total ?? 0;
    }

    if (notifRes?.ok) {
      const d = await notifRes.json();
      const outbox = (d.outbox as { deliveryStatus?: string }[]) ?? [];
      counts.notifications = outbox.filter((o) => o.deliveryStatus !== "sent" && o.deliveryStatus !== "canceled").length;
    }

    if (deviceRes?.ok) {
      const d = await deviceRes.json();
      const execs = (d.executions as { status?: string }[]) ?? [];
      counts.deviceActions = execs.filter((e) => e.status === "pending" || e.status === "claimed").length;
    }
  } catch (err) {
    console.error("[BottomTray] badge count fetch error:", err);
  }
  return counts;
}

/* ─── Callback type for sub-panels to report their counts ───────────────── */

export type BadgeUpdateFn = (key: keyof TabBadgeCounts, count: number) => void;

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function BottomTray({
  locale,
}: {
  locale: string;
}) {
  const TRAY_KEY = "openslin_bottom_tray";
  const trayRef = useRef<HTMLDivElement>(null);

  // SSR-safe: use fixed defaults, restore from localStorage in useEffect
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<TrayTab>("activeRuns");
  const [height, setHeight] = useState(280);
  const [isDragging, setIsDragging] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  /* ─── Badge counts ─── */
  const [badges, setBadges] = useState<TabBadgeCounts>({ activeRuns: 0, pendingActions: 0, notifications: 0, deviceActions: 0 });
  const refreshBadges = useCallback(async () => {
    const c = await fetchBadgeCounts(locale);
    setBadges(c);
  }, [locale]);

  // Sub-panel badge update callback — avoids redundant API calls
  const updateBadge: BadgeUpdateFn = useCallback((key, count) => {
    setBadges((prev) => (prev[key] === count ? prev : { ...prev, [key]: count }));
  }, []);

  // Initial badge load + periodic refresh (only when collapsed; expanded panels report their own counts)
  useEffect(() => {
    const initial = setTimeout(refreshBadges, 0);
    const timer = setInterval(() => {
      // Skip polling when expanded — sub-panels refresh themselves
      if (!trayRef.current?.classList.contains(styles.bottomTrayExpanded)) {
        refreshBadges();
      }
    }, 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refreshBadges]);

  // Restore state from localStorage after hydration
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TRAY_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { expanded?: boolean; activeTab?: TrayTab; height?: number };
        // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration: must restore localStorage state after mount
        if (typeof saved.expanded === "boolean") setExpanded(saved.expanded);
        if (saved.activeTab) setActiveTab(saved.activeTab);
        if (typeof saved.height === "number") setHeight(saved.height);
      }
    } catch {}
    setHydrated(true);
  }, []);

  // Persist state (only after hydration to avoid overwriting with defaults)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(TRAY_KEY, JSON.stringify({ expanded, activeTab, height }));
    } catch {}
  }, [expanded, activeTab, height, hydrated]);

  // Click outside to collapse
  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [expanded]);

  // Drag resize handler
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  // Double-click resize handle to toggle full height
  const handleDragDoubleClick = useCallback(() => {
    const maxH = Math.round(window.innerHeight * 0.7);
    setHeight((prev) => (prev >= maxH - 10 ? 280 : maxH));
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const maxH = Math.round(window.innerHeight * 0.7);
      const newHeight = window.innerHeight - e.clientY;
      setHeight(Math.max(150, Math.min(maxH, newHeight)));
    };
    const handleUp = () => setIsDragging(false);
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  const toggleExpand = useCallback(() => {
    setExpanded((p) => !p);
  }, []);

  const tabs: { key: TrayTab; icon: React.ReactNode; labelKey: string; badgeKey?: keyof TabBadgeCounts }[] = [
    { key: "activeRuns", icon: <IconPlayLg />, labelKey: "activeRuns.title", badgeKey: "activeRuns" },
    { key: "pendingActions", icon: <IconInbox />, labelKey: "pendingActions.title", badgeKey: "pendingActions" },
    { key: "runs", icon: <IconHistory />, labelKey: "bottomTray.runs" },
    { key: "notifications", icon: <IconBell />, labelKey: "bottomTray.notifications", badgeKey: "notifications" },
    { key: "deviceActions", icon: <IconDevice />, labelKey: "bottomTray.deviceActions", badgeKey: "deviceActions" },
  ];


  return (
    <div ref={trayRef} className={`${styles.bottomTray} ${expanded ? styles.bottomTrayExpanded : ""}`}>
      {/* Resize handle */}
      {expanded && (
        <div
          className={`${styles.resizeHandle} ${isDragging ? styles.resizeHandleActive : ""}`}
          onMouseDown={handleDragStart}
          onDoubleClick={handleDragDoubleClick}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panel"
        />
      )}

      {/* Header bar (always visible) */}
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Bottom tray tabs">
          {tabs.map((tab) => {
            const count = tab.badgeKey ? badges[tab.badgeKey] : 0;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                id={`tray-tab-${tab.key}`}
                aria-selected={isActive}
                aria-controls={expanded ? `tray-panel-${tab.key}` : undefined}
                className={`${styles.tab} ${isActive ? styles.tabActive : ""}`}
                onClick={() => {
                  setActiveTab(tab.key);
                  if (!expanded) setExpanded(true);
                }}
                title={t(locale, tab.labelKey)}
              >
                {tab.icon}
                <span className={styles.tabLabel}>{t(locale, tab.labelKey)}</span>
                {count > 0 && (
                  <span
                    className={`${styles.tabBadge} ${
                      tab.key === "pendingActions" ? styles.tabBadgeWarning
                        : tab.key === "notifications" ? styles.tabBadgeInfo
                        : ""
                    }`}
                    aria-label={`${count} items`}
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className={styles.headerActions}>
          {/* Collapsed summary: show quick status when tray is collapsed */}
          {!expanded && (badges.activeRuns > 0 || badges.pendingActions > 0) && (
            <span className={styles.collapsedSummary}>
              {badges.activeRuns > 0 && (
                <>
                  <span className={`${styles.summaryDot} ${styles.summaryDotActive}`} />
                  <span className={styles.summaryText}>
                    {badges.activeRuns} {t(locale, "bottomTray.summaryRunning")}
                  </span>
                </>
              )}
              {badges.pendingActions > 0 && (
                <>
                  <span className={`${styles.summaryDot} ${styles.summaryDotWarning}`} />
                  <span className={styles.summaryText}>
                    {badges.pendingActions} {t(locale, "bottomTray.summaryPending")}
                  </span>
                </>
              )}
            </span>
          )}
          <button
            className={styles.expandBtn}
            onClick={toggleExpand}
            aria-expanded={expanded}
            aria-label={t(locale, expanded ? "bottomTray.collapse" : "bottomTray.expand")}
          >
            {expanded ? <IconChevronDown /> : <IconChevronUp />}
            <span>{t(locale, expanded ? "bottomTray.collapse" : "bottomTray.expand")}</span>
          </button>
        </div>
      </div>

      {/* Content panel (only when expanded) */}
      {expanded && (
        <div
          className={styles.content}
          style={{ height }}
          role="tabpanel"
          id={`tray-panel-${activeTab}`}
          aria-labelledby={`tray-tab-${activeTab}`}
        >
          {activeTab === "activeRuns" && <ActiveRunList locale={locale} onBadgeUpdate={(count: number) => updateBadge("activeRuns", count)} />}
          {activeTab === "pendingActions" && <PendingActionsQueue locale={locale} onBadgeUpdate={(count: number) => updateBadge("pendingActions", count)} />}
          {activeTab === "runs" && <RunHistoryPanel locale={locale} />}
          {activeTab === "notifications" && <NotificationPanel locale={locale} onBadgeUpdate={(count: number) => updateBadge("notifications", count)} />}
          {activeTab === "deviceActions" && <DeviceActionsPanel locale={locale} onBadgeUpdate={(count: number) => updateBadge("deviceActions", count)} />}
        </div>
      )}
    </div>
  );
}
