/**
 * multihopRetrieval.ts — 多跳推理检索引擎
 *
 * P2-2 实现:
 *   - P2-2a: 多跳检索引擎 (迭代推理)
 *   - P2-2b: 推理链路图构建 (DAG)
 *   - P2-2c: 多跳检索配置
 *   - P2-2d: 集成到 Agentic Search
 *
 * @module knowledge-rag/multihopRetrieval
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:multihopRetrieval" });
import { searchChunksHybrid } from "./repo";

// ─── 类型定义 ────────────────────────────────────────────────

/** 单跳证据 */
export interface HopEvidence {
  chunkId: string;
  documentId: string;
  snippet: string;
  score: number;
  /** 来源跳次 */
  hopIndex: number;
}

/** 单跳结果 */
export interface HopResult {
  hopIndex: number;
  query: string;
  evidences: HopEvidence[];
  /** LLM 提取的中间结论 */
  intermediateConclusion: string;
  /** LLM 生成的下一跳查询线索 */
  nextQueryHints: string[];
  /** 信息充分度评估 (0-1) */
  sufficiency: number;
  latencyMs: number;
}

/** 推理链路节点 */
export interface ReasoningNode {
  id: string;
  hopIndex: number;
  query: string;
  conclusion: string;
  evidenceIds: string[];
  /** 依赖的前序节点 */
  dependsOn: string[];
}

/** 推理链路 DAG */
export interface ReasoningGraph {
  nodes: ReasoningNode[];
  edges: Array<{ from: string; to: string; relation: "informs" | "refines" | "contradicts" }>;
  /** 最终综合结论 */
  finalConclusion: string | null;
  totalHops: number;
  totalEvidenceCount: number;
}

/** 多跳检索配置 */
export interface MultihopConfig {
  /** 最大跳数 */
  maxHops: number;
  /** 单跳超时 (ms) */
  perHopTimeoutMs: number;
  /** 总超时 (ms) */
  totalTimeoutMs: number;
  /** 信息充分度阈值 — 超过此值停止 */
  sufficiencyThreshold: number;
  /** 是否允许跨 space 检索 */
  allowCrossSpace: boolean;
  /** 每跳最大结果数 */
  perHopLimit: number;
}

export const DEFAULT_MULTIHOP_CONFIG: MultihopConfig = {
  maxHops: 3,
  perHopTimeoutMs: 10000,
  totalTimeoutMs: 30000,
  sufficiencyThreshold: 0.8,
  allowCrossSpace: false,
  perHopLimit: 5,
};

/** 多跳检索结果 */
export interface MultihopResult {
  hops: HopResult[];
  graph: ReasoningGraph;
  allEvidences: HopEvidence[];
  /** 是否达到信息充分 */
  sufficient: boolean;
  /** 终止原因 */
  terminationReason: "sufficient" | "max_hops" | "timeout" | "no_new_evidence" | "error";
  totalLatencyMs: number;
}

// ─── 核心引擎 ────────────────────────────────────────────────

/**
 * P2-2a: 多跳检索引擎
 *
 * 流程:
 *   1. 第一跳：原始查询 → 检索初始证据
 *   2. LLM 分析证据 → 提取中间结论 + 下一跳查询线索
 *   3. 评估信息充分度
 *   4. 如不充分，用线索构建下一跳查询，重复 1-3
 *   5. 达到充分或最大跳数后，构建推理链路图
 */
