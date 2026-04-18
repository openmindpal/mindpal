"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, Table, StructuredData, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { toRecord } from "@/lib/viewData";

type RetrievalLog = Record<string, unknown>;
type RetrievalLogResp = ApiError & { log?: RetrievalLog };
type EvidenceResolveResp = ApiError & { evidence?: Record<string, unknown> };

function pickArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export default function RetrievalLogDetailClient(props: { locale: string; id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number>(0);
  const [data, setData] = useState<RetrievalLogResp | null>(null);

  const [evidenceBusy, setEvidenceBusy] = useState<string>("");
  const [evidenceError, setEvidenceError] = useState<string>("");
  const [evidenceByKey, setEvidenceByKey] = useState<Record<string, Record<string, unknown>>>({});

  async function load() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/knowledge/retrieval-logs/${encodeURIComponent(props.id)}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData((json as RetrievalLogResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const log = data?.log ?? null;
  const ranked = useMemo(() => {
    const rec = toRecord(log);
    const v = rec ? rec.rankedEvidenceRefs : null;
    return pickArr(v);
  }, [log]);

  async function resolveEvidence(sourceRef: Record<string, unknown>) {
    setEvidenceError("");
    const key = `${String(sourceRef.documentId ?? "")}:${String(sourceRef.version ?? "")}:${String(sourceRef.chunkId ?? "")}`;
    setEvidenceBusy(key);
    try {
      const res = await apiFetch(`/knowledge/evidence/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ sourceRef }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as EvidenceResolveResp) ?? {};
      if (!out.evidence || typeof out.evidence !== "object") throw ({ errorCode: "ERROR", message: "missing evidence" } satisfies ApiError);
      setEvidenceByKey((prev) => ({ ...prev, [key]: out.evidence as Record<string, unknown> }));
    } catch (e: unknown) {
      setEvidenceError(errText(props.locale, toApiError(e)));
    } finally {
      setEvidenceBusy("");
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={`${t(props.locale, "gov.nav.knowledgeLogs")}: ${props.id}`}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={status || 0} />
            <button disabled={busy} onClick={load}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.knowledgeLogs.detail.logTitle")}>
        <StructuredData data={log} />
      </Card>

      <Card title={t(props.locale, "gov.knowledgeLogs.detail.rankedEvidenceRefsTitle")}>
        {evidenceError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{evidenceError}</pre> : null}
        <Table>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.sourceRef")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.rankReason")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.snippetDigest")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.location")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeLogs.detail.table.resolved")}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e, idx) => {
              const rec = toRecord(e);
              const sr = rec && toRecord(rec.sourceRef);
              const key = sr ? `${String(sr.documentId ?? "")}:${String(sr.version ?? "")}:${String(sr.chunkId ?? "")}` : `${idx}`;
              const resolved = evidenceByKey[key] ?? null;
              return (
                <tr key={key}>
                  <td>
                    <StructuredData data={sr ?? null} />
                  </td>
                  <td>
                    <StructuredData data={rec?.rankReason ?? null} />
                  </td>
                  <td>
                    <StructuredData data={rec?.snippetDigest ?? null} />
                  </td>
                  <td>
                    <StructuredData data={rec?.location ?? null} />
                  </td>
                  <td>
                    <button disabled={!sr || evidenceBusy === key} onClick={() => sr && resolveEvidence(sr)}>
                      {evidenceBusy === key ? t(props.locale, "action.loading") : t(props.locale, "gov.knowledgeLogs.detail.resolve")}
                    </button>
                  </td>
                  <td>
                    {resolved ? <StructuredData data={resolved} /> : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
