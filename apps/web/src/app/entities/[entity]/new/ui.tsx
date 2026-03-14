"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE, apiHeaders, text } from "../../../../lib/api";
import { t } from "../../../../lib/i18n";
import type { FieldDef, EffectiveSchema } from "../../../../lib/types";

type Props = {
  locale: string;
  entity: string;
  schema: EffectiveSchema | null;
  toolRef?: string;
  fieldOrder?: string[];
  layoutVariant?: "single" | "twoColumn";
};

function validateAndBuildPayload(fields: Record<string, FieldDef>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [name, def] of Object.entries(fields)) {
    const writable = def?.writable !== false;
    const raw = values[name];
    const empty = raw === undefined || raw === "";
    if (def.required && writable && empty) {
      errors[name] = "required";
      continue;
    }
    if (empty) continue;
    if (def.type === "number") {
      const n = Number(raw);
      if (Number.isNaN(n)) errors[name] = "invalid number";
      else out[name] = n;
    } else if (def.type === "boolean") {
      out[name] = Boolean(raw);
    } else if (def.type === "json") {
      try {
        out[name] = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        errors[name] = "invalid json";
      }
    } else {
      out[name] = raw;
    }
  }
  return { ok: Object.keys(errors).length === 0, payload: out, errors };
}

export function EntityForm(props: Props) {
  const router = useRouter();
  const fields = (props.schema?.fields ?? {}) as Record<string, FieldDef>;
  const fieldEntries = useMemo(() => {
    const entries = Object.entries(fields);
    const order = Array.isArray(props.fieldOrder) ? props.fieldOrder : [];
    if (!order.length) return entries;
    const map = new Map(entries);
    const out: Array<[string, FieldDef]> = [];
    for (const k of order) {
      const v = map.get(k);
      if (v) out.push([k, v]);
    }
    for (const [k, v] of entries) if (!order.includes(k)) out.push([k, v]);
    return out;
  }, [fields, props.fieldOrder]);

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const built = validateAndBuildPayload(fields, values);
      if (!built.ok) {
        setFieldErrors(built.errors);
        return;
      }
      const payload = built.payload;
      const idempotencyKey = crypto.randomUUID();
      if (props.toolRef) {
        const res = await fetch(`${API_BASE}/tools/${encodeURIComponent(props.toolRef)}/execute`, {
          method: "POST",
          headers: {
            ...apiHeaders(props.locale),
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ schemaName: "core", entityName: props.entity, payload }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof data?.message === "object" ? text(data.message, props.locale) : String(data?.message ?? res.statusText);
          throw new Error(`${data?.errorCode ?? "ERROR"}: ${msg}`);
        }
        setRunId(String(data.runId));
        router.push(`/runs/${encodeURIComponent(String(data.runId))}?lang=${encodeURIComponent(props.locale)}`);
      } else {
        const res = await fetch(`${API_BASE}/entities/${encodeURIComponent(props.entity)}`, {
          method: "POST",
          headers: {
            ...apiHeaders(props.locale),
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof data?.message === "object" ? text(data.message, props.locale) : String(data?.message ?? res.statusText);
          throw new Error(`${data?.errorCode ?? "ERROR"}: ${msg}`);
        }
        router.push(`/entities/${encodeURIComponent(props.entity)}?lang=${encodeURIComponent(props.locale)}`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        maxWidth: props.layoutVariant === "twoColumn" ? 980 : 720,
        gridTemplateColumns: props.layoutVariant === "twoColumn" ? "1fr 1fr" : "1fr",
      }}
    >
      {fieldEntries.map(([name, def]) => {
        const label = text(def?.displayName ?? name, props.locale) || name;
        const writable = def?.writable !== false;
        const type = def?.type ?? "string";
        const ferr = fieldErrors[name];

        if (type === "boolean") {
          return (
            <div key={name} style={{ display: "grid", gap: 6 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={Boolean(values[name])}
                disabled={!writable || submitting}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [name]: e.target.checked }));
                  setFieldErrors((s) => {
                    const { [name]: _, ...rest } = s;
                    return rest;
                  });
                }}
              />
              {label}
              {def.required ? " *" : ""}
              </label>
              {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
            </div>
          );
        }

        if (type === "json") {
          return (
            <label key={name} style={{ display: "grid", gap: 6 }}>
              <div>
                {label}
                {def.required ? " *" : ""}
              </div>
              <textarea
                rows={4}
                value={String(values[name] ?? "")}
                disabled={!writable || submitting}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [name]: e.target.value }));
                  setFieldErrors((s) => {
                    const { [name]: _, ...rest } = s;
                    return rest;
                  });
                }}
              />
              {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
            </label>
          );
        }

        return (
          <label key={name} style={{ display: "grid", gap: 6 }}>
            <div>
              {label}
              {def.required ? " *" : ""}
            </div>
            <input
              type={type === "number" ? "number" : "text"}
              value={String(values[name] ?? "")}
              disabled={!writable || submitting}
              onChange={(e) => {
                setValues((v) => ({ ...v, [name]: e.target.value }));
                setFieldErrors((s) => {
                  const { [name]: _, ...rest } = s;
                  return rest;
                });
              }}
            />
            {ferr ? <div style={{ color: "crimson" }}>{ferr}</div> : null}
          </label>
        );
      })}

      {runId ? (
        <p>
          RunId：{runId}
        </p>
      ) : null}
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      <button type="button" onClick={submit} disabled={submitting}>
        {t(props.locale, "submit")}
      </button>
    </div>
  );
}