export async function multihopRetrieve(params: {
  app: FastifyInstance;
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  authorization: string;
  traceId?: string;
  config?: Partial<MultihopConfig>;
}): Promise<MultihopResult> {
  const cfg = { ...DEFAULT_MULTIHOP_CONFIG, ...params.config };
  const totalStart = Date.now();
  const hops: HopResult[] = [];
  const allEvidences: HopEvidence[] = [];
  const seenChunkIds = new Set<string>();
  let currentQuery = params.query;
  let terminationReason: MultihopResult["terminationReason"] = "max_hops";

  for (let hopIdx = 0; hopIdx < cfg.maxHops; hopIdx++) {
    // 超时检查
    if (Date.now() - totalStart > cfg.totalTimeoutMs) {
      terminationReason = "timeout";
      break;
    }

    const hopStart = Date.now();

    try {
      // Step 1: 检索
      const searchResult = await searchChunksHybrid({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        query: currentQuery,
        limit: cfg.perHopLimit,
      });

      const hits = searchResult.hits ?? [];
      const newEvidences: HopEvidence[] = [];

      for (const hit of hits) {
        const chunkId = String(hit.chunk_id ?? hit.chunkId ?? "");
        if (seenChunkIds.has(chunkId)) continue;
        seenChunkIds.add(chunkId);

        newEvidences.push({
          chunkId,
          documentId: String((hit as any).sourceRef?.documentId ?? (hit as any).document_id ?? ""),
          snippet: String(hit.snippet ?? "").slice(0, 500),
          score: Number(hit.score ?? 0),
          hopIndex: hopIdx,
        });
      }

      if (newEvidences.length === 0 && hopIdx > 0) {
        terminationReason = "no_new_evidence";
        break;
      }

      allEvidences.push(...newEvidences);

      // Step 2: LLM 分析证据
      const analysis = await analyzeHopEvidences({
        app: params.app,
        query: params.query,
        currentQuery,
        evidences: newEvidences,
        previousConclusions: hops.map(h => h.intermediateConclusion),
        authorization: params.authorization,
        traceId: params.traceId,
      });

      const hopResult: HopResult = {
        hopIndex: hopIdx,
        query: currentQuery,
        evidences: newEvidences,
        intermediateConclusion: analysis.conclusion,
        nextQueryHints: analysis.nextQueryHints,
        sufficiency: analysis.sufficiency,
        latencyMs: Date.now() - hopStart,
      };
      hops.push(hopResult);

      // Step 3: 检查充分度
      if (analysis.sufficiency >= cfg.sufficiencyThreshold) {
        terminationReason = "sufficient";
        break;
      }

      // Step 4: 构建下一跳查询
      if (analysis.nextQueryHints.length > 0) {
        currentQuery = analysis.nextQueryHints[0]!;
      } else {
        terminationReason = "no_new_evidence";
        break;
      }
    } catch (e: any) {
      _logger.warn("multihop hop failed", { hopIdx, error: e?.message });
      terminationReason = "error";
      break;
    }
  }

  // Step 5: 构建推理链路图
  const graph = buildReasoningGraph(hops, params.query);

  return {
    hops,
    graph,
    allEvidences,
    sufficient: terminationReason === "sufficient",
    terminationReason,
    totalLatencyMs: Date.now() - totalStart,
  };
}

// ─── LLM 证据分析 ────────────────────────────────────────────

async function analyzeHopEvidences(params: {
  app: FastifyInstance;
  query: string;
  currentQuery: string;
  evidences: HopEvidence[];
  previousConclusions: string[];
  authorization: string;
  traceId?: string;
}): Promise<{
  conclusion: string;
  nextQueryHints: string[];
  sufficiency: number;
}> {
  try {
    const { invokeModelChat } = await import("../../../lib/llm");

    const evidenceText = params.evidences
      .map((e, i) => `[${i + 1}] ${e.snippet}`)
      .join("\n---\n");

    const prevText = params.previousConclusions.length > 0
      ? "已有中间结论:\n" + params.previousConclusions.map((c, i) => "- Hop" + i + ": " + c).join("\n") + "\n\n"
      : "";

    const result = await invokeModelChat({
      app: params.app,
      subject: { tenantId: "system", subjectId: "multihop-analyzer", spaceId: undefined },
      locale: "zh-CN",
      purpose: "multihop_evidence_analysis",
      authorization: params.authorization,
      traceId: params.traceId ?? null,
      messages: [
        {
          role: "system",
          content: [
            "你是一个多跳推理分析器。分析检索到的证据，提取关键信息。",
            "",
            '输出 JSON：',
            '{',
            '  "conclusion": "基于当前证据的中间结论",',
            '  "nextQueryHints": ["下一步应该查询的问题1", "问题2"],',
            '  "sufficiency": 0.0-1.0',
            '}',
            "",
            "sufficiency 说明:",
            "- 1.0 = 信息完全充分，已能回答原始问题",
            "- 0.5 = 有部分信息，但还需补充",
            "- 0.0 = 完全没有相关信息",
            "",
            "如果信息已充分，nextQueryHints 可以为空数组。",
            "只输出 JSON，无其他内容。",
          ].join("\n"),
        },
        {
          role: "user",
          content: "原始问题: " + params.query + "\n当前检索查询: " + params.currentQuery + "\n\n" + prevText + "新检索到的证据:\n" + evidenceText,
        },
      ],
    });

    const text = typeof result?.outputText === "string" ? result.outputText.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        conclusion: String(parsed.conclusion ?? ""),
        nextQueryHints: Array.isArray(parsed.nextQueryHints)
          ? parsed.nextQueryHints.map(String).filter((s: string) => s.length > 0).slice(0, 3)
          : [],
        sufficiency: Math.max(0, Math.min(1, Number(parsed.sufficiency ?? 0.5))),
      };
    }
  } catch (e: any) {
    _logger.warn("multihop LLM analysis failed", { error: e?.message });
  }

  // 降级：简单启发式
  return {
    conclusion: params.evidences.map(e => e.snippet.slice(0, 100)).join("; "),
    nextQueryHints: [],
    sufficiency: params.evidences.length > 3 ? 0.7 : 0.3,
  };
}

