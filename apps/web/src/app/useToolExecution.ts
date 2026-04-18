"use client";

import { useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errorMessageText, isPlainObject } from "@/lib/apiError";
import { type ToolSuggestion, type ExecuteResponse } from "@/lib/types";
import { type ToolExecState, TERMINAL_RUN_STATUSES } from "./homeHelpers";

/**
 * useToolExecution — handles inline tool execution and run polling
 * for tool suggestion cards in the chat flow.
 */
export default function useToolExecution({
  locale,
  setToolExecStates,
}: {
  locale: string;
  setToolExecStates: React.Dispatch<React.SetStateAction<Record<string, ToolExecState>>>;
}) {
  /* ─── Poll helper: repeatedly GET /runs/:runId until terminal ─── */
  const pollRunResult = useCallback(async (execKey: string, runId: string, result: ExecuteResponse) => {
    const POLL_INTERVAL = 1500;
    const MAX_POLL_TIME = 60_000;
    const startedAt = Date.now();

    setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "polling", runId } }));

    const poll = async (): Promise<void> => {
      if (Date.now() - startedAt > MAX_POLL_TIME) {
        setToolExecStates((prev) => ({
          ...prev,
          [execKey]: { status: "error", message: t(locale, "chat.toolSuggestion.pollTimeout") },
        }));
        return;
      }

      try {
        const res = await apiFetch(`/runs/${encodeURIComponent(runId)}`, { method: "GET", locale });
        if (!res.ok) {
          setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result, runStatus: "queued" } }));
          return;
        }
        const data = (await res.json()) as { run?: { status?: string }; steps?: Array<{ status?: string; outputDigest?: unknown; errorCategory?: string; lastError?: string }> };
        const runStatus = String(data.run?.status ?? "queued");

        if (TERMINAL_RUN_STATUSES.has(runStatus)) {
          const step0 = Array.isArray(data.steps) ? data.steps[0] : undefined;
          const stepOutput = step0?.outputDigest ?? null;
          const stepError = step0?.lastError ?? step0?.errorCategory ?? undefined;
          setToolExecStates((prev) => ({
            ...prev,
            [execKey]: { status: "done", result, runStatus, stepOutput, stepError },
          }));
          return;
        }

        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "polling", runId, runStatus } }));
      } catch {
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result, runStatus: "queued" } }));
        return;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      return poll();
    };

    await poll();
  }, [locale, setToolExecStates]);

  /* ─── Inline tool execute handler ─── */
  const executeToolInline = useCallback(async (flowItemId: string, suggestionIdx: number, s: ToolSuggestion) => {
    const execKey = `${flowItemId}_${suggestionIdx}`;
    setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "executing" } }));
    try {
      const toolRef = String(s.toolRef ?? "").trim();
      if (!toolRef) throw new Error(t(locale, "error.missingToolRef"));
      const res = await apiFetch(`/tools/${encodeURIComponent(toolRef)}/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(s.idempotencyKey ? { "idempotency-key": s.idempotencyKey } : {}),
        },
        locale,
        body: JSON.stringify(s.inputDraft ?? {}),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = isPlainObject(json) ? (json as ApiError) : {};
        throw new Error(errorMessageText(locale, e.message ?? String(e.errorCode ?? res.statusText)));
      }
      const result = (json as ExecuteResponse) ?? {};
      const receiptStatus = String(result.receipt?.status ?? "");

      if (receiptStatus === "needs_approval") {
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result, runStatus: "needs_approval" } }));
      } else if (result.runId) {
        void pollRunResult(execKey, result.runId, result);
      } else {
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result } }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "error", message: msg } }));
    }
  }, [locale, pollRunResult, setToolExecStates]);

  return { executeToolInline, pollRunResult };
}
