/**
 * advancedRetrieval.ts — 高级检索算法模块
 *
 * 实现:
 *   - HyDE (Hypothetical Document Embeddings) — 先LLM生成假设文档再检索
 *   - 上下文压缩 (Context Compression) — 检索后LLM提取关键片段
 *   - Ensemble 检索器 + RRF (Reciprocal Rank Fusion) — 多策略融合
 *   - 检索器注册表 (Retriever Registry) — 动态注册/组合
 *
 * @module knowledge-rag/advancedRetrieval
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:advancedRetrieval" });
import { searchChunksHybrid } from "./repo";

// ─── 通用类型 ──────────────────────────────────────────────────

/** 检索结果项 */
export interface RetrievalResultItem {
  chunkId: string;
  documentId: string;
  snippet: string;
  score: number;
  source: string;
  metadata?: Record<string, unknown>;
}

/** 检索器接口 */
export interface Retriever {
  readonly name: string;
  readonly kind: "lexical" | "dense" | "sparse" | "hyde" | "ensemble" | "custom";
  retrieve(params: RetrieverInput): Promise<RetrievalResultItem[]>;
}

/** 检索器输入 */
export interface RetrieverInput {
  pool: Pool;
  app: FastifyInstance;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  limit: number;
  authorization: string;
  traceId?: string;
  documentIds?: string[];
  tags?: string[];
  sourceTypes?: string[];
  /** 额外配置 */
  config?: Record<string, unknown>;
}

// ─── HyDE (Hypothetical Document Embeddings) ──────────────────

/** HyDE 配置 */
export interface HyDEConfig {
  enabled: boolean;
  /** LLM 生成假设文档的超时(ms) */
  llmTimeoutMs: number;
  /** 最大假设文档长度(字符) */
  maxHypDocLength: number;
  /** 仅对复杂查询启用 (字符长度阈值) */
  complexityThreshold: number;
  /** 生成假设文档的数量 */
  numHypotheses: number;
}

export const DEFAULT_HYDE_CONFIG: HyDEConfig = {
  enabled: true,
  llmTimeoutMs: 10000,
  maxHypDocLength: 1000,
  complexityThreshold: 10,
  numHypotheses: 1,
};

/**
 * HyDE 检索器 — 先让 LLM 生成一个假设性答案文档，再用该文档的内容作为检索查询
 *
 * 原理: 用户查询 → LLM 生成假设答案 → 用假设答案做向量检索 → 返回真实文档
 * 优势: 将"问题空间"映射到"文档空间"，提升复杂查询的召回率
 */
export class HyDERetriever implements Retriever {
  readonly name = "hyde";
  readonly kind = "hyde" as const;
  private readonly hydeConfig: HyDEConfig;

  constructor(config?: Partial<HyDEConfig>) {
    this.hydeConfig = { ...DEFAULT_HYDE_CONFIG, ...config };
  }

  async retrieve(params: RetrieverInput): Promise<RetrievalResultItem[]> {
    const cfg = this.hydeConfig;

    // 简短查询不启用 HyDE（直接走普通检索）
    if (!cfg.enabled || params.query.length < cfg.complexityThreshold) {
      return this.fallbackSearch(params);
    }

    // 生成假设文档
    let hypotheticalDoc: string;
    try {
      hypotheticalDoc = await generateHypotheticalDocument({
        app: params.app,
        query: params.query,
        authorization: params.authorization,
        traceId: params.traceId,
        maxLength: cfg.maxHypDocLength,
        timeoutMs: cfg.llmTimeoutMs,
      });
    } catch (e: any) {
      _logger.warn("HyDE LLM generation failed, fallback to raw query", { error: e?.message });
      return this.fallbackSearch(params);
    }

    if (!hypotheticalDoc || hypotheticalDoc.length < 10) {
      return this.fallbackSearch(params);
    }

    // 用假设文档作为检索查询
    const result = await searchChunksHybrid({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      query: hypotheticalDoc.slice(0, 2000),
      limit: params.limit,
      documentIds: params.documentIds,
      tags: params.tags,
      sourceTypes: params.sourceTypes,
    });

    return (result.hits ?? []).map((h: any) => ({
      chunkId: String(h.id ?? ""),
      documentId: String(h.document_id ?? ""),
      snippet: String(h.snippet ?? ""),
      score: Number(h._score ?? 0),
      source: "hyde",
      metadata: { hypotheticalDoc: hypotheticalDoc.slice(0, 200), rankReason: h.rank_reason },
    }));
  }

