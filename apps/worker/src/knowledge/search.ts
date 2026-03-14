import crypto from "node:crypto";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";

function tokenize(text: string) {
  const out: string[] = [];
  const s = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
    if (ok) buf += ch;
    else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
    if (out.length >= 256) break;
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

function hash32(str: string) {
  const h = crypto.createHash("sha256").update(str, "utf8").digest();
  return h.readInt32BE(0);
}

function computeMinhash(text: string, k: number) {
  const toks = tokenize(text);
  const mins = new Array<number>(k).fill(2147483647);
  for (const t of toks) {
    for (let i = 0; i < k; i++) {
      const v = hash32(`${i}:${t}`);
      if (v < mins[i]!) mins[i] = v;
    }
  }
  return mins.map((x) => (x === 2147483647 ? 0 : x));
}

function sha256_8(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

export async function knowledgeSearch(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; input: any }) {
  const query = String(params.input?.query ?? "");
  if (!query) return { retrievalLogId: "", evidence: [], candidateCount: 0 };
  const limit = typeof params.input?.limit === "number" && Number.isFinite(params.input.limit) ? Math.max(1, Math.min(50, params.input.limit)) : 10;

  const k = 16;
  const qMinhash = computeMinhash(query, k);
  const lexLimit = Math.max(1, Math.min(200, limit * 12));
  const embLimit = Math.max(1, Math.min(200, limit * 16));

  const startedAt = Date.now();
  const lexRes = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        POSITION(lower($3) IN lower(snippet)) AS match_pos,
        embedding_minhash
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
    [params.tenantId, params.spaceId, query, params.subjectId, lexLimit],
  );
  const embRes = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        NULL::int AS match_pos,
        embedding_minhash
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND space_id = $2
        AND embedding_minhash && $3::int[]
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
      ORDER BY embedding_updated_at DESC NULLS LAST, created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.spaceId, qMinhash, params.subjectId, embLimit],
  );

  const byId = new Map<string, any>();
  for (const r of lexRes.rows as any[]) byId.set(String(r.id), { ...r, _stage: "lex" });
  for (const r of embRes.rows as any[]) if (!byId.has(String(r.id))) byId.set(String(r.id), { ...r, _stage: "emb" });
  const candidates = Array.from(byId.values());

  const qLower = query.toLowerCase();
  function overlapScore(mh: any) {
    const arr = Array.isArray(mh) ? (mh as number[]) : [];
    if (!arr.length) return 0;
    let hit = 0;
    const set = new Set(qMinhash);
    for (const v of arr) if (set.has(Number(v))) hit++;
    return hit / k;
  }
  function lexScore(snippet: string) {
    const pos = snippet.toLowerCase().indexOf(qLower);
    if (pos < 0) return 0;
    return 1 / (1 + pos);
  }

  const rankPolicy = "hybrid_minhash_rerank_v1";
  const scored = candidates
    .map((c) => {
      const snippet = String(c.snippet ?? "");
      const sLex = lexScore(snippet);
      const sEmb = overlapScore(c.embedding_minhash);
      const score = sLex * 1.2 + sEmb;
      return { ...c, _score: score, _sLex: sLex, _sEmb: sEmb };
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
      rankReason: { kind: rankPolicy, stage: h._stage, sLex: Number(h._sLex.toFixed(4)), sEmb: Number(h._sEmb.toFixed(4)) },
    };
  });

  const stageStats = {
    lexical: { returned: lexRes.rowCount, limit: lexLimit },
    embedding: { returned: embRes.rowCount, limit: embLimit, k },
    merged: { candidateCount: candidates.length },
    rerank: { returned: evidence.length },
    latencyMs: Date.now() - startedAt,
  };

  const log = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_logs (
        tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, stage_stats, ranked_evidence_refs, returned_count, degraded
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11)
      RETURNING id
    `,
    [
      params.tenantId,
      params.spaceId,
      { queryLen: query.length, rankPolicy },
      { spaceId: params.spaceId },
      candidates.length,
      JSON.stringify(evidence.map((e: any) => e.sourceRef)),
      rankPolicy,
      JSON.stringify(stageStats),
      JSON.stringify(evidence.map((e: any) => ({ sourceRef: e.sourceRef, snippetDigest: e.snippetDigest, location: e.location, rankReason: e.rankReason }))),
      evidence.length,
      false,
    ],
  );
  const retrievalLogId = log.rows[0]?.id ? String(log.rows[0].id) : "";

  return { retrievalLogId, evidence, candidateCount: candidates.length, returnedCount: evidence.length, rankSummary: { rankPolicy, stageStats } };
}
