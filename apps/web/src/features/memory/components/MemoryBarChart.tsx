"use client";

/* ─── Types ─── */
interface BarChartProps {
  data: { range: string; count: number }[];
  title?: string;
}

/* ─── Component ─── */
export function MemoryBarChart({ data, title }: BarChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="text-[var(--text-sm)] text-[var(--color-text-muted)] p-4">
        暂无数据
      </div>
    );
  }

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {title && (
        <h3 className="text-[var(--text-sm)] font-medium text-[var(--color-text)] mb-4">
          {title}
        </h3>
      )}

      {/* Bar chart container */}
      <div className="flex items-end gap-2 h-40">
        {data.map((item, idx) => {
          const heightPct = (item.count / maxCount) * 100;
          // Generate oklch gradient - hue shifts from 250 (blue) to 55 (orange)
          const hue = 250 - (idx / Math.max(data.length - 1, 1)) * 195;
          const color = `oklch(0.65 0.15 ${hue})`;

          return (
            <div
              key={item.range}
              className="flex-1 flex flex-col items-center gap-1 min-w-0"
            >
              {/* Count label */}
              <span className="text-[var(--text-xs)] text-[var(--color-text-muted)] font-medium">
                {item.count}
              </span>

              {/* Bar */}
              <div className="w-full flex items-end justify-center" style={{ height: "120px" }}>
                <div
                  className="w-full max-w-8 rounded-t-[var(--radius-sm)] transition-all duration-300"
                  style={{
                    height: `${Math.max(heightPct, 2)}%`,
                    backgroundColor: color,
                    minHeight: "4px",
                  }}
                />
              </div>

              {/* Range label */}
              <span className="text-[var(--text-xs)] text-[var(--color-text-muted)] text-center truncate w-full">
                {item.range}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
