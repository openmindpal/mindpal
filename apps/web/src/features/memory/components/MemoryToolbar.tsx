"use client";

import type { MemoryClass } from "../types";
import { CLASS_COLORS } from "../types";

interface MemoryToolbarProps {
  activeClass: MemoryClass | undefined;
  onClassChange: (cls: MemoryClass | undefined) => void;
  minConfidence: number;
  onMinConfidenceChange: (v: number) => void;
  limit: number;
  onLimitChange: (v: number) => void;
}

const CLASS_OPTIONS: { key: MemoryClass; label: string }[] = [
  { key: "episodic", label: "情节" },
  { key: "semantic", label: "语义" },
  { key: "procedural", label: "程序" },
];

const LIMIT_OPTIONS = [50, 100, 200, 500];

export function MemoryToolbar({
  activeClass,
  onClassChange,
  minConfidence,
  onMinConfidenceChange,
  limit,
  onLimitChange,
}: MemoryToolbarProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-2.5 border-b border-[oklch(0.25_0.02_250)] bg-[oklch(0.13_0.02_250)] flex-wrap">
      {/* Class filter pills */}
      <div className="flex items-center gap-1.5">
        {CLASS_OPTIONS.map(({ key, label }) => {
          const isActive = activeClass === key;
          return (
            <button
              key={key}
              onClick={() => onClassChange(isActive ? undefined : key)}
              className="px-3 py-1 rounded-full text-xs font-medium transition-all duration-150"
              style={{
                backgroundColor: isActive ? CLASS_COLORS[key] : "oklch(0.2 0.02 250)",
                color: isActive ? "white" : "oklch(0.7 0.02 250)",
                border: isActive ? "none" : "1px solid oklch(0.3 0.02 250)",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Confidence slider */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[oklch(0.6_0.02_250)] whitespace-nowrap">
          置信度 ≥ {(minConfidence * 100).toFixed(0)}%
        </label>
        <input
          type="range"
          min={0}
          max={100}
          value={minConfidence * 100}
          onChange={(e) => onMinConfidenceChange(Number(e.target.value) / 100)}
          className="w-24 h-1 accent-[oklch(0.6_0.15_250)] cursor-pointer"
        />
      </div>

      {/* Limit selector */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[oklch(0.6_0.02_250)]">节点数</label>
        <select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          className="text-xs bg-[oklch(0.2_0.02_250)] text-[oklch(0.8_0.02_250)] border border-[oklch(0.3_0.02_250)] rounded px-2 py-1 cursor-pointer"
        >
          {LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
