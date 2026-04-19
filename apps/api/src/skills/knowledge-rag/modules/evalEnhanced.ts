/**
 * evalEnhanced.ts — 知识检索评测增强引擎
 *
 * P1-3 实现:
 *   - P1-3a: 自动化黄金语料集构建（从检索日志采样 + LLM 辅助标注）
 *   - P1-3b: 线上真实流量采样（按比例/按策略采样）
 *   - P1-3c: 高级评测指标（NDCG@K, MAP, Recall@K, Precision@K, F1@K, 幻觉率）
 *   - P1-3d: 回归门禁机制
 *   - P1-3f: A/B 实验框架
 *
 * @module knowledge-rag/evalEnhanced
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:evalEnhanced" });

// ═══════════════════════════════════════════════════════════════
//  P1-3c: 高级评测指标
// ═══════════════════════════════════════════════════════════════

/** 排序质量评测项 */
export interface RankedItem {
  documentId: string;
  /** 是否相关 (ground truth) */
  relevant: boolean;
  /** 相关度等级 (0=不相关, 1=部分相关, 2=高度相关, 3=完美匹配) */
  relevanceGrade?: number;
  /** 系统给出的排名 (0-based) */
  rank: number;
}

/** 检索评测指标集合 */
export interface RetrievalMetrics {
  /** Precision@K: 前K个结果中相关结果的比例 */
  precisionAtK: number;
  /** Recall@K: 前K个结果召回相关结果的比例 */
  recallAtK: number;
  /** F1@K: Precision 和 Recall 的调和平均 */
  f1AtK: number;
  /** Hit@K: 前K个结果中是否有相关结果 (0 或 1) */
  hitAtK: number;
  /** MRR@K: Mean Reciprocal Rank — 第一个相关结果排名的倒数 */
  mrrAtK: number;
  /** NDCG@K: Normalized Discounted Cumulative Gain — 考虑多级相关度的排序质量 */
  ndcgAtK: number;
  /** MAP: Mean Average Precision — 所有相关文档位置的平均精度 */
  mapAtK: number;
  /** 幻觉率: 返回结果中不相关内容的比例 */
  hallucinationRate: number;
  /** K 值 */
  k: number;
}

/**
 * 计算 DCG@K (Discounted Cumulative Gain)
 */
function computeDCG(relevanceGrades: number[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(relevanceGrades.length, k); i++) {
    // DCG = sum( (2^rel_i - 1) / log2(i + 2) )
    dcg += (Math.pow(2, relevanceGrades[i]!) - 1) / Math.log2(i + 2);
  }
  return dcg;
}

/**
 * 计算完整检索评测指标集
 */
export function computeRetrievalMetrics(params: {
  /** 系统返回的排序结果 */
  rankedItems: RankedItem[];
  /** 总相关文档数 (ground truth) */
  totalRelevant: number;
  /** 评测的 K 值 */
  k: number;
}): RetrievalMetrics {
  const { rankedItems, totalRelevant, k } = params;
  const topK = rankedItems.slice(0, k);

  // Precision@K
  const relevantInTopK = topK.filter(item => item.relevant).length;
  const precisionAtK = topK.length > 0 ? relevantInTopK / topK.length : 0;

  // Recall@K
  const recallAtK = totalRelevant > 0 ? relevantInTopK / totalRelevant : 0;

  // F1@K
  const f1AtK = precisionAtK + recallAtK > 0
    ? 2 * precisionAtK * recallAtK / (precisionAtK + recallAtK)
    : 0;

  // Hit@K
  const hitAtK = topK.some(item => item.relevant) ? 1 : 0;

  // MRR@K
  const firstRelevantRank = topK.findIndex(item => item.relevant);
  const mrrAtK = firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;

  // NDCG@K
  const actualGrades = topK.map(item => item.relevanceGrade ?? (item.relevant ? 1 : 0));
  const idealGrades = [...actualGrades].sort((a, b) => b - a);
  // 补齐 ideal: 若 totalRelevant 大于已返回的相关数，ideal 中应有更多高分
  const idealFull = rankedItems
    .map(item => item.relevanceGrade ?? (item.relevant ? 1 : 0))
    .sort((a, b) => b - a);
  const dcg = computeDCG(actualGrades, k);
  const idcg = computeDCG(idealFull.length > 0 ? idealFull : idealGrades, k);
  const ndcgAtK = idcg > 0 ? dcg / idcg : 0;

  // MAP@K (Average Precision)
  let apSum = 0;
  let relevantSoFar = 0;
  for (let i = 0; i < topK.length; i++) {
    if (topK[i]!.relevant) {
      relevantSoFar++;
      apSum += relevantSoFar / (i + 1);
    }
  }
  const mapAtK = totalRelevant > 0 ? apSum / totalRelevant : 0;

  // 幻觉率
  const hallucinationRate = topK.length > 0
    ? topK.filter(item => !item.relevant).length / topK.length
    : 0;

  return {
    precisionAtK: round4(precisionAtK),
    recallAtK: round4(recallAtK),
    f1AtK: round4(f1AtK),
    hitAtK,
    mrrAtK: round4(mrrAtK),
    ndcgAtK: round4(ndcgAtK),
    mapAtK: round4(mapAtK),
    hallucinationRate: round4(hallucinationRate),
    k,
  };
}

