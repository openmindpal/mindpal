"use client";

import { useState } from "react";
import { Pencil, Trash2, Save, X } from "lucide-react";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/components/primitives/Dialog";
import { useEntityDetail, useUpdateEntity, useDeleteEntity } from "../hooks/useEntities";
import type { EntityRecord } from "../hooks/useEntities";

/* ─── Props ─── */
interface EntityDetailSheetProps {
  entityName: string | null;
  record: EntityRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/* ─── Component ─── */
export function EntityDetailSheet({ entityName, record, open, onOpenChange }: EntityDetailSheetProps) {
  const entityId = record?.id ?? null;
  const { record: detail, isLoading } = useEntityDetail(open ? entityName : null, open ? entityId : null);
  const updateMutation = useUpdateEntity(entityName);
  const deleteMutation = useDeleteEntity(entityName);

  const [editing, setEditing] = useState(false);
  const [editPayload, setEditPayload] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const displayRecord = detail ?? record;

  const startEditing = () => {
    if (!displayRecord) return;
    const payload = displayRecord.payload ?? {};
    const strPayload: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      strPayload[k] = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
    }
    setEditPayload(strPayload);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditPayload({});
  };

  const handleSave = async () => {
    if (!displayRecord) return;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(editPayload)) {
      try {
        patch[k] = JSON.parse(v);
      } catch {
        patch[k] = v;
      }
    }
    await updateMutation.mutateAsync({ id: displayRecord.id, patch });
    setEditing(false);
    setEditPayload({});
  };

  const handleDelete = async () => {
    if (!displayRecord) return;
    await deleteMutation.mutateAsync(displayRecord.id);
    setDeleteDialogOpen(false);
    onOpenChange(false);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{displayRecord?.id ? `记录 ${displayRecord.id.slice(0, 12)}...` : "实体详情"}</SheetTitle>
            <SheetDescription>
              {entityName ? `实体类型: ${entityName}` : "查看实体记录详细信息"}
            </SheetDescription>
          </SheetHeader>

          <SheetBody className="flex flex-col gap-5">
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : displayRecord ? (
              <>
                {/* System fields */}
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                  <h3 className="mb-2 text-[var(--text-sm)] font-medium text-[var(--color-text)]">系统字段</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--text-sm)]">
                    <dt className="text-[var(--color-text-muted)]">ID</dt>
                    <dd className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                      {displayRecord.id}
                    </dd>
                    <dt className="text-[var(--color-text-muted)]">Schema</dt>
                    <dd className="text-[var(--color-text)]">{displayRecord.schemaName} v{displayRecord.schemaVersion}</dd>
                    <dt className="text-[var(--color-text-muted)]">版本号</dt>
                    <dd className="text-[var(--color-text)]">{displayRecord.revision}</dd>
                    <dt className="text-[var(--color-text-muted)]">创建时间</dt>
                    <dd className="text-[var(--color-text)]">
                      {new Date(displayRecord.createdAt).toLocaleString("zh-CN")}
                    </dd>
                    <dt className="text-[var(--color-text-muted)]">更新时间</dt>
                    <dd className="text-[var(--color-text)]">
                      {new Date(displayRecord.updatedAt).toLocaleString("zh-CN")}
                    </dd>
                  </dl>
                </div>

                <div className="border-t border-[var(--color-border-light)] pt-5">
                <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                  <h3 className="mb-2 text-[var(--text-sm)] font-medium text-[var(--color-text)]">业务字段</h3>
                  {editing ? (
                    <div className="flex flex-col gap-2">
                      {Object.keys(editPayload).map((key) => (
                        <label key={key} className="flex flex-col gap-1">
                          <span className="text-[var(--text-xs)] font-medium text-[var(--color-text-muted)]">{key}</span>
                          <Input
                            value={editPayload[key]}
                            onChange={(e) => setEditPayload((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        </label>
                      ))}
                    </div>
                  ) : (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--text-sm)]">
                      {Object.entries(displayRecord.payload ?? {}).map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-[var(--color-text-muted)]">{key}</dt>
                          <dd className="break-all text-[var(--color-text)]">
                            {typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}
                          </dd>
                        </div>
                      ))}
                      {Object.keys(displayRecord.payload ?? {}).length === 0 && (
                        <p className="col-span-2 text-[var(--color-text-muted)]">无业务字段</p>
                      )}
                    </dl>
                  )}
                </div>
                </div>

                <SheetFooter className="mt-0 pt-5">
                  {editing ? (
                    <>
                      <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
                        <Save className="mr-1 h-4 w-4" />
                        {updateMutation.isPending ? "保存中..." : "保存"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={cancelEditing}>
                        <X className="mr-1 h-4 w-4" />
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" onClick={startEditing}>
                        <Pencil className="mr-1 h-4 w-4" />
                        编辑
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleteDialogOpen(true)}>
                        <Trash2 className="mr-1 h-4 w-4" />
                        删除
                      </Button>
                    </>
                  )}
                </SheetFooter>

                {/* Error display */}
                {(updateMutation.error || deleteMutation.error) && (
                  <p className="text-[var(--text-sm)] text-red-500">
                    {(updateMutation.error as Error)?.message ?? (deleteMutation.error as Error)?.message}
                  </p>
                )}
              </>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>此操作不可撤销，确定要删除该实体记录吗？</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteDialogOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
