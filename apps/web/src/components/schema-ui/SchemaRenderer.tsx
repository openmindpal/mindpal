"use client";

import React, { useState } from "react";
import type { SchemaUiConfig, SchemaUiHints } from "@openslin/shared";
import { useSchemaUiData } from "./useSchemaUiData";
import { MdxBlock } from "./MdxBlock";

/* ── types ── */
interface RenderProps {
  config: SchemaUiConfig;
  rows: unknown[];
  properties: Record<string, any>;
}

/* ── helpers ── */
function getProperties(schema: Record<string, unknown>): Record<string, any> {
  return (schema?.properties as Record<string, any>) ?? {};
}

function pickColumns(props: Record<string, any>, columns?: string[]): string[] {
  const keys = Object.keys(props);
  if (!columns || columns.length === 0) return keys;
  return columns.filter((c) => keys.includes(c));
}

function cellValue(row: any, key: string): string {
  const v = row?.[key];
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/* ── render: table ── */
function renderTable({ config, rows, properties }: RenderProps): React.ReactNode {
  const cols = pickColumns(properties, config.uiHints.columns);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "0.5rem 0.75rem", borderBottom: "2px solid var(--border, #e5e7eb)", fontWeight: 600 }}>
                {properties[c]?.title ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} style={{ padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border, #f3f4f6)" }}>
                  {cellValue(row, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── render: cards ── */
function renderCards({ config, rows, properties }: RenderProps): React.ReactNode {
  const groupBy = config.uiHints.groupBy;
  const groups: Record<string, unknown[]> = {};

  if (groupBy) {
    for (const row of rows) {
      const key = cellValue(row, groupBy) || "—";
      (groups[key] ??= []).push(row);
    }
  } else {
    groups[""] = rows;
  }

  const fields = Object.keys(properties);

  return (
    <div>
      {Object.entries(groups).map(([group, items]) => (
        <div key={group}>
          {group && <h4 style={{ margin: "1rem 0 0.5rem", fontWeight: 600 }}>{group}</h4>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: "0.75rem" }}>
            {(items as any[]).map((row, i) => (
              <div key={i} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: "8px", padding: "0.75rem" }}>
                {fields.map((f) => (
                  <div key={f} style={{ marginBottom: "0.25rem" }}>
                    <span style={{ fontWeight: 500, fontSize: "0.8rem", opacity: 0.7 }}>{properties[f]?.title ?? f}: </span>
                    <span style={{ fontSize: "0.875rem" }}>{cellValue(row, f)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── render: form (enhanced) ── */
function RenderFormInner({ config, properties, onFormChange }: RenderProps & { onFormChange?: (data: Record<string, unknown>) => void }) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const requiredFields: string[] = (config.schema?.required as string[]) ?? [];
  const fieldDeps = config.uiHints.fieldDeps;
  const cascades = config.uiHints.cascades;

  const handleChange = (key: string, value: unknown) => {
    setFormData((prev) => {
      const next = { ...prev, [key]: value };
      // 当父字段值变化时，清空依赖它的子字段值
      if (cascades) {
        for (const [childKey, cas] of Object.entries(cascades)) {
          if (cas.parentField === key) next[childKey] = "";
        }
      }
      onFormChange?.(next);
      return next;
    });
  };

  return (
    <form onSubmit={(e) => e.preventDefault()} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}>
      {Object.entries(properties).map(([key, prop]: [string, any]) => {
        const label = prop?.title ?? key;
        const isRequired = requiredFields.includes(key);
        const dep = fieldDeps?.[key];
        const visible = dep ? formData[dep.showWhen.field] === dep.showWhen.equals : true;

        // 级联下拉优先，无级联则走原来的 enum
        const cascade = cascades?.[key];
        let selectOptions: string[] | undefined;
        if (cascade) {
          const parentVal = String(formData[cascade.parentField] ?? "");
          selectOptions = cascade.optionsMap[parentVal];
        } else if (prop?.enum) {
          selectOptions = prop.enum as string[];
        }

        if (selectOptions) {
          return (
            <label key={key} style={{ display: visible ? "flex" : "none", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontWeight: 500, fontSize: "0.875rem" }}>{label}</span>
              <select
                name={key}
                required={isRequired}
                value={String(formData[key] ?? "")}
                onChange={(e) => handleChange(key, e.target.value)}
                style={{ padding: "0.4rem", borderRadius: "4px", border: "1px solid var(--border, #d1d5db)" }}
              >
                <option value="">请选择</option>
                {selectOptions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          );
        }
        if (prop?.type === "boolean") {
          return (
            <label key={key} style={{ display: visible ? "flex" : "none", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                name={key}
                required={isRequired}
                checked={!!formData[key]}
                onChange={(e) => handleChange(key, e.target.checked)}
              />
              <span style={{ fontSize: "0.875rem" }}>{label}</span>
            </label>
          );
        }
        return (
          <label key={key} style={{ display: visible ? "flex" : "none", flexDirection: "column", gap: "0.25rem" }}>
            <span style={{ fontWeight: 500, fontSize: "0.875rem" }}>{label}</span>
            <input
              name={key}
              type={prop?.type === "number" || prop?.type === "integer" ? "number" : "text"}
              required={isRequired}
              min={prop?.minimum}
              max={prop?.maximum}
              pattern={prop?.pattern}
              minLength={prop?.minLength}
              maxLength={prop?.maxLength}
              value={(formData[key] as string | number) ?? ""}
              onChange={(e) => handleChange(key, prop?.type === "number" || prop?.type === "integer" ? Number(e.target.value) : e.target.value)}
              style={{ padding: "0.4rem", borderRadius: "4px", border: "1px solid var(--border, #d1d5db)" }}
            />
          </label>
        );
      })}
    </form>
  );
}

function renderForm(props: RenderProps & { onFormChange?: (data: Record<string, unknown>) => void }): React.ReactNode {
  return <RenderFormInner {...props} />;
}

/* ── render: chart (pure SVG) ── */
function renderChart({ config, rows, properties }: RenderProps): React.ReactNode {
  const chartType = config.uiHints.chartType ?? "bar";
  const keys = Object.keys(properties);
  const labelKey = keys[0] ?? "label";
  const valueKey = keys[1] ?? "value";
  const values = rows.map((r: any) => Number(r?.[valueKey]) || 0);
  const labels = rows.map((r: any) => cellValue(r, labelKey));
  const max = Math.max(...values, 1);
  const W = 400;
  const H = 220;

  if (chartType === "pie") {
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];
    let cumAngle = 0;
    return (
      <svg viewBox="0 0 200 200" width={200} height={200}>
        {values.map((v, i) => {
          const angle = (v / total) * 360;
          const start = cumAngle;
          cumAngle += angle;
          const r = 80;
          const cx = 100, cy = 100;
          const rad1 = ((start - 90) * Math.PI) / 180;
          const rad2 = ((start + angle - 90) * Math.PI) / 180;
          const x1 = cx + r * Math.cos(rad1), y1 = cy + r * Math.sin(rad1);
          const x2 = cx + r * Math.cos(rad2), y2 = cy + r * Math.sin(rad2);
          const large = angle > 180 ? 1 : 0;
          return <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`} fill={colors[i % colors.length]}><title>{labels[i]}: {v}</title></path>;
        })}
      </svg>
    );
  }

  if (chartType === "line") {
    const pts = values.map((v, i) => `${30 + (i / Math.max(values.length - 1, 1)) * (W - 60)},${H - 30 - (v / max) * (H - 50)}`).join(" ");
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ maxWidth: "100%" }}>
        <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth="2" />
        {values.map((v, i) => {
          const x = 30 + (i / Math.max(values.length - 1, 1)) * (W - 60);
          const y = H - 30 - (v / max) * (H - 50);
          return <circle key={i} cx={x} cy={y} r={3} fill="#3b82f6"><title>{labels[i]}: {v}</title></circle>;
        })}
      </svg>
    );
  }

  // default: bar
  const barW = Math.max(20, (W - 60) / Math.max(values.length, 1) - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ maxWidth: "100%" }}>
      {values.map((v, i) => {
        const h = (v / max) * (H - 50);
        const x = 30 + i * (barW + 4);
        return (
          <g key={i}>
            <rect x={x} y={H - 30 - h} width={barW} height={h} fill="#3b82f6" rx={2}><title>{labels[i]}: {v}</title></rect>
            <text x={x + barW / 2} y={H - 14} textAnchor="middle" fontSize="10" fill="currentColor">{labels[i]?.slice(0, 6)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── render: markdown ── */
function renderMarkdown({ config }: RenderProps): React.ReactNode {
  return <MdxBlock content={config.mdx ?? ""} />;
}

/* ── render: dashboard (recursive grid) ── */
function renderDashboard({ config, rows, properties }: RenderProps): React.ReactNode {
  // dashboard = multi-zone; schema.properties each zone is a sub-SchemaUiConfig
  const zones = Object.entries(properties);
  if (zones.length === 0) return <MdxBlock content={config.mdx ?? "No dashboard zones defined."} />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: "1rem" }}>
      {zones.map(([key, zone]: [string, any]) => (
        <div key={key} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: "8px", padding: "0.75rem" }}>
          <h4 style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>{zone?.title ?? key}</h4>
          {zone?.description && <p style={{ fontSize: "0.8rem", opacity: 0.7, margin: "0 0 0.5rem" }}>{zone.description}</p>}
        </div>
      ))}
    </div>
  );
}

/* ── render: kanban ── */
function renderKanban({ config, rows, properties }: RenderProps): React.ReactNode {
  const colField = config.uiHints.columnField ?? config.uiHints.groupBy;
  const groups: Record<string, unknown[]> = {};

  if (colField) {
    for (const row of rows) {
      const key = cellValue(row, colField) || "—";
      (groups[key] ??= []).push(row);
    }
  } else {
    groups["All"] = rows;
  }

  const fields = Object.keys(properties).filter((f) => f !== colField);

  return (
    <div style={{ display: "flex", gap: "16px", overflowX: "auto", padding: "4px 0" }}>
      {Object.entries(groups).map(([col, items]) => (
        <div key={col} style={{ flex: "0 0 280px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", padding: "0.4rem 0", borderBottom: "2px solid var(--border, #e5e7eb)" }}>{col}</div>
          {(items as any[]).map((row, i) => (
            <div key={i} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: "8px", padding: "0.6rem" }}>
              {fields.map((f) => (
                <div key={f} style={{ marginBottom: "0.2rem" }}>
                  <span style={{ fontWeight: 500, fontSize: "0.75rem", opacity: 0.7 }}>{properties[f]?.title ?? f}: </span>
                  <span style={{ fontSize: "0.85rem" }}>{cellValue(row, f)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── render: timeline ── */
function renderTimeline({ config, rows, properties }: RenderProps): React.ReactNode {
  const timeField = config.uiHints.timeField;
  const sorted = timeField
    ? [...rows].sort((a: any, b: any) => {
        const ta = a?.[timeField] ?? "";
        const tb = b?.[timeField] ?? "";
        return String(ta).localeCompare(String(tb));
      })
    : rows;
  const otherFields = Object.keys(properties).filter((f) => f !== timeField);

  return (
    <div style={{ position: "relative", paddingLeft: "28px" }}>
      <div style={{ position: "absolute", left: "10px", top: 0, bottom: 0, width: "2px", background: "var(--border, #d1d5db)" }} />
      {sorted.map((row: any, i) => (
        <div key={i} style={{ position: "relative", marginBottom: "1.25rem" }}>
          <div style={{ position: "absolute", left: "-23px", top: "4px", width: "10px", height: "10px", borderRadius: "50%", background: "#3b82f6" }} />
          {timeField && <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.2rem" }}>{cellValue(row, timeField)}</div>}
          <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: "8px", padding: "0.6rem" }}>
            {otherFields.map((f) => (
              <div key={f} style={{ marginBottom: "0.15rem", fontSize: "0.85rem" }}>
                <span style={{ fontWeight: 500, opacity: 0.7 }}>{properties[f]?.title ?? f}: </span>
                {cellValue(row, f)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── render: stats ── */
function renderStats({ config, rows, properties }: RenderProps): React.ReactNode {
  const statFields = config.uiHints.statFields ?? Object.entries(properties)
    .filter(([, p]: [string, any]) => p?.type === "number" || p?.type === "integer")
    .slice(0, 4)
    .map(([k]) => k);
  const firstRow: any = rows[0] ?? {};

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px" }}>
      {statFields.map((f) => (
        <div key={f} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: "8px", padding: "1rem", textAlign: "center" }}>
          <div style={{ fontSize: "1.75rem", fontWeight: 700 }}>{firstRow[f] != null ? String(firstRow[f]) : "—"}</div>
          <div style={{ fontSize: "0.8rem", opacity: 0.7, marginTop: "0.25rem" }}>{properties[f]?.title ?? f}</div>
        </div>
      ))}
    </div>
  );
}

/* ── render: tree ── */
function RenderTreeInner({ config, rows, properties }: RenderProps): React.ReactNode {
  const parentField = config.uiHints.parentField;
  const firstKey = Object.keys(properties)[0];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!parentField) {
    return (
      <div>
        {rows.map((row: any, i) => (
          <div key={i} style={{ paddingLeft: "24px", padding: "0.3rem 0 0.3rem 24px", fontSize: "0.875rem", borderBottom: "1px solid var(--border, #f3f4f6)" }}>
            {firstKey ? cellValue(row, firstKey) : JSON.stringify(row)}
          </div>
        ))}
      </div>
    );
  }

  // build tree
  const idField = firstKey ?? "id";
  const childrenMap: Record<string, any[]> = {};
  const roots: any[] = [];
  for (const row of rows as any[]) {
    const pid = row[parentField];
    if (pid == null || pid === "") {
      roots.push(row);
    } else {
      (childrenMap[String(pid)] ??= []).push(row);
    }
  }

  const renderNode = (node: any, depth: number): React.ReactNode => {
    const nodeId = String(node[idField] ?? "");
    const children = childrenMap[nodeId];
    const hasChildren = children && children.length > 0;
    const isOpen = expanded.has(nodeId);

    return (
      <div key={nodeId + depth}>
        <div
          style={{ paddingLeft: `${depth * 24}px`, padding: `0.3rem 0 0.3rem ${depth * 24}px`, fontSize: "0.875rem", borderBottom: "1px solid var(--border, #f3f4f6)", cursor: hasChildren ? "pointer" : "default" }}
          onClick={() => hasChildren && toggle(nodeId)}
        >
          <span style={{ display: "inline-block", width: "16px", textAlign: "center" }}>{hasChildren ? (isOpen ? "▼" : "▶") : ""}</span>
          {cellValue(node, idField)}
        </div>
        {hasChildren && isOpen && children.map((c: any) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return <div>{roots.map((r) => renderNode(r, 0))}</div>;
}

function renderTree(props: RenderProps): React.ReactNode {
  return <RenderTreeInner {...props} />;
}

/* ── strategy map ── */
const renderers: Record<SchemaUiHints["layout"], (props: RenderProps & { onFormChange?: (data: Record<string, unknown>) => void }) => React.ReactNode> = {
  table: renderTable,
  cards: renderCards,
  form: renderForm,
  chart: renderChart,
  markdown: renderMarkdown,
  dashboard: renderDashboard,
  kanban: renderKanban,
  timeline: renderTimeline,
  stats: renderStats,
  tree: renderTree,
};

/* ── main component ── */
export interface SchemaRendererProps {
  config: SchemaUiConfig;
  onFormChange?: (data: Record<string, unknown>) => void;
  /** 交互动作回调（按钮点击等） */
  onAction?: (action: string, data?: Record<string, unknown>) => void;
}

export function SchemaRenderer({ config, onAction }: SchemaRendererProps) {
  const { data, loading, error } = useSchemaUiData(config.dataBindings);
  const properties = getProperties(config.schema);

  // flatten all entity rows into a single array for the primary renderer
  const rows: unknown[] = Object.values(data).flat();

  const render = renderers[config.uiHints.layout] ?? renderers.table;
  const style: React.CSSProperties = { ...(config.uiHints.style as React.CSSProperties) };

  return (
    <section style={style}>
      {config.uiHints.title && <h3 style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>{config.uiHints.title}</h3>}
      {config.uiHints.description && <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", opacity: 0.7 }}>{config.uiHints.description}</p>}
      {loading && <p style={{ fontSize: "0.875rem", opacity: 0.6 }}>Loading…</p>}
      {error && <p style={{ fontSize: "0.875rem", color: "#ef4444" }}>{error}</p>}
      {!loading && render({ config, rows, properties })}
      {config.uiHints.actions?.length ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          {config.uiHints.actions.map((act) => (
            <button
              key={act.action}
              type="button"
              onClick={() => {
                if (act.confirm) {
                  if (!window.confirm(act.confirm)) return;
                }
                onAction?.(act.action);
              }}
              style={{
                padding: "6px 16px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #d0d5dd)",
                background: "var(--bg-primary, #fff)",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              {act.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
