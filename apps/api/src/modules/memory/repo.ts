import type { Pool, PoolClient } from "pg";
import {
  redactValue,
  MINHASH_MODEL_REF,
  computeMinhash,
  minhashOverlapScore,
  evaluateMemoryRisk,
  memorySha256,
  computeMemoryRerankScore,
  escapeIlikePat,
  cosineSimilarity,
  StructuredLogger,
  type WriteProof,
  type WriteIntent,
  type MemoryRerankInput,
  type MemoryScope,
} from "@openslin/shared";
import { encryptMemoryContent, decryptMemoryContent } from "./memoryEncryption";

export type { WriteProof, WriteIntent, MemoryRiskEvaluation, MemoryScope } from "@openslin/shared";
export { evaluateMemoryRisk, MEMORY_TYPE_RISK_LEVELS } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "memory:repo" });

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw e;
  } finally {
    client.release();
  }
}

/** P1-3 Memory OS: 记忆三层分类 */
export type MemoryClass = "episodic" | "semantic" | "procedural";

export type MemoryEntryRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  ownerSubjectId: string | null;
  scope: MemoryScope;
  type: string;
  title: string | null;
  contentText: string;
  contentDigest: string;
  expiresAt: string | null;
  retentionDays: number | null;
  writePolicy: string;
  sourceRef: any;
  writeProof: WriteProof | null;
  /** P1-1: 质量治理字段 */
  sourceTrust: number;
  factVersion: number;
  confidence: number;
  salience: number;
  conflictMarker: string | null;
  resolutionStatus: string | null;
  /** P1-3 Memory OS: 三层分类 + 衰减 + 蒸馏 */
  memoryClass: MemoryClass;
  accessCount: number;
  lastAccessedAt: string | null;
  decayScore: number;
  decayUpdatedAt: string;
  distilledFrom: string[] | null;
  distilledTo: string | null;
  distillationGeneration: number;
  arbitrationStrategy: string | null;
  arbitratedAt: string | null;
  arbitratedBy: string | null;
  /** P1-记忆用户侧管理：置顶/保护标记 */
  pinned: boolean;
  pinnedAt: string | null;
  pinnedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskStateRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  runId: string;
  stepId: string | null;
  phase: string;
  plan: any;
  artifactsDigest: any;
  /** P1-2: 任务关联字段 */
  subjectId: string | null;
  parentRunId: string | null;
  relatedRunIds: string[] | null;
  taskSummary: string | null;
  /** P1-3.1: 阻塞原因 */
  blockReason: string | null;
  /** P1-3.2: 当前角色 */
  role: string | null;
  /** P1-3.3: 下一步动作提示 */
  nextAction: string | null;
  /** P1-3.4: 证据摘要 */
  evidence: any;
  /** P1-3.5: 审批状态 */
  approvalStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

function sha256(text: string) {
  return memorySha256(text);
}

function toEntry(r: any): MemoryEntryRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    ownerSubjectId: r.owner_subject_id,
    scope: r.scope,
    type: r.type,
    title: r.title,
    contentText: r.content_text,
    contentDigest: r.content_digest,
    expiresAt: r.expires_at,
    retentionDays: r.retention_days,
    writePolicy: r.write_policy,
    sourceRef: r.source_ref,
    writeProof: r.write_proof ?? null,
    sourceTrust: r.source_trust ?? 50,
    factVersion: r.fact_version ?? 1,
    confidence: r.confidence ?? 0.5,
    salience: r.salience ?? 0.5,
    conflictMarker: r.conflict_marker ?? null,
    resolutionStatus: r.resolution_status ?? null,
    // P1-3 Memory OS
    memoryClass: r.memory_class ?? "semantic",
    accessCount: typeof r.access_count === "number" ? r.access_count : 0,
    lastAccessedAt: r.last_accessed_at ?? null,
    decayScore: typeof r.decay_score === "number" ? r.decay_score : 1.0,
    decayUpdatedAt: r.decay_updated_at ?? r.created_at,
    distilledFrom: Array.isArray(r.distilled_from) ? r.distilled_from : null,
    distilledTo: r.distilled_to ?? null,
    distillationGeneration: typeof r.distillation_generation === "number" ? r.distillation_generation : 0,
    arbitrationStrategy: r.arbitration_strategy ?? null,
    arbitratedAt: r.arbitrated_at ?? null,
    arbitratedBy: r.arbitrated_by ?? null,
    // P1-记忆用户侧管理：pinned 标记
    pinned: Boolean(r.pinned),
    pinnedAt: r.pinned_at ?? null,
    pinnedBy: r.pinned_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTaskState(r: any): TaskStateRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    runId: r.run_id,
    stepId: r.step_id,
    phase: r.phase,
    plan: r.plan,
    artifactsDigest: r.artifacts_digest,
    subjectId: r.subject_id ?? null,
    parentRunId: r.parent_run_id ?? null,
    relatedRunIds: Array.isArray(r.related_run_ids) ? r.related_run_ids : null,
    taskSummary: r.task_summary ?? null,
    blockReason: r.block_reason ?? null,  // P1-3.1
    role: r.role ?? null,  // P1-3.2
    nextAction: r.next_action ?? null,  // P1-3.3
    evidence: r.evidence ?? null,  // P1-3.4
    approvalStatus: r.approval_status ?? null,  // P1-3.5
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * P1-1b: 冲突检测 - 检查写入前是否存在语义相近但内容可能矛盾的记忆
 * 
 * 检测策略：
 * 1. 使用 minhash overlap 找到语义相近的记忆
 * 2. 检查同类型记忆是否存在内容差异
 * 3. 返回潜在冲突列表供调用方决策
 */
