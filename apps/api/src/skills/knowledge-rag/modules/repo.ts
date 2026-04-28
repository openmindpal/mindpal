import crypto from "node:crypto";
import type { Pool } from "pg";
import { computeMinhash, minhashOverlapScore, StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:knowledgeRepo" });
import { createVectorStore, resolveVectorStoreConfigFromEnv } from "./vectorStore";
import { getRerankConfig, rerank } from "./rerank";

export function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/* ── 外部 Embedding 查询支持（Dense embedding 查询闭环） ── */

type ExternalEmbeddingConfig = {
  endpoint: string;
  apiKey: string | null;
  model: string;
  dimensions: number;
  timeoutMs: number;
};

function resolveExternalEmbeddingConfig(): ExternalEmbeddingConfig | null {
  const endpoint = String(process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey: String(process.env.KNOWLEDGE_EMBEDDING_API_KEY ?? "").trim() || null,
    model: String(process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "text-embedding-3-small").trim(),
    dimensions: Math.max(64, Math.min(4096, Number(process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS ?? 1536))),
    timeoutMs: Math.max(1000, Number(process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS ?? 10000)),
  };
}

async function fetchQueryEmbedding(cfg: ExternalEmbeddingConfig, text: string): Promise<number[] | null> {
  const url = cfg.endpoint.replace(/\/$/, "") + "/v1/embeddings";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const payload: any = { input: [text.slice(0, 8000)], model: cfg.model };
    if (cfg.dimensions) payload.dimensions = cfg.dimensions;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal } as any);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const data = Array.isArray(json?.data) ? json.data : [];
    const vec = Array.isArray(data[0]?.embedding) ? (data[0].embedding as number[]) : [];
    return vec.length > 0 ? vec : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type KnowledgeDocumentRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  version: number;
  title: string;
  sourceType: string;
  tags: any;
  contentDigest: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeIndexJobRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  status: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

function toDoc(r: any): KnowledgeDocumentRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    version: r.version,
    title: r.title,
    sourceType: r.source_type,
    tags: r.tags,
    contentDigest: r.content_digest,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toJob(r: any): KnowledgeIndexJobRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    documentId: r.document_id,
    documentVersion: r.document_version,
    status: r.status,
    attempt: r.attempt,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createDocument(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  title: string;
  sourceType: string;
  tags?: any;
  contentText: string;
  visibility?: "space" | "subject";
  ownerSubjectId?: string | null;
}) {
  const digest = sha256(params.contentText);
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_documents (tenant_id, space_id, version, title, source_type, tags, content_text, content_digest, status, visibility, owner_subject_id)
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'active', $8, $9)
      RETURNING id, tenant_id, space_id, version, title, source_type, tags, content_digest, status, created_at, updated_at
    `,
    [
      params.tenantId,
      params.spaceId,
      params.title,
      params.sourceType,
      params.tags ?? null,
      params.contentText,
      digest,
      params.visibility ?? "space",
      params.ownerSubjectId ?? null,
    ],
  );
  return toDoc(res.rows[0]);
}

export async function getDocumentContent(pool: Pool, tenantId: string, spaceId: string, documentId: string) {
  const res = await pool.query(
    `
      SELECT id, tenant_id, space_id, version, title, source_type, tags, content_text, content_digest, status, created_at, updated_at
      FROM knowledge_documents
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      LIMIT 1
    `,
    [tenantId, spaceId, documentId],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as any;
}

export async function createIndexJob(params: { pool: Pool; tenantId: string; spaceId: string; documentId: string; documentVersion: number }) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_index_jobs (tenant_id, space_id, document_id, document_version, status)
      VALUES ($1, $2, $3, $4, 'queued')
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.documentId, params.documentVersion],
  );
  return toJob(res.rows[0]);
}

export async function setIndexJobRunning(pool: Pool, id: string) {
  const res = await pool.query(
    `
      UPDATE knowledge_index_jobs
      SET status = 'running', attempt = attempt + 1, updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [id],
  );
  if (!res.rowCount) return null;
  return toJob(res.rows[0]);
}

export async function setIndexJobSucceeded(pool: Pool, id: string) {
  await pool.query("UPDATE knowledge_index_jobs SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = $1", [id]);
}

