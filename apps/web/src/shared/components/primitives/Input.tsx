"use client";
import * as React from "react";
import { cn } from "@/shared/lib/cn";

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  error?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, prefix, suffix, ...props }, ref) => (
    <div className={cn("relative flex items-center", className)}>
      {prefix && <span className="absolute left-3 text-[var(--color-text-muted)] pointer-events-none">{prefix}</span>}
      <input
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 text-[var(--text-sm)] text-[var(--color-text)] placeholder:text-[var(--color-text-placeholder)] transition-colors duration-150 hover:border-[var(--color-border-strong)] focus:border-[var(--color-border-strong)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          error
            ? "border-[var(--color-danger)] focus:border-[var(--color-danger)]"
            : "border-[var(--color-border)]",
          prefix && "pl-9",
          suffix && "pr-9"
        )}
        {...props}
      />
      {suffix && <span className="absolute right-3 text-[var(--color-text-muted)]">{suffix}</span>}
    </div>
  )
);
Input.displayName = "Input";
export { Input, type InputProps };
