"use client";

import type { MemoryNodeData } from "../types";
import { CLASS_COLORS } from "../types";

interface MemoryDetailSidebarProps {
  node: MemoryNodeData | null;
  onClose: () => void;
}

const CLASS_LABELS: Record<string, string> = {
  episodic: "情节记忆",
  semantic: "语义记忆",
  procedural: "程序记忆",
};

export function MemoryDetailSidebar({ node, onClose }: MemoryDetailSidebarProps) {
  if (!node) {
    return (
      <aside className="w-80 border-l border-[oklch(0.3_0.02_250)] bg-[oklch(0.15_0.02_250)] p-6 flex flex-col items-center justify-center text-center">
        <div className="text-[oklch(0.5_0.02_250)] text-sm">
          点击图谱中的节点查看详情
        </div>
      </aside>
    );
  }

  const color = CLASS_COLORS[node.memoryClass];
  const formattedDate = new Date(node.createdAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <aside className="w-80 border-l border-[oklch(0.3_0.02_250)] bg-[oklch(0.15_0.02_250)] p-6 flex flex-col gap-5 overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-[oklch(0.9_0.02_250)] leading-snug break-words flex-1">
          {node.title}
        </h3>
        <button
          onClick={onClose}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[oklch(0.5_0.02_250)] hover:text-[oklch(0.8_0.02_250)] hover:bg-[oklch(0.25_0.02_250)] transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Class tag */}
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white"
          style={{ backgroundColor: color }}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: "oklch(0.95 0 0 / 0.6)" }}
          />
          {CLASS_LABELS[node.memoryClass] ?? node.memoryClass}
        </span>
      </div>

      {/* Confidence */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs text-[oklch(0.6_0.02_250)]">
          <span>置信度</span>
          <span className="font-mono">{(node.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="h-2 rounded-full bg-[oklch(0.25_0.02_250)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${node.confidence * 100}%`,
              backgroundColor: color,
            }}
          />
        </div>
      </div>

      {/* Decay Score */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs text-[oklch(0.6_0.02_250)]">
          <span>衰减分数</span>
          <span className="font-mono">{node.decayScore.toFixed(3)}</span>
        </div>
        <div className="h-2 rounded-full bg-[oklch(0.25_0.02_250)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[oklch(0.55_0.12_30)] transition-all duration-300"
            style={{ width: `${node.decayScore * 100}%` }}
          />
        </div>
      </div>

      {/* Created At */}
      <div className="flex flex-col gap-1 text-xs text-[oklch(0.6_0.02_250)]">
        <span>创建时间</span>
        <span className="font-mono text-[oklch(0.75_0.02_250)]">{formattedDate}</span>
      </div>

      {/* ID */}
      <div className="flex flex-col gap-1 text-xs text-[oklch(0.6_0.02_250)] mt-auto pt-4 border-t border-[oklch(0.25_0.02_250)]">
        <span>ID</span>
        <span className="font-mono text-[oklch(0.5_0.02_250)] break-all text-[10px]">
          {node.id}
        </span>
      </div>
    </aside>
  );
}