export async function setIndexJobFailed(pool: Pool, id: string, msg: string) {
  await pool.query("UPDATE knowledge_index_jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [id, msg]);
}

export async function insertChunks(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  chunks: Array<{ chunkIndex: number; startOffset: number; endOffset: number; snippet: string; contentDigest: string }>;
}) {
  const values: any[] = [];
  const rowsSql: string[] = [];
  for (let i = 0; i < params.chunks.length; i++) {
    const c = params.chunks[i]!;
    const base = i * 8;
    rowsSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
    values.push(
      params.tenantId,
      params.spaceId,
      params.documentId,
      params.documentVersion,
      c.chunkIndex,
      c.startOffset,
      c.endOffset,
      JSON.stringify({ snippet: c.snippet, digest: c.contentDigest }),
    );
  }

  if (!rowsSql.length) return 0;
  const sql = `
    INSERT INTO knowledge_chunks (
      tenant_id, space_id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, content_digest
    )
    SELECT v.tenant_id, v.space_id, v.document_id, v.document_version, v.chunk_index, v.start_offset, v.end_offset,
           (v.meta->>'snippet')::text, (v.meta->>'digest')::text
    FROM (
      VALUES ${rowsSql.join(",")}
    ) AS v(tenant_id, space_id, document_id, document_version, chunk_index, start_offset, end_offset, meta)
    ON CONFLICT (tenant_id, space_id, document_id, document_version, chunk_index) DO NOTHING
  `;
  const res = await params.pool.query(sql, values);
  return res.rowCount ?? 0;
}

export async function searchChunks(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; query: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        POSITION(lower($3) IN lower(snippet)) AS match_pos
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND space_id = $2 AND snippet ILIKE ('%' || $3 || '%')
        AND EXISTS (
          SELECT 1
          FROM knowledge_documents d
          WHERE d.tenant_id = knowledge_chunks.tenant_id
            AND d.space_id = knowledge_chunks.space_id
            AND d.id = knowledge_chunks.document_id
            AND d.version = knowledge_chunks.document_version
            AND (
              d.visibility = 'space'
              OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
            )
        )
      ORDER BY match_pos ASC NULLS LAST, created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.spaceId, params.query, params.subjectId, params.limit],
  );
  return res.rows as any[];
}

