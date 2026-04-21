"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";
import type { CollabRun, CollabDetailSnapshot } from "@/lib/types";
import CollabRunDetail from "./CollabRunDetail";
import ConsensusPanel from "./ConsensusPanel";
import DebatePanel from "./DebatePanel";

type ListResponse = { items?: CollabRun[]; nextBefore?: string | null };

export default function CollabRunsClient(props: { locale: string; initialTaskId: string }) {
  const [taskId, setTaskId] = useState(props.initialTaskId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<CollabRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<CollabDetailSnapshot | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  async function search() {
    if (!taskId.trim()) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(
        `/collab-runtime/tasks/${encodeURIComponent(taskId.trim())}/collab-runs?limit=50`,
        { locale: props.locale, cache: "no-store" },
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const data = json as ListResponse;
      setItems(data.items ?? []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(collabRunId: string) {
    if (!taskId.trim()) return;
    setDetailBusy(true);
    setSelectedId(collabRunId);
    try {
      const res = await apiFetch(
        `/collab-runtime/tasks/${encodeURIComponent(taskId.trim())}/collab-runs/${encodeURIComponent(collabRunId)}`,
        { locale: props.locale, cache: "no-store" },
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setDetail(json as CollabDetailSnapshot);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setDetailBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.collabRuns.title")}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder={t(props.locale, "gov.collabRuns.taskIdLabel")}
              style={{ width: 300, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
            />
            <button disabled={busy || !taskId.trim()} onClick={search}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "gov.collabRuns.search")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.collabRuns.title")}>
        <Table header={<span>{items.length ? `${items.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th>{t(props.locale, "gov.collabRuns.id")}</th>
              <th>{t(props.locale, "gov.collabRuns.startedAt")}</th>
              <th>{t(props.locale, "gov.collabRuns.roleCount")}</th>
              <th>{t(props.locale, "gov.collabRuns.phase")}</th>
              <th>{t(props.locale, "gov.collabRuns.status")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>
                  {t(props.locale, "widget.noData")}
                </td>
              </tr>
            ) : (
              items.map((run) => {
                const id = run.collabRunId;
                const roles = Array.isArray(run.roles) ? run.roles : [];
                const isSelected = selectedId === id;
                return (
                  <tr
                    key={id}
                    onClick={() => loadDetail(id)}
                    style={{ cursor: "pointer", background: isSelected ? "var(--sl-bg-highlight, rgba(0,0,0,0.04))" : undefined }}
                  >
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id.slice(0, 8)}</td>
                    <td>{fmtDateTime(run.createdAt, props.locale)}</td>
                    <td>{roles.length}</td>
                    <td><Badge>{statusLabel(run.status, props.locale)}</Badge></td>
                    <td><StatusBadge status={run.status} locale={props.locale} /></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>

      {selectedId && detail ? (
        <>
          <CollabRunDetail
            locale={props.locale}
            snapshot={detail}
            busy={detailBusy}
          />
          <ConsensusPanel
            locale={props.locale}
            taskId={taskId}
            collabRunId={selectedId}
            events={detail.latestEvents}
            envelopes={detail.envelopes?.items ?? []}
          />
          <DebatePanel
            locale={props.locale}
            events={detail.latestEvents}
            envelopes={detail.envelopes?.items ?? []}
          />
        </>
      ) : detailBusy ? (
        <div style={{ padding: 24, textAlign: "center", opacity: 0.6 }}>{t(props.locale, "action.loading")}</div>
      ) : null}
    </div>
  );
}
