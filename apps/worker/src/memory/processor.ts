import type { Pool } from "pg";
import {
  redactValue,
  // ── 从 @openslin/shared/memoryCore 导入的共享权威实现 ──
  MINHASH_MODEL_REF,
  computeMinhash,
  minhashOverlapScore,
  evaluateMemoryRisk,
  memorySha256 as sha256,
  computeMemoryRerankScore,
  StructuredLogger,
  escapeIlikePat,
  type WriteProof,
  type MemoryRerankInput,
  APPROVAL_REQUIRED_RISK_LEVELS,
} from "@openslin/shared";
import { encryptMemoryContent, decryptMemoryContent, isMemoryEncryptionEnabled } from "./memoryEncryption";

const _logger = new StructuredLogger({ module: "worker:memoryProcessor" });

export async function memoryWrite(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  input: any;
}) {
  const scope = params.input?.scope === "space" ? "space" : "user";
  const type = String(params.input?.type ?? "other");
  const title = params.input?.title ? String(params.input.title) : null;
  const contentTextRaw = String(params.input?.contentText ?? "");
  const priority = typeof params.input?.priority === "number" && Number.isFinite(params.input.priority) ? Math.max(0, Math.min(100, params.input.priority)) : null;
  const confidence = typeof params.input?.confidence === "number" && Number.isFinite(params.input.confidence) ? Math.max(0, Math.min(1, params.input.confidence)) : null;
  const retentionDays = typeof params.input?.retentionDays === "number" && Number.isFinite(params.input.retentionDays) ? params.input.retentionDays : null;
  const expiresAt = retentionDays ? new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const redacted = redactValue(contentTextRaw);
  const contentText = String(redacted.value ?? "");
  const digest = sha256(contentText);

  // ── 风险评估（统一调用 @openslin/shared 权威实现） ──
  const riskEvaluation = evaluateMemoryRisk({ type, contentText, title });

  // ── writeProof 服务端校验 ──
  const intentPolicy = params.input?.writeIntent?.policy ?? "policyAllowed";
  if (riskEvaluation.approvalRequired && intentPolicy !== "approved") {
    throw new Error(
      `policy_violation:high_risk_memory_write:riskLevel=${riskEvaluation.riskLevel},` +
      `riskFactors=[${riskEvaluation.riskFactors.join(",")}],requiredPolicy=approved,gotPolicy=${intentPolicy}`
    );
  }

  // 服务端根据实际 intent 生成 writeProof（而非简单信任客户端声明）
  let writeProof: WriteProof;
  if (params.input?.writeIntent) {
    const intent = params.input.writeIntent;
    switch (intent.policy) {
      case "confirmed":
        if (!intent.confirmationRef?.requestId) {
          throw new Error("writeIntent policy=confirmed 需要提供 confirmationRef.requestId");
        }
        writeProof = {
          policy: "confirmed",
          provenAt: new Date().toISOString(),
          provenBy: params.subjectId,
          confirmationRef: {
            requestId: intent.confirmationRef.requestId,
            turnId: intent.confirmationRef.turnId,
            confirmationType: intent.confirmationRef.confirmationType ?? "implicit",
          },
        };
        break;
      case "approved":
        if (!intent.approvalId) {
          throw new Error("writeIntent policy=approved 需要提供 approvalId");
        }
        // Worker 路径无法查询 approvals 表，但记录 approvalId 供审计追溯
        writeProof = {
          policy: "approved",
          provenAt: new Date().toISOString(),
          provenBy: params.subjectId,
          approvalId: intent.approvalId,
        } as WriteProof;
        break;
      case "policyAllowed":
      default:
        writeProof = {
          policy: "policyAllowed",
          provenAt: new Date().toISOString(),
          provenBy: "system",
          policyRef: { snapshotRef: intent.policyRef?.snapshotRef, decision: "allow" },
        };
        break;
    }
  } else {
    // 没有提供 writeIntent，使用默认 policyAllowed
    writeProof = {
      policy: "policyAllowed",
      provenAt: new Date().toISOString(),
      provenBy: params.subjectId,
      policyRef: { snapshotRef: undefined, decision: "allow" },
    };
  }

  const ownerSubjectId = scope === "user" ? params.subjectId : null;

  // 计算 minhash 向量
  const embeddingInput = (title ? `${title} ` : "") + contentText;
  const minhash = computeMinhash(embeddingInput);

  const mergeThreshold = typeof params.input?.mergeThreshold === "number" && Number.isFinite(params.input.mergeThreshold) ? Math.max(0.6, Math.min(0.95, params.input.mergeThreshold)) : 0.86;
  const mergeLimit = typeof params.input?.mergeCandidateLimit === "number" && Number.isFinite(params.input.mergeCandidateLimit) ? Math.max(5, Math.min(200, Math.floor(params.input.mergeCandidateLimit))) : 50;

  // ── 冲突检测：写入前检查是否存在语义相近但内容矛盾的记忆 ──
  let conflictDetected = false;
  let conflictMarker: string | null = null;
  const CONFLICT_THRESHOLD = 0.3;
  try {
    const conflictCandRes = await params.pool.query(
      `SELECT id, type, title, content_text, embedding_minhash
       FROM memory_entries
       WHERE tenant_id = $1 AND space_id = $2 AND type = $3
         AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
         AND embedding_minhash IS NOT NULL AND embedding_minhash && $4::int[]
       ORDER BY created_at DESC LIMIT 10`,
      [params.tenantId, params.spaceId, type, minhash],
    );
    const newContentLower = contentText.toLowerCase().trim();
    for (const row of conflictCandRes.rows as Record<string, unknown>[]) {
      const mh = Array.isArray(row.embedding_minhash) ? (row.embedding_minhash as number[]) : [];
      const overlapScore = minhashOverlapScore(minhash, mh);
      if (overlapScore >= CONFLICT_THRESHOLD) {
        const existingLower = String(row.content_text ?? "").toLowerCase().trim();
        if (existingLower !== newContentLower) {
          conflictDetected = true;
          conflictMarker = String(row.id);
          break;
        }
      }
    }
  } catch {
    // 冲突检测失败不阻塞写入
  }

  // P2-03b: 列级加密（若启用，将 contentText 加密后存入 DB）
  // 提前加密，确保合并分支和 INSERT 分支都使用 storedContentText
  const storedContentText = await encryptMemoryContent({
    pool: params.pool,
    tenantId: params.tenantId,
    plaintext: contentText,
    scopeId: params.tenantId,
  });

  try {
    const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "scope = $3", "type = $4"];
    const args: any[] = [params.tenantId, params.spaceId, scope, type];
    let idx = 5;
    if (scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
    const candRes = await params.pool.query(
      `
        SELECT id, embedding_minhash
        FROM memory_entries
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT $${idx}
      `,
      [...args, mergeLimit],
    );
    let bestId: string | null = null;
    let bestScore = 0;
    for (const r of candRes.rows as Record<string, unknown>[]) {
      const mh = Array.isArray(r.embedding_minhash) ? (r.embedding_minhash as number[]) : [];
      const score = minhashOverlapScore(minhash, mh);
      if (score > bestScore) {
        bestScore = score;
        bestId = String(r.id);
      }
    }
    if (bestId && bestScore >= mergeThreshold) {
      // 合并更新：递增 factVersion，保留冲突标记
      const src = {
        kind: "tool",
        tool: "memory.write",
        merged: { into: bestId, score: Number(bestScore.toFixed(4)) },
        ...(priority !== null ? { priority } : {}),
        ...(confidence !== null ? { confidence } : {}),
      };
      const mergeRes = await params.pool.query(
        `
          UPDATE memory_entries
          SET title = $3,
              content_text = $4,
              content_digest = $5,
              retention_days = $6,
              expires_at = $7,
              write_policy = $8,
              write_proof = $9::jsonb,
              source_ref = COALESCE(source_ref, '{}'::jsonb) || $10::jsonb,
              embedding_model_ref = $11,
              embedding_minhash = $12,
              embedding_updated_at = now(),
              fact_version = COALESCE(fact_version, 1) + 1,
              confidence = COALESCE($13, confidence),
              conflict_marker = COALESCE($14, conflict_marker),
              resolution_status = CASE WHEN $14 IS NOT NULL THEN 'pending' ELSE resolution_status END,
              updated_at = now()
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, scope, type, title, created_at, fact_version, content_text, updated_at
        `,
        [bestId, params.tenantId, title, storedContentText, digest, retentionDays, expiresAt, writeProof.policy, JSON.stringify(writeProof), JSON.stringify(src), MINHASH_MODEL_REF, minhash, confidence, conflictMarker],
      );
      if (!mergeRes.rows.length) {
        throw new Error(`memory merge update returned no rows: id=${bestId}, tenant=${params.tenantId}`);
      }
      const merged = mergeRes.rows[0] as Record<string, unknown>;
      // P0-FIX: 解密 RETURNING 的 content_text（可能为列级加密密文）
      const mergedContentText = await decryptMemoryContent({
        pool: params.pool, tenantId: params.tenantId, value: merged.content_text,
        options: { onFailure: "placeholder" },
      });
      return { entry: { id: String(merged.id), scope: String(merged.scope), type: String(merged.type), title: merged.title != null ? String(merged.title) : null, contentText: mergedContentText, createdAt: String(merged.created_at), factVersion: Number(merged.fact_version), updatedAt: String(merged.updated_at) }, dlpSummary: redacted.summary, riskEvaluation, conflictDetected };
    }
  } catch (mergeErr) {
        _logger.warn("merge candidate query failed, falling through to INSERT", { err: (mergeErr as Error)?.message });
  }

  const res = await params.pool.query(
    `
      INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, retention_days, expires_at, write_policy, write_proof, source_ref,
        embedding_model_ref, embedding_minhash, embedding_updated_at,
        confidence, conflict_marker, resolution_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$18)
      RETURNING id, scope, type, title, created_at
    `,
    [
      params.tenantId,
      params.spaceId,
      ownerSubjectId,
      scope,
      type,
      title,
      storedContentText,
      digest,
      retentionDays,
      expiresAt,
      writeProof.policy,
      JSON.stringify(writeProof),
      JSON.stringify({ kind: "tool", tool: "memory.write", ...(priority !== null ? { priority } : {}), ...(confidence !== null ? { confidence } : {}) }),
      MINHASH_MODEL_REF,
      minhash,
      confidence,
      conflictMarker,
      conflictMarker ? "pending" : null,
    ],
  );
  const row = res.rows[0] as Record<string, unknown>;
  return { entry: { id: String(row.id), scope: String(row.scope), type: String(row.type), title: row.title != null ? String(row.title) : null, createdAt: String(row.created_at) }, dlpSummary: redacted.summary, riskEvaluation, conflictDetected };
}

