"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type RunLite = { runId: string; status: string; toolRef?: string | null; policySnapshotRef?: string | null; idempotencyKey?: string | null; createdAt?: string; updatedAt?: string };
type CollabStateResp = {
  collabRunId?: string | null;
  phase?: string | null;
  currentTurn?: number | null;
  currentRole?: string | null;
  roleStates?: Record<string, { roleName?: string; status?: string; currentStepId?: string | null; progress?: number | null; lastUpdateAt?: string; metadata?: unknown }>;
  completedStepIds?: string[];
  failedStepIds?: string[];
  pendingStepIds?: string[];
  replanCount?: number | null;
  startedAt?: string | null;
  lastUpdatedAt?: string | null;
  version?: number | null;
};
type StateUpdateResp = { updateId?: string; sourceRole?: string | null; updateType?: string | null; payload?: unknown; version?: number | null; createdAt?: string | null };
type CollabDetailResp = { collabRun?: unknown; runs?: RunLite[]; latestEvents?: unknown[]; recentStateUpdates?: StateUpdateResp[]; collabState?: CollabStateResp | null; taskState?: unknown } & ApiError;
type EnvelopesResp = { items?: unknown[]; nextBefore?: string | null } & ApiError;
type EventsResp = { items?: unknown[]; nextBefore?: string | null } & ApiError;
type StreamState = "disconnected" | "connecting" | "connected" | "reconnecting";

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

