"use client";
import * as React from "react";
import { cn } from "@/shared/lib/cn";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[80px] w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 resize-y",
        error
          ? "border-[var(--color-danger)] focus-visible:ring-[var(--color-danger)]"
          : "border-[var(--color-border)]",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
export { Textarea, type TextareaProps };
