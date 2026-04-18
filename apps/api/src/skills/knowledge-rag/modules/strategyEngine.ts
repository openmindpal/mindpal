/**
 * strategyEngine.ts — 策略判定引擎增强
 *
 * 实现:
 *   - 查询意图分类器 (LLM/规则混合)
 *   - 知识库覆盖度预估
 *   - 两级路由 + 置信度灰区机制
 *   - 历史反馈闭环
 *
 * @module knowledge-rag/strategyEngine
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

// ─── 意图分类 ──────────────────────────────────────────────────

/** 查询意图类型 */
export type QueryIntent =
  | "factual"      // 事实型：具体事实查找
  | "analytical"   // 分析型：对比/趋势/综合分析
  | "verification" // 验证型：验证某个说法的准确性
  | "procedural"   // 过程型：操作步骤/方法
  | "exploratory"  // 探索型：开放式了解某个话题
  | "realtime";    // 实时型：需要最新信息

/** 意图分类结果 */
export interface IntentClassification {
  intent: QueryIntent;
  confidence: number;
  /** 次要意图（如果有） */
  secondaryIntent: QueryIntent | null;
  secondaryConfidence: number;
  /** 分类方式 */
  method: "rule" | "llm" | "hybrid";
  /** 查询复杂度 0-1 */
  complexity: number;
  /** 提取的关键实体 */
  entities: string[];
}

/** 规则集：关键词 → 意图映射 */
const INTENT_RULES: Array<{
  keywords: string[];
  intent: QueryIntent;
  weight: number;
}> = [
  // 事实型
  { keywords: ["是什么", "什么是", "定义", "含义", "解释", "谁是", "who is", "what is", "define"], intent: "factual", weight: 0.8 },
  // 分析型
  { keywords: ["对比", "比较", "区别", "差异", "优劣", "趋势", "统计", "综合", "分析", "为什么", "why", "compare", "analyze", "versus"], intent: "analytical", weight: 0.85 },
  // 验证型
  { keywords: ["验证", "确认", "是否", "对不对", "正确吗", "是真的吗", "verify", "confirm", "is it true"], intent: "verification", weight: 0.8 },
  // 过程型
  { keywords: ["怎么", "如何", "步骤", "方法", "操作", "流程", "教程", "how to", "step by step", "tutorial"], intent: "procedural", weight: 0.8 },
  // 实时型
  { keywords: ["最新", "今天", "当前", "现在", "real-time", "latest", "current", "today"], intent: "realtime", weight: 0.75 },
  // 探索型
  { keywords: ["了解", "介绍", "概述", "总结", "知道", "tell me about", "overview", "summary"], intent: "exploratory", weight: 0.6 },
];

/**
 * 基于规则的快速意图分类 (第一级)
 */
export function classifyIntentByRules(query: string): IntentClassification {
  const q = query.toLowerCase().trim();
  const scores = new Map<QueryIntent, number>();

  for (const rule of INTENT_RULES) {
    const matchCount = rule.keywords.filter(k => q.includes(k)).length;
    if (matchCount > 0) {
      const current = scores.get(rule.intent) ?? 0;
      scores.set(rule.intent, current + matchCount * rule.weight);
    }
  }

  // 查询复杂度计算
  const complexity = computeQueryComplexity(q);

  // 提取实体（简化版：提取引号内和大写词）
  const entities = extractEntities(query);

  if (scores.size === 0) {
    // 无匹配规则，根据长度推断
    if (q.length < 15) return { intent: "factual", confidence: 0.4, secondaryIntent: null, secondaryConfidence: 0, method: "rule", complexity, entities };
    if (q.length > 60) return { intent: "analytical", confidence: 0.35, secondaryIntent: "exploratory", secondaryConfidence: 0.3, method: "rule", complexity, entities };
    return { intent: "exploratory", confidence: 0.35, secondaryIntent: null, secondaryConfidence: 0, method: "rule", complexity, entities };
  }

  // 按分数排序
  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = sorted[0]!;
  const maxPossible = INTENT_RULES.filter(r => r.intent === topIntent).reduce((sum, r) => sum + r.keywords.length * r.weight, 0);
  const confidence = Math.min(0.95, topScore / Math.max(1, maxPossible) + 0.3);

  const second = sorted.length > 1 ? sorted[1]! : null;
  const secondMax = second ? INTENT_RULES.filter(r => r.intent === second[0]).reduce((sum, r) => sum + r.keywords.length * r.weight, 0) : 1;

  return {
    intent: topIntent,
    confidence: Math.round(confidence * 100) / 100,
    secondaryIntent: second ? second[0] : null,
    secondaryConfidence: second ? Math.round(Math.min(0.9, second[1] / Math.max(1, secondMax) + 0.2) * 100) / 100 : 0,
    method: "rule",
    complexity,
    entities,
  };
}

