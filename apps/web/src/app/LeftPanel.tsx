"use client";

import { Suspense, lazy, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import type { WorkspaceTab, RecentEntry } from "./homeHelpers";
import ArtifactPreview from "@/components/artifact/ArtifactPreview";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import {
  IconClose, IconExternal, IconChevronLeft, IconPage, IconPin, IconDragHandle,
} from "./HomeIcons";
import styles from "@/styles/page.module.css";

const DynamicBlockRenderer = lazy(() => import("@/components/nl2ui/DynamicBlockRenderer"));

export interface LeftPanelProps {
  locale: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  toggleLeft: () => void;
  pinnedTabs: WorkspaceTab[];
  previewTab: WorkspaceTab | null;
  activeTabId: string | null;
  setActiveTabId: (id: string | null) => void;
  visibleTab: WorkspaceTab | null;
  draggedTabId: string | null;
  dragOverTabId: string | null;
  getTabIcon: (kind: WorkspaceTab["kind"]) => React.ReactNode;
  handleTabDragStart: (e: React.DragEvent, id: string) => void;
  handleTabDragOver: (e: React.DragEvent, id: string) => void;
  handleTabDragLeave: (e: React.DragEvent) => void;
  handleTabDrop: (e: React.DragEvent, id: string) => void;
  handleTabDragEnd: (e: React.DragEvent) => void;
  handlePreviewDoubleClick: () => void;
  pinCurrentPreview: () => void;
  unpinTab: (id: string) => void;
  closePreview: () => void;
  closePanel: () => void;
  recent: RecentEntry[];
  openRecentInPanel: (entry: RecentEntry) => void;
}

export default function LeftPanel(props: LeftPanelProps) {
  const {
    locale, leftCollapsed, rightCollapsed, leftWidth, toggleLeft,
    pinnedTabs, previewTab, activeTabId, setActiveTabId, visibleTab,
    draggedTabId, dragOverTabId, getTabIcon,
    handleTabDragStart, handleTabDragOver, handleTabDragLeave, handleTabDrop, handleTabDragEnd,
    handlePreviewDoubleClick, pinCurrentPreview, unpinTab, closePreview, closePanel,
    recent, openRecentInPanel,
  } = props;

  const router = useRouter();

  // SSR hydration guard: ensure first client render matches server output
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  return (
    <div
      className={`${styles.panelSide} ${leftCollapsed ? styles.panelCollapsed : ""}`}
      style={leftCollapsed ? undefined : rightCollapsed ? { flex: 1 } : { width: `${leftWidth}%` }}
    >
      {/* Collapse toggle */}
      {!leftCollapsed && (
        <button
          className={`${styles.collapseBtn} ${styles.collapseBtnLeft}`}
          onClick={toggleLeft}
          title={t(locale, "panel.collapseLeft")}
        >
          <IconChevronLeft />
        </button>
      )}

      {/* Tab bar */}
      {hydrated && (pinnedTabs.length > 0 || previewTab) && (
        <div className={styles.wsTabs}>
          <div className={styles.wsTabList}>
            {pinnedTabs.map((tab) => (
              <button
                key={tab.id}
                className={`${styles.wsTab} ${activeTabId === tab.id ? styles.wsTabActive : ""} ${styles[`wsTab_${tab.kind}`] || ""} ${draggedTabId === tab.id ? styles.wsTabDragging : ""} ${dragOverTabId === tab.id ? styles.wsTabDragOver : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                title={tab.name}
                draggable
                onDragStart={(e) => handleTabDragStart(e, tab.id)}
                onDragOver={(e) => handleTabDragOver(e, tab.id)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => handleTabDrop(e, tab.id)}
                onDragEnd={handleTabDragEnd}
              >
                <span className={styles.wsTabDragHandle}><IconDragHandle /></span>
                <span className={styles.wsTabIcon}>{getTabIcon(tab.kind)}</span>
                <span className={styles.wsTabLabel}>{tab.name}</span>
                <span className={styles.wsTabClose} onClick={(e) => { e.stopPropagation(); unpinTab(tab.id); }} title={t(locale, "workspace.unpin")}>×</span>
              </button>
            ))}
            {previewTab && (
              <button
                className={`${styles.wsTab} ${styles.wsTabPreview} ${activeTabId === "__preview__" ? styles.wsTabActive : ""} ${styles[`wsTab_${previewTab.kind}`] || ""}`}
                onClick={() => setActiveTabId("__preview__")}
                onDoubleClick={handlePreviewDoubleClick}
                title={`${t(locale, "workspace.preview")}: ${previewTab.name} (${t(locale, "workspace.doubleClickToPin")})`}
              >
                <span className={styles.wsTabIcon}>{getTabIcon(previewTab.kind)}</span>
                <span className={styles.wsTabLabel} style={{ fontStyle: "italic" }}>{previewTab.name}</span>
                <span className={styles.wsTabPin} onClick={(e) => { e.stopPropagation(); pinCurrentPreview(); }} title={t(locale, "workspace.pin")}>
                  <IconPin />
                </span>
                <span className={styles.wsTabClose} onClick={(e) => { e.stopPropagation(); closePreview(); }} title={t(locale, "panel.close")}>×</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content area */}
      {hydrated && visibleTab ? (
        <>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>{visibleTab.name}</span>
            <div className={styles.panelActions}>
              {activeTabId === "__preview__" && previewTab && (
                <button
                  className={styles.panelIconBtn}
                  title={t(locale, "workspace.pin")}
                  onClick={pinCurrentPreview}
                  style={{ color: "var(--sl-accent)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                </button>
              )}
              <button
                className={styles.panelIconBtn}
                title={t(locale, "panel.openNewTab")}
                onClick={() => router.push(visibleTab.url)}
              >
                <IconExternal />
              </button>
              <button className={styles.panelIconBtn} title={t(locale, "panel.close")} onClick={closePanel}>
                <IconClose />
              </button>
            </div>
          </div>
          {/* Render artifact preview, nl2ui preview, or iframe */}
          {visibleTab.kind === "artifact" && visibleTab.meta?.artifactData !== undefined ? (
            <div className={styles.panelContent}>
              <ArtifactPreview
                type={visibleTab.meta.artifactType || "text"}
                data={visibleTab.meta.artifactData}
                locale={locale}
              />
            </div>
          ) : visibleTab.kind === "nl2uiPreview" && visibleTab.meta?.nl2uiConfig ? (
            <div className={styles.panelContent}>
              <Suspense fallback={<div style={{ padding: 16, color: "var(--sl-muted)" }}>{t(locale, "nl2ui.generating")}</div>}>
                <DynamicBlockRenderer
                  config={visibleTab.meta.nl2uiConfig as Nl2UiConfig}
                  readOnly={false}
                  locale={locale}
                />
              </Suspense>
            </div>
          ) : visibleTab.url ? (
            <iframe className={styles.panelFrame} src={visibleTab.url} title={visibleTab.name} sandbox="allow-scripts allow-same-origin" />
          ) : (
            <div className={styles.panelEmpty}>
              <div className={styles.panelEmptyIcon}><IconPage /></div>
              <div className={styles.panelEmptyTitle}>{t(locale, "panel.noUrl")}</div>
            </div>
          )}
        </>
      ) : (
        <div className={styles.panelEmpty}>
          <div className={styles.panelEmptyIcon}>
            <IconPage />
          </div>
          <div className={styles.panelEmptyTitle}>{t(locale, "panel.emptyTitle")}</div>
          <div className={styles.panelEmptyDesc}>{t(locale, "panel.emptyDesc")}</div>
          {recent.length > 0 && (
            <div className={styles.panelEmptyActions}>
              {recent.slice(0, 4).map((r, i) => (
                <button key={`${r.kind}_${r.name}_${i}`} className={styles.suggestChip} onClick={() => openRecentInPanel(r)}>
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
