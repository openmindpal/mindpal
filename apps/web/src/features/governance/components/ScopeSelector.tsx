"use client";

import { cn } from "@/shared/lib/cn";

interface ScopeSelectorProps {
  value: "tenant" | "space";
  onChange: (scope: "tenant" | "space") => void;
  className?: string;
}

const options: { key: "tenant" | "space"; label: string }[] = [
  { key: "tenant", label: "租户级" },
  { key: "space", label: "空间级" },
];

function ScopeSelector({ value, onChange, className }: ScopeSelectorProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-0.5",
        className,
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={cn(
            "rounded-full px-3 py-1 text-[var(--text-sm)] font-medium transition-colors duration-[var(--duration-fast)] select-none",
            value === opt.key
              ? "bg-[var(--color-primary)] text-[var(--color-text-inverse)] shadow-sm"
              : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export { ScopeSelector, type ScopeSelectorProps };