export async function detectMemoryConflicts(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  /** 待写入的记忆类型 */
  type: string;
  /** 待写入的内容 */
  contentText: string;
  /** 待写入的标题 */
  title?: string | null;
  /** 冲突检测阈值，默认 0.3（minhash overlap 得分） */
  conflictThreshold?: number;
  /** 最多检查的候选数 */
  candidateLimit?: number;
}): Promise<{
  hasConflicts: boolean;
  conflicts: Array<{
    id: string;
    type: string;
    title: string | null;
    snippet: string;
    overlapScore: number;
    contentDiffIndicator: "similar" | "different";
  }>;
}> {
  const threshold = params.conflictThreshold ?? 0.3;
  const limit = params.candidateLimit ?? 10;

  // 计算待写入内容的 minhash
  const embeddingInput = (params.title ? `${params.title} ` : "") + params.contentText;
  const qMinhash = computeMinhash(embeddingInput);

  // 查找语义相近的同类型记忆
  const candidatesRes = await params.pool.query(
    `
      SELECT id, type, title, content_text, embedding_minhash
      FROM memory_entries
      WHERE tenant_id = $1
        AND space_id = $2
        AND type = $3
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND embedding_minhash IS NOT NULL
        AND embedding_minhash && $4::int[]
      ORDER BY created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.spaceId, params.type, qMinhash, limit],
  );

  if (!candidatesRes.rowCount) {
    return { hasConflicts: false, conflicts: [] };
  }

  const conflicts: Array<{
    id: string;
    type: string;
    title: string | null;
    snippet: string;
    overlapScore: number;
    contentDiffIndicator: "similar" | "different";
  }> = [];

  const newContentLower = params.contentText.toLowerCase().trim();

  for (const row of candidatesRes.rows as Record<string, unknown>[]) {
    const mh = Array.isArray(row.embedding_minhash) ? (row.embedding_minhash as number[]) : [];
    const overlapScore = minhashOverlapScore(qMinhash, mh);

    if (overlapScore >= threshold) {
      // 检查内容是否相同（简化判断：如果内容完全相同则跳过）
      const existingContentLower = String(row.content_text ?? "").toLowerCase().trim();
      const isSimilar = existingContentLower === newContentLower;

      // 跳过完全相同的记忆（不视为冲突，可能是重复写入）
      if (isSimilar) continue;

      conflicts.push({
        id: String(row.id),
        type: String(row.type),
        title: row.title != null ? String(row.title) : null,
        snippet: String(row.content_text ?? "").slice(0, 200),
        overlapScore,
        contentDiffIndicator: "different",
      });
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}

/**
 * P1-1c: 标记记忆冲突
 * 将新记忆与已存在的冲突记忆建立关联
 */
export async function markMemoryConflict(params: {
  pool: Pool;
  tenantId: string;
  /** 新记忆 ID */
  newMemoryId: string;
  /** 冲突记忆 ID */
  conflictWithId: string;
  /** 解决状态 */
  resolutionStatus?: "pending" | "resolved" | "superseded";
}) {
  await params.pool.query(
    `
      UPDATE memory_entries
      SET conflict_marker = $3, resolution_status = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
    `,
    [params.tenantId, params.newMemoryId, params.conflictWithId, params.resolutionStatus ?? "pending"],
  );
}

/* ── P1-3 Memory OS: 冲突仲裁协议 ── */

export type ArbitrationStrategy = "time_priority" | "confidence_priority" | "user_confirmed" | "auto_merged";

export type ArbitrationResult = {
  strategy: ArbitrationStrategy;
  winnerMemoryId: string | null;
  mergedMemoryId: string | null;
  reasoning: string;
  needsUserConfirmation: boolean;
};

/**
 * P1-3 Memory OS: 冲突仲裁协议
 * 当新写入记忆与已有记忆语义冲突时，执行仲裁逻辑：
 * - time_priority: 新记忆胜出（时间优先，最新的为准）
 * - confidence_priority: 置信度更高的胜出
 * - auto_merged: 自动合并为新记忆（保留双方信息）
 * - user_confirmed: 标记待用户确认，不自动解决
 */
export async function arbitrateMemoryConflict(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  /** 新写入的记忆 */
  newMemory: MemoryEntryRow;
  /** 冲突的已有记忆列表 */
  conflictMemories: Array<{ id: string; confidence: number; createdAt: string; contentText: string; title: string | null }>;
  /** 仲裁策略，默认自动推断 */
  strategy?: ArbitrationStrategy;
  /** 仲裁执行者 */
  arbitratedBy?: string;
}): Promise<ArbitrationResult> {
  const { pool, tenantId, spaceId, newMemory, conflictMemories } = params;

  // 自动推断仲裁策略
  let strategy = params.strategy;
  if (!strategy) {
    // 如果新记忆和已有记忆置信度差距大，使用置信度优先
    const maxExistingConfidence = Math.max(...conflictMemories.map(m => m.confidence), 0);
    const confidenceDiff = Math.abs(newMemory.confidence - maxExistingConfidence);
    if (confidenceDiff > 0.3) {
      strategy = "confidence_priority";
    } else if (conflictMemories.length === 1) {
      // 单一冲突且置信度接近，时间优先
      strategy = "time_priority";
    } else {
      // 多重冲突，需要用户确认
      strategy = conflictMemories.length >= 3 ? "user_confirmed" : "time_priority";
    }
  }

  let result: ArbitrationResult;

  switch (strategy) {
    case "time_priority": {
      // 新记忆胜出，旧记忆标记为 superseded
      const conflictIds = conflictMemories.map(m => m.id);
      await pool.query(
        `UPDATE memory_entries SET resolution_status = 'superseded', updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [tenantId, conflictIds],
      );
      await pool.query(
        `UPDATE memory_entries SET resolution_status = 'resolved', arbitration_strategy = 'time_priority', arbitrated_at = now(), arbitrated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [tenantId, newMemory.id, params.arbitratedBy ?? "system"],
      );
      result = {
        strategy: "time_priority",
        winnerMemoryId: newMemory.id,
        mergedMemoryId: null,
        reasoning: `时间优先策略：新记忆 ${newMemory.id} 胜出，${conflictIds.length} 条旧记忆标记为 superseded`,
        needsUserConfirmation: false,
      };
      break;
    }

    case "confidence_priority": {
      // 找到置信度最高的记忆
      const allCandidates = [{ id: newMemory.id, confidence: newMemory.confidence }, ...conflictMemories];
      allCandidates.sort((a, b) => b.confidence - a.confidence);
      const winnerId = allCandidates[0]!.id;
      const losers = allCandidates.filter(c => c.id !== winnerId).map(c => c.id);

      if (losers.length > 0) {
        await pool.query(
          `UPDATE memory_entries SET resolution_status = 'superseded', updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
          [tenantId, losers],
        );
      }
      await pool.query(
        `UPDATE memory_entries SET resolution_status = 'resolved', arbitration_strategy = 'confidence_priority', arbitrated_at = now(), arbitrated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [tenantId, winnerId, params.arbitratedBy ?? "system"],
      );
      result = {
        strategy: "confidence_priority",
        winnerMemoryId: winnerId,
        mergedMemoryId: null,
        reasoning: `置信度优先策略：记忆 ${winnerId}(置信度=${allCandidates[0]!.confidence.toFixed(2)}) 胜出`,
        needsUserConfirmation: false,
      };
      break;
    }

    case "auto_merged": {
      // 合并新旧记忆内容为一条新记忆
      const mergedContent = [
        `[合并记忆] 新内容：${newMemory.contentText}`,
        ...conflictMemories.map(m => `旧内容(${m.id.slice(0, 8)}): ${m.contentText.slice(0, 300)}`),
      ].join("\n---\n");
      const mergedTitle = newMemory.title ?? conflictMemories[0]?.title ?? "合并记忆";

      const mergedEntry = await createMemoryEntry({
        pool,
        tenantId,
        spaceId,
        ownerSubjectId: newMemory.ownerSubjectId,
        scope: newMemory.scope,
        type: newMemory.type,
        title: `[合并] ${mergedTitle}`,
        contentText: mergedContent.slice(0, 5000),
        writeIntent: { policy: "policyAllowed" },
        memoryClass: newMemory.memoryClass,
        _skipRiskCheck: true,
      });

      // 标记原始记忆为已合并
      const allOriginalIds = [newMemory.id, ...conflictMemories.map(m => m.id)];
      await pool.query(
        `UPDATE memory_entries SET resolution_status = 'superseded', conflict_marker = $3, updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [tenantId, allOriginalIds, mergedEntry.entry.id],
      );
      await pool.query(
        `UPDATE memory_entries SET resolution_status = 'resolved', arbitration_strategy = 'auto_merged', arbitrated_at = now(), arbitrated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [tenantId, mergedEntry.entry.id, params.arbitratedBy ?? "system"],
      );

      result = {
        strategy: "auto_merged",
        winnerMemoryId: null,
        mergedMemoryId: mergedEntry.entry.id,
        reasoning: `自动合并策略：${allOriginalIds.length} 条记忆合并为 ${mergedEntry.entry.id}`,
        needsUserConfirmation: false,
      };
      break;
    }

    case "user_confirmed":
    default: {
      // 标记待用户确认，不自动解决
      const allIds = [newMemory.id, ...conflictMemories.map(m => m.id)];
      await pool.query(
        `UPDATE memory_entries SET resolution_status = 'pending', arbitration_strategy = 'user_confirmed', updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [tenantId, allIds],
      );
      result = {
        strategy: "user_confirmed",
        winnerMemoryId: null,
        mergedMemoryId: null,
        reasoning: `多重冲突(${allIds.length} 条)需要用户确认`,
        needsUserConfirmation: true,
      };
      break;
    }
  }

  // 写仲裁日志
  await pool.query(
    `INSERT INTO memory_arbitration_log (tenant_id, space_id, conflict_memory_ids, strategy, winner_memory_id, merged_memory_id, reasoning, needs_user_confirmation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      spaceId,
      [newMemory.id, ...conflictMemories.map(m => m.id)],
      result.strategy,
      result.winnerMemoryId,
      result.mergedMemoryId,
      result.reasoning,
      result.needsUserConfirmation,
    ],
  );

  return result;
}

/**
 * P1-3 Memory OS: 更新记忆访问计数和时间戳（用于衰减计算）
 */
export async function touchMemoryAccess(params: {
  pool: Pool;
  tenantId: string;
  memoryIds: string[];
}) {
  if (!params.memoryIds.length) return;
  await params.pool.query(
    `UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [params.tenantId, params.memoryIds],
  );
}

