/**
 * auditWriter.ts — 知识处理模块的统一审计写入器
 *
 * 消除 processor.ts / embedding.ts / ingest.ts 中 writeAudit 三重克隆。
 * 所有知识处理审计事件必须通过本模块写入，禁止各文件自行实现。
 *
 * 使用 shared AuditEventInput 标准接口，数据库写入含哈希链保证不可篡改。
 */
import type { Pool } from "pg";
import type { AuditEventInput } from "@openslin/shared";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue, computeEventHash } from "@openslin/shared";

/**
 * 将知识模块审计参数转换为标准 AuditEventInput 并写入 audit_events 表。
 *
 * 功能目标：消除知识模块独立的审计 SQL 拼装，统一走哈希链写入路径，
 * 同时保留 DLP 脱敏与错误分类能力。
 */
export async function writeKnowledgeAudit(pool: Pool, params: { traceId: string; tenantId: string; spaceId: string; action: string; inputDigest?: any; outputDigest?: any; errorCategory?: string }) {
  const errorCategory = normalizeAuditErrorCategory(params.errorCategory);
  const redactedIn = redactValue(params.inputDigest);
  const redactedOut = redactValue(params.outputDigest);
  const outputDigest = attachDlpSummary(redactedOut.value, redactedOut.summary);

  // 构造符合 shared AuditEventInput 的标准化结构
  const _standardEvent: AuditEventInput = {
    tenantId: params.tenantId,
    action: params.action,
    resourceType: "knowledge",
    subject: "system",
    outcome: errorCategory ? "failure" : "success",
    traceId: params.traceId,
    details: {
      spaceId: params.spaceId,
      inputDigest: redactedIn.value ?? null,
      outputDigest: outputDigest ?? null,
      errorCategory,
    },
  };

  // 哈希链写入（保证审计不可篡改）
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [params.tenantId]);
    const prevRes = await client.query(
      "SELECT event_hash, timestamp FROM audit_events WHERE tenant_id = $1 AND event_hash IS NOT NULL ORDER BY timestamp DESC, event_id DESC LIMIT 1",
      [params.tenantId],
    );
    const prevHash = prevRes.rowCount ? (prevRes.rows[0].event_hash as string | null) : null;
    const prevTs = prevRes.rowCount ? (prevRes.rows[0].timestamp as any) : null;
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    const ts = new Date(Math.max(Date.now(), Number.isFinite(prevMs) ? prevMs + 1 : 0)).toISOString();
    const normalized = {
      timestamp: ts,
      subjectId: "system",
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      resourceType: "knowledge",
      action: params.action,
      toolRef: null,
      workflowRef: null,
      result: errorCategory ? "error" : "success",
      traceId: params.traceId,
      requestId: null,
      runId: null,
      stepId: null,
      idempotencyKey: null,
      errorCategory,
      latencyMs: null,
      policyDecision: null,
      inputDigest: redactedIn.value ?? null,
      outputDigest: outputDigest ?? null,
    };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          policy_decision, input_digest, output_digest, idempotency_key,
          result, trace_id, request_id, run_id, step_id, error_category, latency_ms,
          prev_hash, event_hash
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,
          $18,$19
        )
      `,
      [
        ts,
        "system",
        params.tenantId,
        params.spaceId,
        "knowledge",
        params.action,
        null,
        redactedIn.value ?? null,
        outputDigest ?? null,
        null,
        errorCategory ? "error" : "success",
        params.traceId,
        null,
        null,
        null,
        errorCategory,
        null,
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
