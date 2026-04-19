import type { Pool } from "pg";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue, computeMinhash, StructuredLogger, sha256Hex, stableStringify } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:knowledge:embedding" });
import { createVectorStore, resolveVectorStoreConfigFromEnv } from "./vectorStore";
import { createVectorStoreChainFromEnv } from "./vectorStoreProvider";
import type { VectorStoreEmbeddingV2 } from "@openslin/shared";

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
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

/* ── 外部 Embedding 模型支持（OpenAI 兼容 API）─────────────────── */

type ExternalEmbeddingConfig = {
  endpoint: string;
  apiKey: string | null;
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
  /** 并发批次数 (默认2) */
  concurrency: number;
  /** 最大重试次数 (默认2) */
  maxRetries: number;
  /** 模式: external(OpenAI兼容) | local(TEI/Ollama) */
  mode: "external" | "local";
};

function resolveExternalEmbeddingConfig(): ExternalEmbeddingConfig | null {
  // 优先检测 LOCAL_EMBEDDING 模式 (TEI/Ollama)
  const localEndpoint = String(process.env.LOCAL_EMBEDDING_ENDPOINT ?? "").trim();
  if (localEndpoint) {
    return {
      endpoint: localEndpoint,
      apiKey: String(process.env.LOCAL_EMBEDDING_API_KEY ?? "").trim() || null,
      model: String(process.env.LOCAL_EMBEDDING_MODEL ?? "BAAI/bge-large-zh-v1.5").trim(),
      dimensions: Math.max(64, Math.min(4096, Number(process.env.LOCAL_EMBEDDING_DIMENSIONS ?? 1024))),
      batchSize: Math.max(1, Math.min(100, Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE ?? 32))),
      timeoutMs: Math.max(1000, Number(process.env.LOCAL_EMBEDDING_TIMEOUT_MS ?? 30000)),
      concurrency: Math.max(1, Math.min(8, Number(process.env.LOCAL_EMBEDDING_CONCURRENCY ?? 2))),
      maxRetries: Math.max(0, Math.min(5, Number(process.env.LOCAL_EMBEDDING_MAX_RETRIES ?? 2))),
      mode: "local",
    };
  }

  // 外部 Embedding API (OpenAI 兼容)
  const endpoint = String(process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey: String(process.env.KNOWLEDGE_EMBEDDING_API_KEY ?? "").trim() || null,
    model: String(process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "text-embedding-3-small").trim(),
    dimensions: Math.max(64, Math.min(4096, Number(process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS ?? 1536))),
    batchSize: Math.max(1, Math.min(100, Number(process.env.KNOWLEDGE_EMBEDDING_BATCH_SIZE ?? 50))),
    timeoutMs: Math.max(1000, Number(process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS ?? 30000)),
    concurrency: Math.max(1, Math.min(8, Number(process.env.KNOWLEDGE_EMBEDDING_CONCURRENCY ?? 2))),
    maxRetries: Math.max(0, Math.min(5, Number(process.env.KNOWLEDGE_EMBEDDING_MAX_RETRIES ?? 2))),
    mode: "external",
  };
}