/**
 * 校验写入意图并生成写入证明
 * - confirmed: 需要提供 confirmationRef（包含 requestId）
 * - approved: 需要提供已通过的 approvalId，服务端会校验审批状态
 * - policyAllowed: 需要提供策略快照引用，或由系统根据当前上下文自动判定
 */
export async function validateWriteIntent(params: {
  pool: Pool;
  tenantId: string;
  intent: WriteIntent;
  /** 操作者 subjectId，用于记录证明生成者 */
  provenBy: string;
}): Promise<{ ok: true; proof: WriteProof } | { ok: false; reason: string }> {
  const { pool, tenantId, intent, provenBy } = params;
  const now = new Date().toISOString();

  switch (intent.policy) {
    case "confirmed": {
      // 校验用户确认引用
      if (!intent.confirmationRef?.requestId) {
        return { ok: false, reason: "confirmed 策略需要提供 confirmationRef.requestId" };
      }
      return {
        ok: true,
        proof: {
          policy: "confirmed",
          provenAt: now,
          provenBy,
          confirmationRef: {
            requestId: intent.confirmationRef.requestId,
            turnId: intent.confirmationRef.turnId,
            confirmationType: intent.confirmationRef.confirmationType ?? "implicit",
          },
        },
      };
    }

    case "approved": {
      // 校验审批 ID 存在且已通过
      if (!intent.approvalId) {
        return { ok: false, reason: "approved 策略需要提供 approvalId" };
      }
      const approvalRes = await pool.query(
        `SELECT approval_id, status, decided_by_subject_id FROM approvals a
         LEFT JOIN approval_decisions d ON d.approval_id = a.approval_id AND d.decision = 'approve'
         WHERE a.tenant_id = $1 AND a.approval_id = $2 AND a.status = 'approved'
         LIMIT 1`,
        [tenantId, intent.approvalId],
      );
      if (!approvalRes.rowCount) {
        return { ok: false, reason: "审批不存在或未通过" };
      }
      const approvalRow = approvalRes.rows[0] as Record<string, unknown>;
      return {
        ok: true,
        proof: {
          policy: "approved",
          provenAt: now,
          provenBy,
          approvalId: intent.approvalId,
          approvedBySubjectId: approvalRow.decided_by_subject_id != null ? String(approvalRow.decided_by_subject_id) : undefined,
        },
      };
    }

    case "policyAllowed": {
      // policyAllowed 策略：信任服务端调用方已完成策略评估
      // 如果提供了 snapshotRef，记录下来作为审计依据
      return {
        ok: true,
        proof: {
          policy: "policyAllowed",
          provenAt: now,
          provenBy: "system",
          policyRef: {
            snapshotRef: intent.policyRef?.snapshotRef,
            decision: "allow",
          },
        },
      };
    }

    default:
      return { ok: false, reason: "未知的写入策略" };
  }
}

