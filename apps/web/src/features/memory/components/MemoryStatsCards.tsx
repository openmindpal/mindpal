"use client";

import { useMemoryStats } from "../hooks/useMemoryStats";

/* ─── Constants ─── */
const CLASS_COLORS = {
  episodic: "oklch(0.65 0.18 250)",
  semantic: "oklch(0.65 0.18 145)",
  procedural: "oklch(0.65 0.18 55)",
} as const;

const CLASS_LABELS = {
  episodic: "情节记忆",
  semantic: "语义记忆",
  procedural: "程序记忆",
} as const;

type MemoryClass = keyof typeof CLASS_COLORS;

/* ─── Component ─── */
export function MemoryStatsCards() {
  const { data, isLoading, error } = useMemoryStats();

  if (isLoading) {
    return (
      <div className="flex gap-4">
        {(["episodic", "semantic", "procedural"] as const).map((cls) => (
          <div
            key={cls}
            className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 animate-pulse"
          >
            <div className="h-4 w-20 rounded bg-[var(--color-surface-sunken)] mb-3" />
            <div className="h-8 w-12 rounded bg-[var(--color-surface-sunken)] mb-2" />
            <div className="h-2 w-full rounded bg-[var(--color-surface-sunken)]" />
          </div>
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-[var(--text-sm)] text-[var(--color-text-muted)] p-4">
        加载统计数据失败
      </div>
    );
  }

  const classes: MemoryClass[] = ["episodic", "semantic", "procedural"];

  return (
    <div className="flex gap-4">
      {classes.map((cls) => {
        const stats = data.totalByClass[cls];
        const color = CLASS_COLORS[cls];
        const label = CLASS_LABELS[cls];
        const confidencePct = Math.round(stats.avgConfidence * 100);

        return (
          <div
            key={cls}
            className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-shadow duration-[var(--duration-fast)] hover:shadow-md"
          >
            {/* Header with color accent */}
            <div className="flex items-center gap-2 mb-3">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                {label}
              </span>
            </div>

            {/* Count */}
            <div
              className="text-2xl font-bold mb-2"
              style={{ color }}
            >
              {stats.count}
            </div>

            {/* Confidence bar */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[var(--text-xs)] text-[var(--color-text-muted)]">
                <span>平均置信度</span>
                <span>{confidencePct}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--color-surface-sunken)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${confidencePct}%`,
                    backgroundColor: color,
                  }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
