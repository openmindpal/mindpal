"use client";

import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/shared/components/primitives/Sheet";
import { Button } from "@/shared/components/primitives/Button";

/* ─── Props ─── */
interface ResourceDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  data: Record<string, unknown> | null;
  fields: {
    label: string;
    key: string;
    render?: (value: unknown) => React.ReactNode;
  }[];
  actions?: {
    label: string;
    variant?: "primary" | "secondary" | "ghost" | "danger";
    onClick: () => void;
  }[];
}

/* ─── Helpers ─── */
function isJsonValue(v: unknown): boolean {
  return v !== null && typeof v === "object";
}

function renderValue(
  value: unknown,
  renderFn?: (v: unknown) => React.ReactNode,
): React.ReactNode {
  if (renderFn) return renderFn(value);
  if (value == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  if (isJsonValue(value)) {
    return (
      <pre className="max-h-64 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 font-mono text-[var(--text-xs)] text-[var(--color-text)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return String(value);
}

/* ─── Component ─── */
function ResourceDetailSheet({
  open,
  onOpenChange,
  title,
  data,
  fields,
  actions,
}: ResourceDetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">资源详情</SheetDescription>
        </SheetHeader>

        {/* Field list */}
        {data && (
          <div className="flex-1 space-y-4 py-4">
            {fields.map((f) => {
              const value = data[f.key];
              const isJson = isJsonValue(value) && !f.render;
              return (
                <div key={f.key} className={isJson ? "flex flex-col gap-1" : "flex items-start justify-between gap-4"}>
                  <span className="shrink-0 text-[var(--text-sm)] text-[var(--color-text-muted)]">
                    {f.label}
                  </span>
                  <span className={isJson ? "w-full" : "text-right text-[var(--text-sm)] text-[var(--color-text)] break-all"}>
                    {renderValue(value, f.render)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Action buttons */}
        {actions && actions.length > 0 && (
          <SheetFooter className="border-t border-[var(--color-border)] pt-4">
            <div className="flex w-full gap-2 justify-end">
              {actions.map((act) => (
                <Button
                  key={act.label}
                  variant={act.variant ?? "secondary"}
                  size="sm"
                  onClick={act.onClick}
                >
                  {act.label}
                </Button>
              ))}
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

export { ResourceDetailSheet, type ResourceDetailSheetProps };