/** 单批次 embedding 请求 (带重试) — 兼容 OpenAI/TEI/Ollama 格式 */
async function fetchEmbeddingBatch(
  cfg: ExternalEmbeddingConfig,
  batch: string[],
  attempt = 0,
): Promise<number[][]> {
  // TEI/Ollama 本地模式 URL 构建
  let url: string;
  if (cfg.mode === "local") {
    // TEI 格式: POST /embed 或 /v1/embeddings
    const base = cfg.endpoint.replace(/\/$/, "");
    url = base.includes("/v1/") ? base : `${base}/v1/embeddings`;
  } else {
    url = cfg.endpoint.replace(/\/$/, "") + "/v1/embeddings";
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const payload: any = { input: batch, model: cfg.model };
    if (cfg.dimensions) payload.dimensions = cfg.dimensions;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    } as any);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const statusCode = res.status;
      // 429/5xx 可重试
      if ((statusCode === 429 || statusCode >= 500) && attempt < cfg.maxRetries) {
        const delayMs = Math.min(10000, 1000 * Math.pow(2, attempt));
        _logger.warn("API retryable error", { statusCode, delayMs, attempt: attempt + 1, maxRetries: cfg.maxRetries });
        await new Promise(r => setTimeout(r, delayMs));
        return fetchEmbeddingBatch(cfg, batch, attempt + 1);
      }
      _logger.error("external embedding API error", { statusCode, body: errBody.slice(0, 500) });
      throw new Error(`embedding_api_http_${statusCode}`);
    }
    const json = (await res.json()) as any;
    const data = Array.isArray(json?.data) ? json.data : [];
    const sorted = data.sort((a: any, b: any) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
    return sorted.map((item: any) => Array.isArray(item?.embedding) ? (item.embedding as number[]) : []);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      if (attempt < cfg.maxRetries) {
        const delayMs = Math.min(10000, 1000 * Math.pow(2, attempt));
        _logger.warn("API timeout, retrying", { timeoutMs: cfg.timeoutMs, delayMs, attempt: attempt + 1, maxRetries: cfg.maxRetries });
        await new Promise(r => setTimeout(r, delayMs));
        return fetchEmbeddingBatch(cfg, batch, attempt + 1);
      }
      _logger.error("external embedding API timeout", { timeoutMs: cfg.timeoutMs });
      throw new Error("embedding_api_timeout");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 优化的批量 embedding — 并发 + 重试 + 进度日志
 *
 * 将 texts 按 batchSize 分组，最多 concurrency 个并发批次同时执行。
 * 每个批次支持指数退避重试（429/5xx/超时）。
 */
async function fetchExternalEmbeddings(cfg: ExternalEmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const allEmbeddings: number[][] = new Array(texts.length);
  const batches: Array<{ startIdx: number; batch: string[] }> = [];

  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    batches.push({ startIdx: i, batch: texts.slice(i, i + cfg.batchSize) });
  }

  const totalBatches = batches.length;
  let completedBatches = 0;
  const startedAt = Date.now();

  // 并发执行，限制 concurrency
  const executing: Promise<void>[] = [];

  for (const { startIdx, batch } of batches) {
    const task = (async () => {
      const vectors = await fetchEmbeddingBatch(cfg, batch);
      for (let j = 0; j < vectors.length; j++) {
        allEmbeddings[startIdx + j] = vectors[j]!;
      }
      completedBatches++;
      if (totalBatches > 2 && completedBatches % Math.max(1, Math.floor(totalBatches / 5)) === 0) {
        _logger.info("batch progress", { completed: completedBatches, total: totalBatches, elapsedMs: Date.now() - startedAt });
      }
    })();

    executing.push(task);

    if (executing.length >= cfg.concurrency) {
      await Promise.race(executing);
      // 移除已完成的
      for (let i = executing.length - 1; i >= 0; i--) {
        const settled = await Promise.race([executing[i], Promise.resolve("__pending__")]);
        if (settled !== "__pending__") executing.splice(i, 1);
      }
    }
  }

  // 等待所有剩余任务完成
  await Promise.all(executing);

  const elapsed = Date.now() - startedAt;
  _logger.info("external embedding complete", { model: cfg.model, count: texts.length, batches: totalBatches, elapsedMs: elapsed, throughput: Math.round(texts.length / (elapsed / 1000)) });

  return allEmbeddings;
}

/**
 * 从数据库加载 per-tenant/per-space 的 Embedding 模型配置
 * 支持热切换：修改数据库配置后下一次 embedding 作业即生效
 */
