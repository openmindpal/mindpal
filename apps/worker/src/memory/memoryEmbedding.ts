import type { Pool } from "pg";
import { computeMinhash, StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:memoryEmbedding" });

/* ── Memory Embedding Worker ──
 * 蒸馏后的记忆仅有 minhash 近似向量（embedding_model_ref = 'minhash:16@1'），
 * 本模块在蒸馏完成后调用外部 Embedding API 计算真正的密集向量，
 * 并更新 embedding_model_ref 和 embedding_vector 列，
 * 使蒸馏产物可被混合检索的 dense vector 通道精确召回。
 */

/* ── 配置 ─────────────────────────────────────────────── */

type MemoryEmbeddingConfig = {
  endpoint: string;
  apiKey: string | null;
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
};

/**
 * 解析外部 Embedding 配置。
 * 优先读取 MEMORY_EMBEDDING_* 环境变量，降级到 KNOWLEDGE_EMBEDDING_*。
 * 若两者均未配置则返回 null（表示仅用 minhash）。
 */
export function resolveMemoryEmbeddingConfig(): MemoryEmbeddingConfig | null {
  const endpoint =
    String(process.env.MEMORY_EMBEDDING_ENDPOINT ?? "").trim() ||
    String(process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey:
      String(process.env.MEMORY_EMBEDDING_API_KEY ?? "").trim() ||
      String(process.env.KNOWLEDGE_EMBEDDING_API_KEY ?? "").trim() ||
      null,
    model: String(
      process.env.MEMORY_EMBEDDING_MODEL ??
        process.env.KNOWLEDGE_EMBEDDING_MODEL ??
        "text-embedding-3-small",
    ).trim(),
    dimensions: Math.max(
      64,
      Math.min(
        4096,
        Number(
          process.env.MEMORY_EMBEDDING_DIMENSIONS ??
            process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS ??
            1536,
        ),
      ),
    ),
    batchSize: Math.max(
      1,
      Math.min(
        100,
        Number(
          process.env.MEMORY_EMBEDDING_BATCH_SIZE ??
            process.env.KNOWLEDGE_EMBEDDING_BATCH_SIZE ??
            20,
        ),
      ),
    ),
    timeoutMs: Math.max(
      1000,
      Number(
        process.env.MEMORY_EMBEDDING_TIMEOUT_MS ??
          process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS ??
          30000,
      ),
    ),
  };
}

/**
 * 构造 dense embedding model ref 标识（与 knowledge 侧对齐）
 */
export function denseModelRef(cfg: MemoryEmbeddingConfig): string {
  return `${cfg.model}:${cfg.dimensions}`;
}

/* ── 外部 Embedding API 调用 ──────────────────────────── */

async function fetchEmbeddings(
  cfg: MemoryEmbeddingConfig,
  texts: string[],
): Promise<number[][]> {
  const url = cfg.endpoint.replace(/\/$/, "") + "/v1/embeddings";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;

  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize);
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
      } as RequestInit);
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
                _logger.error("embedding API returned error", { status: res.status, body: errBody.slice(0, 500) });
        throw new Error(`memory_embedding_api_http_${res.status}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const data = Array.isArray(json?.data) ? json.data : [];
      const sorted = data.sort(
        (a: any, b: any) => Number(a?.index ?? 0) - Number(b?.index ?? 0),
      );
      for (const item of sorted) {
        const vec = Array.isArray(item?.embedding)
          ? (item.embedding as number[])
          : [];
        allEmbeddings.push(vec);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
                _logger.error("embedding API timeout", { timeoutMs: cfg.timeoutMs });
        throw new Error("memory_embedding_api_timeout");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  return allEmbeddings;
}

/* ── 主处理函数 ───────────────────────────────────────── */

export interface MemoryEmbeddingJobData {
  kind: "memory.embed";
  memoryEntryIds: string[];
  tenantId: string;
  spaceId: string;
}

export interface MemoryEmbeddingResult {
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
  modelRef: string | null;
  durationMs: number;
}

/**
 * 处理一批记忆条目的密集向量嵌入计算。
 *
 * 流程：
 * 1. 解析外部 Embedding 配置（不可用时直接跳过）
 * 2. 读取待处理的 memory_entries
 * 3. 调用外部 API 计算密集向量
 * 4. 更新 embedding_model_ref、embedding_vector、embedding_minhash（保留）、embedding_updated_at
 */
export async function processMemoryEmbeddingJob(params: {
  pool: Pool;
  memoryEntryIds: string[];
  tenantId: string;
  spaceId: string;
}): Promise<MemoryEmbeddingResult> {
  const startTime = Date.now();
  const cfg = resolveMemoryEmbeddingConfig();

  if (!cfg) {
        _logger.info("no external embedding API configured, skipping dense vectors");
    return {
      processed: params.memoryEntryIds.length,
      updated: 0,
      skipped: params.memoryEntryIds.length,
      errors: 0,
      modelRef: null,
      durationMs: Date.now() - startTime,
    };
  }

  const modelRef = denseModelRef(cfg);
  let updated = 0;
  let errors = 0;
  let skipped = 0;

  // 1. 读取记忆条目
  const res = await params.pool.query(
    `SELECT id, title, content_text, embedding_model_ref
     FROM memory_entries
     WHERE tenant_id = $1 AND space_id = $2
       AND id = ANY($3::uuid[])
       AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [params.tenantId, params.spaceId, params.memoryEntryIds],
  );

  const rows = res.rows as Record<string, unknown>[];
  if (rows.length === 0) {
    return {
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      modelRef,
      durationMs: Date.now() - startTime,
    };
  }

  // 2. 准备文本（title + content 拼接）
  const textsById = new Map<string, string>();
  const orderedIds: string[] = [];
  const orderedTexts: string[] = [];

  for (const r of rows) {
    const id = String(r.id);
    const title = String(r.title ?? "");
    const content = String(r.content_text ?? "");
    // 已有 dense 向量的跳过（幂等保护）
    const currentRef = String(r.embedding_model_ref ?? "");
    if (currentRef === modelRef) {
      skipped++;
      continue;
    }
    const text = (title ? title + " " : "") + content;
    if (!text.trim()) {
      skipped++;
      continue;
    }
    textsById.set(id, text);
    orderedIds.push(id);
    orderedTexts.push(text.slice(0, 8000)); // 截断超长文本
  }

  if (orderedTexts.length === 0) {
    return {
      processed: rows.length,
      updated: 0,
      skipped: rows.length,
      errors: 0,
      modelRef,
      durationMs: Date.now() - startTime,
    };
  }

  // 3. 调用外部 Embedding API
  let vectors: number[][];
  try {
    vectors = await fetchEmbeddings(cfg, orderedTexts);
  } catch (e: any) {
        _logger.error("embedding API call failed", { err: e?.message ?? e });
    // 降级：保持 minhash 不变，不阻断蒸馏流程
    return {
      processed: rows.length,
      updated: 0,
      skipped: 0,
      errors: orderedTexts.length,
      modelRef,
      durationMs: Date.now() - startTime,
    };
  }

  // 4. 逐条更新
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]!;
    const vec = i < vectors.length ? vectors[i] : null;
    if (!vec || vec.length === 0) {
      errors++;
      continue;
    }

    try {
      // 同时保留 minhash（重新计算以确保一致性）
      const text = textsById.get(id) ?? "";
      const minhash = computeMinhash(text);

      await params.pool.query(
        `UPDATE memory_entries
         SET embedding_model_ref = $2,
             embedding_vector = $3::jsonb,
             embedding_minhash = $4,
             embedding_updated_at = now(),
             updated_at = now()
         WHERE id = $1 AND tenant_id = $5 AND deleted_at IS NULL`,
        [id, modelRef, JSON.stringify(vec), minhash, params.tenantId],
      );
      updated++;
    } catch (e: any) {
            _logger.error("update memory vector failed", { id, err: e?.message ?? e });
      errors++;
    }
  }

  _logger.info("embedding batch complete", { tenantId: params.tenantId, spaceId: params.spaceId, processed: rows.length, updated, skipped, errors, modelRef, durationMs: Date.now() - startTime });

  return {
    processed: rows.length,
    updated,
    skipped,
    errors,
    modelRef,
    durationMs: Date.now() - startTime,
  };
}

