"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, StructuredData, JsonFormEditor, StatusBadge } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";
import ConflictResolver from "./ConflictResolver";
import ChangeLog from "./ChangeLog";


export default function GovSyncConflictsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [data, setData] = useState<any>((props.initial as any) ?? null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [selectedTicketId, setSelectedTicketId] = useState<string>("");
  const [ticketDetail, setTicketDetail] = useState<any>(null);
  const [detailBusy, setDetailBusy] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string>("");
  const [resolutionJson, setResolutionJson] = useState<string>('{"decisions":[]}');
  const [activeResolverIdx, setActiveResolverIdx] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data as any);
    return "";
  }, [data, props.locale, status]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/sync/conflict-tickets?limit=50`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData(json as any);
      setTicketPage(0);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadTicket(ticketId: string) {
    setDetailError("");
    setDetailBusy(true);
    try {
      const res = await apiFetch(`/sync/conflict-tickets/${encodeURIComponent(ticketId)}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setTicketDetail((json as any)?.ticket ?? null);
      setSelectedTicketId(ticketId);
    } catch (e: unknown) {
      setDetailError(errText(props.locale, toApiError(e)));
    } finally {
      setDetailBusy(false);
    }
  }

  async function abandonTicket(ticketId: string) {
    setDetailError("");
    setActionBusy(true);
    try {
      const res = await apiFetch(`/sync/conflict-tickets/${encodeURIComponent(ticketId)}/abandon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        cache: "no-store",
        body: JSON.stringify({ reason: "abandoned_from_gov_ui" }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
      if (selectedTicketId === ticketId) await loadTicket(ticketId);
    } catch (e: unknown) {
      setDetailError(errText(props.locale, toApiError(e)));
    } finally {
      setActionBusy(false);
    }
  }

  async function resolveTicket(ticketId: string) {
    setDetailError("");
    setActionBusy(true);
    try {
      const parsed = JSON.parse(resolutionJson || "{}");
      const res = await apiFetch(`/sync/conflict-tickets/${encodeURIComponent(ticketId)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        cache: "no-store",
        body: JSON.stringify({ resolution: parsed }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
      if (selectedTicketId === ticketId) await loadTicket(ticketId);
    } catch (e: unknown) {
      setDetailError(errText(props.locale, toApiError(e)));
    } finally {
      setActionBusy(false);
    }
  }

  async function applyProposal(ticketId: string) {
    setDetailError("");
    setActionBusy(true);
    try {
      const res = await apiFetch(`/sync/conflict-tickets/${encodeURIComponent(ticketId)}/apply-proposal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        cache: "no-store",
        body: JSON.stringify({}),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
      if (selectedTicketId === ticketId) await loadTicket(ticketId);
    } catch (e: unknown) {
      setDetailError(errText(props.locale, toApiError(e)));
    } finally {
      setActionBusy(false);
    }
  }

  const tickets: any[] = Array.isArray(data?.tickets) ? data.tickets : [];
  const ticketPageSize = 20;
  const [ticketPage, setTicketPage] = useState(0);
  const ticketTotalPages = Math.max(1, Math.ceil(tickets.length / ticketPageSize));
  const pagedTickets = useMemo(() => tickets.slice(ticketPage * ticketPageSize, (ticketPage + 1) * ticketPageSize), [tickets, ticketPage]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.syncConflicts.title")}
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

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card title={t(props.locale, "gov.syncConflicts.ticketsTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.syncConflicts.ticketId")}</th>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.syncConflicts.status")}</th>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.syncConflicts.mergeId")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.syncConflicts.updatedAt")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.syncConflicts.conflicts")}</th>
                </tr>
              </thead>
              <tbody>
                {pagedTickets.map((tk, idx) => {
                  const conflictCount = Array.isArray(tk.conflictsJson) ? tk.conflictsJson.length : Number(tk.conflictCount ?? 0);
                  return (
                    <tr key={`${tk.ticketId ?? idx}`}>
                      <td style={{ padding: "6px 4px" }}>
                        <button onClick={() => loadTicket(String(tk.ticketId))} disabled={detailBusy}>
                          {String(tk.ticketId ?? "")}
                        </button>
                      </td>
                      <td style={{ padding: "6px 4px" }}>{String(tk.status ?? "")}</td>
                      <td style={{ padding: "6px 4px" }}>{String(tk.mergeId ?? "")}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{fmtDateTime(tk.updatedAt, props.locale)}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{conflictCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {ticketTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(ticketPage * ticketPageSize + 1)).replace("{to}", String(Math.min((ticketPage + 1) * ticketPageSize, tickets.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(tickets.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={ticketPage === 0} onClick={() => setTicketPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(ticketPage + 1))}</span>
                <button disabled={ticketPage >= ticketTotalPages - 1} onClick={() => setTicketPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>

        <Card title={t(props.locale, "gov.syncConflicts.detailTitle")}>
          {detailError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{detailError}</pre> : null}
          {!detailError && detailBusy ? <div>{t(props.locale, "loading")}</div> : null}
          {!detailBusy && ticketDetail ? (
            <div>
              {(() => {
                const cs = Array.isArray(ticketDetail.conflictsJson) ? ticketDetail.conflictsJson : [];
                const count = cs.filter((c: any) => Boolean(c?.proposal && c.proposal.kind === "auto_apply_patch_if_unset")).length;
                if (!count) return null;
                return <div style={{ marginTop: 8 }}>{`proposalCount=${count}`}</div>;
              })()}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Badge>{statusLabel(String(ticketDetail.status ?? ""), props.locale)}</Badge>
                <span>{String(ticketDetail.ticketId ?? "")}</span>
                <a href={`/gov/audit?lang=${encodeURIComponent(props.locale)}&traceId=${encodeURIComponent(String(ticketDetail.traceId ?? ""))}&limit=50`}>
                  {t(props.locale, "gov.syncConflicts.openAudit")}
                </a>
              </div>

              {/* ── Conflict Diff View ── §15.17 ── */}
              {(() => {
                const conflicts = Array.isArray(ticketDetail.conflictsJson) ? ticketDetail.conflictsJson : [];
                if (!conflicts.length) return null;
                return (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "syncConflict.diffView")}</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "#f5f5f5" }}>
                          <th style={{ textAlign: "left", padding: 6 }}>{t(props.locale, "syncConflict.field")}</th>
                          <th style={{ textAlign: "left", padding: 6, background: "#fff3e0" }}>{t(props.locale, "syncConflict.localValue")}</th>
                          <th style={{ textAlign: "left", padding: 6, background: "#e3f2fd" }}>{t(props.locale, "syncConflict.remoteValue")}</th>
                          <th style={{ textAlign: "center", padding: 6 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {conflicts.map((c: any, ci: number) => {
                          const field = String(c?.field ?? c?.path ?? `conflict_${ci}`);
                          const localVal = c?.localValue ?? c?.client ?? c?.ours ?? "";
                          const remoteVal = c?.remoteValue ?? c?.server ?? c?.theirs ?? "";
                          const isDiff = JSON.stringify(localVal) !== JSON.stringify(remoteVal);
                          return (
                            <tr key={ci} style={{ borderBottom: "1px solid #eee" }}>
                              <td style={{ padding: 6, fontFamily: "monospace" }}>{field}</td>
                              <td style={{ padding: 6, background: isDiff ? "#fff3e0" : undefined, whiteSpace: "pre-wrap", maxWidth: 200, overflow: "hidden" }}>
                                {typeof localVal === "object" ? JSON.stringify(localVal) : String(localVal)}
                              </td>
                              <td style={{ padding: 6, background: isDiff ? "#e3f2fd" : undefined, whiteSpace: "pre-wrap", maxWidth: 200, overflow: "hidden" }}>
                                {typeof remoteVal === "object" ? JSON.stringify(remoteVal) : String(remoteVal)}
                              </td>
                              <td style={{ padding: 6, textAlign: "center" }}>
                                {isDiff && (
                                  <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                                    <button
                                      style={{ fontSize: 11, padding: "2px 6px" }}
                                      onClick={() => {
                                        try {
                                          const res = JSON.parse(resolutionJson || "{}");
                                          if (!res.decisions) res.decisions = [];
                                          res.decisions.push({ field, pick: "local" });
                                          setResolutionJson(JSON.stringify(res, null, 2));
                                        } catch { /* ignore */ }
                                      }}
                                    >
                                      {t(props.locale, "syncConflict.acceptLocal")}
                                    </button>
                                    <button
                                      style={{ fontSize: 11, padding: "2px 6px" }}
                                      onClick={() => {
                                        try {
                                          const res = JSON.parse(resolutionJson || "{}");
                                          if (!res.decisions) res.decisions = [];
                                          res.decisions.push({ field, pick: "remote" });
                                          setResolutionJson(JSON.stringify(res, null, 2));
                                        } catch { /* ignore */ }
                                      }}
                                    >
                                      {t(props.locale, "syncConflict.acceptRemote")}
                                    </button>
                                    <button
                                      style={{ fontSize: 11, padding: "2px 6px" }}
                                      onClick={() => setActiveResolverIdx(ci)}
                                    >
                                      {t(props.locale, "gov.syncConflicts.strategy.manual")}
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button
                  onClick={() => applyProposal(String(ticketDetail.ticketId))}
                  disabled={
                    actionBusy ||
                    String(ticketDetail.status) !== "open" ||
                    !Array.isArray(ticketDetail.conflictsJson) ||
                    ticketDetail.conflictsJson.filter((c: any) => Boolean(c?.proposal && c.proposal.kind === "auto_apply_patch_if_unset")).length === 0
                  }
                >
                  {t(props.locale, "gov.syncConflicts.applyProposal")}
                </button>
                <button onClick={() => resolveTicket(String(ticketDetail.ticketId))} disabled={actionBusy || String(ticketDetail.status) !== "open"}>
                  {t(props.locale, "gov.syncConflicts.resolve")}
                </button>
                <button onClick={() => abandonTicket(String(ticketDetail.ticketId))} disabled={actionBusy || String(ticketDetail.status) !== "open"}>
                  {t(props.locale, "gov.syncConflicts.abandon")}
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                <label style={{ display: "block", marginBottom: 4 }}>{t(props.locale, "gov.syncConflicts.resolutionJson")}</label>
                <JsonFormEditor value={resolutionJson} onChange={setResolutionJson} locale={props.locale} disabled={actionBusy} rows={6} />
              </div>
              {/* Three-way merge resolver for individual conflicts */}
              {activeResolverIdx !== null && (() => {
                const conflicts = Array.isArray(ticketDetail.conflictsJson) ? ticketDetail.conflictsJson : [];
                const c = conflicts[activeResolverIdx];
                if (!c) return null;
                return (
                  <ConflictResolver
                    locale={props.locale}
                    conflict={{
                      field: String(c?.field ?? c?.path ?? `conflict_${activeResolverIdx}`),
                      localValue: c?.localValue ?? c?.client ?? c?.ours ?? "",
                      remoteValue: c?.remoteValue ?? c?.server ?? c?.theirs ?? "",
                    }}
                    disabled={actionBusy}
                    onResolve={(field, pick, mergedValue) => {
                      try {
                        const res = JSON.parse(resolutionJson || "{}");
                        if (!res.decisions) res.decisions = [];
                        res.decisions.push({ field, pick, ...(mergedValue !== undefined ? { mergedValue } : {}) });
                        setResolutionJson(JSON.stringify(res, null, 2));
                      } catch { /* ignore */ }
                      setActiveResolverIdx(null);
                    }}
                    onCancel={() => setActiveResolverIdx(null)}
                  />
                );
              })()}

              <div style={{ marginTop: 12 }}>
                <StructuredData data={ticketDetail} />
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Change Log Section */}
      <div style={{ marginTop: 16 }}>
        <ChangeLog locale={props.locale} />
      </div>
    </div>
  );
}
