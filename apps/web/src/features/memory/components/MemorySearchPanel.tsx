"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Input } from "@/shared/components/primitives/Input";
import { Button } from "@/shared/components/primitives/Button";
import { useMemorySearch } from "../hooks/useMemorySearch";

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

type MemoryClass = "episodic" | "semantic" | "procedural";

const PAGE_SIZE = 20;

/* ─── Component ─── */
export function MemorySearchPanel() {
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedClass, setSelectedClass] = useState<MemoryClass | undefined>(undefined);
  const [page, setPage] = useState(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce input
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(inputValue);
      setPage(0);
    }, 300);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [inputValue]);

  const { data, isLoading } = useMemorySearch({
    q: debouncedQuery,
    class: selectedClass,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const handleClassToggle = useCallback((cls: MemoryClass) => {
    setSelectedClass((prev) => (prev === cls ? undefined : cls));
    setPage(0);
  }, []);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-4">
      {/* Search input */}
      <Input
        placeholder="输入关键词搜索..."
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        prefix={
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        }
      />

      {/* Class filter pills */}
      <div className="flex items-center gap-2">
        <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
          按类型筛选：
        </span>
        {(Object.keys(CLASS_LABELS) as MemoryClass[]).map((cls) => {
          const isActive = selectedClass === cls;
          return (
            <button
              key={cls}
              type="button"
              onClick={() => handleClassToggle(cls)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[var(--text-xs)] font-medium transition-all duration-[var(--duration-fast)] border select-none"
              style={{
                backgroundColor: isActive ? CLASS_COLORS[cls] : "transparent",
                borderColor: CLASS_COLORS[cls],
                color: isActive ? "#fff" : CLASS_COLORS[cls],
              }}
            >
              {CLASS_LABELS[cls]}
            </button>
          );
        })}
      </div>

      {/* Results */}
      <div className="space-y-2">
        {isLoading && debouncedQuery && (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-5 w-5 text-[var(--color-text-muted)]" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!isLoading && debouncedQuery && data && data.items.length === 0 && (
          <div className="text-center py-8 text-[var(--text-sm)] text-[var(--color-text-muted)]">
            没有找到匹配的记忆
          </div>
        )}

        {!isLoading && data && data.items.length > 0 && (
          <>
            {/* Total count */}
            <div className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
              共 {data.total} 条
            </div>

            {/* Result list */}
            <div className="space-y-2">
              {data.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3 hover:bg-[var(--color-surface-sunken)] transition-colors duration-[var(--duration-fast)]"
                >
                  {/* Title row */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[var(--text-sm)] font-medium text-[var(--color-text)] truncate flex-1">
                      {item.title || "(无标题)"}
                    </span>
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{
                        backgroundColor: `color-mix(in oklch, ${CLASS_COLORS[item.memoryClass]} 15%, transparent)`,
                        color: CLASS_COLORS[item.memoryClass],
                      }}
                    >
                      {CLASS_LABELS[item.memoryClass]}
                    </span>
                  </div>

                  {/* Content preview - 2 lines */}
                  <p className="text-[var(--text-xs)] text-[var(--color-text-secondary)] line-clamp-2 mb-2">
                    {item.contentText}
                  </p>

                  {/* Meta row */}
                  <div className="flex items-center gap-3 text-[var(--text-xs)] text-[var(--color-text-muted)]">
                    <span>置信度: {Math.round(item.confidence * 100)}%</span>
                    <span>
                      {new Date(item.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  上一页
                </Button>
                <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}

        {/* Empty state - no query */}
        {!debouncedQuery && (
          <div className="text-center py-8 text-[var(--text-sm)] text-[var(--color-text-muted)]">
            输入关键词开始搜索记忆
          </div>
        )}
      </div>
    </div>
  );
}
