"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, Table } from "@/components/ui";
import { toApiError, errText } from "@/lib/apiError";
import type { CollabRunEvent, CollabEnvelope } from "@/lib/types";

/**
 * Consensus Voting Panel — extracts arbiter decision events and
 * envelope proposals to visualise the voting/consensus process,
 * and exposes Approve / Reject buttons for human intervention
 * via the arbiter commit API.
 */
export default function ConsensusPanel(props: {
  locale: string;
  taskId: string;
  collabRunId: string;
  events: CollabRunEvent[];
  envelopes: CollabEnvelope[];
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  /* Derive consensus-related events: arbiter decisions, needs_approval, etc. */
  const arbiterEvents = useMemo(
    () =>
      props.events.filter(
        (e) =>
          e.type === "collab.arbiter.decision" ||
          e.type === "collab.run.needs_approval" ||
          e.actorRole === "arbiter",
      ),
    [props.events],
  );

  /* Derive proposal envelopes as "votes" */
  const proposals = useMemo(
    () => props.envelopes.filter((e) => e.kind === "proposal" || e.kind === "answer"),
    [props.envelopes],
  );

  async function submitArbiterCommit(status: "succeeded" | "stopped") {
    setBusy(true);
    setResult("");
    try {
      const correlationId = arbiterEvents[0]?.correlationId ?? `manual:${Date.now()}`;
      const res = await apiFetch(
        `/collab-runtime/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(props.collabRunId)}/arbiter/commit`,
        {
          method: "POST",
          locale: props.locale,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actorRole: "arbiter",
            status,
            correlationId,
            decisionRedacted: { humanOverride: true, decision: status },
          }),
        },
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setResult(status === "succeeded" ? "✓" : "✗");
    } catch (e: unknown) {
      setResult(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  if (!arbiterEvents.length && !proposals.length) return null;

  return (
    <Card title={t(props.locale, "gov.collabRuns.consensus.title")}>
      {/* Voting results from envelopes */}
      {proposals.length > 0 && (
        <Table header={<span>{proposals.length}</span>}>
          <thead>
            <tr>
              <th>{t(props.locale, "gov.collabRuns.consensus.agent")}</th>
              <th>{t(props.locale, "gov.collabRuns.consensus.decision")}</th>
              <th>{t(props.locale, "gov.collabRuns.consensus.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => (
              <tr key={p.envelopeId}>
                <td><Badge>{p.fromRole}</Badge></td>
                <td>{p.kind}</td>
                <td style={{ fontSize: 12 }}>{p.correlationId}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Arbiter events */}
      {arbiterEvents.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>{t(props.locale, "gov.collabRuns.consensus.outcome")}</strong>
          {arbiterEvents.map((e) => (
            <div key={e.eventId} style={{ marginTop: 4, fontSize: 13 }}>
              <Badge>{e.type}</Badge>
              {e.payloadDigest ? (
                <span style={{ marginLeft: 8, opacity: 0.8 }}>
                  {JSON.stringify(e.payloadDigest).slice(0, 120)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Human override buttons */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button disabled={busy} onClick={() => submitArbiterCommit("succeeded")}>
          {t(props.locale, "gov.collabRuns.consensus.approve")}
        </button>
        <button disabled={busy} onClick={() => submitArbiterCommit("stopped")}>
          {t(props.locale, "gov.collabRuns.consensus.reject")}
        </button>
        {result && <span style={{ alignSelf: "center", fontSize: 13 }}>{result}</span>}
      </div>
    </Card>
  );
}
