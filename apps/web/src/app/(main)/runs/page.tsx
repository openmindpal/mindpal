"use client";

import { useState } from "react";
import { RunList } from "@/features/runs/components/RunList";
import { RunDetailSheet } from "@/features/runs/components/RunDetailSheet";
import type { RunSummary } from "@/features/runs/hooks/useRuns";

export default function RunsPage() {
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleSelectRun = (run: RunSummary) => {
    setSelectedRun(run);
    setSheetOpen(true);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <RunList onSelectRun={handleSelectRun} />
      <RunDetailSheet
        run={selectedRun}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
