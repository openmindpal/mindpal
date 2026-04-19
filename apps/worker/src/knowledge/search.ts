import type { Pool } from "pg";
import { redactValue, computeMinhash, minhashOverlapScore, sha256_8 } from "@openslin/shared";
import { createVectorStore, resolveVectorStoreConfigFromEnv } from "./vectorStore";

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

export async function knowledgeSearch(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; input: any }) {
  const query = String(params.input?.query ?? "");
  if (!query) return { retrievalLogId: "", evidence: [], candidateCount: 0 };
  const limit = typeof params.input?.limit === "number" && Number.isFinite(params.input.limit) ? Math.max(1, Math.min(50, params.input.limit)) : 10;
  const docIds = Array.isArray(params.input?.filters?.documentIds) ? params.input.filters.documentIds.map(String).filter(Boolean) : [];
  const hasDocFilter = docIds.length > 0 && docIds.length <= 200;
  const tags = Array.isArray(params.input?.filters?.tags) ? params.input.filters.tags.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
  const sourceTypes = Array.isArray(params.input?.filters?.sourceTypes) ? params.input.filters.sourceTypes.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
  const hasMetaFilter = (tags.length > 0 && tags.length <= 20) || (sourceTypes.length > 0 && sourceTypes.length <= 20);

  const k = 16;
  const qMinhash = computeMinhash(query, k);
  const lexLimit = Math.max(1, Math.min(200, limit * 12));
  const embLimit = Math.max(1, Math.min(200, limit * 16));
  const metaLimit = Math.max(1, Math.min(200, limit * 8));

  const startedAt = Date.now();
  const metaRes = hasMetaFilter
    ? await params.pool.query(
        `
          SELECT
            c.id, c.document_id, c.document_version, c.chunk_index, c.start_offset, c.end_offset, c.snippet, c.created_at,
            NULL::int AS match_pos,
            c.embedding_minhash
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
        [params.tenantId, params.spaceId, params.subjectId, metaLimit, hasDocFilter ? docIds : null, sourceTypes.length ? sourceTypes : null, tags.length ? tags : null],
      )
    : ({ rows: [] as any[], rowCount: 0 } as any);
  const lexRes = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        POSITION(lower($3) IN lower(snippet)) AS match_pos,
        embedding_minhash
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
    [params.tenantId, params.spaceId, query, params.subjectId, hasDocFilter ? docIds : null, lexLimit],
  );
  const vsCfg = resolveVectorStoreConfigFromEnv();
  const vectorStore = createVectorStore(vsCfg);

  /* Dense embedding 查询闭环：优先使用 dense vector，失败降级 minhash */
  let vectorRes;
  const extEmbCfg = vsCfg.mode === "external" ? resolveExternalEmbeddingConfig() : null;
  if (extEmbCfg) {
    const denseVec = await fetchQueryEmbedding(extEmbCfg, query);
    if (denseVec && denseVec.length > 0) {
      const denseModelRef = `${extEmbCfg.model}:${extEmbCfg.dimensions}`;
      vectorRes = await vectorStore.query({
        pool: params.pool,
        q: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, embeddingModelRef: denseModelRef, vector: denseVec, topK: embLimit, filters: hasDocFilter ? { documentIds: docIds } : undefined },
      });
    } else {
      vectorRes = await vectorStore.query({
        pool: params.pool,
        q: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, embeddingModelRef: "minhash:16@1", vector: qMinhash, topK: embLimit, filters: hasDocFilter ? { documentIds: docIds } : undefined },
      });
    }
  } else {
    vectorRes = await vectorStore.query({
      pool: params.pool,
      q: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, embeddingModelRef: "minhash:16@1", vector: qMinhash, topK: embLimit, filters: hasDocFilter ? { documentIds: docIds } : undefined },
    });
  }
  const chunkIds = vectorRes.results.map((r: { chunkId: string; score: number }) => r.chunkId).filter(Boolean).slice(0, embLimit);
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
              embedding_minhash
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

  const qLower = query.toLowerCase();
  function overlapScore(mh: any) {
    const arr = Array.isArray(mh) ? (mh as number[]) : [];
    return minhashOverlapScore(qMinhash, arr);
  }
  function lexScore(snippet: string) {
    const pos = snippet.toLowerCase().indexOf(qLower);
    if (pos < 0) return 0;
    return 1 / (1 + pos);
  }

  const rankPolicy = "hybrid_minhash_rerank_v2";
  const scored = candidates
    .map((c) => {
      const snippet = String(c.snippet ?? "");
      const sLex = lexScore(snippet);
      const sEmb = overlapScore(c.embedding_minhash);
      const sVec = typeof c._vecScore === "number" && Number.isFinite(c._vecScore) ? Number(c._vecScore) : sEmb;
      const createdAtMs = Date.parse(String(c.created_at ?? ""));
      const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : 0;
      const recencyBoost = 1 / (1 + ageMs / (24 * 60 * 60 * 1000));
      const metaBoost = String(c._stage) === "meta" ? 0.08 : 0;
      const score = sLex * 1.2 + sVec + recencyBoost * 0.05 + metaBoost;
      return { ...c, _score: score, _sLex: sLex, _sVec: sVec, _sEmb: sEmb, _recencyBoost: recencyBoost, _metaBoost: metaBoost };
    })
    .sort((a, b) => (b._score as number) - (a._score as number))
    .slice(0, limit);

  const evidence = scored.map((h: any) => {
    const snippetRaw = String(h.snippet ?? "");
    const clipped = snippetRaw.slice(0, 280);
    const redacted = redactValue(clipped);
    return {
      sourceRef: { documentId: String(h.document_id), version: Number(h.document_version), chunkId: String(h.id) },
      snippet: String(redacted.value ?? ""),
      snippetDigest: { len: snippetRaw.length, sha256_8: sha256_8(snippetRaw) },
      location: { chunkIndex: Number(h.chunk_index), startOffset: Number(h.start_offset), endOffset: Number(h.end_offset) },
      rankReason: {
        kind: rankPolicy,
        stage: h._stage,
        sLex: Number(h._sLex.toFixed(4)),
        sVec: Number(h._sVec.toFixed(4)),
        sEmb: Number(h._sEmb.toFixed(4)),
        recencyBoost: Number(Number(h._recencyBoost ?? 0).toFixed(4)),
        metaBoost: Number(Number(h._metaBoost ?? 0).toFixed(4)),
      },
    };
  });

  const stageStats = {
    metadata: { returned: metaRes.rowCount, limit: metaLimit, tagsCount: tags.length, sourceTypesCount: sourceTypes.length },
    lexical: { returned: lexRes.rowCount, limit: lexLimit },
    embedding: { returned: embRes.rowCount, limit: embLimit, k, degraded: vectorRes.degraded, degradeReason: vectorRes.degradeReason },
    merged: { candidateCount: candidates.length },
    rerank: { returned: evidence.length },
    latencyMs: Date.now() - startedAt,
  };

  const log = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_logs (
        tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, vector_store_ref, stage_stats, ranked_evidence_refs, returned_count, degraded, degrade_reason
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)
      RETURNING id
    `,
    [
      params.tenantId,
      params.spaceId,
      { queryLen: query.length, rankPolicy },
      { spaceId: params.spaceId, documentIds: hasDocFilter ? docIds : null },
      candidates.length,
      JSON.stringify(evidence.map((e: any) => e.sourceRef)),
      rankPolicy,
      JSON.stringify(vectorStore.ref),
      JSON.stringify(stageStats),
      JSON.stringify(evidence.map((e: any) => ({ sourceRef: e.sourceRef, snippetDigest: e.snippetDigest, location: e.location, rankReason: e.rankReason }))),
      evidence.length,
      Boolean(vectorRes.degraded),
      vectorRes.degradeReason,
    ],
  );
  const retrievalLogId = log.rows[0]?.id ? String(log.rows[0].id) : "";

  return { retrievalLogId, evidence, candidateCount: candidates.length, returnedCount: evidence.length, rankSummary: { rankPolicy, stageStats } };
}
