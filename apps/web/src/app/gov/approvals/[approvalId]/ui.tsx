"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { getPhaseLabel } from "@/lib/types";
import { Badge, Card, PageHeader, Table, StatusBadge, StructuredData } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import type { BadgeTone } from "@/components/ui";

type ApprovalDetail = ApiError & { approval?: unknown; run?: unknown; steps?: unknown[] };

const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

function safeStr(v: unknown, fallback = "-"): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function statusLabel(locale: string, raw: unknown): string {
  const s = safeStr(raw, "").toLowerCase();
  if (s === "pending") return t(locale, "gov.approvals.status.pending");
  if (s === "approved") return t(locale, "gov.approvals.status.approved");
  if (s === "rejected") return t(locale, "gov.approvals.status.rejected");
  if (["queued", "running", "succeeded", "failed", "canceled", "needs_approval"].includes(s)) return getPhaseLabel(s, locale);
  return safeStr(raw);
}

function statusTone(raw: unknown): BadgeTone {
  const s = safeStr(raw, "").toLowerCase();
  if (s === "pending" || s === "needs_approval") return "warning";
  if (s === "approved" || s === "succeeded") return "success";
  if (s === "rejected" || s === "failed" || s === "canceled") return "danger";
  return "neutral";
}

function fmtToolRef(v: unknown): string {
  const s = safeStr(v, "");
  if (!s) return "-";
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--sl-border, #e5e7eb)", alignItems: "flex-start" }}>
      <span style={{ flexShrink: 0, width: 120, fontSize: 13, color: "var(--sl-muted, #6b7280)", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, wordBreak: "break-all", flex: 1 }}>{children}</span>
    </div>
  );
}

