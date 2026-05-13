'use client';

import { Menu, Search, Bell } from 'lucide-react';
import { Avatar } from '@/shared/components/primitives/Avatar';
import { useUiStore } from '@/shared/stores';
import { cn } from '@/shared/lib/cn';

export function TopBar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);

  return (
    <header
      className={cn(
        'relative z-[var(--z-sticky)] shrink-0 flex h-[var(--topbar-height)] items-center justify-between gap-3 border-b border-[var(--color-border-light)] bg-white px-4 sm:grid sm:grid-cols-[1fr_minmax(320px,560px)_1fr] sm:gap-4'
      )}
    >
      {/* Left: Logo + Mobile Hamburger */}
      <div className="flex items-center gap-3 sm:min-w-0 sm:justify-self-start">
        <button
          type="button"
          onClick={toggleSidebar}
          className="inline-flex items-center justify-center rounded-[var(--radius-md)] p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)] sm:hidden"
          aria-label="Toggle menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-base font-semibold text-[var(--color-text)]">MindPal</span>
      </div>

      {/* Center: Search trigger */}
      <button
        type="button"
        onClick={toggleCommandPalette}
        className="hidden h-9 w-full items-center justify-between gap-3 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 text-[var(--text-sm)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-white sm:flex sm:justify-self-center"
      >
        <span className="flex items-center gap-2">
          <Search className="h-4 w-4" />
          <span>搜索...</span>
        </span>
        <kbd className="rounded-full border border-[var(--color-border)] bg-white px-2 py-0.5 text-[var(--text-xs)] font-medium text-[var(--color-text-muted)]">
          ⌘K
        </kbd>
      </button>

      {/* Right: Notifications + User Avatar */}
      <div className="flex items-center gap-2 sm:justify-self-end">
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-[var(--radius-md)] p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)]"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
        </button>
        <Avatar size="sm" fallback="U" alt="User" />
      </div>
    </header>
  );
}