/**
 * 扫描并处理所有仍为 minhash 的蒸馏记忆（补偿机制）。
 * 用于 ticker 定时扫描场景，确保遗漏的记忆最终也能获得 dense embedding。
 */
export async function backfillMemoryEmbeddings(params: {
  pool: Pool;
  limit?: number;
}): Promise<MemoryEmbeddingResult> {
  const startTime = Date.now();
  const cfg = resolveMemoryEmbeddingConfig();
  if (!cfg) {
    return { processed: 0, updated: 0, skipped: 0, errors: 0, modelRef: null, durationMs: 0 };
  }

  const modelRef = denseModelRef(cfg);
  const limit = params.limit ?? 50;

  // 查找 minhash-only 的蒸馏记忆（distilled_from IS NOT NULL 表示是蒸馏产物）
  const res = await params.pool.query(
    `SELECT DISTINCT tenant_id, space_id, id
     FROM memory_entries
     WHERE deleted_at IS NULL
       AND embedding_model_ref = 'minhash:16@1'
       AND (distilled_from IS NOT NULL OR memory_class IN ('semantic', 'procedural'))
       AND embedding_vector IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  if (!res.rowCount) {
    return { processed: 0, updated: 0, skipped: 0, errors: 0, modelRef, durationMs: Date.now() - startTime };
  }

  // 按 tenant+space 分组处理
  const groups = new Map<string, { tenantId: string; spaceId: string; ids: string[] }>();
  for (const r of res.rows as Record<string, unknown>[]) {
    const key = `${r.tenant_id}:${r.space_id}`;
    if (!groups.has(key)) {
      groups.set(key, { tenantId: String(r.tenant_id), spaceId: String(r.space_id), ids: [] });
    }
    groups.get(key)!.ids.push(String(r.id));
  }

  let totalUpdated = 0;
  let totalErrors = 0;

  for (const [, group] of groups) {
    const result = await processMemoryEmbeddingJob({
      pool: params.pool,
      memoryEntryIds: group.ids,
      tenantId: group.tenantId,
      spaceId: group.spaceId,
    });
    totalUpdated += result.updated;
    totalErrors += result.errors;
  }

  return {
    processed: res.rowCount ?? 0,
    updated: totalUpdated,
    skipped: 0,
    errors: totalErrors,
    modelRef,
    durationMs: Date.now() - startTime,
  };
}