/* ── HyDE: 假设性文档生成器 ── */
async function generateHydeDocument(prompt: string): Promise<string | null> {
  const endpoint = String(process.env.KNOWLEDGE_HYDE_LLM_ENDPOINT ?? process.env.LLM_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  const apiKey = String(process.env.KNOWLEDGE_HYDE_LLM_API_KEY ?? process.env.LLM_API_KEY ?? "").trim();
  const model = String(process.env.KNOWLEDGE_HYDE_LLM_MODEL ?? process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
  const url = endpoint.replace(/\/$/, "") + "/v1/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      }),
      signal: controller.signal,
    } as any);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    return String(json?.choices?.[0]?.message?.content ?? "").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Query Expansion: 查询扩展 ── */
function expandQuery(query: string, mode: string): string[] {
  const expanded: string[] = [];

  if (mode === "synonym" || mode === "both") {
    // 简单的同义词扩展: 提取关键词并重组
    const words = query.split(/[\s,，、]+/).filter(w => w.length >= 2);
    if (words.length >= 2) {
      // 生成部分关键词组合
      for (let i = 0; i < Math.min(words.length, 4); i++) {
        const subset = words.filter((_, idx) => idx !== i).join(" ");
        if (subset.trim().length >= 2) expanded.push(subset.trim());
      }
    }
  }

  if (mode === "subquery" || mode === "both") {
    // 子查询分解: 按句子/分号/顿号拆分
    const parts = query.split(/[？；\?、;]+/).map(s => s.trim()).filter(s => s.length >= 4);
    if (parts.length > 1) {
      expanded.push(...parts.slice(0, 3));
    }
  }

  // 去重并限制数量
  return [...new Set(expanded)].filter(q => q !== query).slice(0, 4);
}

export async function searchChunksHybrid(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  limit: number;
  lexicalLimit?: number;
  embedLimit?: number;
  documentIds?: string[];
  tags?: string[];
  sourceTypes?: string[];
  strategyRef?: string | null;
  strategyConfig?: any | null;
}) {
  const k = 16;
  const qMinhash = computeMinhash(params.query, k);
  const cfg = params.strategyConfig && typeof params.strategyConfig === "object" ? (params.strategyConfig as any) : null;
  const cfgLimits = cfg?.limits && typeof cfg.limits === "object" ? (cfg.limits as any) : null;
  const lexicalLimit = Math.max(0, Math.min(500, Number(cfgLimits?.lexicalLimit ?? params.lexicalLimit ?? 80)));
  const embedLimit = Math.max(0, Math.min(500, Number(cfgLimits?.embedLimit ?? params.embedLimit ?? 120)));
  const metaLimit = Math.max(0, Math.min(500, Number(cfgLimits?.metaLimit ?? Math.max(20, Math.round((params.lexicalLimit ?? 80) / 2)))));
  const cfgWeights = cfg?.weights && typeof cfg.weights === "object" ? (cfg.weights as any) : null;
  const wLex = Number(cfgWeights?.lex ?? 1.2);
  const wVec = Number(cfgWeights?.vec ?? 1);
  const wRecency = Number(cfgWeights?.recency ?? 0.05);
  const wMetaBoost = Number(cfgWeights?.metaBoost ?? 0.08);

  const startedAt = Date.now();
  const docIds = Array.isArray(params.documentIds) ? params.documentIds.map(String).filter(Boolean) : [];
  const hasDocFilter = docIds.length > 0 && docIds.length <= 200;
  const tags = Array.isArray(params.tags) ? params.tags.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const sourceTypes = Array.isArray(params.sourceTypes) ? params.sourceTypes.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const hasMetaFilter = (tags.length > 0 && tags.length <= 20) || (sourceTypes.length > 0 && sourceTypes.length <= 20);

  /* ── HyDE (Hypothetical Document Embedding) 查询增强 ── */
  let hydeEnabled = !!cfg?.enableHyde;
  let hydeQuery = params.query;
  let hydeStats: { enabled: boolean; generated: boolean; latencyMs: number } = { enabled: hydeEnabled, generated: false, latencyMs: 0 };
  if (hydeEnabled) {
    try {
      const hydeStart = Date.now();
      // 尝试从数据库读取 HyDE 配置
      const hydeRes = await params.pool.query(
        `SELECT enable_hyde, hyde_prompt_template FROM knowledge_retrieval_strategies WHERE tenant_id = $1 AND space_id = $2 AND is_active = TRUE LIMIT 1`,
        [params.tenantId, params.spaceId],
      ).catch(() => ({ rows: [] as any[], rowCount: 0 }));
      if (hydeRes.rowCount && hydeRes.rows[0].enable_hyde) {
        const template = String(hydeRes.rows[0].hyde_prompt_template ?? "").trim();
        const hydePrompt = template
          ? template.replace(/\{\{query\}\}/g, params.query)
          : `请你当作领域专家，针对以下问题写一段简短的参考答案段落（约200字，不需要开头结尾，直接给出内容）：${params.query}`;
        // 用 LLM 生成假设性文档（外部调用可配置）
        const hydeDoc = await generateHydeDocument(hydePrompt).catch(() => null);
        if (hydeDoc && hydeDoc.trim().length > 20) {
          hydeQuery = hydeDoc.trim();
          hydeStats.generated = true;
        }
      }
      hydeStats.latencyMs = Date.now() - hydeStart;
    } catch {
      hydeEnabled = false;
    }
  }

  /* ── Query Expansion (查询扩展) ── */
  let expandedQueries: string[] = [params.query];
  let queryExpansionStats: { enabled: boolean; expansionCount: number } = { enabled: false, expansionCount: 0 };
  if (cfg?.enableQueryExpansion) {
    try {
      const expRes = await params.pool.query(
        `SELECT enable_query_expansion, query_expansion_mode FROM knowledge_retrieval_strategies WHERE tenant_id = $1 AND space_id = $2 AND is_active = TRUE LIMIT 1`,
        [params.tenantId, params.spaceId],
      ).catch(() => ({ rows: [] as any[], rowCount: 0 }));
      if (expRes.rowCount && expRes.rows[0].enable_query_expansion) {
        const mode = String(expRes.rows[0].query_expansion_mode ?? "synonym");
        const subQueries = expandQuery(params.query, mode);
        expandedQueries = [params.query, ...subQueries];
        queryExpansionStats = { enabled: true, expansionCount: subQueries.length };
      }
    } catch { /* 忽略 */ }
  }
  const metaRes = hasMetaFilter
    ? await params.pool.query(
        `
          SELECT
            c.id, c.document_id, c.document_version, c.chunk_index, c.start_offset, c.end_offset, c.snippet, c.created_at,
            NULL::int AS match_pos,
            c.embedding_minhash,
            c.citation_refs, c.source_page, c.source_section, c.hierarchy_path
          FROM knowledge_chunks c
          WHERE c.tenant_id = $1 AND c.space_id = $2
            AND ($5::uuid[] IS NULL OR c.document_id = ANY($5::uuid[]))
            AND EXISTS (
              SELECT 1
              FROM knowledge_documents d
              WHERE d.tenant_id = c.tenant_id
                AND d.space_id = c.space_id
                AND d.id = c.document_id
                AND d.version = c.document_version
                AND ($6::text[] IS NULL OR d.source_type = ANY($6::text[]))
                AND ($7::text[] IS NULL OR d.tags ?| $7::text[])
                AND (
                  d.visibility = 'space'
                  OR (d.visibility = 'subject' AND d.owner_subject_id = $3)
                )
            )
          ORDER BY c.created_at DESC
          LIMIT $4
        `,
        [
          params.tenantId,
          params.spaceId,
          params.subjectId,
          metaLimit,
          hasDocFilter ? docIds : null,
          sourceTypes.length ? sourceTypes : null,
          tags.length ? tags : null,
        ],
      )
    : ({ rows: [] as any[], rowCount: 0 } as any);

  const lexRes = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        POSITION(lower($3) IN lower(snippet)) AS match_pos,
        embedding_minhash,
        citation_refs, source_page, source_section, hierarchy_path
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND space_id = $2 AND snippet ILIKE ('%' || $3 || '%')
        AND ($5::uuid[] IS NULL OR document_id = ANY($5::uuid[]))
        AND EXISTS (
          SELECT 1
          FROM knowledge_documents d
          WHERE d.tenant_id = knowledge_chunks.tenant_id
            AND d.space_id = knowledge_chunks.space_id
            AND d.id = knowledge_chunks.document_id
            AND d.version = knowledge_chunks.document_version
            AND (
              d.visibility = 'space'
              OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
            )
        )
      ORDER BY match_pos ASC NULLS LAST, created_at DESC
      LIMIT $6
    `,
    [params.tenantId, params.spaceId, params.query, params.subjectId, hasDocFilter ? docIds : null, lexicalLimit],
  );
  const vsCfg = resolveVectorStoreConfigFromEnv();
  const vectorStore = createVectorStore(vsCfg);

  /* Dense embedding 查询闭环：若外部 Embedding 已配置且 VectorStore 为 external 模式，
   * 优先使用 dense vector 查询，失败时降级到 minhash
   * HyDE 模式：使用假设性文档的 embedding 进行检索 */
  let vectorRes;
  const embQueryText = hydeStats.generated ? hydeQuery : params.query;
  const extEmbCfg = vsCfg.mode === "external" ? resolveExternalEmbeddingConfig() : null;
  if (extEmbCfg) {
    const denseVec = await fetchQueryEmbedding(extEmbCfg, embQueryText);
    if (denseVec && denseVec.length > 0) {
      const denseModelRef = `${extEmbCfg.model}:${extEmbCfg.dimensions}`;
      vectorRes = await vectorStore.query({
        pool: params.pool,
        q: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, embeddingModelRef: denseModelRef, vector: denseVec, topK: embedLimit, filters: hasDocFilter ? { documentIds: docIds } : undefined },
      });
    } else {
      /* dense embedding 获取失败，降级到 minhash */
      vectorRes = await vectorStore.query({
        pool: params.pool,
        q: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, embeddingModelRef: "minhash:16@1", vector: qMinhash, topK: embedLimit, filters: hasDocFilter ? { documentIds: docIds } : undefined },
      });
    }
  } else {
    vectorRes = await vectorStore.query({
      pool: params.pool,
      q: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, embeddingModelRef: "minhash:16@1", vector: qMinhash, topK: embedLimit, filters: hasDocFilter ? { documentIds: docIds } : undefined },
    });
  }
  const chunkIds = vectorRes.results.map((r) => r.chunkId).filter(Boolean).slice(0, embedLimit);
  const scoreById = new Map<string, number>();
  for (const r of vectorRes.results) if (r && r.chunkId) scoreById.set(String(r.chunkId), Number(r.score ?? 0));
  const embRes =
    chunkIds.length === 0
      ? ({ rows: [] as any[], rowCount: 0 } as any)
      : await params.pool.query(
          `
            SELECT
              id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
              NULL::int AS match_pos,
              embedding_minhash,
              citation_refs, source_page, source_section, hierarchy_path
            FROM knowledge_chunks
            WHERE tenant_id = $1 AND space_id = $2
              AND id = ANY($3::uuid[])
              AND ($5::uuid[] IS NULL OR document_id = ANY($5::uuid[]))
              AND EXISTS (
                SELECT 1
                FROM knowledge_documents d
                WHERE d.tenant_id = knowledge_chunks.tenant_id
                  AND d.space_id = knowledge_chunks.space_id
                  AND d.id = knowledge_chunks.document_id
                  AND d.version = knowledge_chunks.document_version
                  AND (
                    d.visibility = 'space'
                    OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
                  )
              )
          `,
          [params.tenantId, params.spaceId, chunkIds, params.subjectId, hasDocFilter ? docIds : null],
        );

  const byId = new Map<string, any>();
  for (const r of metaRes.rows as any[]) byId.set(String(r.id), { ...r, _stage: "meta" });
  for (const r of lexRes.rows as any[]) byId.set(String(r.id), { ...r, _stage: "lex" });
  for (const r of embRes.rows as any[]) if (!byId.has(String(r.id))) byId.set(String(r.id), { ...r, _stage: "vec", _vecScore: scoreById.get(String(r.id)) ?? 0 });
  const candidates = Array.from(byId.values());

  const qLower = params.query.toLowerCase();
  function overlapScore(mh: any) {
    const arr = Array.isArray(mh) ? (mh as number[]) : [];
    return minhashOverlapScore(qMinhash, arr);
  }
  function lexScore(snippet: string) {
    const pos = snippet.toLowerCase().indexOf(qLower);
    if (pos < 0) return 0;
    return 1 / (1 + pos);
  }

  const preRanked = candidates
    .map((c) => {
      const snippet = String(c.snippet ?? "");
      const sLex = lexScore(snippet);
      const sEmb = overlapScore(c.embedding_minhash);
      const sVec = typeof c._vecScore === "number" && Number.isFinite(c._vecScore) ? Number(c._vecScore) : sEmb;
      const createdAtMs = Date.parse(String(c.created_at ?? ""));
      const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : 0;
      const recencyBoost = 1 / (1 + ageMs / (24 * 60 * 60 * 1000));
      const metaBoost = String(c._stage) === "meta" ? wMetaBoost : 0;
      const score = sLex * wLex + sVec * wVec + recencyBoost * wRecency + metaBoost;
      return { ...c, _score: score, _sLex: sLex, _sVec: sVec, _sEmb: sEmb, _recencyBoost: recencyBoost, _metaBoost: metaBoost };
    })
    .sort((a, b) => (b._score as number) - (a._score as number))
    .slice(0, Math.max(params.limit, 40)); // 给 rerank 留更多候选

  /* ── Rerank 阶段 ── */
  let scored = preRanked;
  let rerankStats: { returned: number; reranked: boolean; degraded: boolean; degradeReason: string | null; latencyMs: number } = {
    returned: preRanked.length, reranked: false, degraded: false, degradeReason: null, latencyMs: 0,
  };
  try {
    const rerankCfg = await getRerankConfig({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId });
    if (rerankCfg && preRanked.length > 0) {
      const snippets = preRanked.map((c) => String(c.snippet ?? ""));
      const rerankResult = await rerank({ config: rerankCfg, query: params.query, documents: snippets });
      rerankStats = {
        returned: rerankResult.items.length,
        reranked: rerankResult.reranked,
        degraded: rerankResult.degraded,
        degradeReason: rerankResult.degradeReason,
        latencyMs: rerankResult.latencyMs,
      };
      if (rerankResult.reranked && rerankResult.items.length > 0) {
        /* 用 rerank 分数重新排序 */
        const rerankedList: typeof preRanked = [];
        for (const item of rerankResult.items) {
          const orig = preRanked[item.originalIndex];
          if (orig) {
            rerankedList.push({ ...orig, _score: item.score, _rerankScore: item.score });
          }
        }
        scored = rerankedList.slice(0, params.limit);
      } else {
        scored = preRanked.slice(0, params.limit);
      }
    } else {
      scored = preRanked.slice(0, params.limit);
    }
  } catch (e: any) {
    _logger.error("rerank stage failed", { error: e?.message ?? e });
    scored = preRanked.slice(0, params.limit);
    rerankStats.degraded = true;
    rerankStats.degradeReason = `rerank_exception: ${e?.message ?? e}`;
  }

  const latencyMs = Date.now() - startedAt;
  const stageStats = {
    metadata: { returned: metaRes.rowCount, limit: metaLimit, tagsCount: tags.length, sourceTypesCount: sourceTypes.length },
    lexical: { returned: lexRes.rowCount, limit: lexicalLimit },
    embedding: { returned: embRes.rowCount, limit: embedLimit, k, degraded: vectorRes.degraded, degradeReason: vectorRes.degradeReason },
    sparse: { enabled: false, queryTermCount: 0 },
    merged: { candidateCount: candidates.length },
    rerank: rerankStats,
    hyde: hydeStats,
    queryExpansion: queryExpansionStats,
    latencyMs,
  };
  const rankPolicy = typeof cfg?.rankPolicy === "string" && cfg.rankPolicy.trim() ? String(cfg.rankPolicy)
    : rerankStats.reranked ? "hybrid_minhash_rerank_v2_external" : "hybrid_minhash_rerank_v2";

  const hits = scored.map((h) => ({
    ...h,
    rank_reason: {
      kind: rankPolicy,
      stage: h._stage,
      sLex: Number(h._sLex.toFixed(4)),
      sVec: Number(h._sVec.toFixed(4)),
      sEmb: Number(h._sEmb.toFixed(4)),
      sSparse: 0,
      recencyBoost: Number(Number(h._recencyBoost ?? 0).toFixed(4)),
      metaBoost: Number(Number(h._metaBoost ?? 0).toFixed(4)),
      ...(typeof (h as any)._rerankScore === "number" ? { rerankScore: Number((h as any)._rerankScore.toFixed(4)) } : {}),
    },
  }));
  return {
    rankPolicy,
    stageStats,
    queryMinhashK: k,
    hits,
    vectorStoreRef: vectorStore.ref,
    degraded: vectorRes.degraded,
    degradeReason: vectorRes.degradeReason,
    strategyRef: params.strategyRef ?? null,
  };
}

export async function createRetrievalLog(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  queryDigest: any;
  filtersDigest: any;
  candidateCount: number;
  citedRefs: any;
  rankPolicy?: string | null;
  strategyRef?: string | null;
  vectorStoreRef?: any | null;
  stageStats?: any;
  rankedEvidenceRefs?: any;
  returnedCount?: number | null;
  degraded?: boolean;
  degradeReason?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_logs (
        tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, strategy_ref, vector_store_ref, stage_stats, ranked_evidence_refs, returned_count, degraded, degrade_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14)
      RETURNING id
    `,
    [
      params.tenantId,
      params.spaceId,
      params.queryDigest,
      params.filtersDigest,
      params.candidateCount,
      JSON.stringify(params.citedRefs ?? []),
      params.rankPolicy ?? null,
      params.strategyRef ?? null,
      params.vectorStoreRef ? JSON.stringify(params.vectorStoreRef) : null,
      params.stageStats ? JSON.stringify(params.stageStats) : null,
      params.rankedEvidenceRefs ? JSON.stringify(params.rankedEvidenceRefs) : null,
      params.returnedCount ?? null,
      Boolean(params.degraded ?? false),
      params.degradeReason ?? null,
    ],
  );
  return res.rows[0]!.id as string;
}

export type KnowledgeRetrievalLogRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  queryDigest: any;
  filtersDigest: any;
  candidateCount: number;
  citedRefs: any;
  rankPolicy: string | null;
  strategyRef: string | null;
  vectorStoreRef: any | null;
  stageStats: any | null;
  rankedEvidenceRefs: any | null;
  returnedCount: number | null;
  degraded: boolean;
  degradeReason: string | null;
  createdAt: string;
};

export async function listRetrievalLogs(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  limit: number;
  offset: number;
  rankPolicy?: string;
  degraded?: boolean;
  runId?: string;
  source?: string;
}) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.rankPolicy) {
    where.push(`rank_policy = $${idx++}`);
    args.push(params.rankPolicy);
  }
  if (params.degraded != null) {
    where.push(`degraded = $${idx++}`);
    args.push(Boolean(params.degraded));
  }
  if (params.runId) {
    where.push(`(filters_digest->>'runId') = $${idx++}`);
    args.push(params.runId);
  }
  if (params.source) {
    where.push(`(filters_digest->>'source') = $${idx++}`);
    args.push(params.source);
  }
  where.push(`true`);
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT
        id, tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, strategy_ref, vector_store_ref, stage_stats, ranked_evidence_refs, returned_count, degraded, degrade_reason, created_at
      FROM knowledge_retrieval_logs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(
    (r): KnowledgeRetrievalLogRow => ({
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      queryDigest: r.query_digest,
      filtersDigest: r.filters_digest,
      candidateCount: Number(r.candidate_count),
      citedRefs: r.cited_refs,
      rankPolicy: r.rank_policy ?? null,
      strategyRef: r.strategy_ref ?? null,
      vectorStoreRef: r.vector_store_ref ?? null,
      stageStats: r.stage_stats ?? null,
      rankedEvidenceRefs: r.ranked_evidence_refs ?? null,
      returnedCount: r.returned_count != null ? Number(r.returned_count) : null,
      degraded: Boolean(r.degraded),
      degradeReason: r.degrade_reason ?? null,
      createdAt: r.created_at,
    }),
  );
}

