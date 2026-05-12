"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { DataTable } from "@/features/governance/components/DataTable";
import { StatusBadge } from "@/features/governance/components/StatusBadge";
import { Button } from "@/shared/components/primitives/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/components/primitives/Tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/shared/components/primitives/Dialog";
import { Input } from "@/shared/components/primitives/Input";
import { Textarea } from "@/shared/components/primitives/Textarea";
import type { ColumnDef, PaginationState } from "@/features/governance/types";
import { useTaskList, useCreateTask } from "../hooks/useTasks";
import type { Task } from "../hooks/useTasks";

/* ─── Status filter tabs ─── */
const STATUS_TABS = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待处理" },
  { value: "running", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
] as const;

/* ─── Status color mapping ─── */
const TASK_STATUS_COLOR: Record<string, "default" | "success" | "warning" | "danger"> = {
  pending: "default",
  created: "default",
  running: "warning",
  completed: "success",
  succeeded: "success",
  done: "success",
  failed: "danger",
  error: "danger",
};

/* ─── Row type for DataTable (must extend Record<string, unknown>) ─── */
type TaskRow = Task & Record<string, unknown>;

/* ─── Columns ─── */
const columns: ColumnDef<TaskRow>[] = [
  {
    key: "title",
    label: "标题",
    width: "40%",
    render: (value) => (value as string) || "未命名任务",
  },
  {
    key: "status",
    label: "状态",
    width: "120px",
    render: (value) => (
      <StatusBadge status={value as string} colorMap={TASK_STATUS_COLOR} />
    ),
  },
  {
    key: "createdAt",
    label: "创建时间",
    hiddenOnMobile: true,
    render: (value) => {
      if (!value) return "—";
      const d = new Date(value as string);
      return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
    },
  },
  {
    key: "updatedAt",
    label: "更新时间",
    hiddenOnMobile: true,
    render: (value) => {
      if (!value) return "—";
      const d = new Date(value as string);
      return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
    },
  },
];

/* ─── Props ─── */
interface TaskListProps {
  onSelectTask: (task: Task) => void;
}

/* ─── Component ─── */
export function TaskList({ onSelectTask }: TaskListProps) {
  const { tasks, isLoading, page, pageSize, setPage, setPageSize } = useTaskList();
  const createTask = useCreateTask();

  /* filter state */
  const [statusFilter, setStatusFilter] = useState("all");

  /* create dialog state */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");

  /* Filtered data */
  const filteredTasks = useMemo(() => {
    if (statusFilter === "all") return tasks;
    return tasks.filter((t) => t.status === statusFilter);
  }, [tasks, statusFilter]);

  /* Pagination (client-side filter → approximate) */
  const pagination: PaginationState = {
    page,
    pageSize,
    total: filteredTasks.length < pageSize ? (page - 1) * pageSize + filteredTasks.length : page * pageSize + 1,
  };

  /* Create handler */
  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    await createTask.mutateAsync({ title: newTitle.trim() });
    setNewTitle("");
    setNewDesc("");
    setDialogOpen(false);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">任务管理</h1>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          新建任务
        </Button>
      </div>

      {/* Status filter tabs */}
      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Table */}
      <DataTable<TaskRow>
        columns={columns}
        data={filteredTasks as TaskRow[]}
        loading={isLoading}
        pagination={pagination}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        onRowClick={(row) => onSelectTask(row as Task)}
        emptyMessage="暂无任务"
      />

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建任务</DialogTitle>
            <DialogDescription>创建一个新的任务来跟踪工作进展</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text)]">标题</span>
              <Input
                placeholder="输入任务标题"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text)]">描述（可选）</span>
              <Textarea
                placeholder="输入任务描述"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={3}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={!newTitle.trim() || createTask.isPending}>
              {createTask.isPending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
