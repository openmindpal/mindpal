"use client";

import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, Table, StatusBadge } from "@/components/ui";
import type { CollabDetailSnapshot, CollabRunEvent, CollabStateUpdate } from "@/lib/types";

export default function CollabRunDetail(props: {
  locale: string;
  snapshot: CollabDetailSnapshot;
  busy: boolean;
}) {
  const { collabRun, latestEvents, collabState, recentStateUpdates } = props.snapshot;
  const roles = Array.isArray(collabRun.roles) ? collabRun.roles : [];
  const roleStates = collabState?.roleStates ?? {};

  return (
    <>
      {/* Role Status Panel */}
      <Card title={t(props.locale, "gov.collabRuns.detail.roles")}>
        <Table header={<span>{roles.length}</span>}>
          <thead>
            <tr>
              <th>{t(props.locale, "gov.collabRuns.detail.roleName")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.roleStatus")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.allowedTools")}</th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 ? (
              <tr><td colSpan={3} style={{ textAlign: "center", padding: 16, opacity: 0.6 }}>-</td></tr>
            ) : (
              roles.map((r) => {
                const rs = roleStates[r.roleName] as Record<string, unknown> | undefined;
                const roleStatus = rs?.status ? String(rs.status) : r.status ?? "-";
                const allowedTools = r.toolPolicy?.allowedTools ?? [];
                return (
                  <tr key={r.roleName}>
                    <td><Badge>{r.roleName}</Badge></td>
                    <td><StatusBadge status={roleStatus} locale={props.locale} /></td>
                    <td>
                      {allowedTools.length ? (
                        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
                          {allowedTools.join(", ")}
                        </span>
                      ) : "-"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>

      {/* Execution Timeline */}
      <Card title={t(props.locale, "gov.collabRuns.detail.timeline")}>
        <Table header={<span>{latestEvents.length}</span>}>
          <thead>
            <tr>
              <th>{t(props.locale, "gov.collabRuns.detail.time")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.eventType")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.actor")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.correlation")}</th>
              <th>{t(props.locale, "gov.collabRuns.detail.payload")}</th>
            </tr>
          </thead>
          <tbody>
            {latestEvents.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: "center", padding: 16, opacity: 0.6 }}>-</td></tr>
            ) : (
              [...latestEvents].reverse().map((ev: CollabRunEvent) => (
                <tr key={ev.eventId}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(ev.createdAt, props.locale)}</td>
                  <td><Badge>{ev.type}</Badge></td>
                  <td>{ev.actorRole ?? "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
                    {ev.correlationId ? ev.correlationId.slice(0, 16) : "-"}
                  </td>
                  <td>
                    {ev.payloadDigest ? (
                      <details>
                        <summary style={{ cursor: "pointer" }}>JSON</summary>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(ev.payloadDigest, null, 2)}</pre>
                      </details>
                    ) : "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>

      {/* State Updates */}
      {recentStateUpdates.length > 0 && (
        <Card title={t(props.locale, "gov.collabRuns.stateUpdates")}>
          <Table header={<span>{recentStateUpdates.length}</span>}>
            <thead>
              <tr>
                <th>{t(props.locale, "gov.collabRuns.detail.time")}</th>
                <th>{t(props.locale, "gov.collabRuns.detail.actor")}</th>
                <th>{t(props.locale, "gov.collabRuns.detail.eventType")}</th>
                <th>{t(props.locale, "gov.collabRuns.detail.payload")}</th>
              </tr>
            </thead>
            <tbody>
              {recentStateUpdates.map((u: CollabStateUpdate) => (
                <tr key={u.updateId}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(u.createdAt, props.locale)}</td>
                  <td>{u.sourceRole}</td>
                  <td><Badge>{u.updateType}</Badge></td>
                  <td>
                    {u.payload ? (
                      <details>
                        <summary style={{ cursor: "pointer" }}>JSON</summary>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(u.payload, null, 2)}</pre>
                      </details>
                    ) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
