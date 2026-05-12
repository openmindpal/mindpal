"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { FormBuilder } from "@/features/governance";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import { toast } from "@/shared/components/feedback/Toast";
import type { FormFieldDef } from "@/features/governance/types";

/* ─── Types ─── */
interface ArtifactPolicy {
  retentionDays: number;
  maxSizeMb: number;
  allowedTypes: string;
  autoCleanup: boolean;
  requireApproval: boolean;
  [key: string]: unknown;
}

/* ─── Form fields ─── */
const FIELDS: FormFieldDef[] = [
  { name: "retentionDays", label: "保留天数", type: "number", required: true, placeholder: "30" },
  { name: "maxSizeMb", label: "最大大小 (MB)", type: "number", required: true, placeholder: "100" },
  {
    name: "allowedTypes",
    label: "允许类型",
    type: "text",
    required: true,
    placeholder: "jar,zip,tar.gz",
  },
  { name: "autoCleanup", label: "自动清理", type: "checkbox" },
  { name: "requireApproval", label: "需要审批", type: "checkbox" },
];

/* ─── Page ─── */
export default function ArtifactPolicyPage() {
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [saving, setSaving] = React.useState(false);

  const { data, isLoading } = useQuery<ArtifactPolicy>({
    queryKey: ["/governance/artifact-policy"],
    queryFn: async () => {
      const res = await apiFetch("/governance/artifact-policy");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<ArtifactPolicy>;
    },
    staleTime: 30_000,
  });

  /* Sync fetched data into form values */
  React.useEffect(() => {
    if (data) {
      setValues(data as Record<string, unknown>);
    }
  }, [data]);

  const handleSave = async () => {
    /* Basic validation */
    const errs: string[] = [];
    FIELDS.forEach((f) => {
      if (f.required && (values[f.name] == null || values[f.name] === "")) {
        errs.push(f.label);
      }
    });
    if (errs.length) {
      toast.error(`请填写: ${errs.join(", ")}`);
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch("/governance/artifact-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error(`保存失败 (${res.status})`);
      toast.success("策略已保存");
      queryClient.invalidateQueries({ queryKey: ["/governance/artifact-policy"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 max-w-lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        工件审查策略
      </h1>

      <div className="max-w-lg">
        <FormBuilder
          fields={FIELDS}
          values={values}
          onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
          onSubmit={handleSave}
          submitLabel="保存策略"
          loading={saving}
        />
      </div>
    </div>
  );
}
