"use client";

/**
 * DependencyEditor — 依赖管理独立组件
 *
 * 从 TaskDock 提取，负责依赖列表展示 + 添加依赖表单。
 */

import { memo, useState } from "react";
import { t } from "@/lib/i18n";
import { DEP_TYPE_KEYS, depTypeLabel } from "@/lib/taskUIUtils";
import type { FrontendTaskQueueEntry, FrontendTaskDependency } from "@/app/homeHelpers";

/* ── Constants ── */

const DEP_STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b",
  resolved: "#10b981",
  blocked: "#ef4444",
  overridden: "#9ca3af",
};

function formatText(locale: string, key: string, replacements?: Record<string, string | number>) {
  let value = t(locale, key);
  if (!replacements) return value;
  for (const [token, tokenValue] of Object.entries(replacements)) {
    value = value.replaceAll(`{${token}}`, String(tokenValue));
  }
  return value;
}

/* ── Types ── */

type DepType = "finish_to_start" | "output_to_input" | "cancel_cascade";

interface DependencyEditorProps {
  locale: string;
  dependencies: FrontendTaskDependency[];
  activeEntries: FrontendTaskQueueEntry[];
  entryMap: Map<string, FrontendTaskQueueEntry>;
  actions: {
    createDep: (params: { fromEntryId: string; toEntryId: string; depType: DepType }) => Promise<{ ok: boolean; error?: string }>;
    removeDep: (depId: string) => Promise<boolean>;
    overrideDep: (depId: string) => Promise<boolean>;
  };
  operating: boolean;
}

/* ── Component ── */

const DependencyEditor = memo(function DependencyEditor({
  locale,
  dependencies,
  activeEntries,
  entryMap,
  actions,
  operating,
}: DependencyEditorProps) {
  const [depEditing, setDepEditing] = useState(false);
  const [depFrom, setDepFrom] = useState("");
  const [depTo, setDepTo] = useState("");
  const [depType, setDepType] = useState<DepType>("finish_to_start");
  const [depError, setDepError] = useState<string | null>(null);

  return (
    <>
      {/* 依赖列表 */}
      {dependencies.length > 0 && (
        <>
          <div style={{ borderTop: "1px solid var(--border-light, #e5e7eb)", margin: "6px 0 4px" }} />
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted, #888)", marginBottom: 2 }}>
            {formatText(locale, "taskDock.dependencies.title", { count: dependencies.length })}
          </div>
          {dependencies.filter(d => d.status !== "overridden").slice(0, 8).map(dep => {
            const from = entryMap.get(dep.fromEntryId);
            const to = entryMap.get(dep.toEntryId);
            return (
              <div key={dep.depId} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 4px", borderRadius: 3, background: "var(--bg-muted, #f5f5f5)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: DEP_STATUS_COLORS[dep.status] ?? "#9ca3af", flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {(from?.goal ?? dep.fromEntryId).slice(0, 20)} → {(to?.goal ?? dep.toEntryId).slice(0, 20)}
                </span>
                <span style={{ color: "var(--text-muted, #888)", flexShrink: 0 }}>{depTypeLabel(dep.depType, locale)}</span>
                {dep.status !== "resolved" && (
                  <button
                    onClick={() => { void actions.overrideDep(dep.depId); }}
                    disabled={operating}
                    title={t(locale, "taskDock.action.override")}
                    style={{ fontSize: 10, padding: "0 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
                  >
                    ✓
                  </button>
                )}
                <button
                  onClick={() => { void actions.removeDep(dep.depId); }}
                  disabled={operating}
                  title={t(locale, "taskDock.action.remove")}
                  style={{ fontSize: 10, padding: "0 4px", borderRadius: 3, border: "1px solid var(--danger, #e53e3e)", color: "var(--danger, #e53e3e)", background: "transparent", cursor: "pointer" }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </>
      )}

      {/* 添加依赖按钮 + 输入区 */}
      {activeEntries.length >= 2 && (
        <div style={{ marginTop: 4 }}>
          {!depEditing ? (
            <button
              onClick={() => { setDepEditing(true); setDepError(null); }}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
            >
              {t(locale, "taskDock.action.addDependency")}
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, background: "var(--bg-muted, #f5f5f5)", borderRadius: 6 }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={depFrom}
                  onChange={(e) => setDepFrom(e.target.value)}
                  style={{ flex: 1, minWidth: 80, fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)" }}
                >
                  <option value="">{t(locale, "taskDock.select.downstream")}</option>
                  {activeEntries.map(e => (
                    <option key={e.entryId} value={e.entryId}>{e.goal.slice(0, 30)}</option>
                  ))}
                </select>
                <span style={{ fontSize: 11 }}>→</span>
                <select
                  value={depTo}
                  onChange={(e) => setDepTo(e.target.value)}
                  style={{ flex: 1, minWidth: 80, fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)" }}
                >
                  <option value="">{t(locale, "taskDock.select.upstream")}</option>
                  {activeEntries.filter(e => e.entryId !== depFrom).map(e => (
                    <option key={e.entryId} value={e.entryId}>{e.goal.slice(0, 30)}</option>
                  ))}
                </select>
                <select
                  value={depType}
                  onChange={(e) => setDepType(e.target.value as typeof depType)}
                  style={{ fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-light, #ddd)" }}
                >
                  <option value="finish_to_start">{depTypeLabel("finish_to_start", locale)}</option>
                  <option value="output_to_input">{depTypeLabel("output_to_input", locale)}</option>
                  <option value="cancel_cascade">{depTypeLabel("cancel_cascade", locale)}</option>
                </select>
              </div>
              {depError && <div style={{ fontSize: 10, color: "var(--danger, #e53e3e)" }}>{depError}</div>}
              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                <button
                  onClick={() => { setDepEditing(false); setDepError(null); }}
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border-light, #ddd)", background: "transparent", cursor: "pointer" }}
                >
                  {t(locale, "taskDock.action.cancel")}
                </button>
                <button
                  disabled={!depFrom || !depTo || operating}
                  onClick={async () => {
                    setDepError(null);
                    const result = await actions.createDep({ fromEntryId: depFrom, toEntryId: depTo, depType });
                    if (result.ok) {
                      setDepEditing(false);
                      setDepFrom("");
                      setDepTo("");
                    } else {
                      setDepError(result.error ?? t(locale, "taskDock.error.failed"));
                    }
                  }}
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--accent-border, #3b82f6)", color: "var(--accent-border, #3b82f6)", background: "transparent", cursor: "pointer" }}
                >
                  {t(locale, "taskDock.action.confirm")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
});

export default DependencyEditor;
