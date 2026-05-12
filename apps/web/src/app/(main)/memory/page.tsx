"use client";

import { useState, useCallback } from "react";
import { MemoryGraph } from "@/features/memory/components/MemoryGraph";
import { MemoryToolbar } from "@/features/memory/components/MemoryToolbar";
import { MemoryDetailSidebar } from "@/features/memory/components/MemoryDetailSidebar";
import type { MemoryClass, MemoryNodeData } from "@/features/memory/types";

export default function MemoryPage() {
  const [activeClass, setActiveClass] = useState<MemoryClass | undefined>(undefined);
  const [minConfidence, setMinConfidence] = useState(0.3);
  const [limit, setLimit] = useState(200);
  const [selectedNode, setSelectedNode] = useState<MemoryNodeData | null>(null);

  const handleNodeSelect = useCallback((node: MemoryNodeData | null) => {
    setSelectedNode(node);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSelectedNode(null);
  }, []);

  return (
    <div className="flex flex-col h-full w-full bg-[oklch(0.1_0.02_250)]">
      {/* Top toolbar */}
      <MemoryToolbar
        activeClass={activeClass}
        onClassChange={setActiveClass}
        minConfidence={minConfidence}
        onMinConfidenceChange={setMinConfidence}
        limit={limit}
        onLimitChange={setLimit}
      />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Graph area */}
        <MemoryGraph
          filter={{ class: activeClass, limit, minConfidence }}
          onNodeSelect={handleNodeSelect}
        />

        {/* Detail sidebar (conditional) */}
        {selectedNode && (
          <MemoryDetailSidebar node={selectedNode} onClose={handleSidebarClose} />
        )}
      </div>
    </div>
  );
}
