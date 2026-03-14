import type { Pool } from "pg";
import { attachDlpSummary, redactValue } from "@openslin/shared";
import { sha256Hex, stableStringify } from "./common";

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

export async function writeAudit(
  pool: Pool,
  e: {
    traceId: string;
    tenantId?: string;
    spaceId?: string | null;
    subjectId?: string | null;
    runId?: string;
    stepId?: string;
    toolRef?: string;
    resourceType?: string;
    action?: string;
    result: "success" | "error";
    inputDigest?: any;
    outputDigest?: any;
    errorCategory?: string;
  },
) {
  const redactedIn = redactValue(e.inputDigest);
  const redactedOut = redactValue(e.outputDigest);
  const outputDigest0 = attachDlpSummary(redactedOut.value, redactedOut.summary);
  const outputDigest =
    outputDigest0 && typeof outputDigest0 === "object" && !Array.isArray(outputDigest0)
      ? (() => {
          const obj: any = outputDigest0 as any;
          if (obj.safetySummary && typeof obj.safetySummary === "object" && !Array.isArray(obj.safetySummary)) {
            const ss: any = obj.safetySummary;
            if (!ss.dlpSummary) ss.dlpSummary = redactedOut.summary;
          } else if (obj.safetySummary === undefined) {
            obj.safetySummary = { decision: "allowed", dlpSummary: redactedOut.summary };
          }
          return obj;
        })()
      : outputDigest0;
  const normalizedBase = {
    subjectId: e.subjectId ?? null,
    tenantId: e.tenantId ?? null,
    spaceId: e.spaceId ?? null,
    resourceType: e.resourceType ?? "tool",
    action: e.action ?? "execute",
    toolRef: e.toolRef ?? null,
    workflowRef: e.runId ?? null,
    result: e.result,
    traceId: e.traceId,
    requestId: null,
    runId: e.runId ?? null,
    stepId: e.stepId ?? null,
    idempotencyKey: null,
    errorCategory: e.errorCategory ?? null,
    latencyMs: null,
    policyDecision: null,
    inputDigest: redactedIn.value ?? null,
    outputDigest: outputDigest ?? null,
  };

  if (!e.tenantId) {
    const ts = new Date().toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    await pool.query(
      `
        INSERT INTO audit_events (timestamp, subject_id, tenant_id, space_id, resource_type, action, tool_ref, workflow_ref, input_digest, output_digest, result, trace_id, run_id, step_id, error_category)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `,
      [
        ts,
        e.subjectId ?? null,
        null,
        e.spaceId ?? null,
        normalized.resourceType,
        normalized.action,
        e.toolRef ?? null,
        e.runId ?? null,
        redactedIn.value ?? null,
        outputDigest ?? null,
        e.result,
        e.traceId,
        e.runId ?? null,
        e.stepId ?? null,
        e.errorCategory ?? null,
      ],
    );
    return;
  }

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
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    const ts = new Date(Math.max(Date.now(), Number.isFinite(prevMs) ? prevMs + 1 : 0)).toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, input_digest, output_digest,
          result, trace_id, run_id, step_id, error_category,
          prev_hash, event_hash
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17
        )
      `,
      [
        ts,
        e.subjectId ?? null,
        e.tenantId,
        e.spaceId ?? null,
        normalized.resourceType,
        normalized.action,
        e.toolRef ?? null,
        e.runId ?? null,
        redactedIn.value ?? null,
        outputDigest ?? null,
        e.result,
        e.traceId,
        e.runId ?? null,
        e.stepId ?? null,
        e.errorCategory ?? null,
        prevHash,
        eventHash,
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
