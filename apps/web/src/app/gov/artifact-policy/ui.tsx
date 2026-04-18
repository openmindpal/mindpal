"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toRecord } from "@/lib/viewData";

type ArtifactPolicy = ApiError & {
  tenantId?: string;
  scopeType?: "tenant" | "space";
  scopeId?: string;
  downloadTokenExpiresInSec?: number;
  downloadTokenMaxUses?: number;
  watermarkHeadersEnabled?: boolean;
  updatedAt?: string;
};

function normalizeArtifactPolicy(value: unknown): ArtifactPolicy | null {
  const record = toRecord(value);
  if (!record) return null;
  const scopeType = stringField(record, "scopeType");
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    tenantId: stringField(record, "tenantId"),
    scopeType: scopeType === "tenant" ? "tenant" : scopeType === "space" ? "space" : undefined,
    scopeId: stringField(record, "scopeId"),
    downloadTokenExpiresInSec: numberField(record, "downloadTokenExpiresInSec"),
    downloadTokenMaxUses: numberField(record, "downloadTokenMaxUses"),
    watermarkHeadersEnabled: typeof record.watermarkHeadersEnabled === "boolean" ? record.watermarkHeadersEnabled : undefined,
    updatedAt: stringField(record, "updatedAt"),
  };
}

export default function GovArtifactPolicyClient(props: { locale: string; initial: unknown; initialStatus: number; initialScopeType: "space" | "tenant" }) {
  const [scopeType, setScopeType] = useState<"space" | "tenant">(props.initialScopeType);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [data, setData] = useState<ArtifactPolicy | null>(normalizeArtifactPolicy(props.initial));

  const initialPolicy = normalizeArtifactPolicy(props.initial);
  const initialExpiresInSec = props.initialStatus === 404 ? 300 : Number(initialPolicy?.downloadTokenExpiresInSec ?? 300);
  const initialMaxUses = props.initialStatus === 404 ? 1 : Number(initialPolicy?.downloadTokenMaxUses ?? 1);
  const initialWatermarkEnabled = props.initialStatus === 404 ? true : Boolean(initialPolicy?.watermarkHeadersEnabled ?? true);
  const [expiresInSec, setExpiresInSec] = useState<string>(String(Number.isFinite(initialExpiresInSec) && initialExpiresInSec > 0 ? initialExpiresInSec : 300));
  const [maxUses, setMaxUses] = useState<string>(String(Number.isFinite(initialMaxUses) && initialMaxUses > 0 ? initialMaxUses : 1));
  const [watermarkHeadersEnabled, setWatermarkHeadersEnabled] = useState<boolean>(initialWatermarkEnabled);

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const initialError = useMemo(() => {
    if (status >= 400 && status !== 404) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  function loadFormFrom(p: ArtifactPolicy | null, isConfigured: boolean) {
    if (!isConfigured) {
      setExpiresInSec("300");
      setMaxUses("1");
      setWatermarkHeadersEnabled(true);
      return;
    }
    const e = Number(p?.downloadTokenExpiresInSec);
    const m = Number(p?.downloadTokenMaxUses);
    setExpiresInSec(String(Number.isFinite(e) && e > 0 ? e : 300));
    setMaxUses(String(Number.isFinite(m) && m > 0 ? m : 1));
    setWatermarkHeadersEnabled(Boolean(p?.watermarkHeadersEnabled ?? true));
  }

  async function load(nextScopeType?: "space" | "tenant") {
    const st = nextScopeType ?? scopeType;
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("scopeType", st);
      const res = await apiFetch(`/governance/artifact-policy?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      const normalized = normalizeArtifactPolicy(json);
      if (res.status === 404) {
        setData(normalized);
        loadFormFrom(null, false);
        return;
      }
      setData(normalized);
      if (!res.ok) {
        setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
        return;
      }
      loadFormFrom(normalized, true);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError("");
    setBusy(true);
    try {
      const e = Math.max(1, Math.min(3600, Math.floor(Number(expiresInSec || "0"))));
      const m = Math.max(1, Math.min(10, Math.floor(Number(maxUses || "0"))));
      const res = await apiFetch(`/governance/artifact-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ scopeType, downloadTokenExpiresInSec: e, downloadTokenMaxUses: m, watermarkHeadersEnabled }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await load(scopeType);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.artifactPolicy.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={() => load()} disabled={busy}>
              {t(props.locale, "gov.artifactPolicy.load")}
            </button>
            <button onClick={save} disabled={busy}>
              {t(props.locale, "gov.artifactPolicy.save")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}
      {!error && status === 404 ? <pre style={{ whiteSpace: "pre-wrap" }}>{t(props.locale, "gov.artifactPolicy.notConfigured")}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.artifactPolicy.configTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.artifactPolicy.scopeType")}</div>
              <select
                value={scopeType}
                onChange={(e) => {
                  const v = e.target.value === "tenant" ? "tenant" : "space";
                  setScopeType(v);
                  load(v);
                }}
                disabled={busy}
              >
                <option value="space">space</option>
                <option value="tenant">tenant</option>
              </select>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.artifactPolicy.expiresInSec")}</div>
              <input value={expiresInSec} onChange={(e) => setExpiresInSec(e.target.value)} disabled={busy} />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.artifactPolicy.maxUses")}</div>
              <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} disabled={busy} />
            </label>

            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={watermarkHeadersEnabled} onChange={(e) => setWatermarkHeadersEnabled(e.target.checked)} disabled={busy} />
              <span>{t(props.locale, "gov.artifactPolicy.watermarkHeadersEnabled")}</span>
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => load()} disabled={busy}>
                {t(props.locale, "gov.artifactPolicy.load")}
              </button>
              <button onClick={save} disabled={busy}>
                {t(props.locale, "gov.artifactPolicy.save")}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
