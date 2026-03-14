"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type CatalogItem = { provider?: string; model?: string; modelRef?: string; endpointHost?: string; defaultLimits?: any };
type Binding = { id?: string; modelRef?: string; provider?: string; model?: string; baseUrl?: string | null; connectorInstanceId?: string; secretId?: string; secretIds?: string[]; status?: string; updatedAt?: string };

type ProviderKey = "openai_compatible" | "deepseek" | "hunyuan" | "qianwen" | "doubao" | "zhipu" | "kimi";
type OnboardResult = { modelRef: string; provider: string; model: string; baseUrl: string | null; binding?: Binding };

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export default function GovModelsClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [bindings, setBindings] = useState<{ status: number; json: any }>(props.initial?.bindings ?? { status: 0, json: null });
  const [catalog, setCatalog] = useState<{ status: number; json: any }>(props.initial?.catalog ?? { status: 0, json: null });

  const catalogItems = useMemo(() => (Array.isArray(catalog?.json?.catalog) ? (catalog.json.catalog as CatalogItem[]) : []), [catalog]);
  const bindingItems = useMemo(() => (Array.isArray(bindings?.json?.bindings) ? (bindings.json.bindings as Binding[]) : []), [bindings]);

  const [providerKey, setProviderKey] = useState<ProviderKey>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [lastSaved, setLastSaved] = useState<OnboardResult | null>(null);
  const [testOutput, setTestOutput] = useState<{ outputText: string; traceId: string } | null>(null);
  const [testError, setTestError] = useState<string>("");

  const refreshCatalog = useCallback(async () => {
    const res = await fetch(`${API_BASE}/models/catalog`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json = await res.json().catch(() => null);
    setCatalog({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  const refreshBindings = useCallback(async () => {
    const res = await fetch(`${API_BASE}/models/bindings`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json = await res.json().catch(() => null);
    setBindings({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setTestError("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function saveOnboard() {
    await runAction(async () => {
      const idem =
        typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `model-onboard-${(crypto as any).randomUUID()}` : `model-onboard-${Date.now()}`;
      const res = await fetch(`${API_BASE}/models/onboard`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json", "idempotency-key": idem },
        body: JSON.stringify({ providerKey, baseUrl, apiKey, modelName }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const modelRef = String((json as any)?.modelRef ?? "");
      const provider = String((json as any)?.provider ?? "");
      const model = String((json as any)?.model ?? "");
      const savedBaseUrl = (json as any)?.baseUrl != null ? String((json as any).baseUrl) : null;
      setLastSaved({ modelRef, provider, model, baseUrl: savedBaseUrl, binding: (json as any)?.binding ?? null });
      setApiKey("");
      await refreshBindings();
      setNotice(t(props.locale, "gov.models.saved"));
    });
  }

  async function testModel(modelRef: string) {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/models/chat`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "gov.models.test",
          modelRef,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setTestOutput(null);
        setTestError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
        return;
      }
      setTestError("");
      setTestOutput({ outputText: String((json as any)?.outputText ?? ""), traceId: String((json as any)?.traceId ?? "") });
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.models.title")}
        actions={
          <>
            <Badge>{bindings.status || 0}</Badge>
            <button onClick={refreshBindings} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {notice ? <pre style={{ color: "seagreen", whiteSpace: "pre-wrap" }}>{notice}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.models.bindingsTitle")}>
          <Table>
            <thead>
              <tr>
                <th>modelRef</th>
                <th>provider</th>
                <th>model</th>
                <th>baseUrl</th>
                <th>connectorInstanceId</th>
                <th>secrets</th>
                <th>status</th>
                <th>{t(props.locale, "action.test")}</th>
              </tr>
            </thead>
            <tbody>
              {bindingItems.map((b, idx) => (
                <tr key={String(b.id ?? b.modelRef ?? idx)}>
                  <td>{String(b.modelRef ?? "")}</td>
                  <td>{String(b.provider ?? "")}</td>
                  <td>{String(b.model ?? "")}</td>
                  <td>{String(b.baseUrl ?? "")}</td>
                  <td>{String(b.connectorInstanceId ?? "")}</td>
                  <td>{Array.isArray(b.secretIds) && b.secretIds.length ? String(b.secretIds.length) : b.secretId ? "1" : "0"}</td>
                  <td>{String(b.status ?? "")}</td>
                  <td>
                    <button onClick={() => testModel(String(b.modelRef ?? ""))} disabled={busy || !String(b.modelRef ?? "")}>
                      {t(props.locale, "action.test")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.models.onboardTitle")}>
          <div style={{ display: "grid", gap: 10, marginTop: 12, maxWidth: 820 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.provider")}</div>
              <select value={providerKey} onChange={(e) => setProviderKey(e.target.value as ProviderKey)} disabled={busy}>
                <option value="openai_compatible">{t(props.locale, "gov.models.provider.openai_compatible")}</option>
                <option value="deepseek">{t(props.locale, "gov.models.provider.deepseek")}</option>
                <option value="hunyuan">{t(props.locale, "gov.models.provider.hunyuan")}</option>
                <option value="qianwen">{t(props.locale, "gov.models.provider.qianwen")}</option>
                <option value="doubao">{t(props.locale, "gov.models.provider.doubao")}</option>
                <option value="zhipu">{t(props.locale, "gov.models.provider.zhipu")}</option>
                <option value="kimi">{t(props.locale, "gov.models.provider.kimi")}</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.baseUrl")}</div>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} placeholder="https://api.openai.com" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.apiKey")}</div>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} type="password" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.models.modelName")}</div>
              <input value={modelName} onChange={(e) => setModelName(e.target.value)} disabled={busy} placeholder="gpt-4o-mini" />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={saveOnboard} disabled={busy || !baseUrl.trim() || !apiKey || !modelName.trim()}>
                {t(props.locale, "gov.models.save")}
              </button>
              <button onClick={() => (lastSaved?.modelRef ? testModel(lastSaved.modelRef) : null)} disabled={busy || !lastSaved?.modelRef}>
                {t(props.locale, "action.test")}
              </button>
              {lastSaved?.modelRef ? <span>{`${t(props.locale, "gov.models.modelRef")}: ${lastSaved.modelRef}`}</span> : null}
            </div>
          </div>
        </Card>
      </div>

      {testError ? <pre style={{ marginTop: 12, color: "crimson", whiteSpace: "pre-wrap" }}>{testError}</pre> : null}
      {testOutput ? (
        <div style={{ marginTop: 12 }}>
          <Card title={t(props.locale, "gov.models.testResult")}>
            <pre style={{ whiteSpace: "pre-wrap" }}>{testOutput.outputText}</pre>
            <div>{testOutput.traceId ? `traceId=${testOutput.traceId}` : ""}</div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
