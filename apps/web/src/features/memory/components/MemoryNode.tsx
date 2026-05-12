"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { MemoryNodeData } from "../types";
import { CLASS_COLORS } from "../types";

type MemoryNodeType = Node<MemoryNodeData, 'memoryNode'>;

function MemoryNodeComponent({ data, selected }: NodeProps<MemoryNodeType>) {
  const color = CLASS_COLORS[data.memoryClass];
  // Scale size by confidence: min 40px, max 80px
  const size = 40 + data.confidence * 40;
  const truncatedTitle =
    data.title.length > 16 ? data.title.slice(0, 14) + "…" : data.title;

  return (
    <>
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div
        className="flex items-center justify-center rounded-full cursor-pointer transition-all duration-200"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: color,
          border: selected ? "3px solid oklch(0.95 0.02 250)" : "2px solid oklch(0.3 0.02 250)",
          boxShadow: selected
            ? `0 0 16px 4px ${color}`
            : `0 2px 8px oklch(0.1 0 0 / 0.3)`,
          opacity: 0.6 + data.confidence * 0.4,
        }}
      >
        <span
          className="text-center font-medium leading-tight text-white"
          style={{
            fontSize: `${Math.max(9, size * 0.16)}px`,
            maxWidth: `${size - 8}px`,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {truncatedTitle}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </>
  );
}

export const MemoryNode = memo(MemoryNodeComponent);