  private async fallbackSearch(params: RetrieverInput): Promise<RetrievalResultItem[]> {
    const result = await searchChunksHybrid({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      query: params.query,
      limit: params.limit,
      documentIds: params.documentIds,
      tags: params.tags,
      sourceTypes: params.sourceTypes,
    });
    return (result.hits ?? []).map((h: any) => ({
      chunkId: String(h.id ?? ""),
      documentId: String(h.document_id ?? ""),
      snippet: String(h.snippet ?? ""),
      score: Number(h._score ?? 0),
      source: "hybrid",
    }));
  }
}

/** 调用 LLM 生成假设性答案文档 */
async function generateHypotheticalDocument(params: {
  app: FastifyInstance;
  query: string;
  authorization: string;
  traceId?: string;
  maxLength: number;
  timeoutMs: number;
}): Promise<string> {
  const { invokeModelChat } = await import("../../../lib/llm");

  const result = await invokeModelChat({
    app: params.app,
    subject: { tenantId: "system", subjectId: "hyde-retriever", spaceId: undefined },
    locale: "zh-CN",
    purpose: "hyde_hypothetical_document",
    authorization: params.authorization,
    traceId: params.traceId ?? null,
    messages: [
      {
        role: "system",
        content: `你是一个知识检索辅助器。针对用户的问题，直接写出一段假设性的答案文档（仿佛你知道正确答案）。
要求：
1. 内容尽量具体、信息密集
2. 使用与该领域文档相似的术语和表达方式
3. 长度控制在 200-500 字
4. 不要加任何前缀/后缀说明，直接输出文档内容`,
      },
      { role: "user", content: params.query },
    ],
  });

  const text = typeof result?.outputText === "string" ? result.outputText.trim() : "";
  return text.slice(0, params.maxLength);
}

// ─── 上下文压缩 (Context Compression) ──────────────────────────

/** 上下文压缩配置 */
export interface ContextCompressionConfig {
  enabled: boolean;
  /** 压缩时保留的最大片段数 */
  maxExtractedFragments: number;
  /** 每个片段最大长度 */
  maxFragmentLength: number;
  /** LLM 压缩超时 */
  llmTimeoutMs: number;
}

export const DEFAULT_COMPRESSION_CONFIG: ContextCompressionConfig = {
  enabled: true,
  maxExtractedFragments: 5,
  maxFragmentLength: 500,
  llmTimeoutMs: 15000,
};

/**
 * 上下文压缩器 — 对检索结果调用 LLM 提取与查询最相关的片段
 *
 * 输入: query + 原始检索结果
 * 输出: 压缩后的精华片段列表
 */
