"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type EvalRunResp = { run?: unknown } & ApiError;

export default function EvalRunClient(props: { locale: string; runId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<EvalRunResp | null>((props.initial as EvalRunResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/evals/runs/${encodeURIComponent(props.runId)}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setData((json as EvalRunResp) ?? null);
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.evalRun.title")}
        description={<span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>runId={props.runId}</span>}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.evalRun.summaryTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(data?.run ?? null, null, 2)}</pre>
        </Card>
      </div>
    </div>
  );
}
