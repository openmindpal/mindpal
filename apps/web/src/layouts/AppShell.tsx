'use client';

import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />

      <div className="flex flex-1 min-h-0">
        <Sidebar />

        {/* Main content area */}
        <main className="flex flex-1 min-w-0 min-h-0 flex-col overflow-y-auto">
          {children}
        </main>
      </div>

      <MobileNav />
    </div>
  );
}
