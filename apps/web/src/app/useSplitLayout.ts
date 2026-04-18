"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SPLIT_KEY = "openslin_split_layout";

function readSavedSplitLayout(): { leftWidth: number; leftCollapsed: boolean; rightCollapsed: boolean } {
  if (typeof window === "undefined") {
    return { leftWidth: 50, leftCollapsed: false, rightCollapsed: false };
  }
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (!raw) return { leftWidth: 50, leftCollapsed: false, rightCollapsed: false };
    const saved = JSON.parse(raw) as { leftWidth?: number; leftCollapsed?: boolean; rightCollapsed?: boolean };
    return {
      leftWidth: typeof saved.leftWidth === "number" ? saved.leftWidth : 50,
      leftCollapsed: Boolean(saved.leftCollapsed),
      rightCollapsed: Boolean(saved.rightCollapsed),
    };
  } catch {
    return { leftWidth: 50, leftCollapsed: false, rightCollapsed: false };
  }
}

export interface SplitLayoutState {
  layoutRestored: boolean;
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  isDragging: boolean;
  splitRef: React.RefObject<HTMLDivElement | null>;
  setLeftWidth: React.Dispatch<React.SetStateAction<number>>;
  setLeftCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setRightCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  handleDragStart: (e: React.MouseEvent) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
}

/** SSR-safe defaults (must match the server render) */
const SSR_DEFAULTS = { leftWidth: 50, leftCollapsed: false, rightCollapsed: false };

export default function useSplitLayout(): SplitLayoutState {
  const [layoutRestored, setLayoutRestored] = useState(false);
  const [leftWidth, setLeftWidth] = useState<number>(SSR_DEFAULTS.leftWidth);
  const [leftCollapsed, setLeftCollapsed] = useState(SSR_DEFAULTS.leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(SSR_DEFAULTS.rightCollapsed);

  useEffect(() => {
    const saved = readSavedSplitLayout();
    const frameId = window.requestAnimationFrame(() => {
      setLeftWidth(saved.leftWidth);
      setLeftCollapsed(saved.leftCollapsed);
      setRightCollapsed(saved.rightCollapsed);
      setLayoutRestored(true);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!layoutRestored) return;
    try { localStorage.setItem(SPLIT_KEY, JSON.stringify({ leftWidth, leftCollapsed, rightCollapsed })); } catch { /* ignore */ }
  }, [leftWidth, leftCollapsed, rightCollapsed, layoutRestored]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.max(15, Math.min(85, pct)));
    };
    const handleUp = () => setIsDragging(false);
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((p) => {
      if (!p && rightCollapsed) setRightCollapsed(false);
      return !p;
    });
  }, [rightCollapsed]);

  const toggleRight = useCallback(() => {
    setRightCollapsed((p) => {
      if (!p && leftCollapsed) setLeftCollapsed(false);
      return !p;
    });
  }, [leftCollapsed]);

  return {
    layoutRestored,
    leftWidth,
    leftCollapsed,
    rightCollapsed,
    isDragging,
    splitRef,
    setLeftWidth,
    setLeftCollapsed,
    setRightCollapsed,
    handleDragStart,
    toggleLeft,
    toggleRight,
  };
}
