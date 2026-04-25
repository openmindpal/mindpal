"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api"
import { fmtDateTime } from "@/lib/fmtDateTime";
import { t } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type AttachmentMeta = {
  id: string;
  mediaId: string;
  mediaType: string;
  caption: string | null;
};

type MemoryEntry = {
  id: string;
  scope: string;
  type: string;
  title: string | null;
  contentText?: string;
  createdAt: string;
  updatedAt?: string;
  attachments?: AttachmentMeta[];
};

type ListResp = { entries?: MemoryEntry[] } & ApiError;

/* ─── Edit modal (inline) ─── */

function EditDialog(props: {
  entry: MemoryEntry;
  locale: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(props.entry.title ?? "");
  const [content, setContent] = useState(props.entry.contentText ?? "");
  const [type, setType] = useState(props.entry.type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      if (title !== (props.entry.title ?? "")) body.title = title || null;
      if (content !== (props.entry.contentText ?? "")) body.contentText = content;
      if (type !== props.entry.type) body.type = type;
      if (!Object.keys(body).length) { props.onClose(); return; }
      const res = await apiFetch(`/memory/entries/${encodeURIComponent(props.entry.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        locale: props.locale,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(errText(props.locale, j as ApiError));
        return;
      }
      props.onSaved();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div style={{ background: "var(--sl-surface-raised, #1e293b)", borderRadius: 12, padding: 24, width: "min(560px, 90vw)", maxHeight: "80vh", overflow: "auto", border: "1px solid var(--sl-border)" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>{t(props.locale, "memory.editTitle")}</h3>
        {error && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", fontSize: 12, marginBottom: 8 }}>{error}</pre>}
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "memory.field.type")}</span>
          <input value={type} onChange={(e) => setType(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "memory.field.title")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} placeholder={t(props.locale, "memory.field.titlePlaceholder")} />
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "memory.field.content")}</span>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} style={{ ...inputStyle, minHeight: 120, resize: "vertical" }} />
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onClose} style={btnSecondary} disabled={saving}>{t(props.locale, "memory.action.cancel")}</button>
          <button onClick={handleSave} style={btnPrimary} disabled={saving}>{saving ? t(props.locale, "memory.action.saving") : t(props.locale, "memory.action.save")}</button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", marginTop: 4, padding: "6px 10px",
  borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-bg)",
  color: "var(--sl-fg)", fontSize: 13, fontFamily: "inherit",
};

const btnPrimary: React.CSSProperties = {
  padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer",
  background: "var(--sl-accent, #818cf8)", color: "#fff", fontSize: 13, fontWeight: 500,
};

const btnSecondary: React.CSSProperties = {
  padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", cursor: "pointer",
  background: "transparent", color: "var(--sl-fg)", fontSize: 13,
};

/* ─── Main component ─── */

export default function MemoryManagerClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ListResp | null>((props.initial as ListResp) ?? null);
  const [status, setStatus] = useState(props.initialStatus);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null);
  const [editEntry, setEditEntry] = useState<MemoryEntry | null>(null);
  const [detailEntry, setDetailEntry] = useState<MemoryEntry | null>(null);
  const pageSize = 20;

  const items = useMemo(() => searchResults ?? (Array.isArray(data?.entries) ? data!.entries! : []), [data, searchResults]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  const refresh = useCallback(async () => {
    setError("");
    setSearchResults(null);
    setSearchQuery("");
    const q = new URLSearchParams();
    q.set("limit", String(pageSize));
    q.set("offset", String(page * pageSize));
    const res = await apiFetch(`/memory/entries?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ListResp) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [page, props.locale]);

  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- skip initial render, mark as initialized
      setInitialized(true); return;
    }
    refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function handleSearch() {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch("/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery.trim(), limit: 20 }),
        locale: props.locale,
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) { setError(errText(props.locale, json)); return; }
      setSearchResults((json?.evidence ?? []).map((e: any) => ({ id: e.id, scope: e.scope, type: e.type, title: e.title, contentText: e.snippet, createdAt: e.createdAt })));
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t(props.locale, "memory.deleteConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch(`/memory/entries/${encodeURIComponent(id)}`, { method: "DELETE", locale: props.locale });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(errText(props.locale, j as ApiError));
      }
      await refresh();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch("/memory/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5000 }),
        locale: props.locale,
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) { setError(errText(props.locale, json)); return; }
      const blob = new Blob([JSON.stringify(json.entries ?? [], null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memory-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(entry: MemoryEntry): Promise<MemoryEntry | null> {
    const res = await apiFetch(`/memory/entries/${encodeURIComponent(entry.id)}`, { locale: props.locale, cache: "no-store" });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) { setError(errText(props.locale, json)); return null; }
    return { ...(json.entry ?? entry), attachments: json.attachments ?? [] };
  }

  async function handleEdit(entry: MemoryEntry) {
    setBusy(true);
    try {
      const full = await loadDetail(entry);
      if (full) setEditEntry(full);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function handleViewDetail(entry: MemoryEntry) {
    setBusy(true);
    try {
      const full = await loadDetail(entry);
      if (full) setDetailEntry(full);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }


  return (
    <div>
      <PageHeader
        title={t(props.locale, "memory.title")}
        description={t(props.locale, "memory.description")}
        actions={
          <button style={btnPrimary} onClick={handleExport} disabled={busy}>
            {busy ? t(props.locale, "memory.exporting") : t(props.locale, "memory.exportJson")}
          </button>
        }
      />

      {(error || initialError) && (
        <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: "8px 0", fontSize: 12 }}>
          {error || initialError}
        </pre>
      )}

      {/* Search bar */}
      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
          placeholder={t(props.locale, "memory.searchPlaceholder")}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button style={btnPrimary} onClick={handleSearch} disabled={busy}>{t(props.locale, "memory.search")}</button>
        {searchResults && (
          <button style={btnSecondary} onClick={() => { setSearchResults(null); setSearchQuery(""); }}>{t(props.locale, "memory.clearSearch")}</button>
        )}
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <th>{t(props.locale, "memory.field.type")}</th>
              <th>{t(props.locale, "memory.field.scope")}</th>
              <th>{t(props.locale, "memory.field.title")}</th>
              <th>{t(props.locale, "memory.field.attachments")}</th>
              <th>{t(props.locale, "memory.field.createdAt")}</th>
              <th>{t(props.locale, "memory.field.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: "center", padding: 24, color: "var(--sl-muted)" }}>{t(props.locale, "memory.empty")}</td></tr>
            )}
            {items.map((entry) => (
              <tr key={entry.id}>
                <td><Badge>{entry.type}</Badge></td>
                <td><Badge>{entry.scope}</Badge></td>
                <td>{entry.title || "—"}</td>
                <td>
                  {entry.attachments?.length
                    ? <Badge>{entry.attachments.length} {t(props.locale, "memory.attachmentCount")}</Badge>
                    : <span style={{ color: "var(--sl-muted)", fontSize: 12 }}>{t(props.locale, "memory.noAttachment")}</span>}
                </td>
                <td>{entry.createdAt ? fmtDateTime(entry.createdAt, props.locale) : "—"}</td>
                <td>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => handleViewDetail(entry)} disabled={busy}>{t(props.locale, "memory.action.detail")}</button>
                    <button style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12 }} onClick={() => handleEdit(entry)} disabled={busy}>{t(props.locale, "memory.action.edit")}</button>
                    <button style={{ ...btnSecondary, padding: "2px 8px", fontSize: 12, color: "crimson" }} onClick={() => handleDelete(entry.id)} disabled={busy}>{t(props.locale, "memory.action.delete")}</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {/* Pagination (only in list mode) */}
      {!searchResults && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
          <button style={btnSecondary} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(props.locale, "memory.prevPage")}</button>
          <span style={{ lineHeight: "32px", fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "memory.pageLabel").replace("{page}", String(page + 1))}</span>
          <button style={btnSecondary} disabled={items.length < pageSize} onClick={() => setPage((p) => p + 1)}>{t(props.locale, "memory.nextPage")}</button>
        </div>
      )}

      {detailEntry && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
          <div style={{ background: "var(--sl-surface-raised, #1e293b)", borderRadius: 12, padding: 24, width: "min(600px, 90vw)", maxHeight: "80vh", overflow: "auto", border: "1px solid var(--sl-border)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>{t(props.locale, "memory.detailTitle")}</h3>
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <div><strong>{t(props.locale, "memory.field.id")}:</strong> <span style={{ fontFamily: "monospace", fontSize: 12 }}>{detailEntry.id}</span></div>
              <div><strong>{t(props.locale, "memory.field.type")}:</strong> <Badge>{detailEntry.type}</Badge></div>
              <div><strong>{t(props.locale, "memory.field.scope")}:</strong> <Badge>{detailEntry.scope}</Badge></div>
              <div><strong>{t(props.locale, "memory.field.title")}:</strong> {detailEntry.title || t(props.locale, "memory.noTitle")}</div>
              <div><strong>{t(props.locale, "memory.field.createdAt")}:</strong> {detailEntry.createdAt ? fmtDateTime(detailEntry.createdAt, props.locale) : "—"}</div>
              {detailEntry.updatedAt && <div><strong>{t(props.locale, "memory.field.updatedAt")}:</strong> {fmtDateTime(detailEntry.updatedAt, props.locale)}</div>}
              <div style={{ marginTop: 12 }}>
                <strong>{t(props.locale, "memory.field.content")}:</strong>
                <pre style={{ whiteSpace: "pre-wrap", background: "var(--sl-bg)", padding: 12, borderRadius: 6, fontSize: 12, marginTop: 4, border: "1px solid var(--sl-border)" }}>
                  {detailEntry.contentText || t(props.locale, "memory.noContent")}
                </pre>
              </div>
              <div style={{ marginTop: 12 }}>
                <strong>{t(props.locale, "memory.relatedAttachments")}({detailEntry.attachments?.length ?? 0}):</strong>
                {(!detailEntry.attachments?.length) && <span style={{ color: "var(--sl-muted)" }}>{t(props.locale, "memory.noAttachments")}</span>}
                {detailEntry.attachments && detailEntry.attachments.length > 0 && (
                  <table style={{ width: "100%", marginTop: 8, fontSize: 12, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--sl-border)" }}>
                        <th style={{ textAlign: "left", padding: "4px 8px" }}>{t(props.locale, "memory.attachment.mediaId")}</th>
                        <th style={{ textAlign: "left", padding: "4px 8px" }}>{t(props.locale, "memory.attachment.type")}</th>
                        <th style={{ textAlign: "left", padding: "4px 8px" }}>{t(props.locale, "memory.attachment.caption")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailEntry.attachments.map((att) => (
                        <tr key={att.id} style={{ borderBottom: "1px solid var(--sl-border)" }}>
                          <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{att.mediaId.slice(0, 8)}…</td>
                          <td style={{ padding: "4px 8px" }}><Badge>{att.mediaType}</Badge></td>
                          <td style={{ padding: "4px 8px" }}>{att.caption || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setDetailEntry(null)} style={btnSecondary}>{t(props.locale, "memory.action.close")}</button>
            </div>
          </div>
        </div>
      )}

      {editEntry && (
        <EditDialog
          entry={editEntry}
          locale={props.locale}
          onClose={() => setEditEntry(null)}
          onSaved={() => { setEditEntry(null); refresh(); }}
        />
      )}
    </div>
  );
}
