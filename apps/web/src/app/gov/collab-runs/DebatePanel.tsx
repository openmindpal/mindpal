"use client";

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, Table } from "@/components/ui";
import type { CollabRunEvent, CollabEnvelope } from "@/lib/types";

/**
 * Debate Process Visualisation — renders communication rounds between
 * agents as a debate timeline, showing speaker, argument, stance and
 * arbiter results.
 */
export default function DebatePanel(props: {
  locale: string;
  events: CollabRunEvent[];
  envelopes: CollabEnvelope[];
}) {
  /* Debate rounds: envelopes with kind "proposal", "question", "answer", "observation" */
  const rounds = useMemo(() => {
    const debateKinds = new Set(["proposal", "question", "answer", "observation", "command"]);
    return props.envelopes
      .filter((e) => debateKinds.has(e.kind))
      .map((e, i) => ({
        round: i + 1,
        speaker: e.fromRole,
        kind: e.kind,
        target: e.toRole ?? (e.broadcast ? "broadcast" : "-"),
        correlationId: e.correlationId,
        time: e.createdAt,
        payloadDigest: e.payloadDigest,
      }));
  }, [props.envelopes]);

  /* Arbiter results */
  const arbiterResults = useMemo(
    () => props.events.filter((e) => e.type === "collab.arbiter.decision"),
    [props.events],
  );

  if (!rounds.length && !arbiterResults.length) return null;

  return (
    <Card title={t(props.locale, "gov.collabRuns.debate.title")}>
      {rounds.length > 0 && (
        <Table header={<span>{rounds.length}</span>}>
          <thead>
            <tr>
              <th>{t(props.locale, "gov.collabRuns.debate.round")}</th>
              <th>{t(props.locale, "gov.collabRuns.debate.speaker")}</th>
              <th>{t(props.locale, "gov.collabRuns.debate.stance")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.time")}</th>
              <th>{t(props.locale, "gov.collabRuns.debate.argument")}</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((r) => (
              <tr key={`${r.round}-${r.correlationId}`}>
                <td>{r.round}</td>
                <td><Badge>{r.speaker}</Badge></td>
                <td><Badge>{r.kind}</Badge></td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(r.time, props.locale)}</td>
                <td>
                  {r.payloadDigest ? (
                    <details>
                      <summary style={{ cursor: "pointer" }}>JSON</summary>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(r.payloadDigest, null, 2)}</pre>
                    </details>
                  ) : r.correlationId}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Arbiter final results */}
      {arbiterResults.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>{t(props.locale, "gov.collabRuns.debate.arbiterResult")}</strong>
          {arbiterResults.map((e) => (
            <div key={e.eventId} style={{ marginTop: 4, fontSize: 13 }}>
              <Badge>{e.actorRole ?? "arbiter"}</Badge>
              <span style={{ marginLeft: 8 }}>
                {e.payloadDigest ? JSON.stringify(e.payloadDigest).slice(0, 200) : "-"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
