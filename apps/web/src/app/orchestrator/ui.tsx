"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t, statusLabel, boolLabel } from "@/lib/i18n";
import { type ApiError, errText, isPlainObject, safeJsonString } from "@/lib/apiError";
import { type DispatchResponse, type ExecuteResponse } from "@/lib/types";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

function pageNameFromUiDirective(d: unknown): string | null {
  if (!isPlainObject(d)) return null;
  if (d.openView !== "page") return null;
  const viewParams = d.viewParams;
  if (!isPlainObject(viewParams)) return null;
  const name = viewParams.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return name.trim();
}

export default function OrchestratorPlaygroundClient(props: { locale: string }) {
  const [message, setMessage] = useState<string>("");
  const [conversationId, setConversationId] = useState<string>("");
  const [turn, setTurn] = useState<DispatchResponse | null>(null);
  const [turnError, setTurnError] = useState<string>("");
  const [busyTurn, setBusyTurn] = useState<boolean>(false);

  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string>("");
  const [inputJson, setInputJson] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");

  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const [execError, setExecError] = useState<string>("");
  const [busyExec, setBusyExec] = useState<boolean>(false);

  const suggestions = useMemo(() => (Array.isArray(turn?.toolSuggestions) ? turn!.toolSuggestions! : []), [turn]);
  const sugPageSize = 20;
  const [sugPage, setSugPage] = useState(0);
  const sugTotalPages = Math.max(1, Math.ceil(suggestions.length / sugPageSize));
  const pagedSuggestions = useMemo(() => suggestions.slice(sugPage * sugPageSize, (sugPage + 1) * sugPageSize), [suggestions, sugPage]);

  const replyText = useMemo(() => {
    const rt = turn?.replyText;
    if (!rt) return "";
    if (typeof rt === "string") return rt;
    return text(rt, props.locale);
  }, [props.locale, turn?.replyText]);

  async function sendTurn() {
    setTurnError("");
    setExec(null);
    setExecError("");
    setActiveIdx(null);
    setBusyTurn(true);
    try {
      const res = await apiFetch(`/orchestrator/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          message,
          locale: props.locale,
          mode: "answer",
          ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      const turnData = (json as DispatchResponse) ?? null;
      setTurn(turnData);
      setSugPage(0);
      if (turnData?.conversationId) setConversationId(turnData.conversationId);
      if (!res.ok) setTurnError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    } finally {
      setBusyTurn(false);
    }
  }

  function openSuggestion(idx: number) {
    const s = suggestions[idx];
    setActiveIdx(idx);
    setActiveSuggestionId(s?.suggestionId ?? "");
    setInputJson(safeJsonString(s?.inputDraft));
    setIdempotencyKey(s?.idempotencyKey ?? "");
    setExec(null);
    setExecError("");
  }

  async function executeSuggestion() {
    const idx = activeIdx;
    if (idx === null) return;
    const s = suggestions[idx];
    const toolRef = s?.toolRef ?? "";
    setExecError("");
    setBusyExec(true);
    try {
      let input: unknown;
      try {
        input = JSON.parse(inputJson);
      } catch {
        setExecError(t(props.locale, "orchestrator.playground.invalidJson"));
        return;
      }
      const turnId = turn?.turnId ?? "";
      const suggestionId = (activeSuggestionId || s?.suggestionId || "").trim();
      const k = idempotencyKey.trim();
      const res = turnId && suggestionId
        ? await apiFetch(`/orchestrator/dispatch/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            locale: props.locale,
            body: JSON.stringify({ turnId, suggestionId, input, ...(k ? { idempotencyKey: k } : {}) }),
          })
        : await apiFetch(`/tools/${encodeURIComponent(toolRef)}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(k ? { "idempotency-key": k } : {}) },
            locale: props.locale,
            body: JSON.stringify(input),
          });
      const json: unknown = await res.json().catch(() => null);
      setExec((json as ExecuteResponse) ?? null);
      if (!res.ok) setExecError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    } finally {
      setBusyExec(false);
    }
  }

  const runHref = exec?.runId ? `/runs/${encodeURIComponent(exec.runId)}?lang=${encodeURIComponent(props.locale)}` : "";
  const approvalHref = exec?.approvalId ? `/gov/approvals/${encodeURIComponent(exec.approvalId)}?lang=${encodeURIComponent(props.locale)}` : "";
  const directivePageName = pageNameFromUiDirective(turn?.uiDirective);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "orchestrator.playground.title")}
        actions={null}
      />

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "orchestrator.playground.messageTitle")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t(props.locale, "orchestrator.playground.messagePlaceholder")}
              style={{ width: 520, maxWidth: "100%" }}
            />
            <input
              value={conversationId}
              onChange={(e) => setConversationId(e.target.value)}
              placeholder={t(props.locale, "orchestrator.playground.conversationIdPlaceholder")}
              style={{ width: 300, maxWidth: "100%" }}
            />
            <button onClick={sendTurn} disabled={busyTurn || !message.trim()}>
              {busyTurn ? t(props.locale, "orchestrator.playground.sending") : t(props.locale, "orchestrator.playground.send")}
            </button>
          </div>
        </Card>
      </div>

      {turnError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 12 }}>{turnError}</pre> : null}

      {replyText ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.replyTitle")}>
            {turn?.turnId ? (
              <div style={{ marginBottom: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                {t(props.locale, "orchestrator.playground.turnId")}: {turn.turnId}
              </div>
            ) : null}
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{replyText}</pre>
          </Card>
        </div>
      ) : null}

      {turn?.uiDirective ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.uiDirectiveTitle")}>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{safeJsonString(turn.uiDirective)}</pre>
            {directivePageName ? (
              <div style={{ marginTop: 8 }}>
                <Link href={`/p/${encodeURIComponent(directivePageName)}?lang=${encodeURIComponent(props.locale)}`}>
                  {t(props.locale, "orchestrator.playground.openPage")}
                </Link>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "orchestrator.playground.suggestionsTitle")}</span>
              <Badge>{suggestions.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "orchestrator.playground.table.suggestionId")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.table.toolRef")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.riskLevel")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.approvalRequired")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {pagedSuggestions.map((s, idx) => {
              const toolRef = s.toolRef ?? "";
              const isActive = activeIdx === idx;
              return (
                <tr key={`${toolRef}:${idx}`}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{s.suggestionId ?? "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{toolRef || "-"}</td>
                  <td>{s.riskLevel ?? "-"}</td>
                  <td>{boolLabel(Boolean(s.approvalRequired), props.locale)}</td>
                  <td>
                    {toolRef ? (
                      <button onClick={() => (isActive ? setActiveIdx(null) : openSuggestion(idx))}>
                        {isActive ? t(props.locale, "orchestrator.playground.close") : t(props.locale, "orchestrator.playground.editAndExecute")}
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {sugTotalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(props.locale, "pagination.showing").replace("{from}", String(sugPage * sugPageSize + 1)).replace("{to}", String(Math.min((sugPage + 1) * sugPageSize, suggestions.length)))}
              {t(props.locale, "pagination.total").replace("{count}", String(suggestions.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={sugPage === 0} onClick={() => setSugPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(sugPage + 1))}</span>
              <button disabled={sugPage >= sugTotalPages - 1} onClick={() => setSugPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
            </div>
          </div>
        )}
      </div>

      {activeIdx !== null ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.executeTitle")}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{t(props.locale, "orchestrator.playground.idempotencyKey")}</span>
                <input value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} style={{ width: 360, maxWidth: "100%" }} />
              </label>
              <button onClick={executeSuggestion} disabled={busyExec}>
                {busyExec ? t(props.locale, "orchestrator.playground.executing") : t(props.locale, "orchestrator.playground.execute")}
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 6 }}>{t(props.locale, "orchestrator.playground.inputJson")}</div>
              <textarea value={inputJson} onChange={(e) => setInputJson(e.target.value)} style={{ width: "100%", minHeight: 220, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
            </div>
            {execError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 12 }}>{execError}</pre> : null}
          </Card>
        </div>
      ) : null}

      {exec ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.resultTitle")}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "orchestrator.playground.status")}</span>
              <Badge>{statusLabel(String(exec.receipt?.status ?? "-"), props.locale)}</Badge>
              {exec.runId ? (
                <Link href={runHref}>
                  {t(props.locale, "orchestrator.playground.openRun")}
                </Link>
              ) : null}
              {exec.approvalId ? (
                <Link href={approvalHref}>
                  {t(props.locale, "orchestrator.playground.openApproval")}
                </Link>
              ) : null}
            </div>
            <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{safeJsonString(exec)}</pre>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