// ─── P2-2b: 推理链路图构建 ────────────────────────────────────

/**
 * 构建推理链路 DAG
 */
function buildReasoningGraph(hops: HopResult[], originalQuery: string): ReasoningGraph {
  const nodes: ReasoningNode[] = [];
  const edges: ReasoningGraph["edges"] = [];

  for (const hop of hops) {
    const nodeId = `hop_${hop.hopIndex}`;
    nodes.push({
      id: nodeId,
      hopIndex: hop.hopIndex,
      query: hop.query,
      conclusion: hop.intermediateConclusion,
      evidenceIds: hop.evidences.map(e => e.chunkId),
      dependsOn: hop.hopIndex > 0 ? [`hop_${hop.hopIndex - 1}`] : [],
    });

    if (hop.hopIndex > 0) {
      edges.push({
        from: `hop_${hop.hopIndex - 1}`,
        to: nodeId,
        relation: "informs",
      });
    }
  }

  // 综合最终结论
  const finalConclusion = hops.length > 0
    ? hops[hops.length - 1]!.intermediateConclusion
    : null;

  return {
    nodes,
    edges,
    finalConclusion,
    totalHops: hops.length,
    totalEvidenceCount: hops.reduce((sum, h) => sum + h.evidences.length, 0),
  };
}

// ─── P2-2c: 配置解析 ────────────────────────────────────────

/**
 * 从环境变量解析多跳检索配置
 */
export function resolveMultihopConfigFromEnv(): MultihopConfig {
  return {
    maxHops: Math.max(1, Math.min(10, Number(process.env.MULTIHOP_MAX_HOPS ?? 3))),
    perHopTimeoutMs: Math.max(1000, Number(process.env.MULTIHOP_PER_HOP_TIMEOUT_MS ?? 10000)),
    totalTimeoutMs: Math.max(5000, Number(process.env.MULTIHOP_TOTAL_TIMEOUT_MS ?? 30000)),
    sufficiencyThreshold: Math.max(0.1, Math.min(1, Number(process.env.MULTIHOP_SUFFICIENCY_THRESHOLD ?? 0.8))),
    allowCrossSpace: process.env.MULTIHOP_ALLOW_CROSS_SPACE === "1",
    perHopLimit: Math.max(1, Number(process.env.MULTIHOP_PER_HOP_LIMIT ?? 5)),
  };
}

/**
 * P2-2d: 判断查询是否需要多跳检索
 */
export function shouldUseMultihop(params: {
  query: string;
  complexity?: number;
  intent?: string;
}): boolean {
  const q = params.query.toLowerCase();

  // 复杂度高的查询
  if (params.complexity != null && params.complexity > 0.7) return true;

  // 分析型或验证型意图
  if (params.intent === "analytical" || params.intent === "verification") return true;

  // 多实体关联查询
  const multiEntityPatterns = [
    /(.+)和(.+)的关系/,
    /(.+)如何影响(.+)/,
    /(.+)依赖(.+)/,
    /(.+) and (.+) relationship/i,
    /how does (.+) affect (.+)/i,
    /compare (.+) with (.+)/i,
  ];
  if (multiEntityPatterns.some(p => p.test(q))) return true;

  // 多步推理关键词
  const multiHopKeywords = ["因此", "所以", "导致", "进而", "最终", "根本原因", "间接", "连锁",
    "therefore", "consequently", "root cause", "indirect", "chain"];
  if (multiHopKeywords.some(kw => q.includes(kw))) return true;

  return false;
}
