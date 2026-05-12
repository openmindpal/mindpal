'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Play,
  CheckSquare,
  Brain,
  FileText,
  Shield,
  Settings,
  GitBranch,
  ChevronLeft,
  ChevronRight,
  Database,
} from 'lucide-react';
import { useUiStore } from '@/shared/stores';
import { cn } from '@/shared/lib/cn';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/shared/components/primitives';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  label: string;
  icon: LucideIcon;
  path: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    title: '对话',
    items: [{ label: '首页', icon: Home, path: '/' }],
  },
  {
    title: '工作',
    items: [
      { label: 'Runs', icon: Play, path: '/runs' },
      { label: 'Tasks', icon: CheckSquare, path: '/tasks' },
      { label: 'Orchestrator', icon: GitBranch, path: '/orchestrator' },
    ],
  },
  {
    title: '知识',
    items: [
      { label: 'Memory', icon: Brain, path: '/memory' },
      { label: 'Docs', icon: FileText, path: '/docs' },
      { label: 'Entities', icon: Database, path: '/entities' },
    ],
  },
  {
    title: '治理',
    items: [{ label: 'Gov', icon: Shield, path: '/gov' }],
  },
  {
    title: '管理',
    items: [{ label: 'Admin', icon: Settings, path: '/admin' }],
  },
  {
    title: '设置',
    items: [{ label: 'Settings', icon: Settings, path: '/settings' }],
  },
];

export function Sidebar() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const pathname = usePathname();

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'relative z-[var(--z-sticky)] shrink-0 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-all duration-200',
          sidebarCollapsed ? 'w-[var(--sidebar-collapsed-width)]' : 'w-[var(--sidebar-width)]',
          'max-sm:hidden'
        )}
      >
        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navGroups.map((group) => (
            <div key={group.title} className="mb-3">
              {!sidebarCollapsed && (
                <span className="mb-1 block px-3 text-[var(--text-xs)] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  {group.title}
                </span>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive =
                    item.path === '/'
                      ? pathname === '/'
                      : pathname.startsWith(item.path);
                  const Icon = item.icon;

                  const linkContent = (
                    <Link
                      href={item.path}
                      className={cn(
                        'flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-[var(--text-sm)] font-medium transition-all duration-150',
                        isActive
                          ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] shadow-sm'
                          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)]',
                        sidebarCollapsed && 'justify-center px-2'
                      )}
                    >
                      <Icon className="h-5 w-5 shrink-0" />
                      {!sidebarCollapsed && <span>{item.label}</span>}
                    </Link>
                  );

                  if (sidebarCollapsed) {
                    return (
                      <li key={item.path}>
                        <Tooltip>
                          <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                          <TooltipContent side="right">
                            {item.label}
                          </TooltipContent>
                        </Tooltip>
                      </li>
                    );
                  }

                  return <li key={item.path}>{linkContent}</li>;
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Collapse Toggle */}
        <div className="border-t border-[var(--color-border)] p-2">
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="flex w-full items-center justify-center rounded-[var(--radius-md)] p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)] transition-colors"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
