import type { Pool } from "pg";
import {
  listModelCatalogFromDb,
  type ModelCatalogEntry,
  type ModelCapabilities,
  type ModelPerformanceStats,
} from "./catalog";

export type RoutingPolicy = {
  tenantId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RoutingPolicyOverride = {
  tenantId: string;
  spaceId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

function toPolicy(r: any): RoutingPolicy {
  return {
    tenantId: r.tenant_id,
    purpose: r.purpose,
    primaryModelRef: r.primary_model_ref,
    fallbackModelRefs: Array.isArray(r.fallback_model_refs) ? r.fallback_model_refs : [],
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPolicyOverride(r: any): RoutingPolicyOverride {
  return {
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    purpose: r.purpose,
    primaryModelRef: r.primary_model_ref,
    fallbackModelRefs: Array.isArray(r.fallback_model_refs) ? r.fallback_model_refs : [],
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listRoutingPolicies(params: { pool: Pool; tenantId: string; limit?: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM routing_policies
      WHERE tenant_id = $1
      ORDER BY purpose ASC
      LIMIT $2
    `,
    [params.tenantId, Math.min(Math.max(params.limit ?? 200, 1), 500)],
  );
  return res.rows.map(toPolicy);
}

export async function getRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM routing_policies
      WHERE tenant_id = $1 AND purpose = $2
      LIMIT 1
    `,
    [params.tenantId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toPolicy(res.rows[0]);
}

export async function getRoutingPolicyOverride(params: { pool: Pool; tenantId: string; spaceId: string; purpose: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM routing_policies_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toPolicyOverride(res.rows[0]);
}

export async function upsertRoutingPolicyOverride(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
}) {
  const fallbacksJson = JSON.stringify(params.fallbackModelRefs ?? []);
  const res = await params.pool.query(
    `
      INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT (tenant_id, space_id, purpose)
      DO UPDATE SET
        primary_model_ref = EXCLUDED.primary_model_ref,
        fallback_model_refs = EXCLUDED.fallback_model_refs,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.purpose, params.primaryModelRef, fallbacksJson, params.enabled],
  );
  return toPolicyOverride(res.rows[0]);
}

export async function deleteRoutingPolicyOverride(params: { pool: Pool; tenantId: string; spaceId: string; purpose: string }) {
  await params.pool.query(
    `
      DELETE FROM routing_policies_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3
    `,
    [params.tenantId, params.spaceId, params.purpose],
  );
}

export async function getEffectiveRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string; spaceId?: string | null }) {
  const spaceId = params.spaceId ?? null;
  if (spaceId) {
    const o = await getRoutingPolicyOverride({ pool: params.pool, tenantId: params.tenantId, spaceId, purpose: params.purpose });
    if (o) {
      const { tenantId, purpose, primaryModelRef, fallbackModelRefs, enabled, createdAt, updatedAt } = o;
      return { tenantId, purpose, primaryModelRef, fallbackModelRefs, enabled, createdAt, updatedAt };
    }
  }
  return getRoutingPolicy({ pool: params.pool, tenantId: params.tenantId, purpose: params.purpose });
}

export async function upsertRoutingPolicy(params: {
  pool: Pool;
  tenantId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
}) {
  const fallbacksJson = JSON.stringify(params.fallbackModelRefs ?? []);
  const res = await params.pool.query(
    `
      INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
      VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (tenant_id, purpose)
      DO UPDATE SET
        primary_model_ref = EXCLUDED.primary_model_ref,
        fallback_model_refs = EXCLUDED.fallback_model_refs,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.purpose, params.primaryModelRef, fallbacksJson, params.enabled],
  );
  return toPolicy(res.rows[0]);
}

export async function disableRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string }) {
  const res = await params.pool.query(
    `
      UPDATE routing_policies
      SET enabled = false, updated_at = now()
      WHERE tenant_id = $1 AND purpose = $2
      RETURNING *
    `,
    [params.tenantId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toPolicy(res.rows[0]);
}

export async function deleteRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string }) {
  await params.pool.query(
    `
      DELETE FROM routing_policies
      WHERE tenant_id = $1 AND purpose = $2
    `,
    [params.tenantId, params.purpose],
  );
}

// ── P2-5: 动态智能路由 ──────────────────────────────

/** 任务特征向量（用于能力匹配） */
export type TaskFeatures = {
  complexity: "low" | "medium" | "high";        // 任务复杂度
  modalities: string[];                          // 需要的模态 ["text", "image"]
  requiresToolCall: boolean;                     // 是否需要工具调用
  requiresStructuredOutput: boolean;             // 是否需要结构化输出
  requiresReasoning: boolean;                    // 是否需要深度推理
  requiresCodeGen: boolean;                      // 是否需要代码生成
  latencySensitive: boolean;                     // 是否延迟敏感
  contextLengthNeeded?: number;                  // 预估上下文长度
  locale?: string;                               // 语言偏好
};

/** 候选模型评分 */
type CandidateScore = {
  modelRef: string;
  entry: ModelCatalogEntry;
  score: number;
  breakdown: Record<string, number>;
};

/**
 * P2-5: 基于任务特征 × 模型能力矩阵 自动匹配最优模型。
 * 优先查询 DB 模型目录，回退到静态路由策略。
 */
export async function dynamicRouteModel(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  purpose: string;
  taskFeatures: TaskFeatures;
}): Promise<{ modelRef: string; reason: string; candidates: CandidateScore[] }> {
  const { pool, tenantId, purpose, taskFeatures } = params;

  // 1. 从 DB 加载可用模型
  const allModels = await listModelCatalogFromDb({ pool, tenantId, status: "active" });

  if (allModels.length === 0) {
    // 回退到静态路由
    const policy = await getEffectiveRoutingPolicy({ pool, tenantId, purpose, spaceId: params.spaceId });
    return {
      modelRef: policy?.primaryModelRef ?? "",
      reason: "无 DB 模型目录，回退静态路由策略",
      candidates: [],
    };
  }

  // 2. 对每个候选模型评分
  const candidates: CandidateScore[] = allModels.map((entry) => {
    const caps = entry.capabilities as ModelCapabilities;
    const perf = entry.performanceStats as ModelPerformanceStats | undefined;
    const breakdown: Record<string, number> = {};

    // 模态匹配（必须支持所有需要的模态）
    const modalityMatch = taskFeatures.modalities.every(m =>
      (caps.supportedModalities ?? []).includes(m));
    breakdown.modality = modalityMatch ? 1.0 : 0.0;

    // 工具调用能力
    if (taskFeatures.requiresToolCall) {
      const toolScore = { none: 0, basic: 0.4, native: 0.8, advanced: 1.0 }[caps.toolCallAbility ?? "none"] ?? 0;
      breakdown.toolCall = toolScore;
    } else {
      breakdown.toolCall = 1.0;
    }

    // 结构化输出
    if (taskFeatures.requiresStructuredOutput) {
      const structScore = { none: 0, json: 0.6, json_schema: 1.0 }[caps.structuredOutputAbility ?? "none"] ?? 0;
      breakdown.structured = structScore;
    } else {
      breakdown.structured = 1.0;
    }

    // 推理深度
    if (taskFeatures.requiresReasoning || taskFeatures.complexity === "high") {
      const reasonScore = { low: 0.2, medium: 0.6, high: 1.0 }[caps.reasoningDepth ?? "medium"] ?? 0.5;
      breakdown.reasoning = reasonScore;
    } else {
      breakdown.reasoning = 0.8;
    }

    // 代码生成
    if (taskFeatures.requiresCodeGen) {
      const codeScore = { none: 0, low: 0.3, medium: 0.6, high: 1.0 }[caps.codeGenQuality ?? "medium"] ?? 0.5;
      breakdown.codeGen = codeScore;
    } else {
      breakdown.codeGen = 1.0;
    }

    // 上下文窗口
    if (taskFeatures.contextLengthNeeded && caps.contextWindow) {
      breakdown.context = taskFeatures.contextLengthNeeded <= caps.contextWindow ? 1.0 : 0.0;
    } else {
      breakdown.context = 1.0;
    }

    // 延迟敏感度
    if (taskFeatures.latencySensitive && perf) {
      const p95 = perf.latencyP95Ms || 5000;
      breakdown.latency = p95 < 2000 ? 1.0 : p95 < 5000 ? 0.6 : 0.2;
    } else {
      breakdown.latency = 0.8;
    }

    // 成功率信任度
    const successRate = perf?.successRate ?? 1;
    breakdown.reliability = successRate;

    // 退化惩罚
    const degradation = entry.degradationScore ?? 0;
    breakdown.degradation = 1 - degradation;

    // 加权总分
    const weights = {
      modality: 0.20, toolCall: 0.15, structured: 0.10,
      reasoning: 0.15, codeGen: 0.08, context: 0.10,
      latency: 0.07, reliability: 0.10, degradation: 0.05,
    };
    let score = 0;
    for (const [k, w] of Object.entries(weights)) {
      score += (breakdown[k] ?? 0.5) * w;
    }
    // 模态不匹配直接淘汰
    if (!modalityMatch) score = 0;
    // 上下文不足淘汰
    if (breakdown.context === 0) score = 0;

    return { modelRef: entry.modelRef, entry, score, breakdown };
  });

  // 3. 按评分降序
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score === 0) {
    // 无合适模型，回退静态路由
    const policy = await getEffectiveRoutingPolicy({ pool, tenantId, purpose, spaceId: params.spaceId });
    return {
      modelRef: policy?.primaryModelRef ?? "",
      reason: "无匹配模型，回退静态路由",
      candidates,
    };
  }

  // 4. 记录路由决策日志（异步，不阻塞）
  pool.query(
    `INSERT INTO routing_decisions_log (tenant_id, space_id, purpose, task_features, candidates, selected_model_ref, selection_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, params.spaceId ?? null, purpose,
     JSON.stringify(taskFeatures),
     JSON.stringify(candidates.slice(0, 5).map(c => ({ modelRef: c.modelRef, score: c.score }))),
     best.modelRef,
     `动态路由: score=${best.score.toFixed(3)}`],
  ).catch(() => {}); // fire-and-forget

  return {
    modelRef: best.modelRef,
    reason: `动态路由: ${best.modelRef} (score=${best.score.toFixed(3)})`,
    candidates,
  };
}

/**
 * P2-5: 能力退化检测。
 * 比较模型实际表现与画像偏差，超过阈值触发告警和自动降级。
 */
export async function checkModelDegradation(params: {
  pool: Pool;
  tenantId: string;
  modelRef: string;
  actualLatencyMs: number;
  actualSuccess: boolean;
}): Promise<{ degraded: boolean; alertType?: string }> {
  const { pool, tenantId, modelRef, actualLatencyMs, actualSuccess } = params;

  // 查询模型画像
  const res = await pool.query(
    `SELECT capabilities, performance_stats, degradation_score, status FROM model_catalog WHERE tenant_id = $1 AND model_ref = $2`,
    [tenantId, modelRef],
  );
  if (!res.rowCount) return { degraded: false };

  const row = res.rows[0] as any;
  const perf = (row.performance_stats ?? {}) as ModelPerformanceStats;
  let degradationScore = Number(row.degradation_score ?? 0);
  let alertType: string | undefined;

  // 延迟尖刺检测
  const p95 = perf.latencyP95Ms || 5000;
  if (actualLatencyMs > p95 * 2) {
    degradationScore = Math.min(1, degradationScore + 0.15);
    alertType = "latency_spike";
  }

  // 失败率检测
  if (!actualSuccess) {
    degradationScore = Math.min(1, degradationScore + 0.2);
    alertType = alertType ?? "error_rate_high";
  }

  // 成功时缓慢恢复
  if (actualSuccess && actualLatencyMs <= p95) {
    degradationScore = Math.max(0, degradationScore - 0.03);
  }

  // 更新退化分数
  const newStatus = degradationScore > 0.7 ? "unavailable" : degradationScore > 0.3 ? "degraded" : "active";
  await pool.query(
    `UPDATE model_catalog SET degradation_score = $3, status = $4, updated_at = now() WHERE tenant_id = $1 AND model_ref = $2`,
    [tenantId, modelRef, degradationScore, newStatus],
  );

  // 当退化严重时创建告警
  const degraded = degradationScore > 0.3;
  if (degraded && alertType) {
    const { createDegradationAlert } = await import("./catalog");
    await createDegradationAlert({
      pool, tenantId, modelRef, alertType,
      severity: degradationScore > 0.7 ? "critical" : "warning",
      details: { degradationScore, actualLatencyMs, actualSuccess, p95 },
    }).catch(() => {});
  }

  return { degraded, alertType };
}