export default function CollabRunClient(props: {
  locale: string;
  taskId: string;
  collabRunId: string;
  initial: unknown;
  initialStatus: number;
  initialEnvelopes: unknown;
  initialEnvelopesStatus: number;
}) {
  const [data, setData] = useState<CollabDetailResp | null>((props.initial as CollabDetailResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [envData, setEnvData] = useState<EnvelopesResp | null>((props.initialEnvelopes as EnvelopesResp) ?? null);
  const [envStatus, setEnvStatus] = useState<number>(props.initialEnvelopesStatus);
  const [eventsData, setEventsData] = useState<EventsResp | null>({ items: asArray((props.initial as any)?.latestEvents) });
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>(() => new Date().toISOString());
  const [streamState, setStreamState] = useState<StreamState>("disconnected");
  const [lastStreamEventAt, setLastStreamEventAt] = useState<string>("");
  const refreshInFlightRef = useRef(false);
  const streamRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);

  const [envFromRole, setEnvFromRole] = useState<string>("planner");
  const [envToRole, setEnvToRole] = useState<string>("arbiter");
  const [envKind, setEnvKind] = useState<string>("message");
  const [envCorrelationId, setEnvCorrelationId] = useState<string>("");
  const [envPayload, setEnvPayload] = useState<string>("");

  const [commitCorrelationId, setCommitCorrelationId] = useState<string>("");
  const [commitStatus, setCommitStatus] = useState<string>("executing");
  const [commitDecision, setCommitDecision] = useState<string>("");

  const collabRun = data?.collabRun ?? null;
  const collabState = (data as any)?.collabState ?? null;
  const taskState = (data as any)?.taskState ?? null;
  const runs = useMemo(() => (Array.isArray(data?.runs) ? (data!.runs as RunLite[]) : []), [data]);
  const envelopes = useMemo(() => (Array.isArray(envData?.items) ? envData!.items! : []), [envData]);
  const events = useMemo(() => (Array.isArray(eventsData?.items) ? eventsData!.items! : []), [eventsData]);
  const stateUpdates = useMemo(() => (Array.isArray(data?.recentStateUpdates) ? data!.recentStateUpdates! : []), [data]);
  const roleStates = useMemo(() => {
    if (!collabState || typeof collabState !== "object" || !collabState.roleStates || typeof collabState.roleStates !== "object") return [];
    return Object.entries(collabState.roleStates).map(([roleName, value]) => ({
      roleName,
      ...(value as any),
    }));
  }, [collabState]);
  const isTerminal = useMemo(() => {
    const phase = String(collabState?.phase ?? (collabRun as any)?.status ?? "").trim();
    return ["succeeded", "failed", "stopped", "canceled"].includes(phase);
  }, [collabRun, collabState]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    if (envStatus >= 400) return errText(props.locale, envData);
    return "";
  }, [data, envData, envStatus, props.locale, status]);

  const inferredPlanCorrelationId = useMemo(() => {
    for (const e of events) {
      const type = typeof (e as any)?.type === "string" ? String((e as any).type) : "";
      const corr = typeof (e as any)?.correlationId === "string" ? String((e as any).correlationId) : "";
      if (type === "collab.plan.generated" && corr) return corr;
    }
    return "";
  }, [events]);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!options?.silent) setRefreshing(true);
    setError("");
    try {
      const dRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}`, {
        locale: props.locale,
        cache: "no-store",
      });
      setStatus(dRes.status);
      const dJson: unknown = await dRes.json().catch(() => null);
      setData((dJson as CollabDetailResp) ?? null);

      const eRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/events?limit=50`, {
        locale: props.locale,
        cache: "no-store",
      });
      const eJson: unknown = await eRes.json().catch(() => null);
      if (eRes.ok) setEventsData((eJson as EventsResp) ?? null);

      const envRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/envelopes?limit=50`, {
        locale: props.locale,
        cache: "no-store",
      });
      setEnvStatus(envRes.status);
      const envJson: unknown = await envRes.json().catch(() => null);
      setEnvData((envJson as EnvelopesResp) ?? null);
      setLastRefreshedAt(new Date().toISOString());

      if (!dRes.ok) setError(errText(props.locale, (dJson as ApiError) ?? { errorCode: String(dRes.status) }));
      else if (!envRes.ok) setError(errText(props.locale, (envJson as ApiError) ?? { errorCode: String(envRes.status) }));
    } finally {
      refreshInFlightRef.current = false;
      if (!options?.silent) setRefreshing(false);
    }
  }, [props.collabRunId, props.locale, props.taskId]);

  useEffect(() => {
    if (isTerminal) {
      streamRef.current?.close();
      streamRef.current = null;
      setStreamState("disconnected");
      return;
    }
    let closed = false;
    const connect = () => {
      if (closed) return;
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      setStreamState(reconnectCountRef.current > 0 ? "reconnecting" : "connecting");
      const url = `${API_BASE}/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/stream`;
      const es = new EventSource(url, { withCredentials: true });
      streamRef.current = es;

      es.onopen = () => {
        reconnectCountRef.current = 0;
        setStreamState("connected");
      };
      es.addEventListener("snapshot", (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as CollabDetailResp & { envelopes?: EnvelopesResp };
          setData(payload);
          setEventsData({ items: asArray((payload as any)?.latestEvents) });
          setEnvData((payload as any)?.envelopes ?? { items: [] });
          setLastRefreshedAt(new Date().toISOString());
          setLastStreamEventAt(new Date().toISOString());
          setError("");
        } catch {}
      });
      es.addEventListener("ping", () => {
        setLastStreamEventAt(new Date().toISOString());
      });
      es.addEventListener("error", () => {
        setStreamState("reconnecting");
      });
      es.onerror = () => {
        es.close();
        streamRef.current = null;
        if (closed) return;
        reconnectCountRef.current += 1;
        setStreamState("reconnecting");
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current - 1), 10000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      setStreamState("disconnected");
    };
  }, [isTerminal, props.collabRunId, props.taskId]);

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

  async function sendEnvelope() {
    if (!envPayload.trim()) return;
    await runAction(async () => {
      const payloadParsed = (() => {
        try {
          return JSON.parse(envPayload);
        } catch {
          return { text: envPayload.trim().slice(0, 20_000) };
        }
      })();
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/envelopes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          fromRole: envFromRole.trim().slice(0, 50),
          toRole: envToRole.trim().slice(0, 50),
          kind: envKind.trim().slice(0, 50),
          correlationId: envCorrelationId.trim().slice(0, 200) || undefined,
          payloadRedacted: payloadParsed,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setEnvPayload("");
    });
  }

  async function arbiterCommit() {
    const corr = (commitCorrelationId || inferredPlanCorrelationId).trim();
    if (!corr) return;
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/arbiter/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          actorRole: "arbiter",
          correlationId: corr.slice(0, 200),
          status: commitStatus ? commitStatus : undefined,
          decisionRedacted: commitDecision.trim() ? { text: commitDecision.trim().slice(0, 20_000) } : undefined,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "collab.detailTitle")}
        description={
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
            taskId={props.taskId} collabRunId={props.collabRunId}
          </span>
        }
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <Badge>{envStatus}</Badge>
            <Badge>{`${t(props.locale, "collab.liveStream")}: ${streamState}`}</Badge>
            <Badge>{`${t(props.locale, "collab.lastRefreshed")}: ${fmtDateTime(lastRefreshedAt, props.locale)}`}</Badge>
            <Badge>{`${t(props.locale, "collab.lastStreamEvent")}: ${fmtDateTime(lastStreamEventAt || null, props.locale)}`}</Badge>
            <button onClick={() => void refresh()} disabled={busy || refreshing}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.summaryTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(collabRun, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.taskStateTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(taskState, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.stateTitle")}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <div><b>phase</b>: {String(collabState?.phase ?? "-")}</div>
            <div><b>currentRole</b>: {String(collabState?.currentRole ?? "-")}</div>
            <div><b>currentTurn</b>: {String(collabState?.currentTurn ?? "-")}</div>
            <div><b>version</b>: {String(collabState?.version ?? "-")}</div>
            <div><b>replanCount</b>: {String(collabState?.replanCount ?? "0")}</div>
            <div><b>updatedAt</b>: {fmtDateTime(collabState?.lastUpdatedAt, props.locale)}</div>
          </div>
          <div style={{ marginTop: 12 }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {JSON.stringify({
                completedStepIds: collabState?.completedStepIds ?? [],
                failedStepIds: collabState?.failedStepIds ?? [],
                pendingStepIds: collabState?.pendingStepIds ?? [],
              }, null, 2)}
            </pre>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.roleStatesTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">role</th>
              <th align="left">status</th>
              <th align="left">currentStepId</th>
              <th align="left">progress</th>
              <th align="left">lastUpdateAt</th>
              <th align="left">metadata</th>
            </tr>
          </thead>
          <tbody>
            {roleStates.map((role: any) => (
              <tr key={String(role.roleName ?? "-")}>
                <td>{String(role.roleName ?? "-")}</td>
                <td><Badge>{statusLabel(String(role.status ?? "-"), props.locale)}</Badge></td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(role.currentStepId ?? "-")}</td>
                <td>{role.progress ?? "-"}</td>
                <td>{fmtDateTime(role.lastUpdateAt, props.locale)}</td>
                <td><pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(role.metadata ?? null, null, 2)}</pre></td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.runsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">runId</th>
              <th align="left">status</th>
              <th align="left">toolRef</th>
              <th align="left">createdAt</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  <Link href={`/runs/${encodeURIComponent(r.runId)}?lang=${encodeURIComponent(props.locale)}`}>{r.runId}</Link>
                </td>
                <td>
                  <Badge>{statusLabel(r.status, props.locale)}</Badge>
                </td>
                <td>{r.toolRef ?? "-"}</td>
                <td>{fmtDateTime(r.createdAt, props.locale)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.arbiterTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
            <div>
              correlationId{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                {inferredPlanCorrelationId ? `(plan=${inferredPlanCorrelationId})` : ""}
              </span>
            </div>
            <input value={commitCorrelationId} onChange={(e) => setCommitCorrelationId(e.target.value)} />
            <div>status</div>
            <select value={commitStatus} onChange={(e) => setCommitStatus(e.target.value)}>
              <option value="executing">executing</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="canceled">canceled</option>
              <option value="stopped">stopped</option>
            </select>
            <div>{t(props.locale, "collab.decisionTitle")}</div>
            <textarea value={commitDecision} onChange={(e) => setCommitDecision(e.target.value)} rows={3} />
            <button onClick={arbiterCommit} disabled={busy || !(commitCorrelationId.trim() || inferredPlanCorrelationId)}>
              {t(props.locale, "collab.commitButton")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "collab.envelopeSendTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <div>fromRole</div>
                <input value={envFromRole} onChange={(e) => setEnvFromRole(e.target.value)} />
              </div>
              <div>
                <div>toRole</div>
                <input value={envToRole} onChange={(e) => setEnvToRole(e.target.value)} />
              </div>
              <div>
                <div>kind</div>
                <input value={envKind} onChange={(e) => setEnvKind(e.target.value)} />
              </div>
            </div>
            <div>correlationId</div>
            <input value={envCorrelationId} onChange={(e) => setEnvCorrelationId(e.target.value)} />
            <div>{t(props.locale, "collab.envelopePayloadLabel")}</div>
            <textarea value={envPayload} onChange={(e) => setEnvPayload(e.target.value)} rows={4} />
            <button onClick={sendEnvelope} disabled={busy || !envPayload.trim()}>
              {t(props.locale, "collab.sendButton")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.eventsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">createdAt</th>
              <th align="left">type</th>
              <th align="left">actorRole</th>
              <th align="left">correlationId</th>
              <th align="left">payloadDigest</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e: any, i: number) => (
              <tr key={String(e?.eventId ?? i)}>
                <td>{fmtDateTime(e?.createdAt ?? e?.created_at, props.locale)}</td>
                <td>
                  <Badge>{String(e?.type ?? "-")}</Badge>
                </td>
                <td>{String(e?.actorRole ?? e?.actor_role ?? "-")}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(e?.correlationId ?? e?.correlation_id ?? "-")}</td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(e?.payloadDigest ?? e?.payload_digest ?? null, null, 2)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.stateUpdatesTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">createdAt</th>
              <th align="left">sourceRole</th>
              <th align="left">updateType</th>
              <th align="left">version</th>
              <th align="left">payload</th>
            </tr>
          </thead>
          <tbody>
            {stateUpdates.map((u: any, i: number) => (
              <tr key={String(u?.updateId ?? i)}>
                <td>{fmtDateTime(u?.createdAt, props.locale)}</td>
                <td>{String(u?.sourceRole ?? "-")}</td>
                <td><Badge>{String(u?.updateType ?? "-")}</Badge></td>
                <td>{String(u?.version ?? "-")}</td>
                <td><pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(u?.payload ?? null, null, 2)}</pre></td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "collab.envelopesTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">createdAt</th>
              <th align="left">fromRole</th>
              <th align="left">toRole</th>
              <th align="left">kind</th>
              <th align="left">correlationId</th>
              <th align="left">payloadDigest</th>
            </tr>
          </thead>
          <tbody>
            {envelopes.map((env: any, i: number) => (
              <tr key={String(env?.envelopeId ?? i)}>
                <td>{fmtDateTime(env?.createdAt ?? env?.created_at, props.locale)}</td>
                <td>{String(env?.fromRole ?? env?.from_role ?? "-")}</td>
                <td>{String(env?.toRole ?? env?.to_role ?? "-")}</td>
                <td>
                  <Badge>{String(env?.kind ?? "-")}</Badge>
                </td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(env?.correlationId ?? env?.correlation_id ?? "-")}</td>
                <td>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(env?.payloadDigest ?? env?.payload_digest ?? null, null, 2)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
