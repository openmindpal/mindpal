"use client";

import { useMemo, useState } from "react";
import { API_BASE, apiHeaders } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";


export default function ModelGatewayClient(props: { locale: string }) {
  const [purpose, setPurpose] = useState<string>("test");
  const [modelRef, setModelRef] = useState<string>("");
  const [message, setMessage] = useState<string>("hello");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<unknown>(null);
  const [status, setStatus] = useState<number>(0);

  async function invoke() {
    setError("");
    setBusy(true);
    setResult(null);
    try {
      const body = {
        purpose: purpose.trim() || "test",
        modelRef: modelRef.trim() ? modelRef.trim() : undefined,
        messages: [{ role: "user", content: message }],
      };
      const res = await fetch(`${API_BASE}/models/chat`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const routingDecision = useMemo(() => {
    const o = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    return o.routingDecision;
  }, [result]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.modelGateway.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status || 0} />
            <button onClick={invoke} disabled={busy}>
              {t(props.locale, "gov.modelGateway.invoke")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.modelGateway.formTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.modelGateway.purpose")}</div>
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.modelGateway.modelRef")}</div>
              <input value={modelRef} onChange={(e) => setModelRef(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.modelGateway.modelRefPlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.modelGateway.message")}</div>
              <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
            </label>
            <div>
              <button onClick={invoke} disabled={busy}>
                {busy ? t(props.locale, "action.loading") : t(props.locale, "gov.modelGateway.invoke")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      {routingDecision ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.modelGateway.routingDecision")}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(routingDecision, null, 2)}</pre>
          </Card>
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.modelGateway.resultTitle")}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

