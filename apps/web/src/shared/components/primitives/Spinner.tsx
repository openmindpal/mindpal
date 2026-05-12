"use client";
import { cn } from "@/shared/lib/cn";

interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: "sm" | "md" | "lg";
}

const sizeClasses = { sm: "h-4 w-4", md: "h-6 w-6", lg: "h-8 w-8" };

function Spinner({ className, size = "md", ...props }: SpinnerProps) {
  return (
    <svg
      className={cn("animate-spin text-[var(--color-primary)]", sizeClasses[size], className)}
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export { Spinner, type SpinnerProps };
