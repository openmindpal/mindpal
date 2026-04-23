"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StructuredData, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type SkillPackagesResponse = ApiError & { items?: any[] };
type SkillPackageUploadResponse = ApiError & { artifactId?: string; depsDigest?: string; signatureStatus?: string; scanSummary?: unknown; manifestSummary?: unknown };
type ToolPublishResponse = ApiError & { toolRef?: string; version?: any };

function guessFormat(name: string): "zip" | "tgz" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".gz")) return "tgz";
  return "zip";
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    bin += String.fromCharCode(...Array.from(part));
  }
  return btoa(bin);
}

export default function GovSkillPackagesClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<SkillPackagesResponse | null>((props.initial as SkillPackagesResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<"zip" | "tgz">("tgz");
  const [uploadStatus, setUploadStatus] = useState<number>(0);
  const [uploadResult, setUploadResult] = useState<SkillPackageUploadResponse | null>(null);

  // URL import
  const [importUrl, setImportUrl] = useState<string>("");
  const [importUrlFormat, setImportUrlFormat] = useState<"zip" | "tgz">("tgz");
  const [importUrlStatus, setImportUrlStatus] = useState<number>(0);
  const [importUrlResult, setImportUrlResult] = useState<SkillPackageUploadResponse | null>(null);

  // Git import
  const [gitRepoUrl, setGitRepoUrl] = useState<string>("");
  const [gitRef, setGitRef] = useState<string>("");
  const [gitSubdir, setGitSubdir] = useState<string>("");
  const [importGitStatus, setImportGitStatus] = useState<number>(0);
  const [importGitResult, setImportGitResult] = useState<SkillPackageUploadResponse | null>(null);

  const [pubToolName, setPubToolName] = useState<string>("utility.echo")
  const [pubArtifactId, setPubArtifactId] = useState<string>("");
  const [pubDepsDigest, setPubDepsDigest] = useState<string>("");
  const [pubStatus, setPubStatus] = useState<number>(0);
  const [pubResult, setPubResult] = useState<ToolPublishResponse | null>(null);

  const items = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);

  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = useMemo(() => items.slice(page * pageSize, (page + 1) * pageSize), [items, page]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  async function refresh() {
    setError("");
    setPage(0);
    const res = await apiFetch(`/artifacts/skill-packages?limit=50`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as SkillPackagesResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function copyText(val: string) {
    if (!val) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(val);
    } catch {}
  }

  async function upload() {
    setError("");
    setUploadResult(null);
    setUploadStatus(0);
    if (!file) {
      setError(t(props.locale, "gov.skillPackages.fileRequired"));
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const base64 = bytesToBase64(new Uint8Array(buf));
      const res = await apiFetch(`/artifacts/skill-packages/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ archiveFormat: format, archiveBase64: base64 }),
      });
      setUploadStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setUploadResult((json as SkillPackageUploadResponse) ?? null);
      const aid = String((json as any)?.artifactId ?? "");
      if (aid) setPubArtifactId(aid);
      const dd = String((json as any)?.depsDigest ?? "");
      if (dd) setPubDepsDigest(dd);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function importFromUrl() {
    setError("");
    setImportUrlResult(null);
    setImportUrlStatus(0);
    const url = importUrl.trim();
    if (!url) {
      setError(t(props.locale, "gov.skillPackages.urlRequired"));
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/artifacts/skill-packages/import-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ url, archiveFormat: importUrlFormat }),
      });
      setImportUrlStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setImportUrlResult((json as SkillPackageUploadResponse) ?? null);
      const aid = String((json as any)?.artifactId ?? "");
      if (aid) setPubArtifactId(aid);
      const dd = String((json as any)?.depsDigest ?? "");
      if (dd) setPubDepsDigest(dd);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function importFromGit() {
    setError("");
    setImportGitResult(null);
    setImportGitStatus(0);
    const repoUrl = gitRepoUrl.trim();
    if (!repoUrl) {
      setError(t(props.locale, "gov.skillPackages.repoUrlRequired"));
      return;
    }
    setBusy(true);
    try {
      const payload: any = { repoUrl };
      if (gitRef.trim()) payload.ref = gitRef.trim();
      if (gitSubdir.trim()) payload.subdir = gitSubdir.trim();
      const res = await apiFetch(`/artifacts/skill-packages/import-git`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(payload),
      });
      setImportGitStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setImportGitResult((json as SkillPackageUploadResponse) ?? null);
      const aid = String((json as any)?.artifactId ?? "");
      if (aid) setPubArtifactId(aid);
      const dd = String((json as any)?.depsDigest ?? "");
      if (dd) setPubDepsDigest(dd);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setError("");
    setPubResult(null);
    setPubStatus(0);
    const name = pubToolName.trim();
    const artifactId = pubArtifactId.trim();
    const depsDigest = pubDepsDigest.trim();
    if (!name) {
      setError(t(props.locale, "gov.skillPackages.toolNameRequired"));
      return;
    }
    if (!artifactId) {
      setError(t(props.locale, "gov.skillPackages.artifactIdRequired"));
      return;
    }
    setBusy(true);
    try {
      const payload: any = { artifactId };
      if (depsDigest) payload.depsDigest = depsDigest;
      const res = await apiFetch(`/tools/${encodeURIComponent(name)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(payload),
      });
      setPubStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPubResult((json as ToolPublishResponse) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.skillPackages.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <Card>
          <h3>{t(props.locale, "gov.skillPackages.uploadTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="file"
              accept=".zip,.tgz,.tar.gz,application/zip,application/gzip"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0] ?? null;
                setFile(f);
                if (f) setFormat(guessFormat(f.name));
              }}
              disabled={busy}
            />
            <select value={format} onChange={(e) => setFormat(e.currentTarget.value === "zip" ? "zip" : "tgz")} disabled={busy}>
              <option value="tgz">tgz</option>
              <option value="zip">zip</option>
            </select>
            <button onClick={upload} disabled={busy || !file}>
              {t(props.locale, "gov.skillPackages.upload")}
            </button>
            {uploadStatus ? <Badge>{uploadStatus}</Badge> : null}
          </div>
          {uploadResult ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span>{`artifactId=${String(uploadResult.artifactId ?? "")}`}</span>
                <button onClick={() => copyText(String(uploadResult.artifactId ?? ""))} disabled={busy}>
                  {t(props.locale, "action.copy")}
                </button>
              </div>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}><StructuredData data={uploadResult} /></pre>
            </div>
          ) : null}
        </Card>

        <Card>
          <h3>{t(props.locale, "gov.skillPackages.importUrlTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={importUrl}
              onChange={(e) => setImportUrl(e.currentTarget.value)}
              placeholder={t(props.locale, "gov.skillPackages.placeholder.url")}
              style={{ minWidth: 400 }}
              disabled={busy}
            />
            <select value={importUrlFormat} onChange={(e) => setImportUrlFormat(e.currentTarget.value === "zip" ? "zip" : "tgz")} disabled={busy}>
              <option value="tgz">tgz</option>
              <option value="zip">zip</option>
            </select>
            <button onClick={importFromUrl} disabled={busy || !importUrl.trim()}>
              {t(props.locale, "gov.skillPackages.importUrl")}
            </button>
            {importUrlStatus ? <Badge>{importUrlStatus}</Badge> : null}
          </div>
          {importUrlResult ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span>{`artifactId=${String(importUrlResult.artifactId ?? "")}`}</span>
                <button onClick={() => copyText(String(importUrlResult.artifactId ?? ""))} disabled={busy}>
                  {t(props.locale, "action.copy")}
                </button>
              </div>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}><StructuredData data={importUrlResult} /></pre>
            </div>
          ) : null}
        </Card>

        <Card>
          <h3>{t(props.locale, "gov.skillPackages.importGitTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={gitRepoUrl}
              onChange={(e) => setGitRepoUrl(e.currentTarget.value)}
              placeholder={t(props.locale, "gov.skillPackages.placeholder.repoUrl")}
              style={{ minWidth: 360 }}
              disabled={busy}
            />
            <input
              value={gitRef}
              onChange={(e) => setGitRef(e.currentTarget.value)}
              placeholder={t(props.locale, "gov.skillPackages.placeholder.ref")}
              style={{ width: 120 }}
              disabled={busy}
            />
            <input
              value={gitSubdir}
              onChange={(e) => setGitSubdir(e.currentTarget.value)}
              placeholder={t(props.locale, "gov.skillPackages.placeholder.subdir")}
              style={{ width: 140 }}
              disabled={busy}
            />
            <button onClick={importFromGit} disabled={busy || !gitRepoUrl.trim()}>
              {t(props.locale, "gov.skillPackages.importGit")}
            </button>
            {importGitStatus ? <Badge>{importGitStatus}</Badge> : null}
          </div>
          {importGitResult ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span>{`artifactId=${String(importGitResult.artifactId ?? "")}`}</span>
                <button onClick={() => copyText(String(importGitResult.artifactId ?? ""))} disabled={busy}>
                  {t(props.locale, "action.copy")}
                </button>
              </div>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}><StructuredData data={importGitResult} /></pre>
            </div>
          ) : null}
        </Card>

        <Card>
          <h3>{t(props.locale, "gov.skillPackages.publishTitle")}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input value={pubToolName} onChange={(e) => setPubToolName(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillPackages.placeholder.toolName")} disabled={busy} />
            <input value={pubArtifactId} onChange={(e) => setPubArtifactId(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillPackages.placeholder.artifactId")} disabled={busy} />
            <input value={pubDepsDigest} onChange={(e) => setPubDepsDigest(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillPackages.placeholder.depsDigest")} disabled={busy} />
            <button onClick={publish} disabled={busy}>
              {t(props.locale, "gov.skillPackages.publish")}
            </button>
            {pubStatus ? <Badge>{pubStatus}</Badge> : null}
            {pubResult?.toolRef ? (
              <a href={`/gov/tools?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.skillPackages.openGovTools")}</a>
            ) : null}
          </div>
          {pubResult ? <div style={{ marginTop: 8 }}><StructuredData data={pubResult} /></div> : null}
        </Card>

        <Card>
          <h3>{t(props.locale, "gov.skillPackages.recentTitle")}</h3>
          <Table>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.skillPackages.table.artifactId")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.type")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.format")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.createdAt")}</th>
                <th align="left">{t(props.locale, "gov.skillPackages.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : paged.map((r, idx) => {
                const aid = String(r?.artifactId ?? r?.artifact_id ?? "");
                return (
                  <tr key={`${aid || "x"}:${idx}`}>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{aid || "-"}</td>
                    <td>{String(r?.type ?? "-")}</td>
                    <td>{String(r?.format ?? "-")}</td>
                    <td>{fmtDateTime(r?.createdAt ?? r?.created_at, props.locale)}</td>
                    <td>
                      <button onClick={() => copyText(aid)} disabled={busy || !aid}>
                        {t(props.locale, "action.copy")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(Math.min((page + 1) * pageSize, items.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(items.length))}
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