export async function getRetrievalLog(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(
    `
      SELECT
        id, tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, strategy_ref, vector_store_ref, stage_stats, ranked_evidence_refs, returned_count, degraded, degrade_reason, created_at
      FROM knowledge_retrieval_logs
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.id],
  );
  if (!res.rowCount) return null;
  const r: any = res.rows[0];
  const out: KnowledgeRetrievalLogRow = {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    queryDigest: r.query_digest,
    filtersDigest: r.filters_digest,
    candidateCount: Number(r.candidate_count),
    citedRefs: r.cited_refs,
    rankPolicy: r.rank_policy ?? null,
    strategyRef: r.strategy_ref ?? null,
    vectorStoreRef: r.vector_store_ref ?? null,
    stageStats: r.stage_stats ?? null,
    rankedEvidenceRefs: r.ranked_evidence_refs ?? null,
    returnedCount: r.returned_count != null ? Number(r.returned_count) : null,
    degraded: Boolean(r.degraded),
    degradeReason: r.degrade_reason ?? null,
    createdAt: r.created_at,
  };
  return out;
}

export type KnowledgeIngestJobRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  provider: string;
  workspaceId: string;
  eventId: string;
  sourceEventPk: string | null;
  status: string;
  attempt: number;
  lastError: string | null;
  documentId: string | null;
  documentVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

export async function listIngestJobs(params: { pool: Pool; tenantId: string; spaceId: string; status?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_ingest_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(
    (r): KnowledgeIngestJobRow => ({
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      provider: r.provider,
      workspaceId: r.workspace_id,
      eventId: r.event_id,
      sourceEventPk: r.source_event_pk ?? null,
      status: r.status,
      attempt: Number(r.attempt),
      lastError: r.last_error ?? null,
      documentId: r.document_id ?? null,
      documentVersion: r.document_version != null ? Number(r.document_version) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
}

export async function getIngestJob(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_ingest_jobs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  const r: any = res.rows[0];
  const out: KnowledgeIngestJobRow = {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    eventId: r.event_id,
    sourceEventPk: r.source_event_pk ?? null,
    status: r.status,
    attempt: Number(r.attempt),
    lastError: r.last_error ?? null,
    documentId: r.document_id ?? null,
    documentVersion: r.document_version != null ? Number(r.document_version) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return out;
}

export type KnowledgeEmbeddingJobRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  embeddingModelRef: string;
  status: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listEmbeddingJobs(params: { pool: Pool; tenantId: string; spaceId: string; status?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_embedding_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(
    (r): KnowledgeEmbeddingJobRow => ({
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      documentId: r.document_id,
      documentVersion: Number(r.document_version),
      embeddingModelRef: r.embedding_model_ref,
      status: r.status,
      attempt: Number(r.attempt),
      lastError: r.last_error ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
}

export async function getEmbeddingJob(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_embedding_jobs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  const r: any = res.rows[0];
  const out: KnowledgeEmbeddingJobRow = {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    documentId: r.document_id,
    documentVersion: Number(r.document_version),
    embeddingModelRef: r.embedding_model_ref,
    status: r.status,
    attempt: Number(r.attempt),
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return out;
}

export async function listIndexJobs(params: { pool: Pool; tenantId: string; spaceId: string; status?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_index_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map((r) => toJob(r));
}

export async function getIndexJob(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_index_jobs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  return toJob(res.rows[0]);
}

/* ── 文档管理 CRUD ─────────────────────────────────────────────────────── */

export async function listDocuments(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  limit: number;
  offset: number;
  status?: string;
  sourceType?: string;
  search?: string;
}) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  if (params.sourceType) {
    where.push(`source_type = $${idx++}`);
    args.push(params.sourceType);
  }
  if (params.search) {
    where.push(`title ILIKE ('%' || $${idx++} || '%')`);
    args.push(params.search);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT id, tenant_id, space_id, version, title, source_type, tags, content_digest, status, visibility, owner_subject_id, created_at, updated_at
      FROM knowledge_documents
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  const countRes = await params.pool.query(
    `SELECT count(*)::int AS total FROM knowledge_documents WHERE ${where.slice(0, where.length).join(" AND ")}`,
    args.slice(0, args.length - 2),
  );
  return {
    documents: (res.rows as any[]).map(toDoc),
    total: Number(countRes.rows[0]?.total ?? 0),
  };
}

export async function getDocument(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(
    `
      SELECT id, tenant_id, space_id, version, title, source_type, tags, content_digest, status, visibility, owner_subject_id, created_at, updated_at
      FROM knowledge_documents
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.id],
  );
  if (!res.rowCount) return null;
  return toDoc(res.rows[0]);
}

