"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, StructuredData, JsonFormEditor } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

const TIMEZONE_OPTIONS = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin"] as const;

export default function GovTriggersClient(props: { locale: string; initial: { status: number; json: any } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<any>(null);
  const [data, setData] = useState(props.initial);

  const items = useMemo(() => (Array.isArray(data?.json?.items) ? data.json.items : []), [data]);

  const [type, setType] = useState<"cron" | "event">("cron");
  const [cronExpr, setCronExpr] = useState("*/5 * * * *");
  const [cronTz, setCronTz] = useState("UTC");
  const [eventSource, setEventSource] = useState<"ingress.envelope" | "governance.audit">("ingress.envelope");
  const [eventFilterJson, setEventFilterJson] = useState<string>('{"provider":"mock"}');
  const [targetKind, setTargetKind] = useState<"workflow" | "job">("workflow");
  const [targetRef, setTargetRef] = useState("tool.echo@1");
  const [idempotencyTemplate, setIdempotencyTemplate] = useState("trigger:{{triggerId}}:{{bucketStart}}");
  const [inputMappingJson, setInputMappingJson] = useState<string>('{"kind":"template","fields":{"triggerId":{"from":"time","key":"triggerId"},"eventType":{"from":"event","path":"eventType"}}}');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<any[]>([]);

  const formRef = useRef<HTMLDivElement>(null);

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

  function resetForm() {
    setType("cron");
    setCronExpr("*/5 * * * *");
    setCronTz("UTC");
    setEventSource("ingress.envelope");
    setEventFilterJson('{"provider":"mock"}');
    setTargetKind("workflow");
    setTargetRef("tool.echo@1");
    setIdempotencyTemplate("trigger:{{triggerId}}:{{bucketStart}}");
    setInputMappingJson('{"kind":"template","fields":{"triggerId":{"from":"time","key":"triggerId"},"eventType":{"from":"event","path":"eventType"}}}');
    setEditingId(null);
  }

  function startEdit(item: any) {
    const id = String(item.triggerId ?? item.trigger_id);
    setEditingId(id);
    setType(item.type ?? "cron");
    setCronExpr(item.cron?.expr ?? item.cronExpr ?? "*/5 * * * *");
    setCronTz(item.cron?.tz ?? "UTC");
    setEventSource(item.event?.source ?? item.eventSource ?? "ingress.envelope");
    setEventFilterJson(item.event?.filter ? JSON.stringify(item.event.filter) : item.eventFilterJson ?? '{"provider":"mock"}');
    setTargetKind(item.target?.kind ?? item.targetKind ?? "workflow");
    setTargetRef(item.target?.ref ?? item.targetRef ?? item.target_ref ?? "");
    setIdempotencyTemplate(item.idempotency?.keyTemplate ?? item.idempotencyTemplate ?? "");
    setInputMappingJson(item.inputMapping ? JSON.stringify(item.inputMapping) : "{}");
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildPayload() {
    const eventFilter = eventFilterJson.trim() ? JSON.parse(eventFilterJson) : undefined;
    const inputMapping = inputMappingJson.trim() ? JSON.parse(inputMappingJson) : undefined;
    const payload: any = {
      type,
      target: { kind: targetKind, ref: targetRef.trim() },
      idempotency: { keyTemplate: idempotencyTemplate.trim() || undefined, windowSec: 60 },
      inputMapping,
    };
    if (type === "cron") payload.cron = { expr: cronExpr.trim(), tz: cronTz, misfirePolicy: "skip" };
    else payload.event = { source: eventSource, filter: eventFilter };
    return payload;
  }

  async function submitForm() {
    await runAction(async () => {
      const payload = buildPayload();
      const url = editingId
        ? `/governance/triggers/${encodeURIComponent(editingId)}/update`
        : `/governance/triggers`;
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(json ?? {});
      if (editingId) resetForm();
    });
  }

  async function deleteTrigger(triggerId: string) {
    if (!window.confirm(t(props.locale, "gov.triggers.confirm.delete"))) return;
    await runAction(async () => {
      const res = await apiFetch(`/governance/triggers/${encodeURIComponent(triggerId)}`, {
        method: "DELETE",
        locale: props.locale,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw toApiError(json);
      }
    });
  }

  async function toggleStatus(triggerId: string, currentStatus: string) {
    const newStatus = currentStatus === "enabled" ? "disabled" : "enabled";
    await runAction(async () => {
      const res = await apiFetch(`/governance/triggers/${encodeURIComponent(triggerId)}/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ status: newStatus }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  async function loadHistory(triggerId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/triggers/${encodeURIComponent(triggerId)}/runs`, {
        locale: props.locale,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const items =
        Array.isArray(json?.runs) ? json.runs :
        Array.isArray(json?.items) ? json.items :
        Array.isArray(json) ? json :
        [];
      setHistoryData(items);
      setHistoryId(triggerId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
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

      <div ref={formRef}>
        <Card title={editingId ? t(props.locale, "gov.triggers.editTitle") : t(props.locale, "gov.triggers.createTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.triggers.label.type")}</div>
              <select value={type} onChange={(e) => setType(e.target.value as any)}>
                <option value="cron">{t(props.locale, "gov.triggers.type.cron")}</option>
                <option value="event">{t(props.locale, "gov.triggers.type.event")}</option>
              </select>
            </label>
            {type === "cron" ? (
              <>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.triggers.label.cronExpr")}</div>
                  <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} />
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.triggers.label.timezone")}</div>
                  <select value={cronTz} onChange={(e) => setCronTz(e.target.value)}>
                    {TIMEZONE_OPTIONS.map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </label>
              </>
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
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={submitForm} disabled={busy}>
                {editingId ? t(props.locale, "gov.triggers.action.update") : t(props.locale, "action.create")}
              </button>
              {editingId ? (
                <button onClick={resetForm} disabled={busy}>
                  {t(props.locale, "gov.triggers.action.cancel")}
                </button>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

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
                ) : items.map((it: any) => {
            const tid = String(it.triggerId ?? it.trigger_id);
            const st = String(it.status ?? "");
            return (
            <tr key={tid}>
              <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{tid}</td>
              <td>{String(it.type ?? "-")}</td>
              <td>
                <Badge>{statusLabel(st || "-", props.locale)}</Badge>
              </td>
              <td>{String(it.targetRef ?? it.target_ref ?? "-")}</td>
              <td>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => preflight(tid)} disabled={busy}>
                    {t(props.locale, "gov.triggers.action.preflight")}
                  </button>
                  <button onClick={() => manualFire(tid)} disabled={busy}>
                    {t(props.locale, "gov.triggers.action.fire")}
                  </button>
                  <button onClick={() => startEdit(it)} disabled={busy}>
                    {t(props.locale, "gov.triggers.action.edit")}
                  </button>
                  <button onClick={() => toggleStatus(tid, st)} disabled={busy}>
                    {st === "enabled" ? t(props.locale, "gov.triggers.action.disable") : t(props.locale, "gov.triggers.action.enable")}
                  </button>
                  <button onClick={() => loadHistory(tid)} disabled={busy}>
                    {t(props.locale, "gov.triggers.action.history")}
                  </button>
                  {st === "disabled" ? (
                    <button onClick={() => deleteTrigger(tid)} disabled={busy} style={{ color: "crimson", borderColor: "crimson" }}>
                      {t(props.locale, "gov.triggers.action.delete")}
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </Table>

      {historyId ? (
        <Card title={`${t(props.locale, "gov.triggers.history.title")} — ${historyId}`}>
          <div style={{ marginBottom: 8 }}>
            <button onClick={() => { setHistoryId(null); setHistoryData([]); }}>
              {t(props.locale, "gov.triggers.action.cancel")}
            </button>
          </div>
          <Table header={<span>{t(props.locale, "gov.triggers.history.title")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.triggers.history.col.status")}</th>
                <th align="left">{t(props.locale, "gov.triggers.history.col.scheduledAt")}</th>
                <th align="left">{t(props.locale, "gov.triggers.history.col.firedAt")}</th>
                <th align="left">{t(props.locale, "gov.triggers.history.col.matchReason")}</th>
                <th align="left">{t(props.locale, "gov.triggers.history.col.lastError")}</th>
              </tr>
            </thead>
            <tbody>
              {historyData.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
              ) : historyData.map((run: any, idx: number) => (
                <tr key={idx}>
                  <td><Badge>{statusLabel(String(run.status ?? "-"), props.locale)}</Badge></td>
                  <td>{String(run.scheduledAt ?? run.scheduled_at ?? "-")}</td>
                  <td>{String(run.firedAt ?? run.fired_at ?? "-")}</td>
                  <td>{String(run.matchReason ?? run.match_reason ?? "-")}</td>
                  <td style={{ color: run.lastError || run.last_error ? "crimson" : undefined }}>{String(run.lastError ?? run.last_error ?? "-")}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