export async function compressContext(params: {
  app: FastifyInstance;
  query: string;
  documents: Array<{ chunkId: string; snippet: string; score: number }>;
  authorization: string;
  traceId?: string;
  config?: Partial<ContextCompressionConfig>;
}): Promise<Array<{ chunkId: string; compressedSnippet: string; relevanceScore: number }>> {
  const cfg = { ...DEFAULT_COMPRESSION_CONFIG, ...params.config };

  if (!cfg.enabled || params.documents.length === 0) {
    return params.documents.map(d => ({
      chunkId: d.chunkId,
      compressedSnippet: d.snippet.slice(0, cfg.maxFragmentLength),
      relevanceScore: d.score,
    }));
  }

  // 构建待压缩的文档列表
  const docTexts = params.documents
    .slice(0, 15) // 限制输入量
    .map((d, i) => `[${i + 1}] (id=${d.chunkId}) ${d.snippet.slice(0, 800)}`)
    .join("\n\n");

  try {
    const { invokeModelChat } = await import("../../../lib/llm");
    const result = await invokeModelChat({
      app: params.app,
      subject: { tenantId: "system", subjectId: "context-compressor", spaceId: undefined },
      locale: "zh-CN",
      purpose: "context_compression",
      authorization: params.authorization,
      traceId: params.traceId ?? null,
      messages: [
        {
          role: "system",
          content: `你是一个文档压缩器。从以下检索结果中提取与查询最相关的关键信息片段。
输出格式（每行一条）：
[编号] relevance=0.xx | 压缩后的关键信息

要求：
1. 只保留与查询直接相关的信息
2. 去除冗余和重复内容
3. 保持原始含义不失真
4. 最多输出 ${cfg.maxExtractedFragments} 条
5. relevance 是 0-1 之间的相关度评分`,
        },
        {
          role: "user",
          content: `查询: ${params.query}\n\n检索结果:\n${docTexts}`,
        },
      ],
    });

    const text = typeof result?.outputText === "string" ? result.outputText : "";
    const lines = text.split("\n").filter((l: string) => l.trim().length > 0);

    const compressed: Array<{ chunkId: string; compressedSnippet: string; relevanceScore: number }> = [];
    for (const line of lines) {
      const match = line.match(/\[(\d+)\]\s*relevance\s*=\s*([\d.]+)\s*\|\s*(.+)/i);
      if (match) {
        const idx = parseInt(match[1]!, 10) - 1;
        const relevance = parseFloat(match[2]!);
        const snippet = match[3]!.trim().slice(0, cfg.maxFragmentLength);
        const doc = params.documents[idx];
        if (doc && snippet) {
          compressed.push({
            chunkId: doc.chunkId,
            compressedSnippet: snippet,
            relevanceScore: Number.isFinite(relevance) ? relevance : doc.score,
          });
        }
      }
    }

    if (compressed.length > 0) return compressed.slice(0, cfg.maxExtractedFragments);
    // LLM 输出格式不匹配，降级返回原始结果
  } catch (e: any) {
    _logger.warn("context compression LLM failed, fallback to raw results", { error: e?.message });
  }

  return params.documents.slice(0, cfg.maxExtractedFragments).map(d => ({
    chunkId: d.chunkId,
    compressedSnippet: d.snippet.slice(0, cfg.maxFragmentLength),
    relevanceScore: d.score,
  }));
}

// ─── Reciprocal Rank Fusion (RRF) ───────────────────────────────

/**
 * RRF 融合算法 — 将多个检索器的结果融合为统一排序
 *
 * 公式: RRF_score(d) = Σ 1/(k + rank_i(d))
 * 其中 k 通常取 60
 *
 * @param resultSets - 多个检索器的结果列表
 * @param k - RRF 常数 (default: 60)
 * @returns 融合后的排序结果
 */
export function reciprocalRankFusion(
  resultSets: Array<{ source: string; items: RetrievalResultItem[] }>,
  k = 60,
): RetrievalResultItem[] {
  const scoreMap = new Map<string, { item: RetrievalResultItem; rrfScore: number; sources: string[] }>();

  for (const { source, items } of resultSets) {
    for (let rank = 0; rank < items.length; rank++) {
      const item = items[rank]!;
      const key = item.chunkId || `${item.documentId}:${item.snippet.slice(0, 50)}`;
      const rrfContrib = 1 / (k + rank + 1);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.rrfScore += rrfContrib;
        existing.sources.push(source);
        // 保留最高原始分数
        if (item.score > existing.item.score) existing.item = item;
      } else {
        scoreMap.set(key, {
          item: { ...item },
          rrfScore: rrfContrib,
          sources: [source],
        });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore, sources }) => ({
      ...item,
      score: rrfScore,
      source: sources.join("+"),
      metadata: { ...item.metadata, rrfScore, fusionSources: sources },
    }));
}

