import { AppShell } from '@/layouts/AppShell';
import { CommandPalette } from '@/features/command-palette';
import { CommandPaletteKeyboardShortcut } from './CommandPaletteShortcut';
import { PageTransition } from './PageTransition';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <PageTransition>{children}</PageTransition>
      <CommandPalette />
      <CommandPaletteKeyboardShortcut />
    </AppShell>
  );
}