export async function createMemoryEntry(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  ownerSubjectId: string | null;
  scope: MemoryScope;
  type: string;
  title?: string | null;
  contentText: string;
  retentionDays?: number | null;
  expiresAt?: string | null;
  /** 写入意图，用于服务端校验并生成 WriteProof */
  writeIntent: WriteIntent;
  sourceRef?: any;
  /** 操作者 subjectId，用于生成 writeProof.provenBy */
  subjectId?: string;
  /** 跳过风险检查（仅内部用途） */
  _skipRiskCheck?: boolean;
  /** 多模态附件引用列表 */
  mediaRefs?: MediaRefInput[];
  /** P1-3 Memory OS: 记忆三层分类，默认 semantic */
  memoryClass?: MemoryClass;
  /** 合并检测阈值（minhash overlap），传入后写入前先查找近似记忆，超过阈值则 UPDATE 而非 INSERT */
  mergeThreshold?: number;
}): Promise<{
  entry: MemoryEntryRow;
  dlpSummary: any;
  writeProof: WriteProof | null;
  riskEvaluation: {
    riskLevel: "low" | "medium" | "high";
    approvalRequired: boolean;
    riskFactors: string[];
  };
  attachments: MemoryAttachmentRow[];
}> {
  const redacted = redactValue(params.contentText);
  const contentText = String(redacted.value ?? "");
  const contentDigest = sha256(contentText);

  // P1-3: 风险评估
  const riskEvaluation = evaluateMemoryRisk({
    type: params.type,
    contentText: contentText,
    title: params.title,
  });

  // 高风险写入必须通过审批流程
  if (!params._skipRiskCheck && riskEvaluation.approvalRequired) {
    const policy = params.writeIntent.policy;
    if (policy !== "approved") {
      throw new Error(
        `高风险记忆写入需要审批流程: riskLevel=${riskEvaluation.riskLevel}, ` +
        `riskFactors=[${riskEvaluation.riskFactors.join(", ")}], 请使用 writeIntent.policy="approved" 并提供有效的 approvalId`
      );
    }
  }

  // 计算 minhash 向量：合并 title + contentText 作为语义输入
  const embeddingInput = (params.title ? `${params.title} ` : "") + contentText;
  const minhash = computeMinhash(embeddingInput);

  // ── 列级加密（若启用）：minhash 基于明文计算，DB 存入密文 ──
  const storedContentText = await encryptMemoryContent({
    pool: params.pool,
    tenantId: params.tenantId,
    plaintext: contentText,
  });

  // 通过 writeIntent 校验并生成 proof
  const validation = await validateWriteIntent({
    pool: params.pool,
    tenantId: params.tenantId,
    intent: params.writeIntent,
    provenBy: params.subjectId ?? "system",
  });
  if (!validation.ok) {
    throw new Error(`写入意图校验失败: ${validation.reason}`);
  }
  const writePolicy = validation.proof.policy;
  const writeProof = validation.proof;

  // ── 可选合并检测：写入前查找 minhash 近似记忆，超过阈值则更新而非新建 ──
  if (params.mergeThreshold != null && params.mergeThreshold > 0) {
    try {
      const mWhere: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "scope = $3", "type = $4"];
      const mArgs: any[] = [params.tenantId, params.spaceId, params.scope, params.type];
      let mIdx = 5;
      if (params.scope === "user" && params.ownerSubjectId) {
        mWhere.push(`owner_subject_id = $${mIdx++}`);
        mArgs.push(params.ownerSubjectId);
      }
      const candRes = await params.pool.query(
        `SELECT id, embedding_minhash FROM memory_entries WHERE ${mWhere.join(" AND ")} ORDER BY updated_at DESC LIMIT $${mIdx}`,
        [...mArgs, 50],
      );
      let bestId: string | null = null;
      let bestScore = 0;
      for (const r of candRes.rows as Record<string, unknown>[]) {
        const mh = Array.isArray(r.embedding_minhash) ? (r.embedding_minhash as number[]) : [];
        const score = minhashOverlapScore(minhash, mh);
        if (score > bestScore) { bestScore = score; bestId = String(r.id); }
      }
      if (bestId && bestScore >= params.mergeThreshold) {
        const mergeRes = await params.pool.query(
          `UPDATE memory_entries
           SET title = $3, content_text = $4, content_digest = $5,
               write_policy = $6, write_proof = $7::jsonb, source_ref = $8::jsonb,
               embedding_minhash = $9, embedding_updated_at = now(),
               fact_version = COALESCE(fact_version, 1) + 1, updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           RETURNING *`,
          [bestId, params.tenantId, params.title ?? null, storedContentText, contentDigest,
           writePolicy, writeProof, params.sourceRef ?? null, minhash],
        );
        if (mergeRes.rowCount) {
          const mergedEntry = toEntry(mergeRes.rows[0]);
          let attachments: MemoryAttachmentRow[] = [];
          if (params.mediaRefs?.length) {
            attachments = await insertMemoryAttachments({ pool: params.pool, tenantId: params.tenantId, memoryId: mergedEntry.id, mediaRefs: params.mediaRefs });
          }
          return { entry: mergedEntry, dlpSummary: redacted.summary, writeProof, riskEvaluation, attachments };
        }
      }
    } catch (mergeErr) {
            _logger.warn("merge detection failed, falling through to INSERT", { err: (mergeErr as Error)?.message });
    }
  }

  const res = await params.pool.query(
    `
      INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, retention_days, expires_at, write_policy, source_ref,
        write_proof, embedding_model_ref, embedding_minhash, embedding_updated_at,
        memory_class
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.ownerSubjectId,
      params.scope,
      params.type,
      params.title ?? null,
      storedContentText,
      contentDigest,
      params.retentionDays ?? null,
      params.expiresAt ?? null,
      writePolicy,
      params.sourceRef ?? null,
      writeProof,
      MINHASH_MODEL_REF,
      minhash,
      params.memoryClass ?? "semantic",
    ],
  );
  const entry = toEntry(res.rows[0]);

  // 写入附件关联
  let attachments: MemoryAttachmentRow[] = [];
  if (params.mediaRefs?.length) {
    attachments = await insertMemoryAttachments({
      pool: params.pool,
      tenantId: params.tenantId,
      memoryId: entry.id,
      mediaRefs: params.mediaRefs,
    });
  }

  return { entry, dlpSummary: redacted.summary, writeProof, riskEvaluation, attachments };
}

/**
 * 更新已有记忆条目（编辑 title / contentText / type）
 * - 重新计算 contentDigest 和 minhash
 * - 重新进行风险评估和 DLP 脱敏
 * - 仅条目所有者或 space 级记忆可编辑
 */
export async function updateMemoryEntry(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  id: string;
  title?: string | null;
  contentText?: string;
  type?: string;
}): Promise<{ entry: MemoryEntryRow; dlpSummary: any; riskEvaluation: ReturnType<typeof evaluateMemoryRisk> } | null> {
  // 1. 查出现有记录
  const existing = await params.pool.query(
    `SELECT * FROM memory_entries
     WHERE tenant_id = $1 AND space_id = $2 AND id = $3 AND deleted_at IS NULL
       AND (scope <> 'user' OR owner_subject_id = $4)
     LIMIT 1`,
    [params.tenantId, params.spaceId, params.id, params.subjectId],
  );
  if (!existing.rowCount) return null;

  const row = existing.rows[0] as Record<string, unknown>;
  const newType = params.type ?? String(row.type);
  const rawText = params.contentText ?? row.content_text;
  const newTitle = params.title !== undefined ? params.title : (row.title != null ? String(row.title) : null);

  // 2. DLP 脱敏
  const redacted = redactValue(rawText);
  const contentText = String(redacted.value ?? "");
  const contentDigest = sha256(contentText);

  // 3. 风险评估
  const riskEvaluation = evaluateMemoryRisk({ type: newType, contentText, title: newTitle });

  // 4. 重算 minhash
  const embeddingInput = (newTitle ? `${newTitle} ` : "") + contentText;
  const minhash = computeMinhash(embeddingInput);

  // 4b. 列级加密（若启用）
  const storedContentText = await encryptMemoryContent({
    pool: params.pool,
    tenantId: params.tenantId,
    plaintext: contentText,
  });

  // 5. 更新
  const res = await params.pool.query(
    `UPDATE memory_entries
     SET type = $5, title = $6, content_text = $7, content_digest = $8,
         embedding_minhash = $9, embedding_updated_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND space_id = $2 AND id = $3 AND deleted_at IS NULL
       AND (scope <> 'user' OR owner_subject_id = $4)
     RETURNING *`,
    [params.tenantId, params.spaceId, params.id, params.subjectId,
     newType, newTitle, storedContentText, contentDigest, minhash],
  );
  if (!res.rowCount) return null;
  return { entry: toEntry(res.rows[0]), dlpSummary: redacted.summary, riskEvaluation };
}

/**
 * 纯导出记忆条目（不删除），返回完整内容
 */
export async function exportMemoryEntries(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  scope?: MemoryScope;
  types?: string[];
  limit: number;
}) {
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "(expires_at IS NULL OR expires_at > now())"];
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (params.scope) {
    where.push(`scope = $${idx++}`);
    args.push(params.scope);
    if (params.scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
  }
  if (params.types?.length) {
    where.push(`type = ANY($${idx++}::text[])`);
    args.push(params.types);
  }

  const limit = Math.max(1, Math.min(5000, params.limit));
  args.push(limit);

  const res = await params.pool.query(
    `SELECT * FROM memory_entries
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    args,
  );

  const entries = (res.rows as Record<string, unknown>[]).map(toEntry);
  return { entries, totalCount: entries.length };
}

