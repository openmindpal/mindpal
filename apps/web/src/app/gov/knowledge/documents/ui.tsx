"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StructuredData, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";

type DocRow = { id: string; title: string; sourceType: string; version: number; status: string; contentDigest: string; tags: unknown; createdAt: string; updatedAt: string };
type DocsResp = ApiError & { documents?: DocRow[]; total?: number };

type InitialData = { status: number; json: unknown };

function normalizeDocsResp(value: unknown): DocsResp | null {
  const record = toRecord(value);
  if (!record) return null;
  const documents = Array.isArray(record.documents)
    ? record.documents.reduce<DocRow[]>((acc, item) => {
        const row = toRecord(item);
        if (!row) return acc;
        acc.push({
          id: toDisplayText(row.id),
          title: toDisplayText(row.title),
          sourceType: toDisplayText(row.sourceType),
          version: Number(row.version ?? 0),
          status: toDisplayText(row.status),
          contentDigest: toDisplayText(row.contentDigest),
          tags: row.tags ?? null,
          createdAt: toDisplayText(row.createdAt),
          updatedAt: toDisplayText(row.updatedAt),
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
    total: numberField(record, "total"),
    documents,
  };
}

export default function KnowledgeDocumentsClient(props: { locale: string; initial?: InitialData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [httpStatus, setHttpStatus] = useState<number>(props.initial?.status ?? 0);
  const [data, setData] = useState<DocsResp | null>(normalizeDocsResp(props.initial?.json));
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [limit, setLimit] = useState("50");
  const [offset, setOffset] = useState("0");

  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createSourceType, setCreateSourceType] = useState("manual");
  const [createContent, setCreateContent] = useState("");
  const [createVisibility, setCreateVisibility] = useState<"space" | "subject">("space");
  const [creating, setCreating] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const [filePreview, setFilePreview] = useState("");

  const [fetchUrl, setFetchUrl] = useState("");
  const [fetching, setFetching] = useState(false);

  const [deleting, setDeleting] = useState("");

  const rows = useMemo(() => (Array.isArray(data?.documents) ? data!.documents! : []), [data]);
  const total = Number(data?.total ?? rows.length);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      const nLimit = Number(limit);
      const nOffset = Number(offset);
      if (Number.isFinite(nLimit) && nLimit > 0) q.set("limit", String(nLimit));
      if (Number.isFinite(nOffset) && nOffset >= 0) q.set("offset", String(nOffset));
      if (statusFilter.trim()) q.set("status", statusFilter.trim());
      if (searchText.trim()) q.set("search", searchText.trim());
      const res = await apiFetch(`/governance/knowledge/documents?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData(normalizeDocsResp(json));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCreateTitle(file.name.replace(/\.[^.]+$/, ""));
    setUploadFile(file);
    // 纯文本文件可直接预览和编辑
    const isTextFile = /\.(txt|md|csv|json|xml|html|yaml|yml|log|ini|conf|toml)$/i.test(file.name);
    if (isTextFile) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? "");
        setCreateContent(text);
        setFilePreview(
          text.length > 2000
            ? `${text.slice(0, 2000)}\n${t(props.locale, "gov.knowledgeDocs.previewTruncated")}`
            : text,
        );
      };
      reader.onerror = () => {
        setError(t(props.locale, "gov.knowledgeDocs.fileReadError"));
      };
      reader.readAsText(file);
    } else {
      setCreateContent("");
      setFilePreview(
        `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${file.type || t(props.locale, "gov.knowledgeDocs.unknownType")})\n${t(props.locale, "gov.knowledgeDocs.binaryPreviewHint")}`,
      );
    }
  }

  async function handleFetchUrl() {
    if (!fetchUrl.trim()) return;
    setFetching(true);
    setError("");
    try {
      const res = await apiFetch("/knowledge/fetch-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ url: fetchUrl.trim() }),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) throw toApiError(json);
      setCreateContent(String(json?.content ?? ""));
      if (json?.title) setCreateTitle(String(json.title));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setFetching(false);
    }
  }

  function handleSourceTypeChange(v: string) {
    setCreateSourceType(v);
    setCreateContent("");
    setCreateTitle("");
    setFilePreview("");
    setFetchUrl("");
  }

  async function handleCreate() {
    if (!createTitle.trim()) return;
    // 二进制文件上传走 /knowledge/documents/upload 接口 (base64 JSON)
    if (uploadFile && !createContent.trim()) {
      setCreating(true);
      setError("");
      try {
        const base64 = await readFileAsBase64(uploadFile);
        const res = await apiFetch("/knowledge/documents/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale: props.locale,
          body: JSON.stringify({
            title: createTitle,
            sourceType: "file",
            visibility: createVisibility,
            fileName: uploadFile.name,
            mimeType: uploadFile.type || "application/octet-stream",
            fileBase64: base64,
          }),
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) throw toApiError(json);
        setShowCreate(false);
        setCreateTitle("");
        setCreateContent("");
        setFilePreview("");
        setUploadFile(null);
        setFetchUrl("");
        await refresh();
      } catch (e: unknown) {
        setError(errText(props.locale, toApiError(e)));
      } finally {
        setCreating(false);
      }
      return;
    }
    // 纯文本内容走原有接口
    if (!createContent.trim()) return;
    setCreating(true);
    setError("");
    try {
      const res = await apiFetch("/knowledge/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ title: createTitle, sourceType: createSourceType, contentText: createContent, visibility: createVisibility }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setShowCreate(false);
      setCreateTitle("");
      setCreateContent("");
      setFilePreview("");
      setUploadFile(null);
      setFetchUrl("");
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    setError("");
    try {
      const res = await apiFetch(`/knowledge/documents/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: "{}",
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setDeleting("");
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.knowledgeDocs")}
        helpHref={getHelpHref("/gov/knowledge", props.locale) ?? undefined}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{httpStatus || "-"}</Badge>
            <button disabled={busy} onClick={refresh}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
            <button onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? t(props.locale, "gov.knowledgeDocs.hideCreate") : t(props.locale, "gov.knowledgeDocs.createDoc")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      {showCreate && (
        <Card title={t(props.locale, "gov.knowledgeDocs.createDoc")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 640 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ minWidth: 72 }}>{t(props.locale, "gov.knowledgeDocs.sourceType")}</span>
              <select value={createSourceType} onChange={(e) => handleSourceTypeChange(e.target.value)}>
                <option value="manual">{t(props.locale, "gov.knowledgeDocs.sourceManual")}</option>
                <option value="file">{t(props.locale, "gov.knowledgeDocs.sourceFile")}</option>
                <option value="api">{t(props.locale, "gov.knowledgeDocs.sourceApi")}</option>
                <option value="connector">{t(props.locale, "gov.knowledgeDocs.sourceConnector")}</option>
              </select>
            </label>

            {createSourceType === "connector" && (
              <div style={{ padding: "16px 12px", background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 6 }}>
                <span style={{ fontWeight: 500 }}>{t(props.locale, "gov.knowledgeDocs.connectorWip")}</span>
                <p style={{ margin: "6px 0 0", fontSize: 13, color: "#666" }}>{t(props.locale, "gov.knowledgeDocs.connectorHint")}</p>
              </div>
            )}

            {createSourceType === "file" && (
              <>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ minWidth: 72 }}>{t(props.locale, "gov.knowledgeDocs.selectFile")}</span>
                  <input type="file" accept=".txt,.md,.csv,.json,.xml,.html,.yaml,.yml,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.ppt,.rtf" onChange={handleFileSelect} style={{ flex: 1 }} />
                </label>
                {filePreview && (
                  <div style={{ border: "1px solid #d9d9d9", borderRadius: 4, padding: 8, maxHeight: 200, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", background: "#fafafa" }}>
                    <div style={{ fontWeight: 500, marginBottom: 4, color: "#888" }}>{t(props.locale, "gov.knowledgeDocs.filePreview")}</div>
                    {filePreview}
                  </div>
                )}
              </>
            )}

            {createSourceType === "api" && (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ minWidth: 72 }}>URL</span>
                <input value={fetchUrl} onChange={(e) => setFetchUrl(e.target.value)} style={{ flex: 1 }} placeholder={t(props.locale, "gov.knowledgeDocs.urlPlaceholder")} />
                <button disabled={fetching || !fetchUrl.trim()} onClick={handleFetchUrl}>
                  {fetching ? t(props.locale, "action.loading") : t(props.locale, "gov.knowledgeDocs.fetchBtn")}
                </button>
              </div>
            )}

            {createSourceType !== "connector" && (
              <>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ minWidth: 72 }}>{t(props.locale, "gov.knowledgeDocs.title")}</span>
                  <input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} style={{ flex: 1 }} placeholder={t(props.locale, "gov.knowledgeDocs.titlePlaceholder")} />
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ minWidth: 72 }}>{t(props.locale, "gov.knowledgeDocs.visibility")}</span>
                  <select value={createVisibility} onChange={(e) => setCreateVisibility(e.target.value as "space" | "subject")}>
                    <option value="space">{t(props.locale, "gov.knowledgeDocs.visSpace")}</option>
                    <option value="subject">{t(props.locale, "gov.knowledgeDocs.visSubject")}</option>
                  </select>
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <span style={{ minWidth: 72, paddingTop: 4 }}>{t(props.locale, "gov.knowledgeDocs.content")}</span>
                  <textarea value={createContent} onChange={(e) => setCreateContent(e.target.value)} rows={8} style={{ flex: 1 }} placeholder={
                    createSourceType === "api" ? t(props.locale, "gov.knowledgeDocs.contentAfterFetch")
                    : createSourceType === "file" ? t(props.locale, "gov.knowledgeDocs.contentAfterFile")
                    : t(props.locale, "gov.knowledgeDocs.contentPlaceholder")
                  } />
                </label>
                <div>
                  <button disabled={creating || !createTitle.trim() || (!createContent.trim() && !uploadFile)} onClick={handleCreate}>
                    {creating ? t(props.locale, "action.loading") : t(props.locale, "gov.knowledgeDocs.submit")}
                  </button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      <Card title={t(props.locale, "gov.changesets.filterTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeDocs.search")}</span>
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{ width: 180 }} placeholder={t(props.locale, "gov.knowledgeDocs.searchPlaceholder")} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeDocs.statusFilter")}</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t(props.locale, "gov.knowledgeDocs.allStatus")}</option>
              <option value="active">active</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.limit")}</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.offset")}</span>
            <input value={offset} onChange={(e) => setOffset(e.target.value)} style={{ width: 90 }} />
          </label>
          <button disabled={busy} onClick={refresh}>{t(props.locale, "action.apply")}</button>
        </div>
      </Card>

      <Card title={`${t(props.locale, "gov.knowledgeDocs.listTitle")} (${total})`}>
        <Table header={<span>{rows.length ? `${rows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeDocs.col.title")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeDocs.col.sourceType")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeDocs.col.version")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeDocs.col.status")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeDocs.col.updatedAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeDocs.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : rows.map((r, idx) => {
              const id = r.id || String(idx);
              return (
                <tr key={id}>
                  <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.title}>
                    {r.title || "-"}
                  </td>
                  <td>{r.sourceType || "-"}</td>
                  <td>{toDisplayText(r.version ?? "-")}</td>
                  <td>
                    <Badge>{statusLabel(r.status || "-", props.locale)}</Badge>
                  </td>
                  <td>{fmtDateTime(r.updatedAt, props.locale)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <details>
                        <summary style={{ cursor: "pointer" }}>{t(props.locale, "gov.knowledgeDocs.detail")}</summary>
                        <StructuredData data={r} />
                      </details>
                      <button
                        disabled={deleting === id}
                        onClick={() => { if (confirm(t(props.locale, "gov.knowledgeDocs.confirmDelete"))) handleDelete(id); }}
                        style={{ color: "crimson" }}
                      >
                        {deleting === id ? t(props.locale, "action.loading") : t(props.locale, "gov.knowledgeDocs.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // strip data:mime;base64, prefix
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
