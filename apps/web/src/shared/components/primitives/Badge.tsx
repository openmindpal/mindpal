"use client";
import * as React from "react";
import { cn } from "@/shared/lib/cn";

const variants = {
  default: "bg-[var(--color-primary-soft)] text-[var(--color-text-secondary)]",
  secondary: "bg-[var(--color-surface-sunken)] text-[var(--color-text-secondary)]",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  outline: "bg-transparent border border-[var(--color-border)] text-[var(--color-text-secondary)]",
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variants;
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-sm)] px-2.5 py-0.5 text-[var(--text-xs)] font-medium transition-colors",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge, type BadgeProps };
