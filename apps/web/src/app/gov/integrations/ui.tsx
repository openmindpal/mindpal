"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StructuredData, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type IntegrationItem = Record<string, unknown>;
type ListResp = ApiError & { scopeType?: string; scopeId?: string; items?: IntegrationItem[] };
type DetailResp = ApiError & { kind?: string; integrationId?: string; integration?: unknown; runs?: unknown; states?: unknown; outbox?: unknown; dlq?: unknown };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

type InitialData = { status: number; json: unknown };

export default function IntegrationsClient(props: { locale: string; initial?: InitialData }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(props.initial?.status ?? 0);
  const [error, setError] = useState("");
  const [scopeType, setScopeType] = useState<"tenant" | "space">("space");
  const [data, setData] = useState<ListResp | null>((props.initial?.json as ListResp) ?? null);

  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [detailStatus, setDetailStatus] = useState(0);
  const [detailError, setDetailError] = useState("");

  const rows = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("limit", "50");
      q.set("offset", "0");
      q.set("scopeType", scopeType);
      const res = await apiFetch(`/governance/integrations?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as ListResp) ?? null;
      setData(out);
      if (!selectedId && Array.isArray(out?.items) && out!.items!.length) {
        const first = out!.items![0];
        if (first && typeof first === "object") setSelectedId(String((first as any).integrationId ?? ""));
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setData(null);
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(integrationId: string) {
    setDetailError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/integrations/${encodeURIComponent(integrationId)}`, { locale: props.locale, cache: "no-store" });
      setDetailStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setDetail((json as DetailResp) ?? null);
    } catch (e: unknown) {
      setDetailError(errText(props.locale, toApiError(e)));
      setDetail(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.integrations")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={status || 0} />
            <select value={scopeType} onChange={(e) => setScopeType(e.target.value as any)} disabled={busy}>
              <option value="space">{t(props.locale, "gov.integrations.scopeType.space")}</option>
              <option value="tenant">{t(props.locale, "gov.integrations.scopeType.tenant")}</option>
            </select>
            <button disabled={busy} onClick={refresh}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.integrations.listTitle")}>
        <Table header={<span>{rows.length ? `${rows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.integrations.table.kind")}</th>
              <th align="left">{t(props.locale, "gov.integrations.table.name")}</th>
              <th align="left">{t(props.locale, "gov.integrations.table.status")}</th>
              <th align="left">{t(props.locale, "gov.integrations.table.updatedAt")}</th>
              <th align="left">{t(props.locale, "gov.integrations.table.integrationId")}</th>
              <th align="left">{t(props.locale, "gov.integrations.table.links")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
                  <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : rows.map((r, idx) => {
              const rec = asRecord(r);
              const integrationId = rec ? String(rec.integrationId ?? idx) : String(idx);
              const kind = rec ? String(rec.kind ?? "") : "";
              const links = rec ? asRecord(rec.links) : null;
              const destId = links ? String(links.destinationId ?? "") : "";
              const subId = links ? String(links.subscriptionId ?? "") : "";
              const connectorId = links ? String(links.connectorInstanceId ?? "") : "";
              return (
                <tr key={integrationId}>
                  <td>{kind || "-"}</td>
                  <td>{rec ? String(rec.name ?? "-") : "-"}</td>
                  <td>{rec ? <Badge>{statusLabel(String(rec.status ?? "-"), props.locale)}</Badge> : "-"}</td>
                  <td>{fmtDateTime(rec?.updatedAt, props.locale)}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{integrationId}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {destId ? <Link href={`/gov/audit?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.integrations.link.siem")}</Link> : null}
                      {subId ? <Link href={`/settings?lang=${encodeURIComponent(props.locale)}#schedules`}>{t(props.locale, "gov.integrations.link.subs")}</Link> : null}
                      {connectorId ? <Link href={`/settings?lang=${encodeURIComponent(props.locale)}#channels`}>{t(props.locale, "gov.integrations.link.connector")}</Link> : null}
                    </div>
                  </td>
                  <td>
                    <button
                      disabled={busy || !integrationId}
                      onClick={async () => {
                        setSelectedId(integrationId);
                        await loadDetail(integrationId);
                      }}
                    >
                      {t(props.locale, "gov.integrations.action.view")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card
        title={t(props.locale, "gov.integrations.detailTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{detailStatus || "-"}</Badge>
            <input
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              placeholder={t(props.locale, "gov.integrations.integrationIdPlaceholder")}
              style={{ width: 420 }}
            />
            <button disabled={busy || !selectedId.trim()} onClick={() => loadDetail(selectedId.trim())}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
          </div>
        }
      >
        {detailError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{detailError}</pre> : null}
        <StructuredData data={detail} />
      </Card>
    </div>
  );
}
