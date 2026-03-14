"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type LongTaskItem = {
  task: { taskId: string; title: string | null; status: string; createdAt: string; updatedAt: string };
  run: { runId: string; status: string; jobType: string | null; toolRef: string | null; traceId: string | null; startedAt: string | null; finishedAt: string | null; updatedAt: string | null } | null;
  progress: { phase: string | null };
  controls: { canCancel: boolean; canContinue: boolean; needsApproval: boolean };
};

type LongTasksResp = { longTasks?: LongTaskItem[] } & ApiError;

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export default function TasksClient(props: { locale: string; initial: unknown; initialStatus: number; initialQuery: { scope?: string | null; limit?: string | null; offset?: string | null } }) {
  const [data, setData] = useState<LongTasksResp | null>((props.initial as LongTasksResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const items = useMemo(() => (Array.isArray(data?.longTasks) ? data!.longTasks! : []), [data]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  async function refresh() {
    setError("");
    const q = new URLSearchParams();
    if (props.initialQuery.scope) q.set("scope", props.initialQuery.scope);
    if (props.initialQuery.limit) q.set("limit", props.initialQuery.limit);
    if (props.initialQuery.offset) q.set("offset", props.initialQuery.offset);
    const res = await fetch(`${API_BASE}/tasks/long-tasks?${q.toString()}`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as LongTasksResp) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
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

  async function cancelRun(runId: string) {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: apiHeaders(props.locale) });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  async function continueAgentRun(taskId: string, runId: string) {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/agent-runs/${encodeURIComponent(runId)}/continue`, {
        method: "POST",
        headers: apiHeaders(props.locale),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "tasks.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "tasks.listTitle")}>
          <Table>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "tasks.col.taskId")}</th>
                <th align="left">{t(props.locale, "tasks.col.title")}</th>
                <th align="left">{t(props.locale, "tasks.col.phase")}</th>
                <th align="left">{t(props.locale, "tasks.col.run")}</th>
                <th align="left">{t(props.locale, "tasks.col.status")}</th>
                <th align="left">{t(props.locale, "tasks.col.jobType")}</th>
                <th align="left">{t(props.locale, "tasks.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.task.taskId}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    <Link href={`/tasks/${encodeURIComponent(it.task.taskId)}?lang=${encodeURIComponent(props.locale)}`}>{it.task.taskId}</Link>
                  </td>
                  <td>{it.task.title ?? "-"}</td>
                  <td>{it.progress.phase ?? "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {it.run?.runId ? <Link href={`/runs/${encodeURIComponent(it.run.runId)}?lang=${encodeURIComponent(props.locale)}`}>{it.run.runId}</Link> : "-"}
                  </td>
                  <td>{it.run ? <Badge>{it.run.status}</Badge> : "-"}</td>
                  <td>{it.run?.jobType ?? "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => it.run?.runId && cancelRun(it.run.runId)} disabled={busy || !it.controls.canCancel || !it.run?.runId}>
                        {t(props.locale, "action.cancel")}
                      </button>
                      <button
                        onClick={() => it.run?.runId && continueAgentRun(it.task.taskId, it.run.runId)}
                        disabled={busy || !it.controls.canContinue || !it.run?.runId}
                      >
                        {t(props.locale, "action.continue")}
                      </button>
                      {it.controls.needsApproval ? <Badge>{t(props.locale, "tasks.badge.needsApproval")}</Badge> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