export async function memoryRead(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; input: any }) {
  const scope = params.input?.scope === "space" ? "space" : params.input?.scope === "user" ? "user" : null;
  const query = String(params.input?.query ?? "");
  const limit = typeof params.input?.limit === "number" && Number.isFinite(params.input.limit) ? Math.max(1, Math.min(20, params.input.limit)) : 5;
  const types = Array.isArray(params.input?.types) ? params.input.types.map((t: any) => String(t)).slice(0, 20) : null;

  if (!query) {
    // P0-FIX: 空 query 时返回最近的记忆条目，支持“列出所有记忆”场景
    const recentWhere: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "(expires_at IS NULL OR expires_at > now())"];
    const recentArgs: any[] = [params.tenantId, params.spaceId];
    let rIdx = 3;
    if (scope) {
      recentWhere.push(`scope = $${rIdx++}`);
      recentArgs.push(scope);
      if (scope === "user") {
        recentWhere.push(`owner_subject_id = $${rIdx++}`);
        recentArgs.push(params.subjectId);
      }
    }
    if (types?.length) {
      recentWhere.push(`type = ANY($${rIdx++}::text[])`);
      recentArgs.push(types);
    }
    const recentRes = await params.pool.query(
      `SELECT id, scope, type, title, content_text, created_at
       FROM memory_entries
       WHERE ${recentWhere.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT $${rIdx}`,
      [...recentArgs, limit],
    );
    const evidence: Array<{ id: string; type: string; scope: string; title: string | null; snippet: string; createdAt: string }> = [];
    for (const r of recentRes.rows as Record<string, unknown>[]) {
      // P2-03b: 解密 content_text（自动检测明文/密文）
      const decryptedContent = await decryptMemoryContent({
        pool: params.pool, tenantId: params.tenantId, value: r.content_text,
        options: { onFailure: "placeholder" },
      });
      const snippetRaw = (r.title ? `${r.title}\n` : "") + decryptedContent;
      const clipped = snippetRaw.slice(0, 280);
      const redacted = redactValue(clipped);
      evidence.push({
        id: String(r.id),
        type: String(r.type),
        scope: String(r.scope),
        title: r.title != null ? String(r.title) : null,
        snippet: String(redacted.value ?? ""),
        createdAt: String(r.created_at),
      });
    }
    return { evidence, candidateCount: evidence.length };
  }

  const baseWhere: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "(expires_at IS NULL OR expires_at > now())"];
  const baseArgs: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (scope) {
    baseWhere.push(`scope = $${idx++}`);
    baseArgs.push(scope);
    if (scope === "user") {
      baseWhere.push(`owner_subject_id = $${idx++}`);
      baseArgs.push(params.subjectId);
    }
  }

  if (types?.length) {
    baseWhere.push(`type = ANY($${idx++}::text[])`);
    baseArgs.push(types);
  }

  const scopeWhereClause = baseWhere.join(" AND ");
  const scopeArgs = [...baseArgs];
  const scopeNextIdx = idx;

  // Stage 1: Lexical (ILIKE)
  const lexLimit = Math.max(limit, limit * 3);
  const lexIdx = scopeNextIdx;
  const lexRes = await params.pool.query(
    `
      SELECT id, scope, type, title, content_text, created_at, embedding_minhash,
             confidence, fact_version, conflict_marker, resolution_status, source_ref,
             'lexical' AS _stage
      FROM memory_entries
      WHERE ${scopeWhereClause}
        AND (content_text ILIKE $${lexIdx} OR COALESCE(title,'') ILIKE $${lexIdx})
      ORDER BY created_at DESC
      LIMIT $${lexIdx + 1}
    `,
    [...scopeArgs, `%${escapeIlikePat(query)}%`, lexLimit],
  );

  // Stage 2: Semantic (minhash overlap)
  const qMinhash = computeMinhash(query);
  const vecLimit = Math.max(limit, limit * 3);
  let vecRows: Record<string, unknown>[] = [];
  try {
    const vecIdx = scopeNextIdx;
    const vecRes = await params.pool.query(
      `
        SELECT id, scope, type, title, content_text, created_at, embedding_minhash,
               confidence, fact_version, conflict_marker, resolution_status, source_ref,
               'vector' AS _stage
        FROM memory_entries
        WHERE ${scopeWhereClause}
          AND embedding_minhash IS NOT NULL
          AND embedding_minhash && $${vecIdx}::int[]
        ORDER BY embedding_updated_at DESC NULLS LAST
        LIMIT $${vecIdx + 1}
      `,
      [...scopeArgs, qMinhash, vecLimit],
    );
    vecRows = vecRes.rows as Record<string, unknown>[];
  } catch {
    // 向量通道降级
  }

  // Merge + Dedup
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of lexRes.rows as Record<string, unknown>[]) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "lexical" });
  }
  for (const r of vecRows) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "vector" });
    else {
      const existing = seen.get(id)!;
      existing._stage = "both";
      existing.embedding_minhash = existing.embedding_minhash ?? r.embedding_minhash;
    }
  }

  // Rerank：使用 @openslin/shared 统一 12 因子公式
  const candidates = Array.from(seen.values());
  const nowMs = Date.now();

  const scored = candidates.map((c) => {
    const src = c.source_ref && typeof c.source_ref === "object" ? (c.source_ref as Record<string, unknown>) : null;
    const input: MemoryRerankInput = {
      contentText: String(c.content_text ?? ""),
      title: c.title != null ? String(c.title) : null,
      createdAt: String(c.created_at ?? ""),
      embeddingMinhash: Array.isArray(c.embedding_minhash) ? (c.embedding_minhash as number[]) : [],
      denseScore: 0,
      stage: String(c._stage ?? "lexical"),
      confidence: typeof c.confidence === "number" && Number.isFinite(c.confidence) ? c.confidence : 0.5,
      factVersion: typeof c.fact_version === "number" && Number.isFinite(c.fact_version) ? c.fact_version : 1,
      conflictMarker: c.conflict_marker != null ? String(c.conflict_marker) : null,
      resolutionStatus: c.resolution_status != null ? String(c.resolution_status) : null,
      memoryClass: String(c.memory_class ?? "semantic"),
      decayScore: typeof c.decay_score === "number" && Number.isFinite(c.decay_score) ? c.decay_score : 1.0,
      distilledTo: c.distilled_to != null ? String(c.distilled_to) : null,
      sourcePriority: src && typeof src.priority === "number" ? src.priority : 0,
    };
    const score = computeMemoryRerankScore(input, query, qMinhash, nowMs);
    return { ...c, _score: score };
  });

  scored.sort((a, b) => (b._score as number) - (a._score as number));
  const topRows = scored.slice(0, limit);

  const evidence: Array<{ id: string; type: string; scope: string; title: string | null; snippet: string; createdAt: string }> = [];
  for (const r of topRows as Array<Record<string, unknown> & { _score: number }>) {
    // P2-03b: 解密 content_text（自动检测明文/密文）
    const decryptedContent = await decryptMemoryContent({
      pool: params.pool, tenantId: params.tenantId, value: r.content_text,
      options: { onFailure: "placeholder" },
    });
    const snippetRaw = (r.title ? `${r.title}\n` : "") + decryptedContent;
    const clipped = snippetRaw.slice(0, 280);
    const redacted = redactValue(clipped);
    evidence.push({
      id: String(r.id),
      type: String(r.type),
      scope: String(r.scope),
      title: r.title != null ? String(r.title) : null,
      snippet: String(redacted.value ?? ""),
      createdAt: String(r.created_at),
    });
  }

  return { evidence, candidateCount: evidence.length };
}