export default function ApprovalDetailClient(props: { locale: string; approvalId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ApprovalDetail | null>((props.initial as ApprovalDetail) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [reason, setReason] = useState<string>("");

  const approval = useMemo(() => {
    if (!data?.approval || typeof data.approval !== "object") return null;
    return data.approval as Record<string, unknown>;
  }, [data]);

  const run = useMemo(() => {
    if (!data?.run || typeof data.run !== "object") return null;
    return data.run as Record<string, unknown>;
  }, [data]);

  const steps = useMemo(() => (Array.isArray(data?.steps) ? data!.steps! : []), [data]);

  const assessmentContext = useMemo(() => {
    if (!approval?.assessmentContext || typeof approval.assessmentContext !== "object") return null;
    return approval.assessmentContext as Record<string, unknown>;
  }, [approval]);

  const approvalStatus = safeStr(approval?.status, "").toLowerCase();
  const isPending = approvalStatus === "pending";

  async function refresh() {
    setError("");
    const res = await apiFetch(`/approvals/${encodeURIComponent(props.approvalId)}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ApprovalDetail) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function decide(decision: "approve" | "reject") {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/approvals/${encodeURIComponent(props.approvalId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ decision, reason: reason.trim() ? reason.trim() : undefined }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.approvalDetail.title")}
        description={
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Link
              href={`/gov/approvals?lang=${encodeURIComponent(props.locale)}`}
              style={{ color: "var(--sl-accent, #2563eb)", textDecoration: "none", fontSize: 13 }}
            >
              ← {t(props.locale, "gov.approvalDetail.backToList")}
            </Link>
            {approval && (
              <Badge tone={statusTone(approval.status)}>{statusLabel(props.locale, approval.status)}</Badge>
            )}
          </div>
        }
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

      {isPending && (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.approvalDetail.actionsTitle")}>
            <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--sl-muted, #6b7280)" }}>{t(props.locale, "gov.approvalDetail.reason")}</div>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy}
                  placeholder={t(props.locale, "gov.approvalDetail.reasonPlaceholder")}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border, #d1d5db)" }}
                />
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => decide("approve")}
                  disabled={busy}
                  style={{ padding: "6px 20px", borderRadius: 6, background: "#16a34a", color: "#fff", border: "none", cursor: busy ? "not-allowed" : "pointer", fontWeight: 600 }}
                >
                  {t(props.locale, "gov.approvalDetail.approve")}
                </button>
                <button
                  onClick={() => decide("reject")}
                  disabled={busy}
                  style={{ padding: "6px 20px", borderRadius: 6, background: "#dc2626", color: "#fff", border: "none", cursor: busy ? "not-allowed" : "pointer", fontWeight: 600 }}
                >
                  {t(props.locale, "gov.approvalDetail.reject")}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {assessmentContext && (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.approvalDetail.assessmentTitle")}>
            <AssessmentContextView ctx={assessmentContext} locale={props.locale} />
          </Card>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvalDetail.approvalTitle")}>
          {approval ? (
            <div style={{ display: "grid", gap: 0 }}>
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.approvalId")}>
                <span style={{ fontFamily: mono }}>{safeStr(approval.approvalId)}</span>
              </FieldRow>
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.status")}>
                <Badge tone={statusTone(approval.status)}>{statusLabel(props.locale, approval.status)}</Badge>
              </FieldRow>
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.toolRef")}>
                {fmtToolRef(approval.toolRef)}
              </FieldRow>
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.runId")}>
                <Link
                  href={`/runs/${encodeURIComponent(safeStr(approval.runId, ""))}?lang=${encodeURIComponent(props.locale)}`}
                  style={{ fontFamily: mono, color: "var(--sl-accent, #2563eb)", textDecoration: "none" }}
                >
                  {safeStr(approval.runId)}
                </Link>
              </FieldRow>
              {Boolean(approval.stepId) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.field.stepId")}>
                  <span style={{ fontFamily: mono }}>{safeStr(approval.stepId)}</span>
                </FieldRow>
              )}
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.requestedBy")}>
                {safeStr(approval.requestedBySubjectId)}
              </FieldRow>
              {Boolean(approval.spaceId) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.field.spaceId")}>
                  {safeStr(approval.spaceId)}
                </FieldRow>
              )}
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.requestedAt")}>
                {fmtDateTime(approval.requestedAt, props.locale)}
              </FieldRow>
              <FieldRow label={t(props.locale, "gov.approvalDetail.field.updatedAt")}>
                {fmtDateTime(approval.updatedAt, props.locale)}
              </FieldRow>
              {Boolean(approval.policySnapshotRef) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.field.policySnapshotRef")}>
                  <span style={{ fontFamily: mono }}>{safeStr(approval.policySnapshotRef)}</span>
                </FieldRow>
              )}
              {Boolean(approval.inputDigest) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.field.inputDigest")}>
                  <StructuredData data={approval.inputDigest} locale={props.locale} />
                </FieldRow>
              )}
            </div>
          ) : (
            <span style={{ color: "var(--sl-muted)", fontStyle: "italic" }}>{t(props.locale, "gov.approvalDetail.noData")}</span>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvalDetail.runTitle")}>
          {run ? (
            <div style={{ display: "grid", gap: 0 }}>
              <FieldRow label={t(props.locale, "gov.approvalDetail.run.runId")}>
                <Link
                  href={`/runs/${encodeURIComponent(safeStr(run.runId ?? run.run_id, ""))}?lang=${encodeURIComponent(props.locale)}`}
                  style={{ fontFamily: mono, color: "var(--sl-accent, #2563eb)", textDecoration: "none" }}
                >
                  {safeStr(run.runId ?? run.run_id)}
                </Link>
              </FieldRow>
              <FieldRow label={t(props.locale, "gov.approvalDetail.run.status")}>
                <Badge tone={statusTone(run.status)}>{statusLabel(props.locale, run.status)}</Badge>
              </FieldRow>
              {Boolean(run.prompt || run.input) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.run.prompt")}>
                  {safeStr(run.prompt ?? run.input)}
                </FieldRow>
              )}
              <FieldRow label={t(props.locale, "gov.approvalDetail.run.createdAt")}>
                {fmtDateTime(run.createdAt ?? run.created_at, props.locale)}
              </FieldRow>
              {Boolean(run.updatedAt ?? run.updated_at) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.run.updatedAt")}>
                  {fmtDateTime(run.updatedAt ?? run.updated_at, props.locale)}
                </FieldRow>
              )}
              {Boolean(run.finishedAt ?? run.finished_at) && (
                <FieldRow label={t(props.locale, "gov.approvalDetail.run.finishedAt")}>
                  {fmtDateTime(run.finishedAt ?? run.finished_at, props.locale)}
                </FieldRow>
              )}
            </div>
          ) : (
            <span style={{ color: "var(--sl-muted)", fontStyle: "italic" }}>{t(props.locale, "gov.approvalDetail.noData")}</span>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>{t(props.locale, "gov.approvalDetail.stepsTitle")}</span>
              <Badge>{steps.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.approvalDetail.step.stepId")}</th>
              <th align="left">{t(props.locale, "gov.approvalDetail.step.seq")}</th>
              <th align="left">{t(props.locale, "gov.approvalDetail.step.status")}</th>
              <th align="left">{t(props.locale, "gov.approvalDetail.step.toolRef")}</th>
            </tr>
          </thead>
          <tbody>
            {steps.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: "24px 16px", color: "var(--sl-muted)", fontStyle: "italic" }}>
                  {t(props.locale, "gov.approvalDetail.noData")}
                </td>
              </tr>
            ) : (
              steps.map((s, idx) => {
                const o = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
                const stepId = String(o.stepId ?? o.step_id ?? "");
                return (
                  <tr key={`${stepId}:${idx}`}>
                    <td style={{ fontFamily: mono }}>{stepId || "-"}</td>
                    <td>{String(o.seq ?? "-")}</td>
                    <td>
                      <Badge tone={statusTone(o.status)}>{statusLabel(props.locale, o.status)}</Badge>
                    </td>
                    <td style={{ fontFamily: mono }}>{fmtToolRef(o.toolRef ?? o.tool_ref)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

/* ─── 纯数据驱动的评估上下文渲染器（零硬编码，适应任意规则结构） ─── */

function AssessmentContextView({ ctx, locale }: { ctx: Record<string, unknown>; locale: string }) {
  const riskLevel = typeof ctx.riskLevel === "string" ? ctx.riskLevel : null;
  const humanSummary = typeof ctx.humanSummary === "string" ? ctx.humanSummary : null;
  const matchedRules = Array.isArray(ctx.matchedRules) ? ctx.matchedRules : [];
  const approverRoles = Array.isArray(ctx.approverRoles) ? ctx.approverRoles : [];
  const requiredApprovals = typeof ctx.requiredApprovals === "number" ? ctx.requiredApprovals : null;
  const expiresInMinutes = typeof ctx.expiresInMinutes === "number" ? ctx.expiresInMinutes : null;
  const riskFactors = Array.isArray(ctx.riskFactors) ? ctx.riskFactors : [];

  const knownKeys = new Set(["riskLevel", "humanSummary", "matchedRules", "approverRoles", "requiredApprovals", "expiresInMinutes", "riskFactors", "approvalRequired"]);

  return (
    <div style={{ display: "grid", gap: 0 }}>
      {humanSummary && (
        <div style={{ padding: "10px 0", borderBottom: "1px solid var(--sl-border, #e5e7eb)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sl-muted, #6b7280)", marginBottom: 4 }}>
            {t(locale, "gov.approvalDetail.assessment.summary")}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--sl-fg, #111)" }}>{humanSummary}</div>
        </div>
      )}

      {riskLevel && (
        <FieldRow label={t(locale, "gov.approvalDetail.assessment.riskLevel")}>
          <Badge tone={riskLevel === "high" ? "danger" : riskLevel === "medium" ? "warning" : "success"}>
            {riskLevel.toUpperCase()}
          </Badge>
        </FieldRow>
      )}

      {requiredApprovals != null && requiredApprovals > 1 && (
        <FieldRow label={t(locale, "gov.approvalDetail.assessment.requiredApprovals")}>
          {requiredApprovals} {t(locale, "gov.approvalDetail.assessment.people")}
        </FieldRow>
      )}

      {approverRoles.length > 0 && (
        <FieldRow label={t(locale, "gov.approvalDetail.assessment.approverRoles")}>
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {approverRoles.map((r, i) => (
              <Badge key={i} tone="neutral">{String(r)}</Badge>
            ))}
          </span>
        </FieldRow>
      )}

      {expiresInMinutes != null && (
        <FieldRow label={t(locale, "gov.approvalDetail.assessment.expiresIn")}>
          {expiresInMinutes >= 60
            ? `${Math.round(expiresInMinutes / 60)} ${t(locale, "gov.approvalDetail.assessment.hours")}`
            : `${expiresInMinutes} ${t(locale, "gov.approvalDetail.assessment.minutes")}`}
        </FieldRow>
      )}

      {riskFactors.length > 0 && (
        <FieldRow label={t(locale, "gov.approvalDetail.assessment.riskFactors")}>
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {riskFactors.map((f, i) => (
              <Badge key={i} tone="warning">{String(f)}</Badge>
            ))}
          </span>
        </FieldRow>
      )}

      {matchedRules.length > 0 && (
        <div style={{ padding: "10px 0" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sl-muted, #6b7280)", marginBottom: 8 }}>
            {t(locale, "gov.approvalDetail.assessment.matchedRules")} ({matchedRules.length})
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {matchedRules.map((mr: any, i: number) => {
              const ruleName = mr?.rule?.name ?? mr?.rule?.ruleId ?? `#${i + 1}`;
              const explanation = mr?.explanation ?? "";
              const ruleDesc = mr?.rule?.description ?? "";
              return (
                <div key={i} style={{ padding: "8px 10px", borderRadius: 6, background: "var(--sl-surface, #f9fafb)", border: "1px solid var(--sl-border, #e5e7eb)" }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{ruleName}</div>
                  {explanation && <div style={{ fontSize: 12, color: "var(--sl-muted, #6b7280)", marginTop: 2 }}>{explanation}</div>}
                  {ruleDesc && ruleDesc !== explanation && <div style={{ fontSize: 12, color: "var(--sl-muted, #6b7280)", marginTop: 2, fontStyle: "italic" }}>{ruleDesc}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 未识别字段自动展示 —— 规则引擎新增任何字段时前端自动渲染，无需改代码 */}
      {Object.entries(ctx)
        .filter(([k]) => !knownKeys.has(k))
        .map(([k, v]) => (
          <FieldRow key={k} label={k}>
            {typeof v === "string" || typeof v === "number" || typeof v === "boolean"
              ? String(v)
              : <StructuredData data={v} locale={locale} />}
          </FieldRow>
        ))}
    </div>
  );
}