"use client";
import { cn } from "@/shared/lib/cn";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)]", className)}
      {...props}
    />
  );
}

export { Skeleton };
