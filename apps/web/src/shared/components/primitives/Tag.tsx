"use client";
import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/cn";

interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  onRemove?: () => void;
}

function Tag({ className, children, onRemove, ...props }: TagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2 py-0.5 text-[var(--text-xs)] text-[var(--color-text-secondary)]",
        className
      )}
      {...props}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors"
        >
          <X className="h-3 w-3" />
          <span className="sr-only">Remove</span>
        </button>
      )}
    </span>
  );
}

export { Tag, type TagProps };
