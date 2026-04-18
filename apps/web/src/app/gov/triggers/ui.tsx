"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, StructuredData, JsonFormEditor } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";


export default function GovTriggersClient(props: { locale: string; initial: { status: number; json: any } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<any>(null);
  const [data, setData] = useState(props.initial);

  const items = useMemo(() => (Array.isArray(data?.json?.items) ? data.json.items : []), [data]);

  const [type, setType] = useState<"cron" | "event">("cron");
  const [cronExpr, setCronExpr] = useState("*/5 * * * *");
  const [eventSource, setEventSource] = useState<"ingress.envelope" | "governance.audit">("ingress.envelope");
  const [eventFilterJson, setEventFilterJson] = useState<string>('{"provider":"mock"}');
  const [targetKind, setTargetKind] = useState<"workflow" | "job">("workflow");
  const [targetRef, setTargetRef] = useState("tool.echo@1");
  const [idempotencyTemplate, setIdempotencyTemplate] = useState("trigger:{{triggerId}}:{{bucketStart}}");
  const [inputMappingJson, setInputMappingJson] = useState<string>('{"kind":"template","fields":{"triggerId":{"from":"time","key":"triggerId"},"eventType":{"from":"event","path":"eventType"}}}');

  const refresh = useCallback(async () => {
    const res = await apiFetch(`/governance/triggers?limit=50`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setData({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createOne() {
    await runAction(async () => {
      const eventFilter = eventFilterJson.trim() ? JSON.parse(eventFilterJson) : undefined;
      const inputMapping = inputMappingJson.trim() ? JSON.parse(inputMappingJson) : undefined;
      const payload: any = {
        type,
        target: { kind: targetKind, ref: targetRef.trim() },
        idempotency: { keyTemplate: idempotencyTemplate.trim() || undefined, windowSec: 60 },
        inputMapping,
      };
      if (type === "cron") payload.cron = { expr: cronExpr.trim(), tz: "UTC", misfirePolicy: "skip" };
      else payload.event = { source: eventSource, filter: eventFilter };
      const res = await apiFetch(`/governance/triggers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(json ?? {});
    });
  }

  async function preflight(triggerId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/triggers/${encodeURIComponent(triggerId)}/preflight`, {
        method: "POST",
        locale: props.locale,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(json ?? {});
    });
  }

  async function manualFire(triggerId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/triggers/${encodeURIComponent(triggerId)}/fire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(json ?? {});
    });
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader title={t(props.locale, "gov.triggers.title")} description={t(props.locale, "gov.triggers.desc")} actions={<StatusBadge locale={props.locale} status={data.status} />} />
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {info ? <StructuredData data={info} /> : null}

      <Card title={t(props.locale, "gov.triggers.createTitle")}>
        <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.triggers.label.type")}</div>
            <select value={type} onChange={(e) => setType(e.target.value as any)}>
              <option value="cron">{t(props.locale, "gov.triggers.type.cron")}</option>
              <option value="event">{t(props.locale, "gov.triggers.type.event")}</option>
            </select>
          </label>
          {type === "cron" ? (
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.triggers.label.cronExpr")}</div>
              <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} />
            </label>
          ) : (
            <>
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.triggers.label.eventSource")}</div>
                <select value={eventSource} onChange={(e) => setEventSource(e.target.value as any)}>
                  <option value="ingress.envelope">ingress.envelope</option>
                  <option value="governance.audit">governance.audit</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.triggers.label.eventFilter")}</div>
                <JsonFormEditor value={eventFilterJson} onChange={setEventFilterJson} locale={props.locale} disabled={busy} rows={5} />
              </label>
            </>
          )}
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.triggers.label.targetKind")}</div>
            <select value={targetKind} onChange={(e) => setTargetKind(e.target.value as any)}>
              <option value="workflow">{t(props.locale, "gov.triggers.targetKind.workflow")}</option>
              <option value="job">{t(props.locale, "gov.triggers.targetKind.job")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.triggers.label.targetRef")}</div>
            <input value={targetRef} onChange={(e) => setTargetRef(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.triggers.label.idempotencyKeyTemplate")}</div>
            <input value={idempotencyTemplate} onChange={(e) => setIdempotencyTemplate(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.triggers.label.inputMapping")}</div>
            <JsonFormEditor value={inputMappingJson} onChange={setInputMappingJson} locale={props.locale} disabled={busy} rows={6} />
          </label>
          <button onClick={createOne} disabled={busy}>
            {t(props.locale, "action.create")}
          </button>
        </div>
      </Card>

      <Table header={<span>{t(props.locale, "gov.triggers.listTitle")}</span>}>
        <thead>
          <tr>
            <th align="left">{t(props.locale, "gov.triggers.col.triggerId")}</th>
            <th align="left">{t(props.locale, "gov.triggers.col.type")}</th>
            <th align="left">{t(props.locale, "gov.triggers.col.status")}</th>
            <th align="left">{t(props.locale, "gov.triggers.col.target")}</th>
            <th align="left">{t(props.locale, "tasks.col.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : items.map((it: any) => (
            <tr key={String(it.triggerId ?? it.trigger_id)}>
              <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(it.triggerId ?? it.trigger_id)}</td>
              <td>{String(it.type ?? "-")}</td>
              <td>
                <Badge>{statusLabel(String(it.status ?? "-"), props.locale)}</Badge>
              </td>
              <td>{String(it.targetRef ?? it.target_ref ?? "-")}</td>
              <td>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => preflight(String(it.triggerId ?? it.trigger_id))} disabled={busy}>
                    {t(props.locale, "gov.triggers.action.preflight")}
                  </button>
                  <button onClick={() => manualFire(String(it.triggerId ?? it.trigger_id))} disabled={busy}>
                    {t(props.locale, "gov.triggers.action.fire")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

