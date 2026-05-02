"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSplitLayoutStore } from "@/store/layoutStore";

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

export default function useSplitLayout(): SplitLayoutState {
  /* ── Zustand (persisted) state ── */
  const leftWidth = useSplitLayoutStore((s) => s.leftWidth);
  const leftCollapsed = useSplitLayoutStore((s) => s.leftCollapsed);
  const rightCollapsed = useSplitLayoutStore((s) => s.rightCollapsed);
  const setLeftWidth = useSplitLayoutStore((s) => s.setLeftWidth);
  const setLeftCollapsed = useSplitLayoutStore((s) => s.setLeftCollapsed);
  const setRightCollapsed = useSplitLayoutStore((s) => s.setRightCollapsed);

  /* ── SSR hydration guard ── */
  const [layoutRestored, setLayoutRestored] = useState(false);
  useEffect(() => {
    // Zustand persist hydrates asynchronously; mark restored after first frame
    const frameId = window.requestAnimationFrame(() => setLayoutRestored(true));
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  /* ── Local-only UI state ── */
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

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
  }, [isDragging, setLeftWidth]);

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((p) => {
      if (!p && rightCollapsed) setRightCollapsed(false);
      return !p;
    });
  }, [rightCollapsed, setLeftCollapsed, setRightCollapsed]);

  const toggleRight = useCallback(() => {
    setRightCollapsed((p) => {
      if (!p && leftCollapsed) setLeftCollapsed(false);
      return !p;
    });
  }, [leftCollapsed, setRightCollapsed, setLeftCollapsed]);

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