/**
 * 聚合多个查询的检索指标 (Macro Average)
 */
export function aggregateMetrics(metricsArray: RetrievalMetrics[]): RetrievalMetrics & {
  queryCount: number;
} {
  if (metricsArray.length === 0) {
    return {
      precisionAtK: 0, recallAtK: 0, f1AtK: 0, hitAtK: 0, mrrAtK: 0,
      ndcgAtK: 0, mapAtK: 0, hallucinationRate: 0, k: 0, queryCount: 0,
    };
  }

  const n = metricsArray.length;
  const avg = (field: keyof RetrievalMetrics) =>
    round4(metricsArray.reduce((s, m) => s + (m[field] as number), 0) / n);

  return {
    precisionAtK: avg("precisionAtK"),
    recallAtK: avg("recallAtK"),
    f1AtK: avg("f1AtK"),
    hitAtK: avg("hitAtK"),
    mrrAtK: avg("mrrAtK"),
    ndcgAtK: avg("ndcgAtK"),
    mapAtK: avg("mapAtK"),
    hallucinationRate: avg("hallucinationRate"),
    k: metricsArray[0]!.k,
    queryCount: n,
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ═══════════════════════════════════════════════════════════════
//  P1-3a: 自动化黄金语料集构建
// ═══════════════════════════════════════════════════════════════

/** 黄金语料项 */
export interface GoldenDatasetItem {
  query: string;
  /** 期望相关的文档ID列表 */
  expectedDocumentIds: string[];
  /** 相关度标注 (documentId → grade) */
  relevanceGrades?: Record<string, number>;
  /** 标注来源 */
  annotationSource: "auto_log" | "llm_assisted" | "human" | "traffic_sampling";
  /** 标注置信度 */
  annotationConfidence: number;
  /** 原始检索日志 ID (可追溯) */
  sourceLogId?: string;
  /** K 值 */
  k: number;
}

/** 黄金语料集 */
export interface GoldenDataset {
  name: string;
  description: string;
  items: GoldenDatasetItem[];
  createdAt: string;
  version: number;
}

/**
 * 从检索日志自动采样高质量 query-document 对
 *
 * 采样策略：
 *   1. 取近 N 天内有返回结果且未降级的成功检索
 *   2. 按 candidate_count 排序取 top quality
 *   3. 自动标注：返回结果作为 expectedDocumentIds
 */
export async function buildGoldenDatasetFromLogs(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  /** 采样天数 */
  days?: number;
  /** 最大采样条数 */
  maxSamples?: number;
  /** 最小候选数阈值 — 低于此阈值的日志不采样 */
  minCandidateCount?: number;
}): Promise<GoldenDataset> {
  const days = params.days ?? 14;
  const maxSamples = params.maxSamples ?? 200;
  const minCandidates = params.minCandidateCount ?? 3;

  const res = await params.pool.query(
    `SELECT id, query_digest, cited_refs, candidate_count, rank_policy, returned_count
     FROM knowledge_retrieval_logs
     WHERE tenant_id = $1 AND space_id = $2
       AND NOT degraded
       AND returned_count > 0
       AND candidate_count >= $3
       AND created_at > now() - ($4 || ' days')::interval
     ORDER BY candidate_count DESC, returned_count DESC
     LIMIT $5`,
    [params.tenantId, params.spaceId, minCandidates, String(days), maxSamples],
  );

  const items: GoldenDatasetItem[] = [];
  const seenQueries = new Set<string>();

  for (const row of res.rows as any[]) {
    const digest = row.query_digest;
    // 提取 query 文本 — query_digest 可能是 JSON { queryLen, rankPolicy } 或包含 queryHash
    const queryText = typeof digest === "object"
      ? (digest.queryHash ?? digest.query ?? JSON.stringify(digest).slice(0, 200))
      : String(digest).slice(0, 200);

    if (seenQueries.has(queryText)) continue;
    seenQueries.add(queryText);

    // 提取文档 ID
    const citedRefs = Array.isArray(row.cited_refs) ? row.cited_refs : [];
    const docIds = [...new Set(
      citedRefs.map((r: any) => r.documentId ?? r.document_id).filter(Boolean) as string[],
    )];

    if (docIds.length === 0) continue;

    items.push({
      query: queryText,
      expectedDocumentIds: docIds,
      annotationSource: "auto_log",
      annotationConfidence: Math.min(0.85, 0.5 + (Number(row.candidate_count) / 100)),
      sourceLogId: String(row.id),
      k: 5,
    });
  }

  return {
    name: `auto_golden_${params.tenantId.slice(0, 8)}_${params.spaceId.slice(0, 8)}`,
    description: `Auto-generated golden dataset from retrieval logs (${days} days, ${items.length} items)`,
    items,
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

/**
 * LLM 辅助标注 — 对自动采样的语料进行相关度评分
 */
export async function llmAssistedAnnotation(params: {
  app: FastifyInstance;
  authorization: string;
  query: string;
  /** 候选文档摘要 */
  documentSnippets: Array<{ documentId: string; snippet: string }>;
  traceId?: string;
}): Promise<Record<string, number>> {
  try {
    const { invokeModelChat } = await import("../../../lib/llm");
    const snippetsText = params.documentSnippets
      .map((d, i) => `[${i + 1}] docId=${d.documentId}\n${d.snippet.slice(0, 300)}`)
      .join("\n---\n");

    const result = await invokeModelChat({
      app: params.app,
      subject: { tenantId: "system", subjectId: "eval-annotator", spaceId: undefined },
      locale: "zh-CN",
      purpose: "golden_dataset_annotation",
      authorization: params.authorization,
      traceId: params.traceId ?? null,
      messages: [
        {
          role: "system",
          content: `你是一个知识检索质量标注员。给定一个查询和多个候选文档摘要，为每个文档评分：
0=完全不相关, 1=部分相关, 2=高度相关, 3=完美匹配
输出 JSON 数组：[{"documentId":"...","grade":0-3}]
只输出 JSON，无其他内容。`,
        },
        {
          role: "user",
          content: `查询: ${params.query}\n\n候选文档:\n${snippetsText}`,
        },
      ],
    });

    const text = typeof result?.outputText === "string" ? result.outputText.trim() : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ documentId: string; grade: number }>;
      const grades: Record<string, number> = {};
      for (const item of parsed) {
        if (item.documentId && typeof item.grade === "number") {
          grades[item.documentId] = Math.max(0, Math.min(3, Math.round(item.grade)));
        }
      }
      return grades;
    }
  } catch (e: any) {
    _logger.warn("LLM annotation failed", { error: e?.message });
  }
  return {};
}

/**
 * 将黄金语料集写入 knowledge_retrieval_eval_sets 表
 */
export async function persistGoldenDataset(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  dataset: GoldenDataset;
  subjectId?: string;
}): Promise<{ evalSetId: string }> {
  const queries = params.dataset.items.map(item => ({
    query: item.query,
    expectedDocumentIds: item.expectedDocumentIds,
    k: item.k,
    annotationSource: item.annotationSource,
    annotationConfidence: item.annotationConfidence,
    relevanceGrades: item.relevanceGrades ?? null,
  }));

  const res = await params.pool.query(
    `INSERT INTO knowledge_retrieval_eval_sets (tenant_id, space_id, name, description, queries, created_by_subject_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      params.tenantId,
      params.spaceId,
      params.dataset.name,
      params.dataset.description,
      JSON.stringify(queries),
      params.subjectId ?? "system_auto",
    ],
  );

  return { evalSetId: String(res.rows[0].id) };
}

// ═══════════════════════════════════════════════════════════════
//  P1-3b: 线上真实流量采样
// ═══════════════════════════════════════════════════════════════

/** 流量采样配置 */
export interface TrafficSamplingConfig {
  /** 采样比例 (0-1) */
  sampleRate: number;
  /** 按策略采样 (null = 全部策略) */
  strategyFilter: string[] | null;
  /** 只采样有用户反馈的 */
  requireFeedback: boolean;
  /** 最大采样条数 */
  maxSamples: number;
  /** 采样时间窗口(天) */
  windowDays: number;
}

export const DEFAULT_SAMPLING_CONFIG: TrafficSamplingConfig = {
  sampleRate: 0.1,
  strategyFilter: null,
  requireFeedback: false,
  maxSamples: 500,
  windowDays: 7,
};

/** 采样记录 */
export interface TrafficSample {
  logId: string;
  query: string;
  strategy: string | null;
  returnedDocumentIds: string[];
  candidateCount: number;
  returnedCount: number;
  degraded: boolean;
  /** 用户反馈分数 (null=无反馈) */
  userFeedbackScore: number | null;
  sampledAt: string;
}

/**
 * 从线上检索日志采样真实流量
 */
export async function sampleTraffic(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  config?: Partial<TrafficSamplingConfig>;
}): Promise<TrafficSample[]> {
  const cfg = { ...DEFAULT_SAMPLING_CONFIG, ...params.config };

  const conditions: string[] = [
    "tenant_id = $1",
    "space_id = $2",
    `created_at > now() - ($3 || ' days')::interval`,
  ];
  const args: any[] = [params.tenantId, params.spaceId, String(cfg.windowDays)];
  let idx = 4;

  if (cfg.strategyFilter && cfg.strategyFilter.length > 0) {
    conditions.push(`rank_policy = ANY($${idx++}::text[])`);
    args.push(cfg.strategyFilter);
  }

  // 使用 TABLESAMPLE 近似采样或 random() 过滤
  const sampleRatePercent = Math.max(0.01, Math.min(1, cfg.sampleRate));

  const res = await params.pool.query(
    `SELECT id, query_digest, cited_refs, candidate_count, returned_count,
            degraded, degrade_reason, rank_policy, strategy_ref
     FROM knowledge_retrieval_logs
     WHERE ${conditions.join(" AND ")}
       AND random() < $${idx++}
     ORDER BY created_at DESC
     LIMIT $${idx++}`,
    [...args, sampleRatePercent, cfg.maxSamples],
  );

  return (res.rows as any[]).map(row => {
    const digest = row.query_digest;
    const queryText = typeof digest === "object"
      ? (digest.queryHash ?? digest.query ?? JSON.stringify(digest).slice(0, 200))
      : String(digest).slice(0, 200);

    const citedRefs = Array.isArray(row.cited_refs) ? row.cited_refs : [];
    const docIds = citedRefs
      .map((r: any) => r.documentId ?? r.document_id)
      .filter(Boolean) as string[];

    return {
      logId: String(row.id),
      query: queryText,
      strategy: row.rank_policy ?? row.strategy_ref ?? null,
      returnedDocumentIds: docIds,
      candidateCount: Number(row.candidate_count ?? 0),
      returnedCount: Number(row.returned_count ?? 0),
      degraded: Boolean(row.degraded),
      userFeedbackScore: null, // 暂无反馈机制，后续扩展
      sampledAt: new Date().toISOString(),
    };
  });
}

/**
 * 将流量采样结果转化为黄金语料条目
 */
export function trafficSamplesToGoldenItems(
  samples: TrafficSample[],
  opts?: { minReturnedCount?: number },
): GoldenDatasetItem[] {
  const minReturned = opts?.minReturnedCount ?? 1;
  return samples
    .filter(s => s.returnedCount >= minReturned && s.returnedDocumentIds.length > 0)
    .map(s => ({
      query: s.query,
      expectedDocumentIds: s.returnedDocumentIds,
      annotationSource: "traffic_sampling" as const,
      annotationConfidence: 0.6,
      sourceLogId: s.logId,
      k: 5,
    }));
}

// ═══════════════════════════════════════════════════════════════
//  P1-3d: 回归门禁机制
// ═══════════════════════════════════════════════════════════════

/** 回归门禁配置 */
export interface RegressionGateConfig {
  /** 准确率(Hit@K)下降阈值 — 超过此值阻拦 */
  hitAtKDropThreshold: number;
  /** MRR 下降阈值 */
  mrrDropThreshold: number;
  /** NDCG 下降阈值 */
  ndcgDropThreshold: number;
  /** 幻觉率上升阈值 */
  hallucinationRiseThreshold: number;
  /** 失败率上升阈值 */
  failureRateRiseThreshold: number;
}

export const DEFAULT_REGRESSION_GATE: RegressionGateConfig = {
  hitAtKDropThreshold: 0.005,
  mrrDropThreshold: 0.01,
  ndcgDropThreshold: 0.01,
  hallucinationRiseThreshold: 0.02,
  failureRateRiseThreshold: 0.01,
};

/** 回归检查结果 */
export interface RegressionCheckResult {
  gateResult: "passed" | "blocked";
  blockedReasons: string[];
  deltas: {
    hitAtKDelta: number;
    mrrDelta: number;
    ndcgDelta: number;
    hallucinationDelta: number;
    failureRateDelta: number;
  };
  baseline: RetrievalMetrics;
  current: RetrievalMetrics;
}

/**
 * 执行回归门禁检查
 */
export function checkRegression(params: {
  baseline: RetrievalMetrics;
  current: RetrievalMetrics;
  baselineFailureRate?: number;
  currentFailureRate?: number;
  config?: Partial<RegressionGateConfig>;
}): RegressionCheckResult {
  const cfg = { ...DEFAULT_REGRESSION_GATE, ...params.config };
  const blockedReasons: string[] = [];

  const hitDelta = params.current.hitAtK - params.baseline.hitAtK;
  const mrrDelta = params.current.mrrAtK - params.baseline.mrrAtK;
  const ndcgDelta = params.current.ndcgAtK - params.baseline.ndcgAtK;
  const hallDelta = params.current.hallucinationRate - params.baseline.hallucinationRate;
  const failDelta = (params.currentFailureRate ?? 0) - (params.baselineFailureRate ?? 0);

  if (-hitDelta > cfg.hitAtKDropThreshold) {
    blockedReasons.push(
      `Hit@K dropped by ${(-hitDelta * 100).toFixed(2)}% (threshold: ${(cfg.hitAtKDropThreshold * 100).toFixed(2)}%)`,
    );
  }
  if (-mrrDelta > cfg.mrrDropThreshold) {
    blockedReasons.push(
      `MRR@K dropped by ${(-mrrDelta * 100).toFixed(2)}% (threshold: ${(cfg.mrrDropThreshold * 100).toFixed(2)}%)`,
    );
  }
  if (-ndcgDelta > cfg.ndcgDropThreshold) {
    blockedReasons.push(
      `NDCG@K dropped by ${(-ndcgDelta * 100).toFixed(2)}% (threshold: ${(cfg.ndcgDropThreshold * 100).toFixed(2)}%)`,
    );
  }
  if (hallDelta > cfg.hallucinationRiseThreshold) {
    blockedReasons.push(
      `Hallucination rate rose by ${(hallDelta * 100).toFixed(2)}% (threshold: ${(cfg.hallucinationRiseThreshold * 100).toFixed(2)}%)`,
    );
  }
  if (failDelta > cfg.failureRateRiseThreshold) {
    blockedReasons.push(
      `Failure rate rose by ${(failDelta * 100).toFixed(2)}% (threshold: ${(cfg.failureRateRiseThreshold * 100).toFixed(2)}%)`,
    );
  }

  return {
    gateResult: blockedReasons.length > 0 ? "blocked" : "passed",
    blockedReasons,
    deltas: {
      hitAtKDelta: round4(hitDelta),
      mrrDelta: round4(mrrDelta),
      ndcgDelta: round4(ndcgDelta),
      hallucinationDelta: round4(hallDelta),
      failureRateDelta: round4(failDelta),
    },
    baseline: params.baseline,
    current: params.current,
  };
}

// ═══════════════════════════════════════════════════════════════
//  P1-3f: A/B 实验框架
// ═══════════════════════════════════════════════════════════════

/** A/B 实验配置 */
export interface ABExperimentConfig {
  experimentId: string;
  name: string;
  /** 策略 A (对照组) */
  controlStrategy: ABStrategyConfig;
  /** 策略 B (实验组) */
  treatmentStrategy: ABStrategyConfig;
  /** 流量分配比例 (0-1, 给 treatment 的比例) */
  trafficSplit: number;
  /** 最小样本量 */
  minSampleSize: number;
  /** 实验截止时间 */
  endDate?: string;
}

export interface ABStrategyConfig {
  /** 检索策略名 */
  retrieverName: string;
  /** 额外配置 */
  config?: Record<string, unknown>;
}

/** A/B 实验结果记录 */
export interface ABExperimentResult {
  experimentId: string;
  queryId: string;
  group: "control" | "treatment";
  query: string;
  /** 策略使用 */
  strategyUsed: string;
  /** 返回结果数 */
  resultCount: number;
  /** 延迟 (ms) */
  latencyMs: number;
  /** 用户反馈 */
  feedback?: number;
  createdAt: string;
}

/** A/B 实验汇总分析 */
export interface ABExperimentAnalysis {
  experimentId: string;
  controlSamples: number;
  treatmentSamples: number;
  control: {
    avgResultCount: number;
    avgLatencyMs: number;
    avgFeedback: number | null;
  };
  treatment: {
    avgResultCount: number;
    avgLatencyMs: number;
    avgFeedback: number | null;
  };
  /** treatment 相对 control 的提升 */
  lift: {
    resultCountLift: number;
    latencyLift: number;
    feedbackLift: number | null;
  };
  /** 是否有统计显著性 (基于样本量) */
  statisticallySignificant: boolean;
  recommendation: "keep_control" | "adopt_treatment" | "insufficient_data" | "no_difference";
}

/**
 * 决定当前请求分配到 A/B 哪个组
 */
export function assignABGroup(
  experiment: ABExperimentConfig,
  requestId: string,
): "control" | "treatment" {
  // 基于 requestId 的哈希确定分组（保证同一请求总是同一组）
  let hash = 0;
  for (let i = 0; i < requestId.length; i++) {
    hash = ((hash << 5) - hash + requestId.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash) / 2147483647;
  return normalized < experiment.trafficSplit ? "treatment" : "control";
}

/**
 * 记录 A/B 实验结果
 */
export async function recordABResult(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  result: ABExperimentResult;
}): Promise<void> {
  try {
    await params.pool.query(
      `INSERT INTO knowledge_retrieval_logs (
         tenant_id, space_id, query_digest, filters_digest,
         candidate_count, cited_refs, rank_policy, strategy_ref,
         returned_count, degraded, degrade_reason
       ) VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8, false, null)`,
      [
        params.tenantId,
        params.spaceId,
        JSON.stringify({
          experimentId: params.result.experimentId,
          group: params.result.group,
          query: params.result.query.slice(0, 200),
          feedback: params.result.feedback ?? null,
        }),
        JSON.stringify({ source: "ab_experiment", experimentId: params.result.experimentId }),
        params.result.resultCount,
        `ab_${params.result.group}_${params.result.strategyUsed}`,
        `ab_${params.result.experimentId}`,
        params.result.resultCount,
      ],
    );
  } catch (e: any) {
    _logger.warn("AB experiment record failed", { error: e?.message });
  }
}

/**
 * 分析 A/B 实验结果
 */
export async function analyzeABExperiment(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  experimentId: string;
}): Promise<ABExperimentAnalysis> {
  const res = await params.pool.query(
    `SELECT
       query_digest->>'group' AS grp,
       COUNT(*)::int AS cnt,
       AVG(returned_count)::numeric(6,2) AS avg_returned,
       AVG(CASE WHEN (query_digest->>'feedback')::numeric IS NOT NULL
                THEN (query_digest->>'feedback')::numeric END)::numeric(4,2) AS avg_feedback
     FROM knowledge_retrieval_logs
     WHERE tenant_id = $1 AND space_id = $2
       AND strategy_ref = $3
       AND filters_digest->>'source' = 'ab_experiment'
     GROUP BY query_digest->>'group'`,
    [params.tenantId, params.spaceId, `ab_${params.experimentId}`],
  );

  let controlData = { cnt: 0, avg_returned: 0, avg_feedback: null as number | null };
  let treatmentData = { cnt: 0, avg_returned: 0, avg_feedback: null as number | null };

  for (const row of res.rows as any[]) {
    const data = {
      cnt: Number(row.cnt ?? 0),
      avg_returned: Number(row.avg_returned ?? 0),
      avg_feedback: row.avg_feedback != null ? Number(row.avg_feedback) : null,
    };
    if (row.grp === "control") controlData = data;
    if (row.grp === "treatment") treatmentData = data;
  }

  const totalSamples = controlData.cnt + treatmentData.cnt;
  const significant = totalSamples >= 100 && controlData.cnt >= 30 && treatmentData.cnt >= 30;

  const resultLift = controlData.avg_returned > 0
    ? (treatmentData.avg_returned - controlData.avg_returned) / controlData.avg_returned
    : 0;

  const feedbackLift = controlData.avg_feedback != null && treatmentData.avg_feedback != null && controlData.avg_feedback > 0
    ? (treatmentData.avg_feedback - controlData.avg_feedback) / controlData.avg_feedback
    : null;

  let recommendation: ABExperimentAnalysis["recommendation"] = "insufficient_data";
  if (significant) {
    if (resultLift > 0.05 || (feedbackLift != null && feedbackLift > 0.05)) {
      recommendation = "adopt_treatment";
    } else if (resultLift < -0.05 || (feedbackLift != null && feedbackLift < -0.05)) {
      recommendation = "keep_control";
    } else {
      recommendation = "no_difference";
    }
  }

  return {
    experimentId: params.experimentId,
    controlSamples: controlData.cnt,
    treatmentSamples: treatmentData.cnt,
    control: {
      avgResultCount: controlData.avg_returned,
      avgLatencyMs: 0, // 暂无 latency 列
      avgFeedback: controlData.avg_feedback,
    },
    treatment: {
      avgResultCount: treatmentData.avg_returned,
      avgLatencyMs: 0,
      avgFeedback: treatmentData.avg_feedback,
    },
    lift: {
      resultCountLift: round4(resultLift),
      latencyLift: 0,
      feedbackLift: feedbackLift != null ? round4(feedbackLift) : null,
    },
    statisticallySignificant: significant,
    recommendation,
  };
}

// ═══════════════════════════════════════════════════════════════
//  P1-3e: 知识检索专项评测 CI 扩展
// ═══════════════════════════════════════════════════════════════

/** 知识检索专项评测报告 */
export interface KnowledgeEvalCIReport {
  timestamp: string;
  evalSetId: string | null;
  goldenDatasetName: string | null;
  /** 聚合指标 */
  aggregateMetrics: RetrievalMetrics & { queryCount: number };
  /** 逐查询指标 */
  perQueryMetrics: Array<{
    query: string;
    metrics: RetrievalMetrics;
    expectedDocumentIds: string[];
    actualDocumentIds: string[];
  }>;
  /** 回归检查 (如果有基线) */
  regression: RegressionCheckResult | null;
  /** 环境配置摘要 */
  environment: {
    vectorStoreProvider?: string;
    chunkStrategy?: string;
    retrieverName?: string;
  };
}

/**
 * 解析知识检索评测 CI 环境配置
 */
export function resolveKnowledgeEvalCIConfig(): {
  goldenDatasetAutoGenerate: boolean;
  regressionGateEnabled: boolean;
  baselinePath: string | null;
  outputPath: string;
  maxSamples: number;
  k: number;
} {
  return {
    goldenDatasetAutoGenerate: process.env.KNOWLEDGE_EVAL_AUTO_GOLDEN === "1",
    regressionGateEnabled: process.env.KNOWLEDGE_EVAL_GATE === "1",
    baselinePath: process.env.KNOWLEDGE_EVAL_BASELINE ?? null,
    outputPath: process.env.KNOWLEDGE_EVAL_OUTPUT ?? "./knowledge-eval-report.json",
    maxSamples: Math.max(1, Number(process.env.KNOWLEDGE_EVAL_MAX_SAMPLES ?? 200)),
    k: Math.max(1, Number(process.env.KNOWLEDGE_EVAL_K ?? 5)),
  };
}

/**
 * 格式化知识评测报告为文本摘要
 */
export function formatKnowledgeEvalSummary(report: KnowledgeEvalCIReport): string {
  const m = report.aggregateMetrics;
  const lines: string[] = [
    "═══════════════════════════════════════════════════════",
    "  Knowledge RAG Eval — CI Report",
    `  ${report.timestamp}`,
    "═══════════════════════════════════════════════════════",
    "",
    `📋 Queries: ${m.queryCount}  |  K: ${m.k}`,
    "",
    "── Aggregate Metrics ──",
    `  Hit@${m.k}:             ${(m.hitAtK * 100).toFixed(1)}%`,
    `  MRR@${m.k}:             ${(m.mrrAtK * 100).toFixed(1)}%`,
    `  NDCG@${m.k}:            ${(m.ndcgAtK * 100).toFixed(1)}%`,
    `  MAP@${m.k}:             ${(m.mapAtK * 100).toFixed(1)}%`,
    `  Precision@${m.k}:       ${(m.precisionAtK * 100).toFixed(1)}%`,
    `  Recall@${m.k}:          ${(m.recallAtK * 100).toFixed(1)}%`,
    `  F1@${m.k}:              ${(m.f1AtK * 100).toFixed(1)}%`,
    `  Hallucination Rate:  ${(m.hallucinationRate * 100).toFixed(1)}%`,
    "",
  ];

  if (report.regression) {
    const r = report.regression;
    lines.push("── Regression Gate ──");
    lines.push(`  Result: ${r.gateResult === "passed" ? "✅ PASSED" : "⛔ BLOCKED"}`);
    lines.push(`  Hit@K delta:           ${(r.deltas.hitAtKDelta * 100).toFixed(2)}%`);
    lines.push(`  MRR delta:             ${(r.deltas.mrrDelta * 100).toFixed(2)}%`);
    lines.push(`  NDCG delta:            ${(r.deltas.ndcgDelta * 100).toFixed(2)}%`);
    lines.push(`  Hallucination delta:   ${(r.deltas.hallucinationDelta * 100).toFixed(2)}%`);
    if (r.blockedReasons.length > 0) {
      lines.push("  Blocked reasons:");
      for (const reason of r.blockedReasons) {
        lines.push(`    - ${reason}`);
      }
    }
    lines.push("");
  }

  if (report.environment.vectorStoreProvider) {
    lines.push(`🔧 VectorStore: ${report.environment.vectorStoreProvider}`);
  }
  if (report.environment.retrieverName) {
    lines.push(`🔧 Retriever: ${report.environment.retrieverName}`);
  }

  return lines.join("\n");
}
