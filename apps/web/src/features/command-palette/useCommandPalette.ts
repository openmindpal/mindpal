"use client";

import { useEffect } from "react";
import { useUiStore } from "@/shared/stores/ui.store";

/**
 * Global shortcut hook for the Command Palette.
 * Registers ⌘K / Ctrl+K to toggle the palette.
 * Call this hook in AppShell or root layout to activate the shortcut.
 */
export function useCommandPalette() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        useUiStore.getState().toggleCommandPalette();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