export async function listMemoryEntries(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  scope?: MemoryScope;
  type?: string;
  limit: number;
  offset: number;
}) {
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL"];
  where.push("(expires_at IS NULL OR expires_at > now())");
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (params.scope) {
    where.push(`scope = $${idx++}`);
    args.push(params.scope);
    if (params.scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
  }

  if (params.type) {
    where.push(`type = $${idx++}`);
    args.push(params.type);
  }

  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_entries
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    [...args, params.limit, params.offset],
  );
  return res.rows.map(toEntry);
}

/** 获取单条记忆详情 */
export async function getMemoryEntry(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  id: string;
}): Promise<MemoryEntryRow | null> {
  const res = await params.pool.query(
    `SELECT * FROM memory_entries
     WHERE tenant_id = $1 AND space_id = $2 AND id = $3 AND deleted_at IS NULL
       AND (scope <> 'user' OR owner_subject_id = $4)
     LIMIT 1`,
    [params.tenantId, params.spaceId, params.id, params.subjectId],
  );
  if (!res.rowCount) return null;
  return toEntry(res.rows[0]);
}

export async function deleteMemoryEntry(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; id: string }) {
  const res = await params.pool.query(
    `
      UPDATE memory_entries
      SET deleted_at = now(), updated_at = now()
      WHERE tenant_id = $1
        AND space_id = $2
        AND id = $3
        AND deleted_at IS NULL
        AND (scope <> 'user' OR owner_subject_id = $4)
      RETURNING id
    `,
    [params.tenantId, params.spaceId, params.id, params.subjectId],
  );
  return Boolean(res.rowCount);
}

export async function clearMemory(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; scope: "user" | "space" | "global" }) {
  const res = await params.pool.query(
    `
      UPDATE memory_entries
      SET deleted_at = now(), updated_at = now()
      WHERE tenant_id = $1
        AND space_id = $2
        AND deleted_at IS NULL
        AND scope = $3
        AND ($3 <> 'user' OR owner_subject_id = $4)
    `,
    [params.tenantId, params.spaceId, params.scope, params.subjectId],
  );
  return res.rowCount ?? 0;
}

export async function exportAndClearMemory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  scope: "user" | "space" | "global";
  types?: string[];
  limit: number;
}) {
  const limit = Math.max(1, Math.min(5000, params.limit));
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "scope = $3", "(expires_at IS NULL OR expires_at > now())"];
  const args: any[] = [params.tenantId, params.spaceId, params.scope];
  let idx = 4;

  if (params.scope === "user") {
    where.push(`owner_subject_id = $${idx++}`);
    args.push(params.subjectId);
  }
  if (params.types?.length) {
    where.push(`type = ANY($${idx++}::text[])`);
    args.push(params.types);
  }
  args.push(limit);

  return withTransaction(params.pool, async (client) => {
    const list = await client.query(
      `
        SELECT *
        FROM memory_entries
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${idx++}
      `,
      args,
    );
    const ids = (list.rows as Record<string, unknown>[]).map((r) => String(r.id ?? "")).filter(Boolean);
    let deletedCount = 0;
    if (ids.length) {
      const del = await client.query(
        `
          UPDATE memory_entries
          SET deleted_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND space_id = $2 AND deleted_at IS NULL AND id = ANY($3::uuid[])
        `,
        [params.tenantId, params.spaceId, ids],
      );
      deletedCount = del.rowCount ?? 0;
    }

    const entries = (list.rows as Record<string, unknown>[]).map(toEntry).map((e) => {
      const redactedTitle = e.title ? String(redactValue(e.title).value ?? "") : null;
      const redactedText = String(redactValue(e.contentText).value ?? "");
      return { ...e, title: redactedTitle, contentText: redactedText };
    });
    return { entries, deletedCount };
  });
}

/**
 * 混合检索记忆：lexical(ILIKE) + semantic(minhash overlap / dense vector) 双通道，加权 rerank。
 * - Stage 1：ILIKE 关键词召回（兼容旧数据与精确匹配场景）
 * - Stage 2a：minhash overlap 向量召回（语义近似）
 * - Stage 2b：dense vector cosine 召回（若配置了外部 Embedding API）
 * - Merge + Rerank：去重合并，按综合得分排序
 * - 失败时静默降级到纯 ILIKE（不阻塞）
 */
