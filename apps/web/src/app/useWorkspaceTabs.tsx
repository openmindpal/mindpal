"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type WorkspaceTab } from "./homeHelpers";
import { IconRun, IconApproval, IconKnowledge, IconArtifact, IconWorkbench, IconPanel, IconPage } from "./HomeIcons";

const WORKSPACE_KEY = "openslin_workspace_tabs";

export interface WorkspaceTabsState {
  pinnedTabs: WorkspaceTab[];
  setPinnedTabs: React.Dispatch<React.SetStateAction<WorkspaceTab[]>>;
  previewTab: WorkspaceTab | null;
  setPreviewTab: React.Dispatch<React.SetStateAction<WorkspaceTab | null>>;
  activeTabId: string | null;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  visibleTab: WorkspaceTab | null;
  draggedTabId: string | null;
  dragOverTabId: string | null;
  openInWorkspace: (entry: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => void;
  getTabIcon: (kind: WorkspaceTab["kind"]) => React.ReactNode;
  pinCurrentPreview: () => void;
  unpinTab: (tabId: string) => void;
  closePreview: () => void;
  handleTabDragStart: (e: React.DragEvent, tabId: string) => void;
  handleTabDragOver: (e: React.DragEvent, tabId: string) => void;
  handleTabDragLeave: () => void;
  handleTabDrop: (e: React.DragEvent, targetTabId: string) => void;
  handleTabDragEnd: () => void;
  handlePreviewDoubleClick: () => void;
}

export default function useWorkspaceTabs(opts: {
  leftCollapsed: boolean;
  setLeftCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
}): WorkspaceTabsState {
  const { leftCollapsed, setLeftCollapsed } = opts;
  const [savedWorkspace] = useState(() => {
    let pinned: WorkspaceTab[] = [];
    let activeTabId: string | null = null;
    if (typeof window === "undefined") {
      return { pinnedTabs: pinned, activeTabId };
    }
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { pinned?: WorkspaceTab[]; activeTabId?: string | null };
        pinned = Array.isArray(saved.pinned) ? saved.pinned : [];
        activeTabId = saved.activeTabId ?? pinned[0]?.id ?? null;
      }
    } catch {
      activeTabId = pinned[0]?.id ?? null;
    }
    return { pinnedTabs: pinned, activeTabId };
  });

  const [pinnedTabs, setPinnedTabs] = useState<WorkspaceTab[]>(savedWorkspace.pinnedTabs);
  const [previewTab, setPreviewTab] = useState<WorkspaceTab | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(savedWorkspace.activeTabId);

  /* ─── Tab drag state ─── */
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);

  const [layoutRestored] = useState(true);

  useEffect(() => {
    if (!layoutRestored) return;
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ pinned: pinnedTabs, activeTabId }));
    } catch { /* ignore */ }
  }, [pinnedTabs, activeTabId, layoutRestored]);

  // Derived: the currently visible tab (active pinned tab, or preview)
  const visibleTab: WorkspaceTab | null = useMemo(() => {
    if (activeTabId === "__preview__" && previewTab) return previewTab;
    const found = pinnedTabs.find((t) => t.id === activeTabId);
    if (found) return found;
    if (previewTab) return previewTab;
    return pinnedTabs[0] ?? null;
  }, [pinnedTabs, previewTab, activeTabId]);

  // Workspace actions
  const openInWorkspace = useCallback((entry: { kind: WorkspaceTab["kind"]; name: string; url: string; meta?: WorkspaceTab["meta"] }) => {
    // Check if already pinned — if so, just switch to it
    const existing = pinnedTabs.find((t) => t.kind === entry.kind && t.name === entry.name);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      // Open as preview (temporary)
      const tab: WorkspaceTab = { id: "__preview__", kind: entry.kind, name: entry.name, url: entry.url, meta: entry.meta };
      setPreviewTab(tab);
      setActiveTabId("__preview__");
    }
    if (leftCollapsed) setLeftCollapsed(false);
  }, [pinnedTabs, leftCollapsed, setLeftCollapsed]);

  // Helper: get icon for tab kind
  const getTabIcon = (kind: WorkspaceTab["kind"]) => {
    switch (kind) {
      case "runDetail": return <IconRun />;
      case "approvalDetail": return <IconApproval />;
      case "knowledgeResult": return <IconKnowledge />;
      case "artifact": return <IconArtifact />;
      case "workbench": return <IconWorkbench />;
      case "nl2uiPreview": return <IconPanel />;
      case "page":
      default: return <IconPage />;
    }
  };

  const pinCurrentPreview = useCallback(() => {
    if (!previewTab) return;
    const newTab: WorkspaceTab = { ...previewTab, id: `ws_${Date.now()}` };
    setPinnedTabs((prev) => {
      // Avoid duplicates
      if (prev.some((t) => t.kind === newTab.kind && t.name === newTab.name)) return prev;
      return [...prev, newTab];
    });
    setActiveTabId(newTab.id);
    setPreviewTab(null);
  }, [previewTab]);

  const unpinTab = useCallback((tabId: string) => {
    setPinnedTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // If active tab was removed, switch to another
      if (activeTabId === tabId) {
        const idx = prev.findIndex((t) => t.id === tabId);
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveTabId(fallback?.id ?? (previewTab ? "__preview__" : null));
      }
      return next;
    });
  }, [activeTabId, previewTab]);

  const closePreview = useCallback(() => {
    setPreviewTab(null);
    if (activeTabId === "__preview__") {
      setActiveTabId(pinnedTabs[pinnedTabs.length - 1]?.id ?? null);
    }
  }, [activeTabId, pinnedTabs]);

  /* ─── Tab drag handlers ─── */
  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tabId);
    setDraggedTabId(tabId);
  }, []);

  const handleTabDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (draggedTabId && draggedTabId !== tabId) {
      setDragOverTabId(tabId);
    }
  }, [draggedTabId]);

  const handleTabDragLeave = useCallback(() => {
    setDragOverTabId(null);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (!draggedTabId || draggedTabId === targetTabId) {
      setDraggedTabId(null);
      setDragOverTabId(null);
      return;
    }

    setPinnedTabs((prev) => {
      const dragIdx = prev.findIndex((t) => t.id === draggedTabId);
      const dropIdx = prev.findIndex((t) => t.id === targetTabId);
      if (dragIdx < 0 || dropIdx < 0) return prev;

      const newTabs = [...prev];
      const [dragged] = newTabs.splice(dragIdx, 1);
      newTabs.splice(dropIdx, 0, dragged);
      return newTabs;
    });

    setDraggedTabId(null);
    setDragOverTabId(null);
  }, [draggedTabId]);

  const handleTabDragEnd = useCallback(() => {
    setDraggedTabId(null);
    setDragOverTabId(null);
  }, []);

  /* ─── Double-click to pin preview ─── */
  const handlePreviewDoubleClick = useCallback(() => {
    pinCurrentPreview();
  }, [pinCurrentPreview]);

  return {
    pinnedTabs,
    setPinnedTabs,
    previewTab,
    setPreviewTab,
    activeTabId,
    setActiveTabId,
    visibleTab,
    draggedTabId,
    dragOverTabId,
    openInWorkspace,
    getTabIcon,
    pinCurrentPreview,
    unpinTab,
    closePreview,
    handleTabDragStart,
    handleTabDragOver,
    handleTabDragLeave,
    handleTabDrop,
    handleTabDragEnd,
    handlePreviewDoubleClick,
  };
}
