"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, Table, StatusBadge, getHelpHref, AlertBanner, friendlyError } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";
import { useFormState } from "@/hooks/useFormState";

type SchemaRow = { name: string; version: string; publishedAt: string };
type SchemasResp = { schemas?: SchemaRow[] } & ApiError;

const SCHEMA_NAME_RE = /^[a-z][a-z0-9-]*$/;
const ENTITY_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function normalizeSchemasResp(value: unknown): SchemasResp | null {
  const record = toRecord(value);
  if (!record) return null;
  const schemas = Array.isArray(record.schemas)
    ? record.schemas.reduce<SchemaRow[]>((acc, item) => {
        const row = toRecord(item);
        if (!row) return acc;
        acc.push({
          name: toDisplayText(row.name),
          version: toDisplayText(row.version),
          publishedAt: toDisplayText(row.publishedAt),
        });
        return acc;
      }, [])
    : undefined;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    schemas,
  };
}

export default function SchemasClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<SchemasResp | null>(normalizeSchemasResp(props.initial));
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [q, setQ] = useState<string>("");

  const [showCreate, setShowCreate] = useState(false);
  const createForm = useFormState({
    initial: { cName: "", cDisplayName: "", cEntityName: "", cEntityDisplayName: "" },
  });
  const busy = createForm.busy;
  const cName = createForm.fields.cName;
  const cDisplayName = createForm.fields.cDisplayName;
  const cEntityName = createForm.fields.cEntityName;
  const cEntityDisplayName = createForm.fields.cEntityDisplayName;
  const cError = createForm.errors._form ?? "";

  /** Build minimal schema definition object without forcing any built-in entity/field preset */
  const buildSchemaDef = useCallback(() => {
    const name = cName.trim();
    const entityName = cEntityName.trim();
    const displayName = cDisplayName.trim() || name;
    const entityDisplayName = cEntityDisplayName.trim() || entityName;

    const entities = entityName
      ? {
          [entityName]: {
            displayName: { "zh-CN": entityDisplayName, "en-US": entityDisplayName },
            fields: {},
          },
        }
      : {};

    return {
      name,
      displayName: { "zh-CN": displayName, "en-US": displayName },
      entities,
    };
  }, [cDisplayName, cEntityDisplayName, cEntityName, cName]);

  const schemas = useMemo(() => (Array.isArray(data?.schemas) ? data.schemas : []), [data]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return schemas;
    return schemas.filter((x) => String(x?.name ?? "").toLowerCase().includes(s));
  }, [q, schemas]);

  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = useMemo(() => filtered.slice(page * pageSize, (page + 1) * pageSize), [filtered, page]);

  // Reset to first page when filter changes
  const handleSearch = (value: string) => {
    setQ(value);
    setPage(0);
  };

  async function refresh() {
    setError("");
    await createForm.runAction(async () => {
      const res = await apiFetch(`/schemas`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setData(normalizeSchemasResp(json));
      if (!res.ok) setError(errText(props.locale, (json as any) ?? { errorCode: String(res.status) }));
    });
  }

  const handleCreate = useCallback(async () => {
    createForm.clearErrors();
    const name = cName.trim();
    const entityName = cEntityName.trim();
    if (!name) { createForm.setError("_form", t(props.locale, "gov.schemas.createNameRequired")); return; }
    if (!SCHEMA_NAME_RE.test(name)) { createForm.setError("_form", t(props.locale, "gov.schemas.createNameInvalid")); return; }
    if (entityName && !ENTITY_NAME_RE.test(entityName)) { createForm.setError("_form", t(props.locale, "gov.schemas.createEntityInvalid")); return; }

    const schemaDef = buildSchemaDef();

    await createForm.runAction(async () => {
      const csRes = await apiFetch(`/governance/changesets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ title: `Create Schema: ${name}`, scope: "tenant" }),
      });
      const csJson: any = await csRes.json().catch(() => null);
      if (!csRes.ok) throw toApiError(csJson);
      const csId = String(csJson?.changeset?.id ?? "");

      const itemRes = await apiFetch(`/governance/changesets/${encodeURIComponent(csId)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ kind: "schema.publish", name, schemaDef }),
      });
      const itemJson = await itemRes.json().catch(() => null);
      if (!itemRes.ok) throw toApiError(itemJson);

      window.location.href = `/gov/changesets/${encodeURIComponent(csId)}?lang=${encodeURIComponent(props.locale)}`;
    });
  }, [buildSchemaDef, cName, cEntityName, props.locale, createForm]);

  const initialError = useMemo(() => (status >= 400 ? errText(props.locale, data) : ""), [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.schemas.title")}
        helpHref={getHelpHref("/gov/schemas", props.locale) ?? undefined}
        description={<StatusBadge locale={props.locale} status={status} />}
        actions={
          <>
            <button
              onClick={() => { setShowCreate(true); createForm.clearErrors(); createForm.reset(); }}
              disabled={busy}
              style={{ fontWeight: 600 }}
            >
              {t(props.locale, "gov.schemas.createButton")}
            </button>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <Link href={`/gov/changesets?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.schemas.changesets")}</Link>
          </>
        }
      />

      {error ? (() => { const fe = friendlyError(error, props.locale); return <AlertBanner severity="error" locale={props.locale} technical={error} recovery={fe.recovery}>{fe.message}</AlertBanner>; })() : null}
      {!error && initialError ? (() => { const fe = friendlyError(initialError, props.locale); return <AlertBanner severity="warning" locale={props.locale} technical={initialError} recovery={fe.recovery}>{fe.message}</AlertBanner>; })() : null}

      {showCreate && (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.schemas.createTitle")}>
            <div style={{ display: "grid", gap: 12, maxWidth: 480 }}>
              {cError ? (() => { const fe = friendlyError(cError, props.locale); return <AlertBanner severity="error" locale={props.locale} technical={cError} recovery={fe.recovery}>{fe.message}</AlertBanner>; })() : null}

              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.schemas.createNameLabel")}</span>
                <input
                  value={cName}
                  onChange={(e) => createForm.setField("cName", e.target.value)}
                  placeholder={t(props.locale, "gov.schemas.createNamePlaceholder")}
                  disabled={busy}
                />
                <span style={{ fontSize: 12, opacity: 0.6 }}>{t(props.locale, "gov.schemas.createNameHint")}</span>
              </label>

              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.schemas.createDisplayNameLabel")}</span>
                <input
                  value={cDisplayName}
                  onChange={(e) => createForm.setField("cDisplayName", e.target.value)}
                  placeholder={t(props.locale, "gov.schemas.createDisplayNamePlaceholder")}
                  disabled={busy}
                />
              </label>

              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.schemas.createEntityLabel")}</span>
                <input
                  value={cEntityName}
                  onChange={(e) => createForm.setField("cEntityName", e.target.value)}
                  placeholder={t(props.locale, "gov.schemas.createEntityPlaceholder")}
                  disabled={busy}
                />
                <span style={{ fontSize: 12, opacity: 0.6 }}>{t(props.locale, "gov.schemas.createEntityHint")}</span>
              </label>

              {cEntityName.trim() ? (
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.schemas.createEntityDisplayNameLabel")}</span>
                  <input
                    value={cEntityDisplayName}
                    onChange={(e) => createForm.setField("cEntityDisplayName", e.target.value)}
                    placeholder={t(props.locale, "gov.schemas.createEntityDisplayNamePlaceholder")}
                    disabled={busy}
                  />
                </label>
              ) : null}

              <div style={{ padding: 12, borderRadius: 6, background: "var(--sl-surface-soft)", border: "1px solid var(--sl-border)", marginTop: 8 }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--sl-muted)" }}>
                  💡 <strong>{t(props.locale, "gov.schemas.createTipLabel")}</strong>
                  {t(props.locale, "gov.schemas.createTipBody")}
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={handleCreate} disabled={busy} style={{ fontWeight: 600 }}>
                  {t(props.locale, "gov.schemas.createSubmit")}
                </button>
                <button onClick={() => setShowCreate(false)} disabled={busy}>
                  {t(props.locale, "gov.schemas.createCancel")}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.searchTitle")}>
          <input value={q} onChange={(e) => handleSearch(e.target.value)} placeholder={t(props.locale, "gov.schemas.searchPlaceholder")} />
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.latestTitle")}>
          <Table header={<span>{t(props.locale, "gov.schemas.schemasHeader")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.schemas.table.name")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.version")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.publishedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {paged.length === 0 ? (
                <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
              ) : paged.map((s) => (
                <tr key={s.name}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    <Link href={`/gov/schemas/${encodeURIComponent(s.name)}?lang=${encodeURIComponent(props.locale)}`}>{s.name}</Link>
                  </td>
                  <td>{s.version || "-"}</td>
                  <td>{s.publishedAt || "-"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(Math.min((page + 1) * pageSize, filtered.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(filtered.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(page + 1))}</span>
                <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
