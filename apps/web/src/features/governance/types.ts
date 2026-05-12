import type * as React from "react";

/* ─── Column Definition ─── */
export interface ColumnDef<T> {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  width?: string;
  /** Custom cell renderer. `value` is typed as `unknown` to keep the generic ergonomic. */
  render?: (value: unknown, row: T) => React.ReactNode;
  /** Hide on mobile, show from sm breakpoint */
  hiddenOnMobile?: boolean;
}

/* ─── Filter Definition ─── */
export interface FilterDef {
  key: string;
  label: string;
  type: "select" | "text" | "date-range";
  options?: { label: string; value: string }[];
}

/* ─── Form Field Definition ─── */
export interface FormFieldDef {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "checkbox" | "json";
  required?: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  defaultValue?: unknown;
}

/* ─── Resource Action ─── */
export interface ResourceAction<T> {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  variant?: "default" | "destructive" | "outline";
  onClick: (row: T) => void | Promise<void>;
  visible?: (row: T) => boolean;
}

/* ─── Resource Page Config ─── */
export interface ResourcePageConfig<T> {
  title: string;
  apiEndpoint: string;
  columns: ColumnDef<T>[];
  filters?: FilterDef[];
  searchable?: boolean;
  searchPlaceholder?: string;
  createForm?: {
    title: string;
    fields: FormFieldDef[];
  };
  detailFields?: {
    label: string;
    key: keyof T & string;
    render?: (value: unknown) => React.ReactNode;
  }[];
  actions?: ResourceAction<T>[];
  /** Response array field name, defaults to "items" */
  responseKey?: string;
  selectable?: boolean;
}

/* ─── Pagination State ─── */
export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

/* ─── Sort State ─── */
export interface SortState {
  key: string;
  direction: "asc" | "desc";
}
