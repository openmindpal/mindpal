"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, Table } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";

type ChangeLogRow = {
  changeId?: string;
  opId?: string;
  entityName?: string;
  recordId?: string;
  operation?: string;
  revision?: number;
  patch?: Record<string, unknown>;
  createdAt?: string;
};

/**
 * Change Log visualisation — time-line style display of sync change records.
 * Fetches from the sync pull endpoint to show recent applied changes.
 */
export default function ChangeLog(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<ChangeLogRow[]>([]);

  async function load() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/sync/pull`, {
        method: "POST",
        locale: props.locale,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "web_gov_changelog", cursor: null, limit: 50 }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const data = json as { items?: ChangeLogRow[] };
      setEntries(data.items ?? []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card title={t(props.locale, "gov.syncConflicts.changeLog.title")}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button disabled={busy} onClick={load}>
          {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
        </button>
      </div>
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}
      {entries.length === 0 && !busy ? (
        <div style={{ opacity: 0.6, padding: 16, textAlign: "center" }}>{t(props.locale, "widget.noData")}</div>
      ) : (
        <div style={{ position: "relative", paddingLeft: 20 }}>
          {/* Timeline line */}
          <div style={{ position: "absolute", left: 8, top: 0, bottom: 0, width: 2, background: "#ddd" }} />
          {entries.map((e, i) => (
            <div key={e.changeId ?? e.opId ?? i} style={{ position: "relative", marginBottom: 12, paddingLeft: 16 }}>
              {/* Timeline dot */}
              <div style={{
                position: "absolute",
                left: -16,
                top: 4,
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: e.operation === "delete" ? "#ef5350" : e.operation === "create" ? "#66bb6a" : "#42a5f5",
              }} />
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: "nowrap" }}>{fmtDateTime(e.createdAt, props.locale)}</span>
                <Badge>{e.operation ?? "-"}</Badge>
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
                  {e.entityName ?? "-"} / {e.recordId ? String(e.recordId).slice(0, 8) : "-"}
                </span>
                {e.revision != null && <span style={{ fontSize: 11, opacity: 0.6 }}>rev {e.revision}</span>}
              </div>
              {e.patch && Object.keys(e.patch).length > 0 && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12 }}>
                    {t(props.locale, "gov.syncConflicts.changeLog.changes")}
                  </summary>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(e.patch, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
