"use client";

import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/components/primitives/Badge";

/* ─── Default status → variant mapping ─── */
const DEFAULT_COLOR_MAP: Record<string, "default" | "success" | "warning" | "danger"> = {
  draft: "default",
  pending: "default",
  inactive: "default",

  active: "success",
  released: "success",
  succeeded: "success",
  done: "success",
  enabled: "success",

  submitted: "warning",
  canary_released: "warning",
  running: "warning",
  connecting: "warning",

  failed: "danger",
  error: "danger",
  disabled: "danger",
  rolled_back: "danger",
};

/* ─── Props ─── */
interface StatusBadgeProps {
  status: string;
  colorMap?: Record<string, "default" | "success" | "warning" | "danger">;
  className?: string;
}

/* ─── Component ─── */
function StatusBadge({ status, colorMap, className }: StatusBadgeProps) {
  const merged = colorMap ? { ...DEFAULT_COLOR_MAP, ...colorMap } : DEFAULT_COLOR_MAP;
  const variant = merged[status.toLowerCase()] ?? "secondary";

  return (
    <Badge
      variant={variant as "default" | "success" | "warning" | "danger" | "secondary"}
      className={cn("transition-colors duration-150", className)}
    >
      {status}
    </Badge>
  );
}

export { StatusBadge, type StatusBadgeProps };