async function resolveEmbeddingConfigFromDb(pool: Pool, tenantId: string, spaceId: string): Promise<ExternalEmbeddingConfig | null> {
  try {
    // 优先查找 space 级别配置，再查 tenant 级别
    const res = await pool.query(
      `SELECT model_name, provider, endpoint, api_key_ref, dimensions, batch_size, concurrency, max_retries, timeout_ms
       FROM knowledge_embedding_model_configs
       WHERE tenant_id = $1 AND (space_id = $2 OR space_id IS NULL) AND is_active = TRUE
       ORDER BY CASE WHEN space_id IS NOT NULL THEN 0 ELSE 1 END, is_default DESC
       LIMIT 1`,
      [tenantId, spaceId],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0] as any;
    const endpoint = String(row.endpoint ?? "").trim();
    if (!endpoint) return null;

    const provider = String(row.provider ?? "openai").toLowerCase();
    return {
      endpoint,
      apiKey: String(row.api_key_ref ?? "").trim() || null,
      model: String(row.model_name ?? "text-embedding-3-small"),
      dimensions: Number(row.dimensions ?? 1536),
      batchSize: Math.max(1, Math.min(100, Number(row.batch_size ?? 50))),
      timeoutMs: Math.max(1000, Number(row.timeout_ms ?? 30000)),
      concurrency: Math.max(1, Math.min(8, Number(row.concurrency ?? 2))),
      maxRetries: Math.max(0, Math.min(5, Number(row.max_retries ?? 2))),
      mode: provider === "local" || provider === "tei" || provider === "ollama" ? "local" : "external",
    };
  } catch {
    // 表不存在或查询失败，降级到环境变量
    return null;
  }
}

