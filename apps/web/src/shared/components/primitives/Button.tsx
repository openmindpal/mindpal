"use client";
import * as React from "react";
import { cn } from "@/shared/lib/cn";

// 变体定义
const variants = {
  primary: "bg-[var(--color-primary)] text-[var(--color-text-inverse)] hover:bg-[var(--color-primary-hover)] shadow-sm hover:shadow-[var(--shadow-hover)]",
  secondary: "bg-[var(--color-surface-raised)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-sunken)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-hover)]",
  ghost: "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text)] hover:shadow-sm",
  danger: "bg-[var(--color-danger)] text-[var(--color-text-inverse)] hover:opacity-90 hover:shadow-[var(--shadow-hover)]",
  link: "text-[var(--color-primary)] underline-offset-4 hover:underline p-0 h-auto",
};

const sizes = {
  sm: "h-8 px-3 text-[var(--text-sm)] rounded-[var(--radius-sm)] gap-1.5",
  md: "h-9 px-4 text-[var(--text-sm)] rounded-[var(--radius-md)] gap-2",
  lg: "h-11 px-6 text-[var(--text-base)] rounded-[var(--radius-md)] gap-2",
  icon: "h-9 w-9 rounded-[var(--radius-md)]",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none select-none",
        variants[variant],
        sizes[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin -ml-1 mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
);
Button.displayName = "Button";
export { Button, type ButtonProps };
