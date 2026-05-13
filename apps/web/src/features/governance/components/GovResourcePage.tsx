"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/shared/components/primitives/Select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import { DataTable } from "./DataTable";
import { FormBuilder } from "./FormBuilder";
import { ScopeSelector } from "./ScopeSelector";
import { ResourceDetailSheet } from "./ResourceDetailSheet";
import { useResourceList } from "../hooks/useResourceList";
import { useResourceMutation } from "../hooks/useResourceMutation";
import type { ResourcePageConfig, ColumnDef, SortState } from "../types";

/* ─── Props ─── */
interface GovResourcePageProps<T extends Record<string, unknown>> {
  config: ResourcePageConfig<T>;
}

/* ─── Component ─── */
function GovResourcePageInner<T extends Record<string, unknown>>({
  config,
}: GovResourcePageProps<T>) {
  /* ── Resource list ── */
  const resource = useResourceList<T>({
    endpoint: config.apiEndpoint,
    responseKey: config.responseKey,
  });

  /* ── Mutations ── */
  const mutations = useResourceMutation({
    endpoint: config.apiEndpoint,
    listQueryKey: [config.apiEndpoint],
    onSuccess: () => setCreateOpen(false),
  });

  /* ── Local UI state ── */
  const [scope, setScope] = React.useState<"tenant" | "space">("tenant");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailRow, setDetailRow] = React.useState<T | null>(null);
  const [selectedRows, setSelectedRows] = React.useState<T[]>([]);

  /* ── Search debounce ── */
  const [searchInput, setSearchInput] = React.useState("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useEffect(() => {
    timerRef.current = setTimeout(() => {
      resource.setSearch(searchInput);
    }, 300);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  /* ── Init form defaults when opening create sheet ── */
  const openCreateSheet = React.useCallback(() => {
    const defaults: Record<string, unknown> = {};
    config.createForm?.fields.forEach((f) => {
      if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
    });
    setFormValues(defaults);
    setFormErrors({});
    setCreateOpen(true);
  }, [config.createForm]);

  /* ── Form submit ── */
  const handleCreate = React.useCallback(async () => {
    if (!config.createForm) return;

    /* Validate required fields */
    const errs: Record<string, string> = {};
    config.createForm.fields.forEach((f) => {
      if (f.required) {
        const v = formValues[f.name];
        if (v == null || v === "" || v === false) {
          errs[f.name] = `${f.label}不能为空`;
        }
      }
    });
    if (Object.keys(errs).length) {
      setFormErrors(errs);
      return;
    }
    setFormErrors({});

    await mutations.create(formValues);
  }, [config.createForm, formValues, mutations]);

  /* ── Row click → detail ── */
  const handleRowClick = React.useCallback(
    (row: T) => {
      if (!config.detailFields) return;
      setDetailRow(row);
      setDetailOpen(true);
    },
    [config.detailFields],
  );

  /* ── Build columns (append action column if needed) ── */
  const columns = React.useMemo(() => {
    if (!config.actions?.length) return config.columns;

    const actionCol: ColumnDef<T> = {
      key: "__actions" as keyof T & string,
      label: "操作",
      width: "120px",
      render: (_value: unknown, row: T) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {config.actions!
            .filter((a) => !a.visible || a.visible(row))
            .map((a) => (
              <Button
                key={a.label}
                variant={
                  a.variant === "destructive"
                    ? "danger"
                    : a.variant === "outline"
                      ? "secondary"
                      : "ghost"
                }
                size="sm"
                onClick={() => a.onClick(row)}
              >
                {a.icon && <a.icon className="h-3.5 w-3.5" />}
                {a.label}
              </Button>
            ))}
        </div>
      ),
    };
    return [...config.columns, actionCol];
  }, [config.columns, config.actions]);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
          {config.title}
        </h1>
        {config.createForm && (
          <Button onClick={openCreateSheet} size="sm">
            <Plus className="h-4 w-4" />
            新建
          </Button>
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3">
        {config.searchable !== false && (
          <div className="w-full sm:w-64">
            <Input
              placeholder={config.searchPlaceholder ?? "搜索…"}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              prefix={<Search className="h-4 w-4" />}
            />
          </div>
        )}

        <ScopeSelector value={scope} onChange={setScope} />

        {config.filters?.map((filter) =>
          filter.type === "select" ? (
            <Select
              key={filter.key}
              value={resource.filters[filter.key] || "__all__"}
              onValueChange={(v) =>
                resource.setFilters({ ...resource.filters, [filter.key]: v === "__all__" ? "" : v })
              }
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder={filter.label} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部</SelectItem>
                {filter.options?.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null,
        )}
      </div>

      {/* ── DataTable ── */}
      <DataTable<T>
        columns={columns}
        data={resource.data}
        loading={resource.isLoading}
        pagination={resource.pagination}
        onPageChange={resource.setPage}
        onPageSizeChange={resource.setPageSize}
        sort={resource.sort}
        onSortChange={resource.setSort as (sort: SortState) => void}
        selectable={config.selectable}
        selectedRows={selectedRows}
        onSelectionChange={setSelectedRows}
        onRowClick={config.detailFields ? handleRowClick : undefined}
      />

      {/* ── Create Sheet ── */}
      {config.createForm && (
        <Sheet open={createOpen} onOpenChange={setCreateOpen}>
          <SheetContent
            side="right"
            className={cn("flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg")}
          >
            <SheetHeader>
              <SheetTitle>{config.createForm.title}</SheetTitle>
              <SheetDescription className="sr-only">
                新建资源表单
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <FormBuilder
                fields={config.createForm.fields}
                values={formValues}
                onChange={(name, value) =>
                  setFormValues((prev) => ({ ...prev, [name]: value }))
                }
                onSubmit={handleCreate}
                submitLabel="创建"
                loading={mutations.isLoading}
                errors={formErrors}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}

      {/* ── Detail Sheet ── */}
      {config.detailFields && (
        <ResourceDetailSheet
          open={detailOpen}
          onOpenChange={setDetailOpen}
          title={config.title + " 详情"}
          data={detailRow as Record<string, unknown> | null}
          fields={config.detailFields.map((f) => ({
            label: f.label,
            key: f.key as string,
            render: f.render,
          }))}
        />
      )}
    </div>
  );
}

/** Generic GovResourcePage — use `GovResourcePage<MyRow>` for type inference. */
export const GovResourcePage = GovResourcePageInner as <
  T extends Record<string, unknown>,
>(
  props: GovResourcePageProps<T>,
) => React.ReactElement;

export type { GovResourcePageProps };
