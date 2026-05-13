'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Play, CheckSquare, Brain, Settings } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type { LucideIcon } from 'lucide-react';

interface MobileTab {
  label: string;
  icon: LucideIcon;
  path: string;
}

const tabs: MobileTab[] = [
  { label: '首页', icon: Home, path: '/' },
  { label: 'Runs', icon: Play, path: '/runs' },
  { label: 'Tasks', icon: CheckSquare, path: '/tasks' },
  { label: 'Memory', icon: Brain, path: '/memory' },
  { label: 'Settings', icon: Settings, path: '/settings' },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="relative z-[var(--z-sticky)] shrink-0 flex h-[var(--mobile-nav-height)] items-center justify-around border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] pb-[env(safe-area-inset-bottom)] sm:hidden">
      {tabs.map((tab) => {
        const isActive =
          tab.path === '/' ? pathname === '/' : pathname.startsWith(tab.path);
        const Icon = tab.icon;

        return (
          <Link
            key={tab.path}
            href={tab.path}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[var(--text-xs)] transition-colors',
              isActive
                ? 'text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)]'
            )}
          >
            <Icon className="h-5 w-5" />
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