export async function searchMemory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  scope?: MemoryScope;
  types?: string[];
  limit: number;
}) {
  const baseWhere: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL"];
  baseWhere.push("(expires_at IS NULL OR expires_at > now())");
  const baseArgs: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (params.scope) {
    baseWhere.push(`scope = $${idx++}`);
    baseArgs.push(params.scope);
    if (params.scope === "user") {
      baseWhere.push(`owner_subject_id = $${idx++}`);
      baseArgs.push(params.subjectId);
    }
  }

  if (params.types?.length) {
    baseWhere.push(`type = ANY($${idx++}::text[])`);
    baseArgs.push(params.types);
  }

  const scopeWhereClause = baseWhere.join(" AND ");
  const scopeArgs = [...baseArgs];
  const scopeNextIdx = idx;

  // ── Stage 1: Lexical (ILIKE) 召回 ──
  const lexLimit = Math.max(params.limit, params.limit * 3);
  const lexIdx = scopeNextIdx;
  const lexRes = await params.pool.query(
    `
      SELECT *, 'lexical' AS _stage
      FROM memory_entries
      WHERE ${scopeWhereClause}
        AND (content_text ILIKE $${lexIdx} OR COALESCE(title,'') ILIKE $${lexIdx})
      ORDER BY created_at DESC
      LIMIT $${lexIdx + 1}
    `,
    [...scopeArgs, `%${escapeIlikePat(params.query)}%`, lexLimit],
  );

  // ── Stage 2: Semantic (minhash overlap) 召回 ──
  const qMinhash = computeMinhash(params.query);
  const vecLimit = Math.max(params.limit, params.limit * 3);
  let vecRows: any[] = [];
  try {
    const vecIdx = scopeNextIdx;
    const vecRes = await params.pool.query(
      `
        SELECT *, 'vector' AS _stage, embedding_minhash
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
  } catch (err) {
        _logger.warn("MinHash vector recall failed, falling back to lexical only", { err: (err as Error)?.message });
  }

  // ── Stage 2b: Dense vector cosine 召回（蒸馏产物密集向量通道） ──
  let denseRows: any[] = [];
  let queryEmbeddingVec: number[] | null = null;
  try {
    const embEndpoint = String(process.env.MEMORY_EMBEDDING_ENDPOINT ?? process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ?? "").trim();
    if (embEndpoint) {
      const embApiKey = String(process.env.MEMORY_EMBEDDING_API_KEY ?? process.env.KNOWLEDGE_EMBEDDING_API_KEY ?? "").trim() || null;
      const embModel = String(process.env.MEMORY_EMBEDDING_MODEL ?? process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "text-embedding-3-small").trim();
      const embDim = Math.max(64, Math.min(4096, Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS ?? 1536)));
      const embTimeout = Math.max(1000, Number(process.env.MEMORY_EMBEDDING_TIMEOUT_MS ?? process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS ?? 5000));

      // 获取查询向量
      const url = embEndpoint.replace(/\/$/, "") + "/v1/embeddings";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (embApiKey) headers["authorization"] = `Bearer ${embApiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), embTimeout);
      try {
        const payload: any = { input: [params.query], model: embModel };
        if (embDim) payload.dimensions = embDim;
        const embRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
        if (embRes.ok) {
          const embJson = (await embRes.json()) as Record<string, unknown>;
          const firstData = Array.isArray(embJson?.data) && embJson.data[0];
          if (firstData && Array.isArray(firstData.embedding)) {
            queryEmbeddingVec = firstData.embedding as number[];
          }
        }
      } finally {
        clearTimeout(timer);
      }

      // 使用 query embedding 对带有 dense vector 的记忆做 cosine 相似度排序
      if (queryEmbeddingVec && queryEmbeddingVec.length > 0) {
        const denseModelRef = `${embModel}:${embDim}`;
        const denseIdx = scopeNextIdx;
        const denseRes = await params.pool.query(
          `
            SELECT *, 'dense_vector' AS _stage, embedding_vector
            FROM memory_entries
            WHERE ${scopeWhereClause}
              AND embedding_vector IS NOT NULL
              AND embedding_model_ref = $${denseIdx}
            ORDER BY embedding_updated_at DESC NULLS LAST
            LIMIT $${denseIdx + 1}
          `,
          [...scopeArgs, denseModelRef, vecLimit],
        );
        denseRows = (denseRes.rows as Record<string, unknown>[]).map((r) => {
          // 解析 JSONB 向量并计算 cosine 相似度
          let vec: number[] = [];
          try {
            vec = typeof r.embedding_vector === "string" ? JSON.parse(r.embedding_vector) : (Array.isArray(r.embedding_vector) ? r.embedding_vector : []);
          } catch (err) { _logger.warn("embedding_vector JSON.parse failed", { err: (err as Error)?.message }); vec = []; }
          const cosine = cosineSimilarity(queryEmbeddingVec!, vec);
          return { ...r, _dense_score: cosine };
        }).filter((r) => r._dense_score > (Number(process.env.MEMORY_DENSE_COSINE_THRESHOLD) || 0.25)); // 过滤低相似度
      }
    }
  } catch (err) {
        _logger.warn("Dense vector recall failed, falling back to other channels", { err: (err as Error)?.message });
  }

  // ── Stage 3: pgvector 向量检索（如果 pgvector 扩展可用） ──
  let pgvectorRows: any[] = [];
  try {
    const pgvectorEnabled = String(process.env.MEMORY_PGVECTOR_ENABLED ?? "").trim().toLowerCase();
    if (pgvectorEnabled === "true" || pgvectorEnabled === "1") {
      // 需要查询向量（复用 Stage 2b 获取的 queryEmbeddingVec，或重新获取）
      let pgQueryVec = queryEmbeddingVec;
      if (!pgQueryVec) {
        const embEndpoint = String(process.env.MEMORY_EMBEDDING_ENDPOINT ?? process.env.KNOWLEDGE_EMBEDDING_ENDPOINT ?? "").trim();
        if (embEndpoint) {
          const embApiKey = String(process.env.MEMORY_EMBEDDING_API_KEY ?? process.env.KNOWLEDGE_EMBEDDING_API_KEY ?? "").trim() || null;
          const embModel = String(process.env.MEMORY_EMBEDDING_MODEL ?? process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "text-embedding-3-small").trim();
          const embDim = Math.max(64, Math.min(4096, Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS ?? 1536)));
          const embTimeout = Math.max(1000, Number(process.env.MEMORY_EMBEDDING_TIMEOUT_MS ?? process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS ?? 5000));
          const url = embEndpoint.replace(/\/$/, "") + "/v1/embeddings";
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (embApiKey) headers["authorization"] = `Bearer ${embApiKey}`;
          const ctrl = new AbortController();
          const tmr = setTimeout(() => ctrl.abort(), embTimeout);
          try {
            const payload: any = { input: [params.query], model: embModel };
            if (embDim) payload.dimensions = embDim;
            const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
            if (resp.ok) {
              const json = (await resp.json()) as Record<string, unknown>;
              const d0 = Array.isArray(json?.data) && json.data[0];
              if (d0 && Array.isArray(d0.embedding)) {
                pgQueryVec = d0.embedding as number[];
              }
            }
          } finally {
            clearTimeout(tmr);
          }
        }
      }

      if (pgQueryVec && pgQueryVec.length > 0) {
        const pgvStartedAt = Date.now();
        const vecStr = `[${pgQueryVec.join(",")}]`;
        const topK = Math.max(params.limit, params.limit * 3);
        const distOp = String(process.env.PGVECTOR_DISTANCE_METRIC ?? "cosine").trim();
        const op = distOp === "l2" ? "<->" : distOp === "inner_product" ? "<#>" : "<=>";
        const scoreExpr = op === "<=>" ? `1 - (mv.embedding ${op} $${scopeNextIdx}::vector)` : `-(mv.embedding ${op} $${scopeNextIdx}::vector)`;

        const pgRes = await params.pool.query(
          `
            SELECT me.*, 'pgvector' AS _stage,
                   ${scoreExpr} AS _pgvector_score
            FROM memory_vectors mv
            JOIN memory_entries me ON me.id = mv.memory_id AND me.deleted_at IS NULL
            WHERE me.tenant_id = $1
              AND me.space_id = $2
              AND (me.expires_at IS NULL OR me.expires_at > now())
            ORDER BY mv.embedding ${op} $${scopeNextIdx}::vector
            LIMIT $${scopeNextIdx + 1}
          `,
          [params.tenantId, params.spaceId, vecStr, topK],
        );
        pgvectorRows = pgRes.rows as Record<string, unknown>[];
        const pgvLatency = Date.now() - pgvStartedAt;
        _logger.info("pgvector memory recall completed", {
          module: "memory",
          action: "pgvector_recall",
          resultCount: pgvectorRows.length,
          latencyMs: pgvLatency,
        });
      }
    }
  } catch (err) {
    // 向量检索失败时静默降级，继续使用 keyword + minhash 结果
    _logger.warn("pgvector memory recall failed, falling back to keyword + minhash", {
      module: "memory",
      action: "vector_search_fallback",
      error: (err as Error)?.message,
    });
  }

  // ── Merge + Dedup ──
  const seen = new Map<string, any>();
  for (const r of lexRes.rows as Record<string, unknown>[]) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "lexical", _dense_score: 0 });
  }
  for (const r of vecRows) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "vector", _dense_score: 0 });
    else {
      // 同时命中两个通道的，标记为 both
      const existing = seen.get(id)!;
      existing._stage = "both";
      existing.embedding_minhash = existing.embedding_minhash ?? r.embedding_minhash;
    }
  }
  // 合并 dense vector 结果
  for (const r of denseRows) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "dense_vector" });
    else {
      const existing = seen.get(id)!;
      existing._stage = existing._stage === "lexical" ? "both" : existing._stage;
      existing._dense_score = Math.max(existing._dense_score ?? 0, r._dense_score ?? 0);
    }
  }
  // 合并 pgvector 结果
  for (const r of pgvectorRows) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "pgvector", _dense_score: typeof r._pgvector_score === "number" ? r._pgvector_score : 0 });
    else {
      const existing = seen.get(id)!;
      if (existing._stage === "lexical") existing._stage = "both";
      const pgScore = typeof r._pgvector_score === "number" ? r._pgvector_score : 0;
      existing._dense_score = Math.max(existing._dense_score ?? 0, pgScore);
    }
  }

  // ── Rerank：使用 @openslin/shared 统一 12 因子公式 ──
  const candidates = Array.from(seen.values());
  const nowMs = Date.now();

  const scored = candidates.map((c) => {
    const src = c.source_ref && typeof c.source_ref === "object" ? c.source_ref : null;
    const input: MemoryRerankInput = {
      contentText: String(c.content_text ?? ""),
      title: c.title ?? null,
      createdAt: String(c.created_at ?? ""),
      embeddingMinhash: Array.isArray(c.embedding_minhash) ? c.embedding_minhash : [],
      denseScore: typeof c._dense_score === "number" && Number.isFinite(c._dense_score) ? c._dense_score : 0,
      stage: String(c._stage ?? "lexical"),
      confidence: typeof c.confidence === "number" && Number.isFinite(c.confidence) ? c.confidence : 0.5,
      factVersion: typeof c.fact_version === "number" && Number.isFinite(c.fact_version) ? c.fact_version : 1,
      conflictMarker: c.conflict_marker ?? null,
      resolutionStatus: c.resolution_status ?? null,
      memoryClass: String(c.memory_class ?? "semantic"),
      decayScore: typeof c.decay_score === "number" && Number.isFinite(c.decay_score) ? c.decay_score : 1.0,
      distilledTo: c.distilled_to ?? null,
      sourcePriority: src && typeof src.priority === "number" ? src.priority : 0,
      scope: c.scope ?? undefined,
    };
    const score = computeMemoryRerankScore(input, params.query, qMinhash, nowMs);
    return { ...c, _score: score };
  });

  scored.sort((a, b) => (b._score as number) - (a._score as number));
  const topEntries = scored.slice(0, params.limit).map((r) => toEntry(r));

  // ── 正式解密：通过 API 侧 memoryEncryption 桥接层对密文透明解密 ──
  const evidence: Array<{ id: string; type: string; scope: string; title: string | null; snippet: string; createdAt: string }> = [];
  for (const e of topEntries) {
    const decrypted = await decryptMemoryContent({
      pool: params.pool,
      tenantId: params.tenantId,
      value: e.contentText,
      options: { onFailure: "placeholder" },
    });
    const snippetRaw = (e.title ? `${e.title}\n` : "") + decrypted;
    const clipped = snippetRaw.slice(0, 500);
    const redacted = redactValue(clipped);
    evidence.push({
      id: e.id,
      type: e.type,
      scope: e.scope,
      title: e.title,
      snippet: String(redacted.value ?? ""),
      createdAt: e.createdAt,
    });
  }

  return {
    evidence,
    searchMode: pgvectorRows.length > 0 ? "hybrid_pgvector" : denseRows.length > 0 ? "hybrid_dense" : vecRows.length > 0 ? "hybrid" : "lexical_only",
    stageStats: {
      lexical: { returned: lexRes.rowCount ?? 0 },
      vector: { returned: vecRows.length },
      denseVector: { returned: denseRows.length },
      pgvector: { returned: pgvectorRows.length },
      merged: { candidateCount: candidates.length },
      reranked: { returned: evidence.length },
    },
  };
}

