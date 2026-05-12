"use client";

import { useState } from "react";
import { EntityList, EntityDetailSheet } from "@/features/entities";
import type { EntityRecord } from "@/features/entities";

export default function EntitiesPage() {
  const [selectedRecord, setSelectedRecord] = useState<EntityRecord | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleSelectRecord = (record: EntityRecord) => {
    setSelectedRecord(record);
    setSheetOpen(true);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <EntityList onSelectRecord={handleSelectRecord} />
      <EntityDetailSheet
        entityName={selectedRecord?.entityName ?? null}
        record={selectedRecord}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