export async function processKnowledgeEmbeddingJob(params: { pool: Pool; embeddingJobId: string }) {
  const jobRes = await params.pool.query("SELECT * FROM knowledge_embedding_jobs WHERE id = $1 LIMIT 1", [params.embeddingJobId]);
  if (!jobRes.rowCount) throw new Error("embedding_job_not_found");
  const job = jobRes.rows[0] as any;
  const tenantId = String(job.tenant_id ?? "");
  const spaceId = String(job.space_id ?? "");
  const documentId = String(job.document_id ?? "");
  const documentVersion = Number(job.document_version ?? 0);
  const modelRef = String(job.embedding_model_ref ?? "");
  const traceId = `kemb-${params.embeddingJobId}`;

  if (!tenantId || !spaceId || !documentId || !documentVersion || !modelRef) throw new Error("embedding_job_invalid");
  await params.pool.query("UPDATE knowledge_embedding_jobs SET status='running', attempt=attempt+1, updated_at=now() WHERE id=$1", [params.embeddingJobId]);

  const startedAt = Date.now();
  try {
    const chunksRes = await params.pool.query(
      `
        SELECT id, snippet
        FROM knowledge_chunks
        WHERE tenant_id=$1 AND space_id=$2 AND document_id=$3 AND document_version=$4
        ORDER BY chunk_index ASC
        LIMIT 5000
      `,
      [tenantId, spaceId, documentId, documentVersion],
    );
    const chunks = chunksRes.rows as any[];
    const k = 16;
    let updated = 0;
    const nowIso = new Date().toISOString();
    const embeddings: any[] = [];

    /* 尝试加载 per-tenant/per-space Embedding 模型配置（数据库优先） */
    let extCfg = await resolveEmbeddingConfigFromDb(params.pool, tenantId, spaceId);
    if (!extCfg) extCfg = resolveExternalEmbeddingConfig();
    let externalVectors: number[][] | null = null;
    if (extCfg) {
      try {
        const texts = chunks.map((c) => String(c.snippet ?? "").slice(0, 8000));
        externalVectors = await fetchExternalEmbeddings(extCfg, texts);
        _logger.info("external vectors returned", { model: extCfg.model, count: externalVectors.length, dimensions: externalVectors[0]?.length ?? 0 });
      } catch (e: any) {
        _logger.error("external embedding failed, fallback to minhash", { err: e?.message ?? e });
        externalVectors = null;
      }
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci]!;
      const id = String(c.id ?? "");
      const snippet = String(c.snippet ?? "");
      if (!id) continue;

      /* minhash 始终计算（作为回退和 GIN 索引） */
      const minhash = computeMinhash(snippet, k);

      /* 如果有外部向量，也保存到 embedding_vector 列 */
      const extVec = externalVectors && ci < externalVectors.length ? externalVectors[ci] : null;
      const effectiveModelRef = extVec ? `${extCfg!.model}:${extCfg!.dimensions}` : modelRef;

      if (extVec) {
        await params.pool.query(
          `UPDATE knowledge_chunks
           SET embedding_model_ref=$2, embedding_minhash=$3, embedding_vector=$6, embedding_updated_at=now()
           WHERE id=$1 AND tenant_id=$4 AND space_id=$5`,
          [id, effectiveModelRef, minhash, tenantId, spaceId, JSON.stringify(extVec)],
        );
      } else {
        await params.pool.query(
          `UPDATE knowledge_chunks
           SET embedding_model_ref=$2, embedding_minhash=$3, embedding_updated_at=now()
           WHERE id=$1 AND tenant_id=$4 AND space_id=$5`,
          [id, modelRef, minhash, tenantId, spaceId],
        );
      }
      embeddings.push({
        chunkId: id,
        documentId,
        documentVersion,
        embeddingModelRef: effectiveModelRef,
        vector: extVec ?? minhash,
        updatedAt: nowIso,
      });
      updated++;
    }

    const vectorStore = createVectorStore(resolveVectorStoreConfigFromEnv());
    const upsertRes = await vectorStore.upsertEmbeddings({ pool: params.pool, embeddings });

    /* ── V2 向量存储并行写入（如已配置 Qdrant/Milvus） ── */
    let v2UpsertRes: any = null;
    try {
      const v2Chain = createVectorStoreChainFromEnv();
      if (v2Chain.capabilities().provider !== "fallback") {
        const collectionName = `kn_${tenantId.slice(0, 8)}_${spaceId.slice(0, 8)}`;
        const dimension = externalVectors && externalVectors.length > 0 && externalVectors[0]!.length > 0
          ? externalVectors[0]!.length
          : 0;
        if (dimension > 0) {
          await v2Chain.ensureCollection({ name: collectionName, dimension, distance: "cosine" });
          const v2Embeddings: VectorStoreEmbeddingV2[] = [];
          for (let ci2 = 0; ci2 < chunks.length; ci2++) {
            const c2 = chunks[ci2]!;
            const extVec2 = externalVectors && ci2 < externalVectors.length ? externalVectors[ci2] : null;
            if (extVec2 && extVec2.length > 0) {
              v2Embeddings.push({
                id: String(c2.id ?? ""),
                vector: extVec2,
                metadata: {
                  tenantId,
                  spaceId,
                  documentId,
                  documentVersion,
                  chunkIndex: ci2,
                  embeddingModelRef: `${extCfg!.model}:${extCfg!.dimensions}`,
                },
                updatedAt: nowIso,
              });
            }
          }
          if (v2Embeddings.length > 0) {
            v2UpsertRes = await v2Chain.batchUpsert({ collection: collectionName, embeddings: v2Embeddings });
            _logger.info("V2 vector store upsert", { count: v2UpsertRes.count, provider: v2UpsertRes.provider, latencyMs: v2UpsertRes.latencyMs });
          }
        }
      }
    } catch (e: any) {
      _logger.warn("V2 vector store upsert failed (non-blocking)", { err: e?.message ?? e });
    }

    await params.pool.query("UPDATE knowledge_embedding_jobs SET status='succeeded', last_error=NULL, updated_at=now() WHERE id=$1", [params.embeddingJobId]);
    const latencyMs = Date.now() - startedAt;
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "embed",
      inputDigest: { embeddingJobId: params.embeddingJobId, documentId, version: documentVersion, modelRef },
      outputDigest: { chunkCount: chunks.length, updatedCount: updated, latencyMs, vectorStoreRef: vectorStore.ref, vectorStoreUpsert: upsertRes, v2UpsertRes: v2UpsertRes ?? undefined },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await params.pool.query("UPDATE knowledge_embedding_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1", [params.embeddingJobId, msg]);
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "embed",
      inputDigest: { embeddingJobId: params.embeddingJobId, documentId, version: documentVersion, modelRef },
      outputDigest: { error: msg },
      errorCategory: "retryable",
    });
    throw e;
  }
}
