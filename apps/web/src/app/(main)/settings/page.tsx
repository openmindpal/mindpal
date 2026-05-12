"use client";

import { Settings } from "lucide-react";
import { LocaleSection, DisplaySection, TokensSection, MfaSection } from "@/features/settings";

export default function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings className="h-6 w-6 text-[var(--color-text-secondary)]" />
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">系统设置</h1>
      </div>

      {/* Settings Cards */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <LocaleSection />
        <DisplaySection />
        <TokensSection />
        <MfaSection />
      </div>
    </div>
  );
}
