"use client";

import * as React from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import { Textarea } from "@/shared/components/primitives/Textarea";
import { Checkbox } from "@/shared/components/primitives/Checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/shared/components/primitives/Select";
import type { FormFieldDef } from "../types";

/* ─── Props ─── */
interface FormBuilderProps {
  fields: FormFieldDef[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  onSubmit: () => void;
  submitLabel?: string;
  loading?: boolean;
  errors?: Record<string, string>;
  className?: string;
}

/* ─── Component ─── */
function FormBuilder({
  fields,
  values,
  onChange,
  onSubmit,
  submitLabel = "提交",
  loading = false,
  errors,
  className,
}: FormBuilderProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className={cn("flex flex-col gap-4", className)}>
      {fields.map((field) => {
        const error = errors?.[field.name];
        const value = values[field.name];

        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            {/* Label (skip for checkbox — label rendered inline) */}
            {field.type !== "checkbox" && (
              <label
                htmlFor={`form-${field.name}`}
                className="text-[var(--text-sm)] font-medium text-[var(--color-text)]"
              >
                {field.label}
                {field.required && (
                  <span className="ml-0.5 text-[var(--color-danger)]">*</span>
                )}
              </label>
            )}

            {/* Field renderers */}
            {field.type === "text" && (
              <Input
                id={`form-${field.name}`}
                value={String(value ?? "")}
                placeholder={field.placeholder}
                disabled={loading}
                error={!!error}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}

            {field.type === "number" && (
              <Input
                id={`form-${field.name}`}
                type="number"
                value={value != null ? String(value) : ""}
                placeholder={field.placeholder}
                disabled={loading}
                error={!!error}
                onChange={(e) =>
                  onChange(field.name, e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            )}

            {field.type === "select" && (
              <Select
                value={String(value ?? "")}
                onValueChange={(v) => onChange(field.name, v)}
                disabled={loading}
              >
                <SelectTrigger id={`form-${field.name}`}>
                  <SelectValue placeholder={field.placeholder ?? "请选择"} />
                </SelectTrigger>
                <SelectContent>
                  {field.options?.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {field.type === "textarea" && (
              <Textarea
                id={`form-${field.name}`}
                value={String(value ?? "")}
                placeholder={field.placeholder}
                disabled={loading}
                error={!!error}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}

            {field.type === "json" && (
              <Textarea
                id={`form-${field.name}`}
                value={
                  typeof value === "string"
                    ? value
                    : value != null
                      ? JSON.stringify(value, null, 2)
                      : ""
                }
                placeholder={field.placeholder ?? "{}"}
                disabled={loading}
                error={!!error}
                className="min-h-[160px] font-mono text-[var(--text-xs)]"
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}

            {field.type === "checkbox" && (
              <label className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--color-text)]">
                <Checkbox
                  id={`form-${field.name}`}
                  checked={!!value}
                  onCheckedChange={(checked) => onChange(field.name, !!checked)}
                  disabled={loading}
                />
                {field.label}
                {field.required && (
                  <span className="text-[var(--color-danger)]">*</span>
                )}
              </label>
            )}

            {/* Error message */}
            {error && (
              <p className="text-[var(--text-xs)] text-[var(--color-danger)]">
                {error}
              </p>
            )}
          </div>
        );
      })}

      {/* Submit button */}
      <div className="pt-2">
        <Button type="submit" loading={loading} className="w-full">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export { FormBuilder, type FormBuilderProps };