export async function upsertTaskState(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  runId: string;
  stepId?: string | null;
  phase: string;
  plan?: any;
  artifactsDigest?: any;
  /** P1-3.1 */
  blockReason?: string | null;
  /** P1-3.2 */
  role?: string | null;
  /** P1-3.3 */
  nextAction?: string | null;
  clearNextAction?: boolean;
  /** P1-3.4 */
  evidence?: any;
  /** P1-3.5 */
  approvalStatus?: string | null;
  clearApprovalStatus?: boolean;
  clearBlockReason?: boolean;
}) {
  const redactedPlan = redactValue(params.plan);
  const redactedArtifacts = redactValue(params.artifactsDigest);

  const res = await params.pool.query(
    `
      INSERT INTO memory_task_states (
        tenant_id, space_id, run_id, step_id, phase, plan, artifacts_digest,
        block_reason, role, next_action, evidence, approval_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (tenant_id, space_id, run_id)
      WHERE deleted_at IS NULL
      DO UPDATE SET
        step_id = EXCLUDED.step_id,
        phase = EXCLUDED.phase,
        plan = EXCLUDED.plan,
        artifacts_digest = EXCLUDED.artifacts_digest,
        block_reason = CASE
          WHEN $13::boolean THEN NULL
          WHEN EXCLUDED.block_reason IS NOT NULL THEN EXCLUDED.block_reason
          ELSE memory_task_states.block_reason
        END,
        role = COALESCE(EXCLUDED.role, memory_task_states.role),
        next_action = CASE
          WHEN $14::boolean THEN NULL
          WHEN EXCLUDED.next_action IS NOT NULL THEN EXCLUDED.next_action
          ELSE memory_task_states.next_action
        END,
        evidence = COALESCE(EXCLUDED.evidence, memory_task_states.evidence),
        approval_status = CASE
          WHEN $15::boolean THEN NULL
          WHEN EXCLUDED.approval_status IS NOT NULL THEN EXCLUDED.approval_status
          ELSE memory_task_states.approval_status
        END,
        updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.runId,
      params.stepId ?? null,
      params.phase,
      redactedPlan.value ?? null,
      redactedArtifacts.value ?? null,
      params.blockReason ?? null,
      params.role ?? null,
      params.nextAction ?? null,
      params.evidence ? JSON.stringify(params.evidence) : null,
      params.approvalStatus ?? null,
      params.clearBlockReason === true,
      params.clearNextAction === true,
      params.clearApprovalStatus === true,
    ],
  );
  return { taskState: toTaskState(res.rows[0]), dlpSummary: { plan: redactedPlan.summary, artifacts: redactedArtifacts.summary } };
}

export async function getTaskState(params: { pool: Pool; tenantId: string; spaceId: string; runId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_task_states
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.runId],
  );
  if (!res.rowCount) return null;
  return toTaskState(res.rows[0]);
}

/**
 * P1-2a: 查询该空间最近的任务状态（用于编排层记忆召回）。
 * 按 updated_at 倒序，返回最近 N 条任务摘要。
 * 
 * 支持可选 subjectId 过滤，用于多用户场景下只返回当前用户的任务。
 */
export async function listRecentTaskStates(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  limit: number;
  /** 可选：按 subjectId 过滤（需要表支持 subject_id 字段） */
  subjectId?: string;
  /** 可选：按任务阶段过滤 */
  phase?: string | string[];
}) {
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL"];
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  // 可选 subjectId 过滤
  if (params.subjectId) {
    where.push(`(subject_id = $${idx} OR subject_id IS NULL)`);
    args.push(params.subjectId);
    idx++;
  }

  // 可选 phase 过滤
  if (params.phase) {
    if (Array.isArray(params.phase)) {
      where.push(`phase = ANY($${idx}::text[])`);
      args.push(params.phase);
    } else {
      where.push(`phase = $${idx}`);
      args.push(params.phase);
    }
    idx++;
  }

  args.push(params.limit);

  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_task_states
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx}
    `,
    args,
  );
  return res.rows.map(toTaskState);
}

