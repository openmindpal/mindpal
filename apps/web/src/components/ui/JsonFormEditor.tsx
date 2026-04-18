"use client";

import { useCallback, useState } from "react";
import { t } from "@/lib/i18n";
import styles from "./ui.module.css";

/* ─── JSON Form Editor: visual key-value editing with JSON advanced mode toggle ─── */

const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

type KVEntry = { key: string; value: string };

function flattenToKV(obj: Record<string, unknown>): KVEntry[] {
  return Object.entries(obj).map(([key, val]) => ({
    key,
    value: typeof val === "object" && val !== null ? JSON.stringify(val) : String(val ?? ""),
  }));
}

function kvToObject(entries: KVEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { key, value } of entries) {
    if (!key.trim()) continue;
    // Try to parse as JSON
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function parseJsonFormValue(jsonStr: string, locale: string): { entries: KVEntry[]; parseError: string } {
  try {
    const obj = JSON.parse(jsonStr || "{}");
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      return { entries: flattenToKV(obj), parseError: "" };
    }
    return { entries: [], parseError: t(locale, "jsonForm.objectOnly") };
  } catch {
    return { entries: [], parseError: t(locale, "jsonForm.invalidJson") };
  }
}

/**
 * Editable key-value form with JSON toggle.
 * - `value`: JSON string
 * - `onChange`: callback with updated JSON string
 * - `formLabel` / `jsonLabel`: toggle button labels
 */
export function JsonFormEditor(props: {
  value: string;
  onChange: (json: string) => void;
  locale?: string;
  disabled?: boolean;
  rows?: number;
  formLabel?: string;
  jsonLabel?: string;
}) {
  const locale = props.locale ?? "zh-CN";
  const initial = parseJsonFormValue(props.value, locale);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [entries, setEntries] = useState<KVEntry[]>(initial.entries);
  const [parseError, setParseError] = useState(initial.parseError);

  // Sync from JSON string -> KV entries when switching to form mode
  const syncToForm = useCallback((jsonStr: string) => {
    const next = parseJsonFormValue(jsonStr, locale);
    setEntries(next.entries);
    setParseError(next.parseError);
  }, [locale]);

  function switchToForm() {
    syncToForm(props.value);
    setMode("form");
  }

  function switchToJson() {
    if (mode === "form") {
      const obj = kvToObject(entries);
      props.onChange(JSON.stringify(obj, null, 2));
    }
    setMode("json");
  }

  function updateEntry(index: number, field: "key" | "value", val: string) {
    const next = [...entries];
    next[index] = { ...next[index]!, [field]: val };
    setEntries(next);
    const obj = kvToObject(next);
    props.onChange(JSON.stringify(obj, null, 2));
  }

  function addEntry() {
    const next = [...entries, { key: "", value: "" }];
    setEntries(next);
  }

  function removeEntry(index: number) {
    const next = entries.filter((_, i) => i !== index);
    setEntries(next);
    const obj = kvToObject(next);
    props.onChange(JSON.stringify(obj, null, 2));
  }

  const formLabel = props.formLabel ?? t(locale, "jsonForm.mode.form");
  const jsonLabel = props.jsonLabel ?? t(locale, "jsonForm.mode.json");

  return (
    <div>
      {/* Toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 8 }}>
        <button
          type="button"
          onClick={switchToForm}
          disabled={props.disabled}
          className={`${styles.tabBtn} ${mode === "form" ? styles.tabBtnActive : ""}`}
          style={{ padding: "4px 12px", fontSize: 12 }}
        >
          {formLabel}
        </button>
        <button
          type="button"
          onClick={switchToJson}
          disabled={props.disabled}
          className={`${styles.tabBtn} ${mode === "json" ? styles.tabBtnActive : ""}`}
          style={{ padding: "4px 12px", fontSize: 12 }}
        >
          {jsonLabel}
        </button>
      </div>

      {mode === "json" ? (
        <textarea
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          disabled={props.disabled}
          rows={props.rows ?? 6}
          style={{ width: "100%", fontFamily: mono, fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-bg)", color: "var(--sl-fg)", resize: "vertical" }}
        />
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {parseError ? (
            <div style={{ color: "crimson", fontSize: 12 }}>{parseError}</div>
          ) : null}
          {entries.map((entry, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                value={entry.key}
                onChange={(e) => updateEntry(i, "key", e.target.value)}
                disabled={props.disabled}
                placeholder={t(locale, "jsonForm.field.key")}
                style={{ width: 160, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-bg)", color: "var(--sl-fg)", fontSize: 12, fontFamily: mono }}
              />
              <input
                value={entry.value}
                onChange={(e) => updateEntry(i, "value", e.target.value)}
                disabled={props.disabled}
                placeholder={t(locale, "jsonForm.field.value")}
                style={{ flex: 1, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-bg)", color: "var(--sl-fg)", fontSize: 12, fontFamily: mono }}
              />
              <button
                type="button"
                onClick={() => removeEntry(i)}
                disabled={props.disabled}
                style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "transparent", color: "crimson", cursor: "pointer", fontSize: 12 }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addEntry}
            disabled={props.disabled}
            style={{ justifySelf: "start", padding: "4px 12px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "transparent", color: "var(--sl-fg)", cursor: "pointer", fontSize: 12 }}
          >
            + {t(locale, "action.add")}
          </button>
        </div>
      )}
    </div>
  );
}
