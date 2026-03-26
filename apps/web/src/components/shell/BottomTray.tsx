"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { t } from "@/lib/i18n";
import RunHistoryPanel from "./RunHistoryPanel";
import NotificationPanel from "./NotificationPanel";
import DeviceActionsPanel from "./DeviceActionsPanel";
import ActiveRunList from "./ActiveRunList";
import PendingActionsQueue from "./PendingActionsQueue";
import styles from "./BottomTray.module.css";

/* ─── Icons ─────────────────────────────────────────────────────────────────── */

function IconHistory() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
}

function IconBell() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>;
}

function IconDevice() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>;
}

function IconPlay() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" /></svg>;
}

function IconInbox() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>;
}

function IconChevronUp() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15" /></svg>;
}

function IconChevronDown() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>;
}

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type TrayTab = "activeRuns" | "pendingActions" | "runs" | "notifications" | "deviceActions";

/* ─── Component ─────────────────────────────────────────────────────────────── */

export default function BottomTray({ locale }: { locale: string }) {
  const TRAY_KEY = "openslin_bottom_tray";
  const trayRef = useRef<HTMLDivElement>(null);

  // SSR-safe: use fixed defaults, restore from localStorage in useEffect
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<TrayTab>("activeRuns");
  const [height, setHeight] = useState(280);
  const [isDragging, setIsDragging] = useState(false);
  const [hydrated, setHydrated] = useState(false);

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

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const newHeight = window.innerHeight - e.clientY;
      setHeight(Math.max(150, Math.min(500, newHeight)));
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

  const tabs: { key: TrayTab; icon: React.ReactNode; labelKey: string }[] = [
    { key: "activeRuns", icon: <IconPlay />, labelKey: "activeRuns.title" },
    { key: "pendingActions", icon: <IconInbox />, labelKey: "pendingActions.title" },
    { key: "runs", icon: <IconHistory />, labelKey: "bottomTray.runs" },
    { key: "notifications", icon: <IconBell />, labelKey: "bottomTray.notifications" },
    { key: "deviceActions", icon: <IconDevice />, labelKey: "bottomTray.deviceActions" },
  ];

  return (
    <div ref={trayRef} className={`${styles.bottomTray} ${expanded ? styles.bottomTrayExpanded : ""}`}>
      {/* Resize handle */}
      {expanded && (
        <div
          className={`${styles.resizeHandle} ${isDragging ? styles.resizeHandleActive : ""}`}
          onMouseDown={handleDragStart}
        />
      )}

      {/* Header bar (always visible) */}
      <div className={styles.header}>
        <div className={styles.tabs}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ""}`}
              onClick={() => {
                setActiveTab(tab.key);
                if (!expanded) setExpanded(true);
              }}
            >
              {tab.icon}
              <span className={styles.tabLabel}>{t(locale, tab.labelKey)}</span>
            </button>
          ))}
        </div>
        <button className={styles.expandBtn} onClick={toggleExpand}>
          {expanded ? <IconChevronDown /> : <IconChevronUp />}
          <span>{t(locale, expanded ? "bottomTray.collapse" : "bottomTray.expand")}</span>
        </button>
      </div>

      {/* Content panel (only when expanded) */}
      {expanded && (
        <div className={styles.content} style={{ height }}>
          {activeTab === "activeRuns" && <ActiveRunList locale={locale} />}
          {activeTab === "pendingActions" && <PendingActionsQueue locale={locale} />}
          {activeTab === "runs" && <RunHistoryPanel locale={locale} />}
          {activeTab === "notifications" && <NotificationPanel locale={locale} />}
          {activeTab === "deviceActions" && <DeviceActionsPanel locale={locale} />}
        </div>
      )}
    </div>
  );
}
