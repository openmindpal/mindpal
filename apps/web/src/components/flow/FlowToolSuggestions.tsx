"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import { safeJsonString } from "@/lib/apiError";
import { type ToolSuggestion } from "@/lib/types";
import {
  type ToolExecState,
  friendlyToolName, riskBadgeKey, riskBadgeClass, friendlyOutputSummary,
} from "../../app/homeHelpers";
import { IconExternal } from "../../app/HomeIcons";
import styles from "../../app/page.module.css";

export function FlowToolSuggestions({ locale, it, toolExecStates, executeToolInline }: {
  locale: string;
  it: { id: string; suggestions: ToolSuggestion[] };
  toolExecStates: Record<string, ToolExecState>;
  executeToolInline: (flowItemId: string, idx: number, s: ToolSuggestion) => void;
}) {
  return (
    <div className={styles.bubbleText}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(locale, "chat.toolSuggestion.title")}</div>
      {it.suggestions.map((s, idx) => {
        const toolRef = String(s.toolRef ?? "").trim();
        const risk = String(s.riskLevel ?? "low").trim();
        const approval = Boolean(s.approvalRequired);
        const execKey = `${it.id}_${idx}`;
        const execState = toolExecStates[execKey] ?? { status: "idle" };
        const doneRunStatus = execState.status === "done" ? (execState.runStatus ?? String(execState.result?.receipt?.status ?? "")) : "";
        return (
          <div key={execKey} className={styles.toolSuggestionCard}>
            <div className={styles.toolSuggestionHeader}>
              <span className={styles.toolSuggestionName}>{friendlyToolName(locale, toolRef)}</span>
              <span className={`${styles.toolSuggestionBadge} ${riskBadgeClass(risk, styles)}`}>{t(locale, riskBadgeKey(risk))}</span>
              <span className={`${styles.toolSuggestionBadge} ${styles.toolSuggestionBadgeApproval}`}>
                {t(locale, approval ? "chat.toolSuggestion.needsApproval" : "chat.toolSuggestion.noApproval")}
              </span>
            </div>
            {s.inputDraft != null && (
              <div className={styles.toolSuggestionInput}>
                <div className={styles.toolSuggestionInputLabel}>{t(locale, "chat.toolSuggestion.inputLabel")}</div>
                <pre className={styles.toolSuggestionInputPre}>{safeJsonString(s.inputDraft)}</pre>
              </div>
            )}
            <div className={styles.toolSuggestionActions}>
              {execState.status === "idle" && toolRef && (
                <button className={styles.toolExecBtn} onClick={() => void executeToolInline(it.id, idx, s)} aria-label={`执行工具: ${friendlyToolName(locale, toolRef)}`}>
                  {t(locale, "chat.toolSuggestion.execute")}
                </button>
              )}
              {execState.status === "executing" && (
                <button className={styles.toolExecBtn} disabled>{t(locale, "chat.toolSuggestion.executing")}</button>
              )}
              <Link className={styles.inlineBtn} href={`/orchestrator?lang=${encodeURIComponent(locale)}`}>
                <IconExternal /> {t(locale, "chat.toolSuggestion.viewDetail")}
              </Link>
            </div>
            {execState.status === "polling" && (
              <div className={styles.toolExecPolling}>
                {t(locale, "chat.toolSuggestion.polling")}
                {execState.runStatus && execState.runStatus !== "queued" && (
                  <span style={{ marginLeft: 4, fontWeight: 500 }}>({t(locale, `chat.toolSuggestion.runStatus.${execState.runStatus}`)})</span>
                )}
              </div>
            )}
            {execState.status === "done" && (
              <FlowToolExecDone locale={locale} execState={execState} doneRunStatus={doneRunStatus} toolRef={toolRef} />
            )}
            {execState.status === "error" && (
              <div className={`${styles.toolExecResult} ${styles.toolExecResultFailed}`}>
                {t(locale, "chat.toolSuggestion.resultFailed")}: {execState.message}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FlowToolExecDone({ locale, execState, doneRunStatus, toolRef }: {
  locale: string;
  execState: ToolExecState & { status: "done" };
  doneRunStatus: string;
  toolRef: string;
}) {
  return (
    <>
      <div className={`${styles.toolExecResult} ${
        doneRunStatus === "needs_approval" || doneRunStatus === "queued" ? styles.toolExecResultQueued
        : doneRunStatus === "failed" || doneRunStatus === "canceled" || doneRunStatus === "deadletter" ? styles.toolExecResultFailed
        : styles.toolExecResultSuccess
      }`}>
        {doneRunStatus === "needs_approval" ? t(locale, "chat.toolSuggestion.resultApproval")
          : doneRunStatus === "queued" ? t(locale, "chat.toolSuggestion.resultQueued")
          : doneRunStatus === "failed" || doneRunStatus === "deadletter" ? t(locale, "chat.toolSuggestion.runStatus.failed")
          : doneRunStatus === "canceled" ? t(locale, "chat.toolSuggestion.runStatus.canceled")
          : t(locale, "chat.toolSuggestion.runStatus.succeeded")}
        {execState.result?.runId && (
          <span style={{ marginLeft: 8 }}>
            <Link className={styles.inlineLink} href={`/runs/${encodeURIComponent(execState.result.runId)}?lang=${encodeURIComponent(locale)}`}>
              {t(locale, "orchestrator.playground.openRun")}
            </Link>
          </span>
        )}
      </div>
      {doneRunStatus === "succeeded" && (() => {
        const summary = friendlyOutputSummary(locale, toolRef, execState.stepOutput);
        return (
          <div className={styles.toolExecSummary}>
            <div className={styles.toolExecSummaryText}>{summary.text}</div>
            {summary.latencyMs != null && (
              <div className={styles.toolExecSummaryMeta}>
                <span>{t(locale, "chat.toolSuggestion.latency")} {(summary.latencyMs / 1000).toFixed(1)}s</span>
              </div>
            )}
            {execState.result?.runId && (
              <div className={styles.toolExecSummaryLink}>
                <Link className={styles.inlineLink} href={`/runs/${encodeURIComponent(execState.result.runId)}?lang=${encodeURIComponent(locale)}`}>
                  {t(locale, "chat.toolSuggestion.viewRun")}
                </Link>
              </div>
            )}
          </div>
        );
      })()}
      {(doneRunStatus === "failed" || doneRunStatus === "deadletter") && execState.stepError && (
        <div className={styles.toolExecOutputWrap}>
          <div className={styles.toolExecOutputLabel}>{t(locale, "chat.toolSuggestion.errorDetail")}</div>
          <pre className={styles.toolExecOutputPre}>{execState.stepError}</pre>
        </div>
      )}
    </>
  );
}
