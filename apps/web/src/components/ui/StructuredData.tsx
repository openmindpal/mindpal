import type { ReactNode } from "react";
import styles from "@/styles/ui.module.css";
import { Badge } from "./Badge";
import { t } from "@/lib/i18n";

/* ─── Structured data display ─── */

const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/** camelCase / snake_case → 空格分隔并首字母大写（未知 key 兜底） */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * 通过 i18n 查找 sd.key.<key>，若无对应翻译则走 humanizeKey 兜底。
 */
function resolveKeyLabel(key: string, locale?: string): string {
  const i18nKey = `sd.key.${key}`;
  const translated = t(locale, i18nKey);
  // t() 在找不到时返回原始 key，判断是否命中
  if (translated !== i18nKey) return translated;
  return humanizeKey(key);
}

function isPrimitive(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || typeof v !== "object";
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span style={{ color: "var(--sl-muted)", fontStyle: "italic" }}>—</span>;
  if (typeof value === "boolean") return <Badge tone={value ? "success" : "neutral"}>{String(value)}</Badge>;
  if (typeof value === "number") return <span style={{ fontFamily: mono, fontWeight: 600 }}>{value}</span>;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      return <span>{parsed.toLocaleString()}</span>;
    }
  }
  if (s.length > 120) return <span style={{ wordBreak: "break-all" }}>{s}</span>;
  return <span>{s}</span>;
}

function renderValue(value: unknown, depth: number, locale?: string): ReactNode {
  if (isPrimitive(value)) return <PrimitiveValue value={value} />;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span style={{ color: "var(--sl-muted)", fontStyle: "italic" }}>[]</span>;
    // Array of primitives: inline badges
    if (value.every(isPrimitive)) {
      return (
        <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
          {value.map((v, i) => (
            <Badge key={i}>{String(v ?? "—")}</Badge>
          ))}
        </span>
      );
    }
    // Array of objects: nested tables
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {value.map((item, i) => (
          <div key={i} style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "color-mix(in srgb, var(--sl-bg) 30%, var(--sl-surface))" }}>
            <div style={{ fontSize: 11, color: "var(--sl-muted)", marginBottom: 4, fontWeight: 600 }}>#{i}</div>
            {renderValue(item, depth + 1, locale)}
          </div>
        ))}
      </div>
    );
  }

  // Object
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span style={{ color: "var(--sl-muted)", fontStyle: "italic" }}>{"{}"}</span>;

  return (
    <table className={styles.structuredTable} style={{ marginLeft: depth > 0 ? 0 : undefined }}>
      <tbody>
        {entries.map(([key, val]) => (
          <tr key={key}>
            <td className={styles.structuredKey}>{resolveKeyLabel(key, locale)}</td>
            <td className={styles.structuredVal}>{renderValue(val, depth + 1, locale)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Renders arbitrary data as a structured key-value display instead of raw JSON.
 * Handles nested objects, arrays, primitives, dates, and booleans with semantic styling.
 * Pass `locale` (e.g. "zh-CN") to enable key label translation for known fields.
 */
export function StructuredData(props: { data: unknown; emptyText?: string; locale?: string }) {
  if (props.data === null || props.data === undefined) {
    return <span style={{ color: "var(--sl-muted)", fontStyle: "italic" }}>{props.emptyText ?? "—"}</span>;
  }
  return <div>{renderValue(props.data, 0, props.locale)}</div>;
}
