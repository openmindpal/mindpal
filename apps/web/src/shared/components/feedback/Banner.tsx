"use client";
import * as React from "react";
import { X, Info, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/shared/lib/cn";

const variants = {
  info: { bg: "bg-[var(--color-surface-sunken)]", text: "text-[var(--color-text-secondary)]", Icon: Info },
  success: { bg: "bg-[var(--color-success-soft)]", text: "text-[var(--color-success)]", Icon: CheckCircle },
  warning: { bg: "bg-[var(--color-warning-soft)]", text: "text-[var(--color-warning)]", Icon: AlertTriangle },
  danger: { bg: "bg-[var(--color-danger-soft)]", text: "text-[var(--color-danger)]", Icon: XCircle },
};

interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variants;
  onDismiss?: () => void;
}

function Banner({ className, variant = "info", children, onDismiss, ...props }: BannerProps) {
  const { bg, text, Icon } = variants[variant];
  return (
    <div
      role="alert"
      className={cn("flex items-center gap-3 rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-sm)]", bg, text, className)}
      {...props}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 rounded-[var(--radius-sm)] p-1 opacity-70 hover:opacity-100 transition-opacity">
          <X className="h-4 w-4" />
          <span className="sr-only">Dismiss</span>
        </button>
      )}
    </div>
  );
}

export { Banner, type BannerProps };
