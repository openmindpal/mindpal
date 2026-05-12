"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/components/primitives/Tabs";
import { DataTable, StatusBadge } from "@/features/governance";
import { useResourceList } from "@/features/governance/hooks/useResourceList";
import { useResourceMutation } from "@/features/governance/hooks/useResourceMutation";
import { Button } from "@/shared/components/primitives/Button";
import { Play, Plus } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import { FormBuilder } from "@/features/governance";
import type { ColumnDef, FormFieldDef } from "@/features/governance/types";

/* ─── Row Types ─── */
interface EvalSuite {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

interface EvalRun {
  id: string;
  suiteId: string;
  status: string;
  score: number;
  startedAt: string;
  [key: string]: unknown;
}

/* ─── Page ─── */
export default function EvalsPage() {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});

  /* ── Suites ── */
  const suites = useResourceList<EvalSuite>({
    endpoint: "/governance/evals/suites",
  });

  const suiteMutations = useResourceMutation({
    endpoint: "/governance/evals/suites",
    listQueryKey: ["/governance/evals/suites"],
    onSuccess: () => setCreateOpen(false),
  });

  const suiteCols: ColumnDef<EvalSuite>[] = [
    { key: "name", label: "套件名称", sortable: true },
    { key: "description", label: "描述", hiddenOnMobile: true },
    {
      key: "status",
      label: "状态",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    { key: "createdAt", label: "创建时间", sortable: true, hiddenOnMobile: true },
    {
      key: "id",
      label: "操作",
      width: "100px",
      render: (_v, row) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => suiteMutations.customAction(row.id, "runs")}
        >
          <Play className="h-3.5 w-3.5" />
          执行
        </Button>
      ),
    },
  ];

  /* ── Runs ── */
  const runs = useResourceList<EvalRun>({
    endpoint: "/governance/evals/runs",
  });

  const runCols: ColumnDef<EvalRun>[] = [
    { key: "id", label: "运行 ID", sortable: true },
    { key: "suiteId", label: "套件 ID" },
    {
      key: "status",
      label: "状态",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    { key: "score", label: "得分", sortable: true },
    { key: "startedAt", label: "开始时间", sortable: true, hiddenOnMobile: true },
  ];

  /* ── Create form ── */
  const createFields: FormFieldDef[] = [
    { name: "name", label: "套件名称", type: "text", required: true },
    { name: "description", label: "描述", type: "textarea" },
  ];

  const handleCreate = () => {
    const errs: Record<string, string> = {};
    createFields.forEach((f) => {
      if (f.required && !formValues[f.name]) errs[f.name] = `${f.label}不能为空`;
    });
    if (Object.keys(errs).length) {
      setFormErrors(errs);
      return;
    }
    setFormErrors({});
    suiteMutations.create(formValues);
  };

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
          评估管理
        </h1>
        <Button size="sm" onClick={() => { setFormValues({}); setFormErrors({}); setCreateOpen(true); }}>
          <Plus className="h-4 w-4" />
          新建套件
        </Button>
      </div>

      <Tabs defaultValue="suites">
        <TabsList>
          <TabsTrigger value="suites">评估套件</TabsTrigger>
          <TabsTrigger value="runs">运行记录</TabsTrigger>
        </TabsList>

        <TabsContent value="suites">
          <DataTable<EvalSuite>
            columns={suiteCols}
            data={suites.data}
            loading={suites.isLoading}
            pagination={suites.pagination}
            onPageChange={suites.setPage}
            onPageSizeChange={suites.setPageSize}
            sort={suites.sort}
            onSortChange={suites.setSort}
          />
        </TabsContent>

        <TabsContent value="runs">
          <DataTable<EvalRun>
            columns={runCols}
            data={runs.data}
            loading={runs.isLoading}
            pagination={runs.pagination}
            onPageChange={runs.setPage}
            onPageSizeChange={runs.setPageSize}
            sort={runs.sort}
            onSortChange={runs.setSort}
          />
        </TabsContent>
      </Tabs>

      {/* ── Create Suite Sheet ── */}
      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>新建评估套件</SheetTitle>
            <SheetDescription className="sr-only">创建新的评估套件</SheetDescription>
          </SheetHeader>
          <div className="flex-1 py-4">
            <FormBuilder
              fields={createFields}
              values={formValues}
              onChange={(name, value) => setFormValues((prev) => ({ ...prev, [name]: value }))}
              onSubmit={handleCreate}
              submitLabel="创建"
              loading={suiteMutations.isLoading}
              errors={formErrors}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
