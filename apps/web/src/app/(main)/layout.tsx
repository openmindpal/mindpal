import dynamic from 'next/dynamic';
import { AppShell } from '@/layouts/AppShell';
import { CommandPaletteKeyboardShortcut } from './CommandPaletteShortcut';
import { PageTransition } from './PageTransition';

const CommandPalette = dynamic(
  () => import('@/features/command-palette/CommandPalette').then(m => m.CommandPalette)
);

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <PageTransition>{children}</PageTransition>
      <CommandPalette />
      <CommandPaletteKeyboardShortcut />
    </AppShell>
  );
}