// ─── Ensemble 检索器 ────────────────────────────────────────────

/** Ensemble 配置 */
export interface EnsembleConfig {
  /** 启用的检索器列表 */
  retrievers: string[];
  /** RRF k 参数 */
  rrfK: number;
  /** 每个检索器的最大结果数 */
  perRetrieverLimit: number;
  /** 并行执行 */
  parallel: boolean;
}

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  retrievers: ["hybrid", "hyde"],
  rrfK: 60,
  perRetrieverLimit: 30,
  parallel: true,
};

/**
 * Ensemble 检索器 — 组合多个检索策略，通过 RRF 融合结果
 */
export class EnsembleRetriever implements Retriever {
  readonly name = "ensemble";
  readonly kind = "ensemble" as const;
  private readonly ensembleConfig: EnsembleConfig;

  constructor(config?: Partial<EnsembleConfig>) {
    this.ensembleConfig = { ...DEFAULT_ENSEMBLE_CONFIG, ...config };
  }

  async retrieve(params: RetrieverInput): Promise<RetrievalResultItem[]> {
    const cfg = this.ensembleConfig;
    const retrieverNames = cfg.retrievers;
    const retrievers = retrieverNames
      .map(name => getRetriever(name))
      .filter((r): r is Retriever => r !== null);

    if (retrievers.length === 0) {
      // 无可用检索器，降级到 hybrid
      const hybrid = getRetriever("hybrid");
      if (hybrid) return hybrid.retrieve(params);
      return [];
    }

    const subParams = { ...params, limit: cfg.perRetrieverLimit };

    // 并行或串行执行各检索器
    let resultSets: Array<{ source: string; items: RetrievalResultItem[] }>;

    if (cfg.parallel) {
      const promises = retrievers.map(async (r) => {
        try {
          const items = await r.retrieve(subParams);
          return { source: r.name, items };
        } catch (e: any) {
          _logger.warn("ensemble retriever failed", { retriever: r.name, error: e?.message });
          return { source: r.name, items: [] };
        }
      });
      resultSets = await Promise.all(promises);
    } else {
      resultSets = [];
      for (const r of retrievers) {
        try {
          const items = await r.retrieve(subParams);
          resultSets.push({ source: r.name, items });
        } catch (e: any) {
          _logger.warn("ensemble retriever failed", { retriever: r.name, error: e?.message });
          resultSets.push({ source: r.name, items: [] });
        }
      }
    }

    // RRF 融合
    const fused = reciprocalRankFusion(resultSets, cfg.rrfK);
    return fused.slice(0, params.limit);
  }
}

// ─── 默认 Hybrid 检索器 (包装现有 searchChunksHybrid) ────────────

class HybridRetriever implements Retriever {
  readonly name = "hybrid";
  readonly kind = "dense" as const;

  async retrieve(params: RetrieverInput): Promise<RetrievalResultItem[]> {
    const result = await searchChunksHybrid({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      query: params.query,
      limit: params.limit,
      documentIds: params.documentIds,
      tags: params.tags,
      sourceTypes: params.sourceTypes,
    });
    return (result.hits ?? []).map((h: any) => ({
      chunkId: String(h.id ?? ""),
      documentId: String(h.document_id ?? ""),
      snippet: String(h.snippet ?? ""),
      score: Number(h._score ?? 0),
      source: "hybrid",
      metadata: { rankReason: h.rank_reason, stageStats: result.stageStats },
    }));
  }
}

// ─── 检索器注册表 ────────────────────────────────────────────────

const _retrieverRegistry = new Map<string, Retriever>();

