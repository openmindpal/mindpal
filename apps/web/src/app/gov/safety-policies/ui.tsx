"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, StructuredData, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";

type SafetyPolicyType = "content" | "injection" | "risk";

type PolicyRow = { policyId: string; policyType: SafetyPolicyType; name: string; createdAt: string };
type PolicyListResp = { items?: Array<{ policy: PolicyRow; activeVersion?: number | null; latest?: any | null }> } & ApiError;

type VersionsResp = { policy?: PolicyRow; versions?: Array<{ version: number; status: string; policyDigest: string; createdAt: string; publishedAt?: string | null }> } & ApiError;
type VersionResp = { version?: any } & ApiError;
type DiffResp = { summary?: any } & ApiError;

function normalizePolicyRow(value: unknown): PolicyRow | null {
  const record = toRecord(value);
  if (!record) return null;
  const policyType = stringField(record, "policyType");
  if (policyType !== "content" && policyType !== "injection" && policyType !== "risk") return null;
  return {
    policyId: toDisplayText(record.policyId),
    policyType,
    name: toDisplayText(record.name),
    createdAt: toDisplayText(record.createdAt),
  };
}

function normalizePolicyListResp(value: unknown): PolicyListResp | null {
  const record = toRecord(value);
  if (!record) return null;
  const items = Array.isArray(record.items)
    ? record.items.reduce<Array<{ policy: PolicyRow; activeVersion?: number | null; latest?: any | null }>>((acc, item) => {
        const row = toRecord(item);
        const policy = normalizePolicyRow(row?.policy);
        if (!row || !policy) return acc;
        acc.push({
          policy,
          activeVersion: row.activeVersion == null ? null : Number(row.activeVersion),
          latest: row.latest ?? null,
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
    items,
  };
}

function normalizeVersionsResp(value: unknown): VersionsResp | null {
  const record = toRecord(value);
  if (!record) return null;
  const versions = Array.isArray(record.versions)
    ? record.versions.reduce<Array<{ version: number; status: string; policyDigest: string; createdAt: string; publishedAt?: string | null }>>((acc, item) => {
        const row = toRecord(item);
        if (!row) return acc;
        acc.push({
          version: Number(row.version ?? 0),
          status: toDisplayText(row.status),
          policyDigest: toDisplayText(row.policyDigest),
          createdAt: toDisplayText(row.createdAt),
          publishedAt: row.publishedAt == null ? null : toDisplayText(row.publishedAt),
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
    policy: normalizePolicyRow(record.policy) ?? undefined,
    versions,
  };
}

function normalizeVersionResp(value: unknown): VersionResp | null {
  const record = toRecord(value);
  if (!record) return null;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    version: record.version,
  };
}

function normalizeDiffResp(value: unknown): DiffResp | null {
  const record = toRecord(value);
  if (!record) return null;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    summary: record.summary,
  };
}

export default function SafetyPoliciesClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<PolicyListResp | null>(normalizePolicyListResp(props.initial));
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [searchText, setSearchText] = useState<string>("");
  const [filterType, setFilterType] = useState<SafetyPolicyType | "">(  "");
  const [newType, setNewType] = useState<SafetyPolicyType>("content");
  const [newName, setNewName] = useState<string>("content-default");
  const [newJson, setNewJson] = useState<string>(JSON.stringify({ version: "v1", mode: "audit_only", denyTargets: ["model:invoke", "tool:execute"], denyHitTypes: ["token"] }, null, 2));

  const [selectedPolicyId, setSelectedPolicyId] = useState<string>("");
  const [versions, setVersions] = useState<VersionsResp | null>(null);
  const [versionDetail, setVersionDetail] = useState<VersionResp | null>(null);
  const [diff, setDiff] = useState<DiffResp | null>(null);
  const [diffFrom, setDiffFrom] = useState<number>(0);
  const [diffTo, setDiffTo] = useState<number>(0);
  const [overrideSpaceId, setOverrideSpaceId] = useState<string>("");
  const [overrideTarget, setOverrideTarget] = useState<{ policyId: string; version: number } | null>(null);

  const [activeChangesetId, setActiveChangesetId] = useState<string>("");
  const [changesetStatus, setChangesetStatus] = useState<string>("");
  const [changesetError, setChangesetError] = useState<string>("");

  const items = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data]);
  const filtered = useMemo(() => {
    let result = items;
    if (filterType) result = result.filter((x) => String(x?.policy?.policyType ?? "") === filterType);
    if (searchText.trim()) {
      const needle = searchText.trim().toLowerCase();
      result = result.filter((x) => (x?.policy?.name ?? "").toLowerCase().includes(needle));
    }
    return result;
  }, [filterType, searchText, items]);

  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = useMemo(() => filtered.slice(page * pageSize, (page + 1) * pageSize), [filtered, page]);

  async function refresh() {
    setError("");
    setPage(0);
    const qs = filterType ? `?policyType=${encodeURIComponent(filterType)}&limit=50` : "?limit=50";
    const res = await apiFetch(`/governance/safety-policies${qs}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData(normalizePolicyListResp(json));
    if (!res.ok) setError(errText(props.locale, (json as any) ?? { errorCode: String(res.status) }));
  }

  async function runAction(fn: () => Promise<void>) {
    setError("");
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

  async function createDraft() {
    await runAction(async () => {
      const policyJson = (() => {
        try {
          return JSON.parse(newJson);
        } catch {
          return { raw: newJson };
        }
      })();
      const res = await apiFetch(`/governance/safety-policies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ policyType: newType, name: newName.trim(), policyJson }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const policyId = String((json as any)?.version?.policyId ?? "");
      if (policyId) setSelectedPolicyId(policyId);
    });
  }

  async function loadVersions(policyId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/safety-policies/${encodeURIComponent(policyId)}/versions?limit=50`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setVersions(normalizeVersionsResp(json));
      setVersionDetail(null);
      setDiff(null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadVersion(policyId: string, version: number) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/safety-policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(String(version))}`, {
        locale: props.locale,
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setVersionDetail(normalizeVersionResp(json));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadDiff(policyId: string, from: number, to: number) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/safety-policies/${encodeURIComponent(policyId)}/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`, {
        locale: props.locale,
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setDiff(normalizeDiffResp(json));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createChangeSetWithItems(title: string, items: any[], canaryTargets?: string[]) {
    const csRes = await apiFetch(`/governance/changesets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      locale: props.locale,
      body: JSON.stringify({ title, scope: "tenant", ...(canaryTargets ? { canaryTargets } : {}) }),
    });
    const csJson: any = await csRes.json().catch(() => null);
    if (!csRes.ok) throw toApiError(csJson);
    const id = String(csJson?.changeset?.id ?? "");
    if (!id) throw toApiError({ errorCode: "ERROR", message: "missing changeset id" });
    for (const it of items) {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(id)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(it),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(j);
    }
    return id;
  }

  async function publishAndActivate(policyId: string, version: number) {
    await runAction(async () => {
      const id = await createChangeSetWithItems(`policy publish ${policyId}@${version}`, [
        { kind: "policy.publish", policyId, version },
        { kind: "policy.set_active", policyId, version },
      ]);
      setActiveChangesetId(id);
      setChangesetStatus("draft");
      setChangesetError("");
    });
  }

  async function rollbackActive(policyId: string) {
    await runAction(async () => {
      const id = await createChangeSetWithItems(`policy rollback ${policyId}`, [{ kind: "policy.rollback", policyId }]);
      setActiveChangesetId(id);
      setChangesetStatus("draft");
      setChangesetError("");
    });
  }

  async function setOverride(policyId: string, version: number, spaceId: string) {
    await runAction(async () => {
      const id = await createChangeSetWithItems(`policy override ${policyId}@${version} space=${spaceId}`, [{ kind: "policy.set_override", policyId, version, spaceId }], [spaceId]);
      setActiveChangesetId(id);
      setChangesetStatus("draft");
      setChangesetError("");
    });
  }

  async function submitChangeset() {
    setChangesetError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(activeChangesetId)}/submit`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setChangesetStatus("submitted");
    } catch (e: unknown) {
      setChangesetError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function approveChangeset() {
    setChangesetError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(activeChangesetId)}/approve`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setChangesetStatus("approved");
    } catch (e: unknown) {
      setChangesetError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function releaseChangeset() {
    setChangesetError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(activeChangesetId)}/release?mode=full`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setChangesetStatus("released");
      setActiveChangesetId("");
      await refresh();
    } catch (e: unknown) {
      setChangesetError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  function cancelChangeset() {
    setActiveChangesetId("");
    setChangesetStatus("");
    setChangesetError("");
  }

  function ChangesetPanel() {
    if (!activeChangesetId) return null;
    return (
      <div style={{ padding: 16, marginBottom: 12, border: "1px solid var(--sl-border, #e2e8f0)", borderRadius: 8, background: "var(--sl-surface-alt, #f8fafc)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <strong>变更集操作</strong>
          <Badge>{changesetStatus || "draft"}</Badge>
          <span style={{ fontSize: 12, color: "var(--sl-muted, #64748b)", fontFamily: "monospace" }}>{activeChangesetId.slice(0, 8)}</span>
        </div>
        {changesetError && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginBottom: 8 }}>{changesetError}</pre>}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--sl-muted, #64748b)" }}>draft → submitted → approved → released</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={submitChangeset} disabled={busy || changesetStatus !== "draft"}>
            提交审批
          </button>
          <button onClick={approveChangeset} disabled={busy || changesetStatus !== "submitted"}>
            审批通过
          </button>
          <button onClick={releaseChangeset} disabled={busy || changesetStatus !== "approved"}>
            发布生效
          </button>
          <button onClick={cancelChangeset} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    );
  }

  const initialError = useMemo(() => (status >= 400 ? errText(props.locale, data) : ""), [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.safetyPolicies.title")}
        helpHref={getHelpHref("/gov/safety-policies", props.locale) ?? undefined}
        description={<StatusBadge locale={props.locale} status={status} />}
        actions={
          <>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <Link href={`/gov/changesets?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.safetyPolicies.changesets")}</Link>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.safetyPolicies.createDraftTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 900 }}>
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8, alignItems: "center" }}>
              <div>{t(props.locale, "gov.safetyPolicies.policyType")}</div>
              <select value={newType} onChange={(e) => setNewType(e.target.value as SafetyPolicyType)} disabled={busy}>
                <option value="content">{t(props.locale, "gov.safetyPolicies.type.content")}</option>
                <option value="injection">{t(props.locale, "gov.safetyPolicies.type.injection")}</option>
                <option value="risk">{t(props.locale, "gov.safetyPolicies.type.risk")}</option>
              </select>
              <div>{t(props.locale, "gov.safetyPolicies.name")}</div>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy} />
            </div>
            <div>{t(props.locale, "gov.safetyPolicies.policyJson")}</div>
            <textarea value={newJson} onChange={(e) => setNewJson(e.target.value)} rows={10} disabled={busy} />
            <button onClick={createDraft} disabled={busy || !newName.trim()}>
              {t(props.locale, "gov.safetyPolicies.createDraftButton")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.safetyPolicies.policiesTitle")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span>{t(props.locale, "gov.safetyPolicies.filter")}</span>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value as any)} disabled={busy}>
              <option value="">{t(props.locale, "gov.safetyPolicies.all")}</option>
              <option value="content">{t(props.locale, "gov.safetyPolicies.type.content")}</option>
              <option value="injection">{t(props.locale, "gov.safetyPolicies.type.injection")}</option>
              <option value="risk">{t(props.locale, "gov.safetyPolicies.type.risk")}</option>
            </select>
            <input
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); setPage(0); }}
              placeholder="搜索策略名称..."
              disabled={busy}
              style={{ width: 200 }}
            />
          </div>
          <Table header={<span>{t(props.locale, "gov.safetyPolicies.items")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.policyId")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.type")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.name")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.active")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.latest")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {paged.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
              ) : paged.map((x) => (
                <tr key={toDisplayText(x?.policy?.policyId)}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{toDisplayText(x?.policy?.policyId)}</td>
                  <td>
                    <Badge>{toDisplayText(x?.policy?.policyType)}</Badge>
                  </td>
                  <td>{toDisplayText(x?.policy?.name)}</td>
                  <td>{x?.activeVersion ?? "-"}</td>
                  <td>{toDisplayText(toRecord(x?.latest)?.version ?? "-")}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() => {
                        const pid = toDisplayText(x?.policy?.policyId);
                        setSelectedPolicyId(pid);
                        loadVersions(pid);
                      }}
                    >
                      {t(props.locale, "gov.safetyPolicies.versions")}
                    </button>
                  </td>
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

      {selectedPolicyId && versions?.versions ? (
        <div style={{ marginTop: 16 }}>
          <Card title={`${t(props.locale, "gov.safetyPolicies.policyTitle")} ${selectedPolicyId}`}>
            <div style={{ display: "grid", gap: 12 }}>
              <ChangesetPanel />
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <button onClick={() => loadVersions(selectedPolicyId)} disabled={busy}>
                  {t(props.locale, "gov.safetyPolicies.reloadVersions")}
                </button>
                <button onClick={() => rollbackActive(selectedPolicyId)} disabled={busy}>
                  {t(props.locale, "gov.safetyPolicies.rollbackActive")}
                </button>
              </div>

              <Table header={<span>{t(props.locale, "gov.safetyPolicies.versionsHeader")}</span>}>
                <thead>
                  <tr>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.version")}</th>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.status")}</th>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.digest")}</th>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.versions!.map((v) => (
                    <tr key={String(v.version)}>
                      <td>{v.version}</td>
                      <td>
                        <Badge>{statusLabel(v.status, props.locale)}</Badge>
                      </td>
                      <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{v.policyDigest.slice(0, 12)}</td>
                      <td style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => loadVersion(selectedPolicyId, v.version)} disabled={busy}>
                          {t(props.locale, "gov.safetyPolicies.view")}
                        </button>
                        <button onClick={() => publishAndActivate(selectedPolicyId, v.version)} disabled={busy || v.status === "released"}>
                          {t(props.locale, "gov.safetyPolicies.publishActivate")}
                        </button>
                        <button
                          onClick={() => {
                            setOverrideTarget({ policyId: selectedPolicyId, version: v.version });
                            setOverrideSpaceId("");
                          }}
                          disabled={busy || v.status !== "released"}
                        >
                          {t(props.locale, "gov.safetyPolicies.setOverride")}
                        </button>
                        <button
                          onClick={() => {
                            if (!diffFrom) setDiffFrom(v.version);
                            else setDiffTo(v.version);
                          }}
                          disabled={busy}
                        >
                          {t(props.locale, "gov.safetyPolicies.pickDiff")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>

              {overrideTarget ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0", background: "rgba(15,23,42,0.03)", borderRadius: 6, paddingInline: 12, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.safetyPolicies.overrideLabel")}</span>
                  <input
                    value={overrideSpaceId}
                    onChange={(e) => setOverrideSpaceId(e.target.value)}
                    placeholder={t(props.locale, "gov.safetyPolicies.overridePlaceholder")}
                    style={{ width: 220 }}
                    disabled={busy}
                  />
                  <button
                    disabled={busy || !overrideSpaceId.trim()}
                    onClick={() => {
                      if (overrideTarget && overrideSpaceId.trim()) {
                        setOverride(overrideTarget.policyId, overrideTarget.version, overrideSpaceId.trim());
                        setOverrideTarget(null);
                        setOverrideSpaceId("");
                      }
                    }}
                  >
                    {t(props.locale, "gov.safetyPolicies.overrideConfirm")}
                  </button>
                  <button onClick={() => setOverrideTarget(null)} disabled={busy}>
                    {t(props.locale, "action.cancel")}
                  </button>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span>{t(props.locale, "gov.safetyPolicies.diff")}</span>
                <input style={{ width: 80 }} value={diffFrom || ""} onChange={(e) => setDiffFrom(Number(e.target.value) || 0)} />
                <input style={{ width: 80 }} value={diffTo || ""} onChange={(e) => setDiffTo(Number(e.target.value) || 0)} />
                <button disabled={busy || !diffFrom || !diffTo} onClick={() => loadDiff(selectedPolicyId, diffFrom, diffTo)}>
                  {t(props.locale, "gov.safetyPolicies.diff")}
                </button>
              </div>

              {diff ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>版本对比结果</div>
                  {(() => {
                    const summary = (diff as any)?.summary;
                    const fields = Array.isArray(summary?.fields) ? summary.fields : [];
                    if (!summary?.changed) {
                      return <div style={{ color: "var(--sl-muted, #64748b)", fontStyle: "italic" }}>两个版本内容完全相同</div>;
                    }
                    if (fields.length === 0) {
                      return <div style={{ color: "var(--sl-muted, #64748b)" }}>内容有变化（大小: {summary.aSize} → {summary.bSize} 字节），但无法解析字段级差异</div>;
                    }
                    return (
                      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                        {fields.map((f: any, i: number) => (
                          <div
                            key={i}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 4,
                              background: f.type === "added" ? "rgba(34,197,94,0.08)" : f.type === "removed" ? "rgba(239,68,68,0.08)" : "rgba(234,179,8,0.08)",
                              borderLeft: `3px solid ${f.type === "added" ? "#22c55e" : f.type === "removed" ? "#ef4444" : "#eab308"}`,
                            }}
                          >
                            <span style={{ fontWeight: 600, fontFamily: "monospace" }}>{f.key}</span>
                            <span style={{ marginLeft: 8, fontSize: 11, color: f.type === "added" ? "#16a34a" : f.type === "removed" ? "#dc2626" : "#ca8a04" }}>
                              {f.type === "added" ? "[新增]" : f.type === "removed" ? "[删除]" : "[修改]"}
                            </span>
                            {f.type === "changed" && (
                              <div style={{ marginTop: 4, fontSize: 12, fontFamily: "monospace" }}>
                                <span style={{ color: "#dc2626", textDecoration: "line-through" }}>{JSON.stringify(f.from)}</span>
                                <span style={{ margin: "0 6px" }}>→</span>
                                <span style={{ color: "#16a34a" }}>{JSON.stringify(f.to)}</span>
                              </div>
                            )}
                            {f.type === "added" && (
                              <div style={{ marginTop: 4, fontSize: 12, fontFamily: "monospace", color: "#16a34a" }}>{JSON.stringify(f.to)}</div>
                            )}
                            {f.type === "removed" && (
                              <div style={{ marginTop: 4, fontSize: 12, fontFamily: "monospace", color: "#dc2626", textDecoration: "line-through" }}>{JSON.stringify(f.from)}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              ) : null}
              {versionDetail ? <StructuredData data={versionDetail} /> : null}
            </div>
          </Card>
        </div>
      ) : null}

      {activeChangesetId && !selectedPolicyId && (
        <div style={{ marginTop: 16 }}>
          <Card title="变更集操作">
            <ChangesetPanel />
          </Card>
        </div>
      )}
    </div>
  );
}