/**
 * 基于 LLM 的精确意图分类 (第二级)
 */
export async function classifyIntentByLLM(params: {
  app: FastifyInstance;
  query: string;
  authorization: string;
  traceId?: string;
}): Promise<IntentClassification> {
  try {
    const { invokeModelChat } = await import("../../../lib/llm");
    const result = await invokeModelChat({
      app: params.app,
      subject: { tenantId: "system", subjectId: "intent-classifier", spaceId: undefined },
      locale: "zh-CN",
      purpose: "query_intent_classification",
      authorization: params.authorization,
      traceId: params.traceId ?? null,
      messages: [
        {
          role: "system",
          content: `你是一个查询意图分类器。分析用户查询并输出 JSON：
{
  "intent": "factual|analytical|verification|procedural|exploratory|realtime",
  "confidence": 0.0-1.0,
  "secondary_intent": "...|null",
  "complexity": 0.0-1.0,
  "entities": ["entity1", "entity2"]
}
只输出 JSON，无其他内容。`,
        },
        { role: "user", content: params.query },
      ],
    });

    const text = typeof result?.outputText === "string" ? result.outputText.trim() : "";
    // 提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const validIntents: QueryIntent[] = ["factual", "analytical", "verification", "procedural", "exploratory", "realtime"];
      const intent = validIntents.includes(parsed.intent) ? parsed.intent : "factual";
      return {
        intent,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7))),
        secondaryIntent: validIntents.includes(parsed.secondary_intent) ? parsed.secondary_intent : null,
        secondaryConfidence: 0,
        method: "llm",
        complexity: Math.max(0, Math.min(1, Number(parsed.complexity ?? 0.5))),
        entities: Array.isArray(parsed.entities) ? parsed.entities.map(String).slice(0, 10) : [],
      };
    }
  } catch (e: any) {
    console.warn(`[StrategyEngine] LLM 意图分类失败: ${e?.message}`);
  }

  // 降级到规则分类
  return classifyIntentByRules(params.query);
}

/** 计算查询复杂度 (0-1) */
function computeQueryComplexity(query: string): number {
  let score = 0;
  const q = query.toLowerCase();

  // 长度因子
  score += Math.min(0.3, q.length / 200);

  // 多子句
  const clauses = q.split(/[,，;；。.!！?？]/).filter(s => s.trim().length > 2);
  score += Math.min(0.2, clauses.length * 0.05);

  // 逻辑词
  const logicWords = ["并且", "而且", "或者", "但是", "然而", "如果", "除非", "and", "or", "but", "however", "if"];
  score += Math.min(0.2, logicWords.filter(w => q.includes(w)).length * 0.05);

  // 问号数量
  score += Math.min(0.15, (q.match(/[?？]/g) ?? []).length * 0.05);

  // 比较词
  const compareWords = ["对比", "比较", "区别", "不同", "versus", "vs", "compare"];
  score += Math.min(0.15, compareWords.filter(w => q.includes(w)).length * 0.08);

  return Math.min(1, Math.round(score * 100) / 100);
}