export async function updateDocument(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  id: string;
  title?: string;
  tags?: any;
  status?: string;
}) {
  const sets: string[] = ["updated_at = now()"];
  const args: any[] = [params.tenantId, params.spaceId, params.id];
  let idx = 4;
  if (params.title !== undefined) {
    sets.push(`title = $${idx++}`);
    args.push(params.title);
  }
  if (params.tags !== undefined) {
    sets.push(`tags = $${idx++}::jsonb`);
    args.push(JSON.stringify(params.tags));
  }
  if (params.status !== undefined) {
    sets.push(`status = $${idx++}`);
    args.push(params.status);
  }
  const res = await params.pool.query(
    `
      UPDATE knowledge_documents
      SET ${sets.join(", ")}
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      RETURNING id, tenant_id, space_id, version, title, source_type, tags, content_digest, status, created_at, updated_at
    `,
    args,
  );
  if (!res.rowCount) return null;
  return toDoc(res.rows[0]);
}

export async function deleteDocument(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  await params.pool.query("DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND space_id = $2 AND document_id = $3", [params.tenantId, params.spaceId, params.id]);
  const res = await params.pool.query(
    "DELETE FROM knowledge_documents WHERE tenant_id = $1 AND space_id = $2 AND id = $3 RETURNING id",
    [params.tenantId, params.spaceId, params.id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getDocumentChunkCount(params: { pool: Pool; tenantId: string; spaceId: string; documentId: string }) {
  const res = await params.pool.query(
    "SELECT count(*)::int AS total FROM knowledge_chunks WHERE tenant_id = $1 AND space_id = $2 AND document_id = $3",
    [params.tenantId, params.spaceId, params.documentId],
  );
  return Number(res.rows[0]?.total ?? 0);
}

export async function resolveEvidenceRef(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  sourceRef: { documentId: string; version: number; chunkId: string };
  opts?: { includeVersionHistory?: boolean };
}) {
  const res = await params.pool.query(
    `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.document_version,
        c.chunk_index,
        c.start_offset,
        c.end_offset,
        c.snippet,
        c.citation_refs,
        c.source_page,
        c.source_section,
        d.title AS document_title,
        d.source_type AS document_source_type
      FROM knowledge_chunks c
      JOIN knowledge_documents d
        ON d.tenant_id = c.tenant_id
        AND d.space_id = c.space_id
        AND d.id = c.document_id
        AND d.version = c.document_version
      WHERE c.tenant_id = $1
        AND c.space_id = $2
        AND c.id = $3
        AND c.document_id = $4
        AND c.document_version = $5
        AND (
          d.visibility = 'space'
          OR (d.visibility = 'subject' AND d.owner_subject_id = $6)
        )
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.sourceRef.chunkId, params.sourceRef.documentId, params.sourceRef.version, params.subjectId],
  );
  if (!res.rowCount) return null;
  const row = res.rows[0] as any;

  // 版本历史查询
  if (params.opts?.includeVersionHistory && row.document_id) {
    const { rows: versions } = await params.pool.query(
      `
        SELECT version, status, updated_at
        FROM knowledge_documents
        WHERE id = $1 AND tenant_id = $2
        ORDER BY version DESC
      `,
      [row.document_id, params.tenantId],
    );
    row.versionHistory = versions.map((v: any) => ({
      version: v.version,
      status: v.status,
      updatedAt: v.updated_at,
    }));
  }

  return row;
}

export async function resolveEvidenceRefByChunkId(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; chunkId: string }) {
  const res = await params.pool.query(
    `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.document_version,
        c.chunk_index,
        c.start_offset,
        c.end_offset,
        c.snippet,
        c.citation_refs,
        c.source_page,
        c.source_section,
        d.title AS document_title,
        d.source_type AS document_source_type
      FROM knowledge_chunks c
      JOIN knowledge_documents d
        ON d.tenant_id = c.tenant_id
        AND d.space_id = c.space_id
        AND d.id = c.document_id
        AND d.version = c.document_version
      WHERE c.tenant_id = $1
        AND c.space_id = $2
        AND c.id = $3
        AND (
          d.visibility = 'space'
          OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
        )
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.chunkId, params.subjectId],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as any;
}
