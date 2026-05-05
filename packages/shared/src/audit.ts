/**
 * Audit Event Format & Hash Chain (S10)
 * Re-exported from @mindpal/protocol - the single source of truth.
 *
 * Additional runtime functions (insertAuditEvent, insertAuditEventFromShared)
 * remain here as they depend on pg database and cryptoUtils.
 */

// Re-export protocol-layer types, constants, and pure functions
export {
  AUDIT_ERROR_CATEGORIES,
  HIGH_RISK_AUDIT_ACTIONS,
  AuditContractError,
  normalizeAuditErrorCategory,
  isHighRiskAuditAction,
  generateHumanSummary,
  withPolicySnapshotRef,
} from '@mindpal/protocol';

export type {
  AuditQueryable,
  AuditPoolLike,
  AuditClientLike,
  AuditEventInput,
  AuditWriter,
  DetailedAuditEventInput,
  AuditErrorCategory,
  InsertAuditEventOptions,
  AuditEvidenceRef,
} from '@mindpal/protocol';

// ── Runtime DB functions (depend on pg and cryptoUtils) ──

import { computeEventHash } from "./cryptoUtils";
import type {
  AuditPoolLike,
  DetailedAuditEventInput,
  InsertAuditEventOptions,
  AuditEventInput,
} from '@mindpal/protocol';
import {
  AuditContractError,
  isHighRiskAuditAction,
  normalizeAuditErrorCategory,
  generateHumanSummary,
  withPolicySnapshotRef,
} from '@mindpal/protocol';

/**
 * 统一审计事件写入函数。
 *
 * - 不带 tenantId 或 skipHashChain=true → 简单 INSERT
 * - 带 tenantId 且 skipHashChain=false → 事务性哈希链写入
 */
export async function insertAuditEvent(
  pool: AuditPoolLike,
  e: DetailedAuditEventInput,
  opts?: InsertAuditEventOptions,
) {
  if (process.env.AUDIT_FORCE_FAIL === "1") throw new Error("audit_force_fail");

  const policySnapshotRef = String(e.policySnapshotRef ?? "").trim() || null;

  // 高风险审计动作校验
  const missingContextFields: string[] = [];
  if (isHighRiskAuditAction({ resourceType: e.resourceType, action: e.action })) {
    if (!String(e.runId ?? "").trim()) missingContextFields.push("runId");
    if (!String(e.stepId ?? "").trim()) missingContextFields.push("stepId");
    if (!policySnapshotRef) missingContextFields.push("policySnapshotRef");
    if (missingContextFields.length > 0) {
      throw new AuditContractError({
        errorCode: "AUDIT_CONTEXT_REQUIRED",
        message: "high_risk_audit_context_required",
        details: {
          resourceType: e.resourceType,
          action: e.action,
          missing: missingContextFields,
        },
      });
    }
  }

  const policyDecision = withPolicySnapshotRef(e.policyDecision, policySnapshotRef);
  const errorCategory = normalizeAuditErrorCategory(e.errorCategory);

  // P3-3: humanSummary
  const humanSummary = e.humanSummary ?? generateHumanSummary(e);
  const enrichedOutputDigest =
    e.outputDigest && typeof e.outputDigest === "object" && !Array.isArray(e.outputDigest)
      ? { ...(e.outputDigest as Record<string, unknown>), humanSummary }
      : e.outputDigest
        ? { _original: e.outputDigest, humanSummary }
        : { humanSummary };

  const useHashChain = !!e.tenantId && !opts?.skipHashChain;

  if (!useHashChain) {
    await pool.query(
      `
        INSERT INTO audit_events (
          subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, policy_decision, input_digest, output_digest,
          idempotency_key, result, trace_id, request_id, run_id, step_id, error_category, latency_ms, outbox_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
      `,
      [
        e.subjectId ?? null,
        e.tenantId ?? null,
        e.spaceId ?? null,
        e.resourceType,
        e.action,
        e.toolRef ?? null,
        e.workflowRef ?? null,
        policyDecision,
        e.inputDigest ?? null,
        enrichedOutputDigest,
        e.idempotencyKey ?? null,
        e.result,
        e.traceId,
        e.requestId ?? null,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        e.latencyMs ?? null,
        e.outboxId ?? null,
      ],
    );
    return;
  }

  // ── 事务性哈希链写入 ──
  const ts0 = e.outboxId ? new Date().toISOString() : (e.timestamp ?? new Date().toISOString());
  const normalizedBase = {
    subjectId: e.subjectId ?? null,
    tenantId: e.tenantId ?? null,
    spaceId: e.spaceId ?? null,
    resourceType: e.resourceType,
    action: e.action,
    toolRef: e.toolRef ?? null,
    workflowRef: e.workflowRef ?? null,
    result: e.result,
    traceId: e.traceId,
    requestId: e.requestId ?? null,
    runId: e.runId ?? null,
    stepId: e.stepId ?? null,
    idempotencyKey: e.idempotencyKey ?? null,
    errorCategory,
    latencyMs: e.latencyMs ?? null,
    policyDecision,
    inputDigest: e.inputDigest ?? null,
    outputDigest: enrichedOutputDigest,
    outboxId: e.outboxId ?? null,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [e.tenantId]);
    const prevRes = await client.query(
      "SELECT event_hash, timestamp FROM audit_events WHERE tenant_id = $1 AND event_hash IS NOT NULL ORDER BY timestamp DESC, event_id DESC LIMIT 1",
      [e.tenantId],
    );
    const prevHash = prevRes.rowCount ? (prevRes.rows[0].event_hash as string | null) : null;
    const prevTs = prevRes.rowCount ? (prevRes.rows[0].timestamp as any) : null;
    let ts = ts0;
    const tsMs = new Date(ts0).getTime();
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    if (Number.isFinite(prevMs) && Number.isFinite(tsMs) && tsMs <= prevMs) ts = new Date(Math.max(Date.now(), prevMs + 1)).toISOString();
    if (!Number.isFinite(tsMs) && Number.isFinite(prevMs)) ts = new Date(Math.max(Date.now(), prevMs + 1)).toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, policy_decision, input_digest, output_digest,
          idempotency_key, result, trace_id, request_id, run_id, step_id, error_category, latency_ms,
          prev_hash, event_hash, outbox_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22
        )
      `,
      [
        ts,
        e.subjectId ?? null,
        e.tenantId ?? null,
        e.spaceId ?? null,
        e.resourceType,
        e.action,
        e.toolRef ?? null,
        e.workflowRef ?? null,
        policyDecision,
        e.inputDigest ?? null,
        enrichedOutputDigest,
        e.idempotencyKey ?? null,
        e.result,
        e.traceId,
        e.requestId ?? null,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        e.latencyMs ?? null,
        prevHash,
        eventHash,
        e.outboxId ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 将简单 AuditEventInput 转换为 DetailedAuditEventInput 并写入。
 */
export async function insertAuditEventFromShared(
  pool: AuditPoolLike,
  event: AuditEventInput,
): Promise<void> {
  const outcomeMap: Record<string, "success" | "denied" | "error"> = {
    success: "success",
    failure: "error",
    denied: "denied",
  };
  await insertAuditEvent(pool, {
    tenantId: event.tenantId,
    subjectId: event.subject,
    resourceType: event.resourceType,
    action: event.action,
    result: outcomeMap[event.outcome] ?? "error",
    traceId: event.traceId ?? "",
    timestamp: event.timestamp,
    inputDigest: event.details ?? null,
    outputDigest: event.resourceId ? { resourceId: event.resourceId } : null,
  });
}