/* ── 多模态记忆：附件管理 ── */

export type MemoryAttachmentRow = {
  id: string;
  tenantId: string;
  memoryId: string;
  mediaId: string;
  mediaType: string;
  caption: string | null;
  displayOrder: number;
  createdAt: string;
};

function toAttachment(r: any): MemoryAttachmentRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    memoryId: r.memory_id,
    mediaId: r.media_id,
    mediaType: r.media_type,
    caption: r.caption ?? null,
    displayOrder: Number(r.display_order ?? 0),
    createdAt: r.created_at,
  };
}

export type MediaRefInput = {
  mediaId: string;
  mediaType?: string;
  caption?: string | null;
};

/** 批量写入记忆附件关联 */
export async function insertMemoryAttachments(params: {
  pool: Pool;
  tenantId: string;
  memoryId: string;
  mediaRefs: MediaRefInput[];
}): Promise<MemoryAttachmentRow[]> {
  if (!params.mediaRefs.length) return [];
  const values: string[] = [];
  const args: any[] = [params.tenantId, params.memoryId];
  let idx = 3;
  for (let i = 0; i < params.mediaRefs.length; i++) {
    const ref = params.mediaRefs[i]!;
    values.push(`($1, $2, $${idx}, $${idx + 1}, $${idx + 2}, ${i})`);
    args.push(ref.mediaId, ref.mediaType ?? "file", ref.caption ?? null);
    idx += 3;
  }
  const res = await params.pool.query(
    `INSERT INTO memory_entry_attachments (tenant_id, memory_id, media_id, media_type, caption, display_order)
     VALUES ${values.join(", ")}
     RETURNING *`,
    args,
  );
  return res.rows.map(toAttachment);
}

/** 查询记忆的所有附件 */
export async function listMemoryAttachments(params: {
  pool: Pool;
  tenantId: string;
  memoryId: string;
}): Promise<MemoryAttachmentRow[]> {
  const res = await params.pool.query(
    `SELECT * FROM memory_entry_attachments
     WHERE tenant_id = $1 AND memory_id = $2
     ORDER BY display_order ASC, created_at ASC`,
    [params.tenantId, params.memoryId],
  );
  return res.rows.map(toAttachment);
}

/** 批量查询多条记忆的附件（返回 Map<memoryId, attachments[]>） */
export async function listMemoryAttachmentsBatch(params: {
  pool: Pool;
  tenantId: string;
  memoryIds: string[];
}): Promise<Map<string, MemoryAttachmentRow[]>> {
  const map = new Map<string, MemoryAttachmentRow[]>();
  if (!params.memoryIds.length) return map;
  const res = await params.pool.query(
    `SELECT * FROM memory_entry_attachments
     WHERE tenant_id = $1 AND memory_id = ANY($2::uuid[])
     ORDER BY display_order ASC, created_at ASC`,
    [params.tenantId, params.memoryIds],
  );
  for (const r of res.rows) {
    const att = toAttachment(r);
    const list = map.get(att.memoryId) ?? [];
    list.push(att);
    map.set(att.memoryId, list);
  }
  return map;
}

/** 删除记忆的所有附件关联 */
export async function deleteMemoryAttachments(params: {
  pool: Pool;
  tenantId: string;
  memoryId: string;
}): Promise<number> {
  const res = await params.pool.query(
    `DELETE FROM memory_entry_attachments WHERE tenant_id = $1 AND memory_id = $2`,
    [params.tenantId, params.memoryId],
  );
  return res.rowCount ?? 0;
}

/**
 * P1-记忆用户侧管理：标记记忆为重要（置顶/保护）
 * - pinned=true 的记忆不会被自动衰减清理
 * - 记录 pinned_at 和 pinned_by 用于审计
 */
export async function pinMemoryEntry(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  id: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    `
      UPDATE memory_entries
      SET pinned = TRUE, pinned_at = now(), pinned_by = $4, updated_at = now()
      WHERE tenant_id = $1
        AND space_id = $2
        AND id = $3
        AND deleted_at IS NULL
        AND (scope <> 'user' OR owner_subject_id = $4)
      RETURNING id
    `,
    [params.tenantId, params.spaceId, params.id, params.subjectId],
  );
  return Boolean(res.rowCount);
}

/**
 * P1-记忆用户侧管理：取消记忆的置顶/保护标记
 */
export async function unpinMemoryEntry(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  id: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    `
      UPDATE memory_entries
      SET pinned = FALSE, pinned_at = NULL, pinned_by = NULL, updated_at = now()
      WHERE tenant_id = $1
        AND space_id = $2
        AND id = $3
        AND deleted_at IS NULL
        AND (scope <> 'user' OR owner_subject_id = $4)
      RETURNING id
    `,
    [params.tenantId, params.spaceId, params.id, params.subjectId],
  );
  return Boolean(res.rowCount);
}