/** 提取查询中的关键实体 */
function extractEntities(query: string): string[] {
  const entities: string[] = [];

  // 引号内容
  const quoted = query.match(/["'"'「」『』]([^"'"'「」『』]+)["'"'「」『』]/g);
  if (quoted) entities.push(...quoted.map(q => q.replace(/["'"'「」『』]/g, "").trim()));

  // 英文专有名词（连续大写开头词）
  const properNouns = query.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g);
  if (properNouns) entities.push(...properNouns);

  return [...new Set(entities)].slice(0, 10);
}

// ─── 知识库覆盖度预估 ───────────────────────────────────────────

/** 覆盖度评估结果 */
export interface CoverageEstimate {
  /** 预估覆盖度 0-1 */
  score: number;
  /** 评估方法 */
  method: "historical" | "sampling" | "heuristic";
  /** 置信度 */
  confidence: number;
  /** 建议 */
  suggestion: "sufficient" | "partial" | "low" | "unknown";
}

/**
 * 快速评估知识库对查询的覆盖能力
 */
export async function estimateCoverage(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  query: string;
}): Promise<CoverageEstimate> {
  try {
    // 方法1: 基于历史检索成功率
    const histRes = await params.pool.query(
      `SELECT
         COUNT(*)::int AS total,
         SUM(CASE WHEN returned_count > 0 AND NOT degraded THEN 1 ELSE 0 END)::int AS successful
       FROM knowledge_retrieval_logs
       WHERE tenant_id = $1 AND space_id = $2
         AND created_at > now() - interval '7 days'
       LIMIT 1`,
      [params.tenantId, params.spaceId],
    );
    const total = Number(histRes.rows[0]?.total ?? 0);
    const successful = Number(histRes.rows[0]?.successful ?? 0);

    if (total >= 10) {
      const successRate = successful / total;
      return {
        score: Math.round(successRate * 100) / 100,
        method: "historical",
        confidence: Math.min(0.9, total / 100),
        suggestion: successRate > 0.7 ? "sufficient" : successRate > 0.4 ? "partial" : "low",
      };
    }

    // 方法2: 简单采样 — 检查是否有相关文档
    const sampleRes = await params.pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM knowledge_chunks
       WHERE tenant_id = $1 AND space_id = $2
         AND snippet ILIKE '%' || $3 || '%'
       LIMIT 1`,
      [params.tenantId, params.spaceId, params.query.slice(0, 50)],
    );
    const sampleCount = Number(sampleRes.rows[0]?.cnt ?? 0);

    return {
      score: sampleCount > 5 ? 0.7 : sampleCount > 0 ? 0.4 : 0.1,
      method: "sampling",
      confidence: 0.4,
      suggestion: sampleCount > 5 ? "sufficient" : sampleCount > 0 ? "partial" : "low",
    };
  } catch {
    return { score: 0.5, method: "heuristic", confidence: 0.2, suggestion: "unknown" };
  }
}

// ─── 两级路由 + 灰区机制 ────────────────────────────────────────

/** 策略路由结果 */
export interface StrategyDecision {
  strategy: "simple" | "hybrid" | "agentic";
  confidence: number;
  intent: IntentClassification;
  coverage: CoverageEstimate | null;
  /** 路由级别 */
  routingLevel: "fast" | "precise";
  /** 是否经过灰区二次判定 */
  grayZoneEscalated: boolean;
  /** 决策理由 */
  reason: string;
}

/** 灰区置信度阈值 */
const GRAY_ZONE_LOW = 0.45;
const GRAY_ZONE_HIGH = 0.7;

/**
 * 增强版策略判定 — 两级路由 + 灰区机制
 *
 * 第一级 (fast): 规则分类 → 快速路由
 *   - 高置信度 → 直接决定
 *   - 灰区 → 升级到第二级
 * 第二级 (precise): LLM 分类 + 覆盖度预估 → 精确判定
 */
export async function determineStrategyEnhanced(params: {
  app: FastifyInstance;
  pool: Pool;
  tenantId: string;
  spaceId: string;
  query: string;
  authorization: string;
  traceId?: string;
  context?: {
    hasExternalSources?: boolean;
    requiresRealtime?: boolean;
    sensitiveData?: boolean;
  };
}): Promise<StrategyDecision> {
  // 强制规则
  if (params.context?.sensitiveData) {
    return {
      strategy: "agentic",
      confidence: 1,
      intent: classifyIntentByRules(params.query),
      coverage: null,
      routingLevel: "fast",
      grayZoneEscalated: false,
      reason: "sensitive_data_forced_agentic",
    };
  }

  // 第一级: 规则快速分类
  const ruleIntent = classifyIntentByRules(params.query);
  const fastStrategy = intentToStrategy(ruleIntent, params.context);

  // 高置信度 → 直接返回
  if (ruleIntent.confidence >= GRAY_ZONE_HIGH) {
    return {
      strategy: fastStrategy,
      confidence: ruleIntent.confidence,
      intent: ruleIntent,
      coverage: null,
      routingLevel: "fast",
      grayZoneEscalated: false,
      reason: `rule_high_confidence: ${ruleIntent.intent} (${ruleIntent.confidence})`,
    };
  }

  // 灰区: 升级到第二级
  if (ruleIntent.confidence < GRAY_ZONE_HIGH) {
    try {
      // 并行: LLM 意图分类 + 覆盖度预估
      const [llmIntent, coverage] = await Promise.all([
        ruleIntent.confidence < GRAY_ZONE_LOW
          ? classifyIntentByLLM({ app: params.app, query: params.query, authorization: params.authorization, traceId: params.traceId })
          : Promise.resolve(ruleIntent),
        estimateCoverage({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, query: params.query }),
      ]);

      // 综合判定
      const mergedIntent = llmIntent.confidence > ruleIntent.confidence ? llmIntent : ruleIntent;
      mergedIntent.method = "hybrid";

      let strategy = intentToStrategy(mergedIntent, params.context);

      // 覆盖度影响：覆盖不足时升级策略
      if (coverage.suggestion === "low" && strategy === "simple") {
        strategy = "hybrid";
      }
      if (coverage.suggestion === "low" && mergedIntent.complexity > 0.6) {
        strategy = "agentic";
      }

      return {
        strategy,
        confidence: mergedIntent.confidence,
        intent: mergedIntent,
        coverage,
        routingLevel: "precise",
        grayZoneEscalated: true,
        reason: `gray_zone_escalated: ${mergedIntent.intent} (${mergedIntent.confidence}), coverage=${coverage.score}`,
      };
    } catch (e: any) {
      console.warn(`[StrategyEngine] 二级判定失败: ${e?.message}`);
    }
  }

  // 降级：使用规则结果
  return {
    strategy: fastStrategy,
    confidence: ruleIntent.confidence,
    intent: ruleIntent,
    coverage: null,
    routingLevel: "fast",
    grayZoneEscalated: false,
    reason: `rule_fallback: ${ruleIntent.intent}`,
  };
}

/** 意图 → 策略映射 */
function intentToStrategy(
  intent: IntentClassification,
  context?: { hasExternalSources?: boolean; requiresRealtime?: boolean },
): "simple" | "hybrid" | "agentic" {
  if (context?.requiresRealtime) return "agentic";
  if (context?.hasExternalSources) return "hybrid";

  switch (intent.intent) {
    case "factual":
      return intent.complexity < 0.3 ? "simple" : "hybrid";
    case "procedural":
      return intent.complexity < 0.4 ? "simple" : "hybrid";
    case "analytical":
      return intent.complexity > 0.6 ? "agentic" : "hybrid";
    case "verification":
      return "agentic";
    case "realtime":
      return "agentic";
    case "exploratory":
      return intent.complexity > 0.5 ? "hybrid" : "simple";
    default:
      return "hybrid";
  }
}

// ─── 历史反馈闭环 ────────────────────────────────────────────────

/** 策略反馈记录 */
export interface StrategyFeedback {
  query: string;
  strategyUsed: string;
  intent: QueryIntent;
  intentConfidence: number;
  retrievalQuality: number;
  /** 用户满意度 (0-1, null=未反馈) */
  userSatisfaction: number | null;
  latencyMs: number;
}

/**
 * 记录策略判定结果和检索质量，用于持续优化
 */
export async function recordStrategyFeedback(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  feedback: StrategyFeedback;
}): Promise<void> {
  try {
    await params.pool.query(
      `INSERT INTO knowledge_retrieval_logs (
         tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
         rank_policy, strategy_ref, returned_count, degraded, degrade_reason
       ) VALUES ($1, $2, $3, $4, 0, '[]'::jsonb, $5, $6, $7, false, null)`,
      [
        params.tenantId,
        params.spaceId,
        JSON.stringify({
          queryHash: params.feedback.query.slice(0, 100),
          intent: params.feedback.intent,
          intentConfidence: params.feedback.intentConfidence,
          userSatisfaction: params.feedback.userSatisfaction,
        }),
        JSON.stringify({ source: "strategy_feedback" }),
        `strategy_${params.feedback.strategyUsed}`,
        `intent_${params.feedback.intent}`,
        Math.round(params.feedback.retrievalQuality * 100),
      ],
    );
  } catch (e: any) {
    console.warn(`[StrategyEngine] 反馈记录失败: ${e?.message}`);
  }
}

/**
 * 获取策略效果统计（用于阈值调优）
 */
export async function getStrategyStats(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  days?: number;
}): Promise<Array<{
  strategy: string;
  count: number;
  avgQuality: number;
  avgLatency: number;
}>> {
  const days = params.days ?? 30;
  try {
    const res = await params.pool.query(
      `SELECT
         strategy_ref AS strategy,
         COUNT(*)::int AS count,
         AVG(returned_count)::numeric(6,2) AS avg_quality,
         0 AS avg_latency
       FROM knowledge_retrieval_logs
       WHERE tenant_id = $1 AND space_id = $2
         AND strategy_ref LIKE 'intent_%'
         AND created_at > now() - ($3 || ' days')::interval
       GROUP BY strategy_ref
       ORDER BY count DESC`,
      [params.tenantId, params.spaceId, String(days)],
    );
    return (res.rows as any[]).map(r => ({
      strategy: String(r.strategy ?? ""),
      count: Number(r.count ?? 0),
      avgQuality: Number(r.avg_quality ?? 0),
      avgLatency: Number(r.avg_latency ?? 0),
    }));
  } catch {
    return [];
  }
}
