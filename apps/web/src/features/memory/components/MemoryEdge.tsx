"use client";

import { memo } from "react";
import { BaseEdge, getStraightPath, type EdgeProps } from "@xyflow/react";

interface MemoryEdgeComponentData {
  edgeType: "distillation" | "association";
  weight: number;
}

function MemoryEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  selected,
}: EdgeProps & { data?: MemoryEdgeComponentData }) {
  const [edgePath] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const edgeType = data?.edgeType ?? "association";
  const weight = data?.weight ?? 0.5;
  // Map weight to opacity range 0.3 ~ 1.0
  const opacity = 0.3 + weight * 0.7;

  const isDistillation = edgeType === "distillation";

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: selected ? "oklch(0.85 0.15 250)" : "oklch(0.6 0.05 250)",
        strokeWidth: isDistillation ? 2 : 1.5,
        strokeDasharray: isDistillation ? undefined : "6 4",
        opacity,
      }}
      markerEnd={isDistillation ? "url(#arrowhead)" : undefined}
    />
  );
}

export const MemoryEdge = memo(MemoryEdgeComponent);