/** 注册检索器 */
export function registerRetriever(retriever: Retriever): void {
  _retrieverRegistry.set(retriever.name, retriever);
}

/** 获取检索器 */
export function getRetriever(name: string): Retriever | null {
  return _retrieverRegistry.get(name) ?? null;
}

/** 列出所有已注册检索器 */
export function listRetrievers(): string[] {
  return Array.from(_retrieverRegistry.keys());
}

/** 移除检索器 */
export function unregisterRetriever(name: string): boolean {
  return _retrieverRegistry.delete(name);
}

// ─── 初始化内置检索器 ─────────────────────────────────────────────

registerRetriever(new HybridRetriever());
registerRetriever(new HyDERetriever());
registerRetriever(new EnsembleRetriever());

// ─── 从环境变量解析高级检索配置 ──────────────────────────────────

export function resolveAdvancedRetrievalConfigFromEnv(): {
  hydeConfig: Partial<HyDEConfig>;
  compressionConfig: Partial<ContextCompressionConfig>;
  ensembleConfig: Partial<EnsembleConfig>;
  defaultRetriever: string;
} {
  const hydeEnabled = String(process.env.KNOWLEDGE_HYDE_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const compressionEnabled = String(process.env.KNOWLEDGE_COMPRESSION_ENABLED ?? "false").trim().toLowerCase() === "true";
  const defaultRetriever = String(process.env.KNOWLEDGE_DEFAULT_RETRIEVER ?? "hybrid").trim();
  const ensembleRetrievers = String(process.env.KNOWLEDGE_ENSEMBLE_RETRIEVERS ?? "hybrid,hyde").trim().split(",").map(s => s.trim()).filter(Boolean);

  return {
    hydeConfig: {
      enabled: hydeEnabled,
      complexityThreshold: Math.max(5, Number(process.env.KNOWLEDGE_HYDE_COMPLEXITY_THRESHOLD ?? 10)),
    },
    compressionConfig: {
      enabled: compressionEnabled,
      maxExtractedFragments: Math.max(1, Number(process.env.KNOWLEDGE_COMPRESSION_MAX_FRAGMENTS ?? 5)),
    },
    ensembleConfig: {
      retrievers: ensembleRetrievers,
      rrfK: Math.max(1, Number(process.env.KNOWLEDGE_ENSEMBLE_RRF_K ?? 60)),
    },
    defaultRetriever,
  };
}

/**
 * 统一检索入口 — 根据配置选择检索策略执行
 */
export async function advancedRetrieve(params: RetrieverInput & {
  retrieverName?: string;
  enableCompression?: boolean;
}): Promise<{
  results: RetrievalResultItem[];
  compressed?: Array<{ chunkId: string; compressedSnippet: string; relevanceScore: number }>;
  retrieverUsed: string;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  const cfg = resolveAdvancedRetrievalConfigFromEnv();
  const retrieverName = params.retrieverName ?? cfg.defaultRetriever;

  // 获取检索器
  let retriever = getRetriever(retrieverName);
  if (!retriever) {
    _logger.warn("retriever not found, fallback to hybrid", { retrieverName });
    retriever = getRetriever("hybrid")!;
  }

  // 执行检索
  const results = await retriever.retrieve(params);

  // 可选：上下文压缩
  let compressed: Array<{ chunkId: string; compressedSnippet: string; relevanceScore: number }> | undefined;
  if (params.enableCompression ?? cfg.compressionConfig.enabled) {
    compressed = await compressContext({
      app: params.app,
      query: params.query,
      documents: results.map(r => ({ chunkId: r.chunkId, snippet: r.snippet, score: r.score })),
      authorization: params.authorization,
      traceId: params.traceId,
      config: cfg.compressionConfig,
    });
  }

  return {
    results,
    compressed,
    retrieverUsed: retriever.name,
    latencyMs: Date.now() - startedAt,
  };
}
