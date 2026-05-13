"use client";

import * as React from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/components/primitives/Button";
import { Checkbox } from "@/shared/components/primitives/Checkbox";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/shared/components/primitives/Select";
import type { ColumnDef, PaginationState, SortState } from "../types";

/* ─── Props ─── */
interface DataTableProps<T extends Record<string, unknown>> {
  columns: ColumnDef<T>[];
  data: T[];
  loading?: boolean;
  pagination?: PaginationState;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  selectable?: boolean;
  selectedRows?: T[];
  onSelectionChange?: (rows: T[]) => void;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}

/* ─── Page-size options ─── */
const PAGE_SIZES = ["10", "20", "50"] as const;

/* ─── Component ─── */
function DataTableInner<T extends Record<string, unknown>>(
  props: DataTableProps<T>,
) {
  const {
    columns,
    data,
    loading = false,
    pagination,
    onPageChange,
    onPageSizeChange,
    sort,
    onSortChange,
    selectable = false,
    selectedRows = [],
    onSelectionChange,
    onRowClick,
    emptyMessage = "暂无数据",
  } = props;

  /* ── Selection helpers ── */
  const isSelected = React.useCallback(
    (row: T) => selectedRows.includes(row),
    [selectedRows],
  );

  const allSelected =
    data.length > 0 && data.every((r) => selectedRows.includes(r));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    onSelectionChange(allSelected ? [] : [...data]);
  };

  const toggleRow = (row: T) => {
    if (!onSelectionChange) return;
    onSelectionChange(
      isSelected(row)
        ? selectedRows.filter((r) => r !== row)
        : [...selectedRows, row],
    );
  };

  /* ── Sort handler ── */
  const handleSort = (key: string) => {
    if (!onSortChange) return;
    const direction =
      sort?.key === key && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ key, direction });
  };

  /* ── Pagination derived values ── */
  const startIndex = pagination
    ? (pagination.page - 1) * pagination.pageSize + 1
    : 0;
  const endIndex = pagination
    ? Math.min(pagination.page * pagination.pageSize, pagination.total)
    : 0;
  const totalPages = pagination
    ? Math.ceil(pagination.total / pagination.pageSize)
    : 0;

  /* ── Skeleton rows ── */
  const skeletonRows = Array.from({ length: 5 }, (_, i) => i);

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-[var(--text-sm)]">
        {/* ── Head ── */}
        <thead>
          <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)]">
            {selectable && (
              <th className="w-10 px-4 py-3 text-left">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="全选"
                />
              </th>
            )}
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "px-4 py-3 text-left font-semibold text-[var(--color-text-secondary)] select-none",
                  col.sortable && "cursor-pointer hover:text-[var(--color-text)]",
                  col.hiddenOnMobile && "hidden sm:table-cell",
                )}
                style={col.width ? { width: col.width } : undefined}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sortable && sort?.key === col.key && (
                    sort.direction === "asc"
                      ? <ArrowUp className="h-3.5 w-3.5" />
                      : <ArrowDown className="h-3.5 w-3.5" />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>

        {/* ── Body ── */}
        <tbody>
          {/* Loading skeleton */}
          {loading &&
            skeletonRows.map((i) => (
              <tr key={`skel-${i}`} className="border-b border-[var(--color-border)]">
                {selectable && (
                  <td className="px-4 py-4">
                    <Skeleton className="h-4 w-4" />
                  </td>
                )}
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn("px-4 py-4", col.hiddenOnMobile && "hidden sm:table-cell")}
                  >
                    <Skeleton className="h-4 w-full" />
                  </td>
                ))}
              </tr>
            ))}

          {/* Empty state */}
          {!loading && data.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0)}
                className="py-12 text-center"
              >
                <div className="flex flex-col items-center justify-center text-center">
                  <svg className="w-12 h-12 text-[var(--color-text-muted)] opacity-40 mb-3" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 12C8 9.79 9.79 8 12 8H28L40 20V36C40 38.21 38.21 40 36 40H12C9.79 40 8 38.21 8 36V12Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M28 8V20H40" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M20 28H28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M20 33H26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <p className="text-sm text-[var(--color-text-muted)]">{emptyMessage}</p>
                </div>
              </td>
            </tr>
          )}

          {/* Data rows */}
          {!loading &&
            data.map((row, idx) => (
              <tr
                key={idx}
                className={cn(
                  "border-b border-[var(--color-border)] transition-colors duration-150 hover:bg-[var(--color-surface-raised)] even:bg-[var(--color-surface-sunken)]/30",
                  onRowClick && "cursor-pointer",
                )}
                onClick={() => onRowClick?.(row)}
              >
                {selectable && (
                  <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isSelected(row)}
                      onCheckedChange={() => toggleRow(row)}
                      aria-label="选择行"
                    />
                  </td>
                )}
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn("px-4 py-4 text-[var(--color-text)]", col.hiddenOnMobile && "hidden sm:table-cell")}
                  >
                    {col.render
                      ? col.render(row[col.key], row)
                      : String(row[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>

      {/* ── Pagination ── */}
      {pagination && pagination.total > 0 && (
        <div className="flex items-center justify-between px-3 py-3 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
          <span>
            第 {startIndex}–{endIndex} 条，共 {pagination.total} 条
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-xs)]">每页</span>
            <Select
              value={String(pagination.pageSize)}
              onValueChange={(v) => onPageSizeChange?.(Number(v))}
            >
              <SelectTrigger className="h-8 w-[72px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange?.(pagination.page - 1)}
            >
              上一页
            </Button>
            <span className="text-[var(--text-xs)]">
              {pagination.page} / {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={pagination.page >= totalPages}
              onClick={() => onPageChange?.(pagination.page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Generic DataTable — use `DataTable<MyRow>` for full type inference. */
export const DataTable = DataTableInner as <T extends Record<string, unknown>>(
  props: DataTableProps<T>,
) => React.ReactElement;

export type { DataTableProps };
