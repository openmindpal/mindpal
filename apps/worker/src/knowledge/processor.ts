import type { Pool } from "pg";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue, sha256Hex, stableStringify } from "@openslin/shared";
import { chunkText as knowledgeChunkText, resolveChunkConfigFromEnv, defaultChunkConfig } from "./chunkStrategy";
import type { ChunkResult, ChunkStrategyConfig, ChunkStrategyName } from "./chunkStrategy";

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

function digestObject(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}

async function writeAudit(pool: Pool, params: { traceId: string; tenantId: string; spaceId: string; action: string; inputDigest?: any; outputDigest?: any; errorCategory?: string }) {
  const errorCategory = normalizeAuditErrorCategory(params.errorCategory);
  const redactedIn = redactValue(params.inputDigest);
  const redactedOut = redactValue(params.outputDigest);
  const outputDigest = attachDlpSummary(redactedOut.value, redactedOut.summary);

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

/** 固定长度分块 — 智能分块引擎失败时的 fallback */
function chunkTextFixed(text: string, maxLen: number) {
  const chunks: Array<{ chunkIndex: number; startOffset: number; endOffset: number; snippet: string; contentDigest: string }> = [];
  let i = 0;
  let idx = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxLen);
    const snippet = text.slice(i, end);
    chunks.push({ chunkIndex: idx++, startOffset: i, endOffset: end, snippet, contentDigest: sha256Hex(snippet) });
    i = end;
  }
  return chunks;
}

/**
 * 从数据库加载 per-tenant/per-space 分块配置
 * 如果数据库无配置，降级到环境变量 → 默认配置
 */
async function resolveChunkConfig(pool: Pool, tenantId: string, spaceId: string): Promise<Partial<ChunkStrategyConfig>> {
  try {
    const res = await pool.query(
      "SELECT strategy, max_len, overlap, separators, semantic_threshold FROM knowledge_chunk_configs WHERE tenant_id=$1 AND space_id=$2 LIMIT 1",
      [tenantId, spaceId],
    );
    if (res.rowCount) {
      const row = res.rows[0] as any;
      const config: Partial<ChunkStrategyConfig> = {};
      if (row.strategy) config.strategy = String(row.strategy) as ChunkStrategyName;
      if (row.max_len) config.maxLen = Math.max(50, Math.min(10000, Number(row.max_len)));
      if (row.overlap != null) config.overlap = Math.max(0, Math.min(5000, Number(row.overlap)));
      if (row.semantic_threshold != null) config.semanticThreshold = Number(row.semantic_threshold);
      if (Array.isArray(row.separators)) config.separators = row.separators.map(String);
      return config;
    }
  } catch { /* 表不存在或查询失败，降级 */ }
  return resolveChunkConfigFromEnv();
}

export async function processKnowledgeIndexJob(params: { pool: Pool; indexJobId: string }) {
  const jobRes = await params.pool.query("SELECT * FROM knowledge_index_jobs WHERE id = $1 LIMIT 1", [params.indexJobId]);
  if (!jobRes.rowCount) return null;
  const job = jobRes.rows[0] as any;
  const tenantId = job.tenant_id as string;
  const spaceId = job.space_id as string;
  const docId = job.document_id as string;
  const docVersion = job.document_version as number;
  const traceId = `kidx-${params.indexJobId}`;

  await params.pool.query("UPDATE knowledge_index_jobs SET status='running', attempt=attempt+1, updated_at=now() WHERE id=$1", [params.indexJobId]);

  const startedAt = Date.now();
  try {
    const docRes = await params.pool.query(
      `
        SELECT content_text
        FROM knowledge_documents
        WHERE tenant_id=$1 AND space_id=$2 AND id=$3 AND version=$4
        LIMIT 1
      `,
      [tenantId, spaceId, docId, docVersion],
    );
    if (!docRes.rowCount) throw new Error("document_not_found");
    const contentText = docRes.rows[0]!.content_text as string;

    // 使用智能分块引擎
    const chunkCfg = await resolveChunkConfig(params.pool, tenantId, spaceId);
    let chunks: ChunkResult[];
    try {
      chunks = await knowledgeChunkText(contentText, chunkCfg);
    } catch {
      // 智能分块失败，降级到固定分块
      const fixed = chunkTextFixed(contentText, chunkCfg.maxLen ?? 600);
      chunks = fixed.map(c => ({
        ...c,
        strategyName: "fixed" as const,
        hierarchyPath: null,
        overlapBefore: 0,
        overlapAfter: 0,
      }));
    }
    if (chunks.length) {
      const values: any[] = [];
      const rowsSql: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const base = i * 13;
        rowsSql.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`);
        values.push(tenantId, spaceId, docId, docVersion, c.chunkIndex, c.startOffset, c.endOffset, c.snippet, c.contentDigest, c.strategyName, c.hierarchyPath, c.overlapBefore, c.overlapAfter);
      }
      await params.pool.query(
        `
          INSERT INTO knowledge_chunks (
            tenant_id, space_id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, content_digest,
            chunk_strategy, hierarchy_path, overlap_before, overlap_after
          ) VALUES ${rowsSql.join(",")}
          ON CONFLICT (tenant_id, space_id, document_id, document_version, chunk_index) DO NOTHING
        `,
        values,
      );
    }

    await params.pool.query("UPDATE knowledge_index_jobs SET status='succeeded', last_error=NULL, updated_at=now() WHERE id=$1", [params.indexJobId]);
    const latencyMs = Date.now() - startedAt;
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "index",
      inputDigest: { indexJobId: params.indexJobId, documentId: docId, version: docVersion },
      outputDigest: { chunkCount: chunks.length, latencyMs, chunkStrategy: chunks[0]?.strategyName ?? 'fixed' },
    });
    return { tenantId, spaceId, documentId: docId, documentVersion: docVersion, chunkCount: chunks.length };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await params.pool.query("UPDATE knowledge_index_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1", [params.indexJobId, msg]);
    const permanent = msg === "document_not_found";
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "index",
      inputDigest: digestObject({ indexJobId: params.indexJobId, documentId: docId, version: docVersion }),
      outputDigest: { error: msg },
      errorCategory: permanent ? "policy_violation" : "retryable",
    });
    if (permanent) return null;
    throw e;
  }
}
