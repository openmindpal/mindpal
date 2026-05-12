"use client";

import { useCallback } from "react";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Home,
  Play,
  CheckSquare,
  Brain,
  GitBranch,
  FileText,
  Shield,
  Settings,
  Cog,
  MessageSquarePlus,
  Sun,
  Languages,
  PanelLeft,
  Search,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { useUiStore } from "@/shared/stores/ui.store";
import { useSessionStore } from "@/shared/stores/session.store";
import { usePreferencesStore } from "@/shared/stores/preferences.store";

export function CommandPalette() {
  const router = useRouter();
  const open = useUiStore((s) => s.commandPaletteOpen);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const setTheme = useUiStore((s) => s.setTheme);
  const theme = useUiStore((s) => s.theme);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const clearSession = useSessionStore((s) => s.clearSession);
  const locale = usePreferencesStore((s) => s.locale);
  const setLocale = usePreferencesStore((s) => s.setLocale);

  const close = useCallback(() => {
    if (open) toggleCommandPalette();
  }, [open, toggleCommandPalette]);

  const runAction = useCallback(
    (action: () => void) => {
      action();
      close();
    },
    [close],
  );

  const handleNewChat = useCallback(() => {
    runAction(() => {
      clearSession();
      router.push("/");
    });
  }, [runAction, clearSession, router]);

  const handleToggleTheme = useCallback(() => {
    runAction(() => {
      const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
      setTheme(next);
    });
  }, [runAction, theme, setTheme]);

  const handleToggleLocale = useCallback(() => {
    runAction(() => {
      setLocale(locale === "zh-CN" ? "en-US" : "zh-CN");
    });
  }, [runAction, locale, setLocale]);

  const handleToggleSidebar = useCallback(() => {
    runAction(toggleSidebar);
  }, [runAction, toggleSidebar]);

  const navigateTo = useCallback(
    (path: string) => {
      runAction(() => router.push(path));
    },
    [runAction, router],
  );

  return (
    <AnimatePresence>
      {open && (
        <Command.Dialog
          open={open}
          onOpenChange={(v) => {
            if (!v) close();
          }}
          label="Command Palette"
          loop
          overlayClassName="fixed inset-0 z-[var(--z-overlay)] bg-black/50"
          contentClassName={cn(
            "fixed left-1/2 top-[20%] z-[var(--z-modal)] w-full max-w-lg -translate-x-1/2",
            "rounded-[var(--radius-xl)] border border-[var(--color-border)]",
            "bg-[var(--color-surface-0)] shadow-lg overflow-hidden",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            {/* Search Input */}
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4">
              <Search className="h-5 w-5 shrink-0 text-[var(--color-text-muted)]" />
              <Command.Input
                placeholder="搜索页面、命令..."
                className={cn(
                  "flex-1 h-12 bg-transparent text-base text-[var(--color-text)]",
                  "placeholder:text-[var(--color-text-muted)] outline-none border-none",
                )}
              />
            </div>

            {/* List */}
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="py-6 text-center text-sm text-[var(--color-text-muted)]">
                未找到结果
              </Command.Empty>

              {/* Navigation Group */}
              <Command.Group
                heading="页面导航"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--color-text-muted)] [&_[cmdk-group-heading]]:uppercase"
              >
                <CommandItem onSelect={() => navigateTo("/")} icon={<Home />} label="首页" />
                <CommandItem onSelect={() => navigateTo("/runs")} icon={<Play />} label="运行管理" />
                <CommandItem onSelect={() => navigateTo("/tasks")} icon={<CheckSquare />} label="任务管理" />
                <CommandItem onSelect={() => navigateTo("/memory")} icon={<Brain />} label="记忆管理" />
                <CommandItem onSelect={() => navigateTo("/orchestrator")} icon={<GitBranch />} label="编排中心" />
                <CommandItem onSelect={() => navigateTo("/docs")} icon={<FileText />} label="文档中心" />
                <CommandItem onSelect={() => navigateTo("/gov")} icon={<Shield />} label="治理中心" />
                <CommandItem onSelect={() => navigateTo("/admin")} icon={<Settings />} label="管理后台" />
                <CommandItem onSelect={() => navigateTo("/settings")} icon={<Cog />} label="系统设置" />
              </Command.Group>

              <Command.Separator className="my-1 h-px bg-[var(--color-border)]" />

              {/* Actions Group */}
              <Command.Group
                heading="操作"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--color-text-muted)] [&_[cmdk-group-heading]]:uppercase"
              >
                <CommandItem onSelect={handleNewChat} icon={<MessageSquarePlus />} label="新建对话" />
                <CommandItem onSelect={handleToggleTheme} icon={<Sun />} label="切换主题" />
                <CommandItem onSelect={handleToggleLocale} icon={<Languages />} label="切换语言" />
                <CommandItem onSelect={handleToggleSidebar} icon={<PanelLeft />} label="切换侧边栏" />
              </Command.Group>
            </Command.List>
          </motion.div>
        </Command.Dialog>
      )}
    </AnimatePresence>
  );
}

/* ─────────────── Internal Item Component ─────────────── */

interface CommandItemProps {
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
}

function CommandItem({ onSelect, icon, label }: CommandItemProps) {
  return (
    <Command.Item
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-3 h-11 px-2 rounded-[var(--radius-md)] cursor-pointer",
        "text-sm text-[var(--color-text)]",
        "data-[selected=true]:bg-[var(--color-primary-soft)]",
        "transition-colors duration-100",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center [&>svg]:h-5 [&>svg]:w-5 text-[var(--color-text-muted)]">
        {icon}
      </span>
      <span>{label}</span>
    </Command.Item>
  );
}
