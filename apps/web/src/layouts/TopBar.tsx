'use client';

import { Menu, Search, Bell } from 'lucide-react';
import { Avatar } from '@/shared/components/primitives';
import { useUiStore } from '@/shared/stores';
import { cn } from '@/shared/lib/cn';

export function TopBar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);

  return (
    <header
      className={cn(
        'relative z-[var(--z-sticky)] shrink-0 flex h-[var(--topbar-height)] items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4'
      )}
    >
      {/* Left: Logo + Mobile Hamburger */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleSidebar}
          className="inline-flex items-center justify-center rounded-[var(--radius-md)] p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-text)] sm:hidden"
          aria-label="Toggle menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-lg font-bold text-[var(--color-text)]">MindPal</span>
      </div>

      {/* Center: Search trigger */}
      <button
        type="button"
        onClick={toggleCommandPalette}
        className="hidden items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3 py-1.5 text-[var(--text-sm)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] sm:flex"
      >
        <Search className="h-4 w-4" />
        <span>搜索...</span>
        <kbd className="ml-4 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[var(--text-xs)] font-medium">
          ⌘K
        </kbd>
      </button>

      {/* Right: Notifications + User Avatar */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-[var(--radius-md)] p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-text)]"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
        </button>
        <Avatar size="sm" fallback="U" alt="User" />
      </div>
    </header>
  );
}
