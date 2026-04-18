/**
 * localRerank.ts — 本地轻量级 Rerank 模块
 *
 * P2-3 实现:
 *   - P2-3a: 基于规则的轻量级重排器 (BM25 + 余弦 + 覆盖率 + 新鲜度 + 位置权重)
 *   - P2-3b: 轻量级 Cross-Encoder 接口 (支持本地模型加载)
 *   - P2-3c: Rerank 级联降级策略 (外部 API → Cross-Encoder → 规则重排器)
 *   - P2-3d: Rerank 配置扩展 (fallback_mode / 本地模型路径)
 *
 * @module knowledge-rag/localRerank
 */

import type { Pool } from "pg";
import type { RerankConfig, RerankResult } from "./rerank";
import { rerank as externalRerank } from "./rerank";

// ═══════════════════════════════════════════════════════════════
//  P2-3a: 基于规则的轻量级重排器
// ═══════════════════════════════════════════════════════════════

/** 规则重排器的文档输入 */
export interface RuleRerankDocument {
  /** 文档文本 */
  text: string;
  /** 原始排序索引 */
  originalIndex: number;
  /** embedding 向量 (可选, 用于余弦相似度) */
  embedding?: number[];
  /** 文档创建时间 (可选, 用于新鲜度) */
  createdAt?: Date | string | number;
  /** 文档在原始检索中的位置分数 (可选) */
  positionScore?: number;
}

/** 规则重排器配置 */
export interface RuleRerankConfig {
  /** BM25 权重 */
  bm25Weight: number;
  /** 余弦相似度权重 */
  cosineWeight: number;
  /** 查询词覆盖率权重 */
  coverageWeight: number;
  /** 新鲜度权重 */
  freshnessWeight: number;
  /** 位置权重 (原始排序位置) */
  positionWeight: number;
  /** BM25 参数 k1 */
  bm25K1: number;
  /** BM25 参数 b */
  bm25B: number;
}

export const DEFAULT_RULE_RERANK_CONFIG: RuleRerankConfig = {
  bm25Weight: 0.35,
  cosineWeight: 0.25,
  coverageWeight: 0.20,
  freshnessWeight: 0.10,
  positionWeight: 0.10,
  bm25K1: 1.5,
  bm25B: 0.75,
};

/**
 * 计算 BM25 分数
 *
 * BM25(D, Q) = Σ IDF(qi) * (f(qi,D) * (k1+1)) / (f(qi,D) + k1 * (1 - b + b * |D|/avgdl))
 */
function computeBM25(params: {
  query: string;
  document: string;
  avgDocLen: number;
  k1: number;
  b: number;
  totalDocs: number;
  termDocFreqs: Map<string, number>;
}): number {
  const queryTerms = tokenize(params.query);
  const docTerms = tokenize(params.document);
  const docLen = docTerms.length;
  if (docLen === 0 || queryTerms.length === 0) return 0;

  const termFreqs = new Map<string, number>();
  for (const t of docTerms) {
    termFreqs.set(t, (termFreqs.get(t) ?? 0) + 1);
  }

  let score = 0;
  for (const qt of queryTerms) {
    const tf = termFreqs.get(qt) ?? 0;
    if (tf === 0) continue;

    const df = params.termDocFreqs.get(qt) ?? 0;
    // IDF = ln((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((params.totalDocs - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (params.k1 + 1)) / (tf + params.k1 * (1 - params.b + params.b * docLen / params.avgDocLen));
    score += idf * tfNorm;
  }

  return score;
}

/**
 * 计算余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 计算查询词覆盖率
 */
function queryCoverage(query: string, document: string): number {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return 0;
  const docTerms = new Set(tokenize(document));
  let covered = 0;
  for (const qt of queryTerms) {
    if (docTerms.has(qt)) covered++;
  }
  return covered / queryTerms.size;
}

/**
 * 计算新鲜度分数 (0-1)
 * 越新的文档分数越高
 */
function freshnessScore(createdAt?: Date | string | number): number {
  if (createdAt == null) return 0.5; // 未知时间给中间值
  const ts = typeof createdAt === "number"
    ? createdAt
    : typeof createdAt === "string"
      ? Date.parse(createdAt)
      : createdAt.getTime();
  if (!Number.isFinite(ts)) return 0.5;
  const ageMs = Math.max(0, Date.now() - ts);
  // 衰减函数: 1/(1 + age/30天)
  return 1 / (1 + ageMs / (30 * 24 * 60 * 60 * 1000));
}

/**
 * 简易分词 (支持中英文)
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(t => t.length > 0);
}

/**
 * P2-3a: 基于规则的轻量级重排器
 *
 * 综合 BM25 分数 + embedding 余弦相似度 + 查询词覆盖率 + 文档新鲜度 + 位置权重
 */
export function ruleBasedRerank(params: {
  query: string;
  documents: RuleRerankDocument[];
  queryEmbedding?: number[];
  config?: Partial<RuleRerankConfig>;
}): RerankResult {
  const startedAt = Date.now();
  const cfg = { ...DEFAULT_RULE_RERANK_CONFIG, ...params.config };

  if (params.documents.length === 0) {
    return { reranked: true, items: [], degraded: false, degradeReason: null, latencyMs: 0 };
  }

  // 预计算 BM25 所需的全局统计
  const totalDocs = params.documents.length;
  const docTexts = params.documents.map(d => d.text);
  const docTokenLengths = docTexts.map(t => tokenize(t).length);
  const avgDocLen = docTokenLengths.reduce((a, b) => a + b, 0) / totalDocs;

  // 计算 term-document frequencies
  const termDocFreqs = new Map<string, number>();
  for (const text of docTexts) {
    const uniqueTerms = new Set(tokenize(text));
    for (const t of uniqueTerms) {
      termDocFreqs.set(t, (termDocFreqs.get(t) ?? 0) + 1);
    }
  }

  // 对每个文档计算综合分数
  const scored = params.documents.map((doc, idx) => {
    // BM25
    const bm25 = computeBM25({
      query: params.query,
      document: doc.text,
      avgDocLen,
      k1: cfg.bm25K1,
      b: cfg.bm25B,
      totalDocs,
      termDocFreqs,
    });

    // 余弦相似度
    let cosine = 0;
    if (params.queryEmbedding && doc.embedding) {
      cosine = cosineSimilarity(params.queryEmbedding, doc.embedding);
    }

    // 覆盖率
    const coverage = queryCoverage(params.query, doc.text);

    // 新鲜度
    const freshness = freshnessScore(doc.createdAt);

    // 位置分数 (原始位置越靠前分数越高)
    const position = doc.positionScore ?? (1 / (1 + idx));

    // 加权综合
    const score = bm25 * cfg.bm25Weight
      + cosine * cfg.cosineWeight
      + coverage * cfg.coverageWeight
      + freshness * cfg.freshnessWeight
      + position * cfg.positionWeight;

    return { originalIndex: doc.originalIndex, score };
  });

  // 按分数降序排序
  scored.sort((a, b) => b.score - a.score);

  return {
    reranked: true,
    items: scored,
    degraded: false,
    degradeReason: null,
    latencyMs: Date.now() - startedAt,
  };
}

// ═══════════════════════════════════════════════════════════════
//  P2-3b: 轻量级 Cross-Encoder 接口
// ═══════════════════════════════════════════════════════════════

/** Cross-Encoder 模型接口 */
export interface CrossEncoderModel {
  /** 模型名称 */
  readonly name: string;
  /** 模型是否已加载 */
  readonly loaded: boolean;
  /**
   * 加载模型
   * @returns true 如果加载成功
   */
  load(): Promise<boolean>;
  /**
   * 对 query-document 对进行打分
   * @returns 每对的相关性分数 (0-1)
   */
  predict(pairs: Array<{ query: string; document: string }>): Promise<number[]>;
  /** 卸载模型释放资源 */
  unload(): Promise<void>;
}

/** Cross-Encoder 配置 */
export interface CrossEncoderConfig {
  /** 模型路径或标识 */
  modelPath: string;
  /** 模型类型 */
  modelType: "onnx" | "http_local" | "mock";
  /** 批大小 */
  batchSize: number;
  /** 单次推理超时 (ms) */
  timeoutMs: number;
  /** 最大输入长度 (tokens) */
  maxInputLength: number;
}

export const DEFAULT_CROSS_ENCODER_CONFIG: CrossEncoderConfig = {
  modelPath: "",
  modelType: "mock",
  batchSize: 32,
  timeoutMs: 5000,
  maxInputLength: 512,
};

/**
 * HTTP 本地 Cross-Encoder 实现
 *
 * 通过本地 HTTP 服务 (如 FastAPI + sentence-transformers) 进行推理
 * 请求格式: POST /predict { pairs: [{query, document}] }
 * 响应格式: { scores: number[] }
 */
export class HttpLocalCrossEncoder implements CrossEncoderModel {
  readonly name: string;
  private _loaded = false;
  private readonly endpoint: string;
  private readonly cfg: CrossEncoderConfig;

  constructor(config: CrossEncoderConfig) {
    this.cfg = config;
    this.endpoint = config.modelPath.replace(/\/$/, "");
    this.name = `http_local:${this.endpoint}`;
  }

  get loaded() { return this._loaded; }

  async load(): Promise<boolean> {
    try {
      const res = await fetch(this.endpoint + "/health", {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      } as any);
      this._loaded = res.ok;
      return this._loaded;
    } catch {
      this._loaded = false;
      return false;
    }
  }

  async predict(pairs: Array<{ query: string; document: string }>): Promise<number[]> {
    if (!this._loaded) {
      const ok = await this.load();
      if (!ok) throw new Error("Cross-Encoder model not available");
    }

    const results: number[] = [];
    for (let i = 0; i < pairs.length; i += this.cfg.batchSize) {
      const batch = pairs.slice(i, i + this.cfg.batchSize);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(this.endpoint + "/predict", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairs: batch.map(p => ({
              query: p.query.slice(0, this.cfg.maxInputLength),
              document: p.document.slice(0, this.cfg.maxInputLength),
            })),
          }),
          signal: controller.signal,
        } as any);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as any;
        const scores = Array.isArray(json?.scores) ? json.scores : [];
        for (let j = 0; j < batch.length; j++) {
          results.push(Number(scores[j] ?? 0));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  async unload(): Promise<void> {
    this._loaded = false;
  }
}

/**
 * Mock Cross-Encoder (用于测试和未配置模型时)
 * 使用简单的词汇重叠启发式模拟 Cross-Encoder 打分
 */
export class MockCrossEncoder implements CrossEncoderModel {
  readonly name = "mock_cross_encoder";
  private _loaded = false;

  get loaded() { return this._loaded; }

  async load(): Promise<boolean> {
    this._loaded = true;
    return true;
  }

  async predict(pairs: Array<{ query: string; document: string }>): Promise<number[]> {
    return pairs.map(p => {
      // 基于词汇重叠的简单打分
      const qTerms = new Set(tokenize(p.query));
      const dTerms = new Set(tokenize(p.document));
      if (qTerms.size === 0) return 0;
      let overlap = 0;
      for (const qt of qTerms) {
        if (dTerms.has(qt)) overlap++;
      }
      // 归一化到 0-1
      return overlap / qTerms.size;
    });
  }

  async unload(): Promise<void> {
    this._loaded = false;
  }
}

/**
 * 使用 Cross-Encoder 进行重排
 */
export async function crossEncoderRerank(params: {
  query: string;
  documents: string[];
  model: CrossEncoderModel;
}): Promise<RerankResult> {
  const startedAt = Date.now();

  if (params.documents.length === 0) {
    return { reranked: true, items: [], degraded: false, degradeReason: null, latencyMs: 0 };
  }

  try {
    const pairs = params.documents.map(doc => ({ query: params.query, document: doc }));
    const scores = await params.model.predict(pairs);

    const items = scores.map((score, idx) => ({
      originalIndex: idx,
      score: Math.max(0, Math.min(1, score)),
    }));
    items.sort((a, b) => b.score - a.score);

    return {
      reranked: true,
      items,
      degraded: false,
      degradeReason: null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (e: any) {
    console.warn(`[localRerank] Cross-Encoder rerank failed: ${e?.message}`);
    return {
      reranked: false,
      items: params.documents.map((_, i) => ({ originalIndex: i, score: 0 })),
      degraded: true,
      degradeReason: `cross_encoder_error: ${e?.message ?? e}`,
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
//  P2-3c: Rerank 级联降级策略
// ═══════════════════════════════════════════════════════════════

/** 级联降级模式 */
export type RerankFallbackMode = "external_only" | "cross_encoder" | "rule" | "cross_encoder_then_rule" | "none";

/** 级联重排配置 */
export interface CascadeRerankConfig {
  /** 降级模式 */
  fallbackMode: RerankFallbackMode;
  /** 外部 Rerank 配置 (null = 不使用外部) */
  externalConfig: RerankConfig | null;
  /** Cross-Encoder 模型实例 (null = 不使用) */
  crossEncoderModel: CrossEncoderModel | null;
  /** 规则重排器配置 */
  ruleConfig: Partial<RuleRerankConfig>;
  /** 规则重排器的文档元数据 (可选) */
  documentMetadata?: RuleRerankDocument[];
  /** 查询 embedding (可选, 供规则重排器使用) */
  queryEmbedding?: number[];
}

/**
 * P2-3c: 级联降级重排
 *
 * 降级链:
 *   外部 Rerank API → 本地 Cross-Encoder → 规则重排器
 *
 * 每级失败时自动降级到下一级，记录降级原因。
 */
export async function cascadeRerank(params: {
  query: string;
  documents: string[];
  config: CascadeRerankConfig;
}): Promise<RerankResult & { cascadeLevel: "external" | "cross_encoder" | "rule" | "none" }> {
  const startedAt = Date.now();
  const { config } = params;

  if (params.documents.length === 0) {
    return {
      reranked: true,
      items: [],
      degraded: false,
      degradeReason: null,
      latencyMs: 0,
      cascadeLevel: "none",
    };
  }

  const degradeReasons: string[] = [];

  // Level 1: 外部 Rerank API
  if (config.externalConfig && config.fallbackMode !== "rule" && config.fallbackMode !== "cross_encoder") {
    try {
      const result = await externalRerank({
        config: config.externalConfig,
        query: params.query,
        documents: params.documents,
      });
      if (result.reranked && !result.degraded) {
        return { ...result, cascadeLevel: "external" };
      }
      degradeReasons.push(`external: ${result.degradeReason ?? "failed"}`);
    } catch (e: any) {
      degradeReasons.push(`external: ${e?.message ?? "unknown_error"}`);
    }
  }

  // Level 2: Cross-Encoder
  if (config.crossEncoderModel && config.fallbackMode !== "rule" && config.fallbackMode !== "external_only") {
    try {
      const result = await crossEncoderRerank({
        query: params.query,
        documents: params.documents,
        model: config.crossEncoderModel,
      });
      if (result.reranked && !result.degraded) {
        const totalDegradeReason = degradeReasons.length > 0
          ? `cascade_to_cross_encoder [${degradeReasons.join("; ")}]`
          : null;
        return {
          ...result,
          degraded: degradeReasons.length > 0,
          degradeReason: totalDegradeReason,
          cascadeLevel: "cross_encoder",
        };
      }
      degradeReasons.push(`cross_encoder: ${result.degradeReason ?? "failed"}`);
    } catch (e: any) {
      degradeReasons.push(`cross_encoder: ${e?.message ?? "unknown_error"}`);
    }
  }

  // Level 3: 规则重排器
  if (config.fallbackMode !== "external_only" && config.fallbackMode !== "none") {
    const ruleDocs: RuleRerankDocument[] = config.documentMetadata
      ?? params.documents.map((text, i) => ({ text, originalIndex: i }));
    const result = ruleBasedRerank({
      query: params.query,
      documents: ruleDocs,
      queryEmbedding: config.queryEmbedding,
      config: config.ruleConfig,
    });
    const totalDegradeReason = degradeReasons.length > 0
      ? `cascade_to_rule [${degradeReasons.join("; ")}]`
      : null;
    return {
      ...result,
      degraded: degradeReasons.length > 0,
      degradeReason: totalDegradeReason,
      cascadeLevel: "rule",
      latencyMs: Date.now() - startedAt,
    };
  }

  // 所有级别都跳过或失败
  return {
    reranked: false,
    items: params.documents.map((_, i) => ({ originalIndex: i, score: 0 })),
    degraded: true,
    degradeReason: `all_levels_failed [${degradeReasons.join("; ")}]`,
    latencyMs: Date.now() - startedAt,
    cascadeLevel: "none",
  };
}

// ═══════════════════════════════════════════════════════════════
//  P2-3d: Rerank 配置扩展
// ═══════════════════════════════════════════════════════════════

/** 扩展的 Rerank 配置 (包含降级和本地模型) */
export interface ExtendedRerankConfig {
  /** 降级模式 */
  fallbackMode: RerankFallbackMode;
  /** 本地 Cross-Encoder 模型路径 */
  crossEncoderModelPath: string | null;
  /** 本地 Cross-Encoder 模型类型 */
  crossEncoderModelType: CrossEncoderConfig["modelType"];
  /** Cross-Encoder 批大小 */
  crossEncoderBatchSize: number;
  /** Cross-Encoder 超时 (ms) */
  crossEncoderTimeoutMs: number;
  /** 规则重排器权重配置 */
  ruleWeights: Partial<RuleRerankConfig>;
}

export const DEFAULT_EXTENDED_RERANK_CONFIG: ExtendedRerankConfig = {
  fallbackMode: "cross_encoder_then_rule",
  crossEncoderModelPath: null,
  crossEncoderModelType: "mock",
  crossEncoderBatchSize: 32,
  crossEncoderTimeoutMs: 5000,
  ruleWeights: {},
};

/**
 * 从环境变量解析扩展 Rerank 配置
 */
export function resolveExtendedRerankConfigFromEnv(): ExtendedRerankConfig {
  const modeRaw = String(process.env.KNOWLEDGE_RERANK_FALLBACK_MODE ?? "cross_encoder_then_rule").trim();
  const validModes: RerankFallbackMode[] = ["external_only", "cross_encoder", "rule", "cross_encoder_then_rule", "none"];
  const fallbackMode: RerankFallbackMode = validModes.includes(modeRaw as any) ? (modeRaw as RerankFallbackMode) : "cross_encoder_then_rule";

  return {
    fallbackMode,
    crossEncoderModelPath: String(process.env.KNOWLEDGE_CROSS_ENCODER_MODEL_PATH ?? "").trim() || null,
    crossEncoderModelType: (process.env.KNOWLEDGE_CROSS_ENCODER_MODEL_TYPE as any) ?? "mock",
    crossEncoderBatchSize: Math.max(1, Number(process.env.KNOWLEDGE_CROSS_ENCODER_BATCH_SIZE ?? 32)),
    crossEncoderTimeoutMs: Math.max(1000, Number(process.env.KNOWLEDGE_CROSS_ENCODER_TIMEOUT_MS ?? 5000)),
    ruleWeights: {
      bm25Weight: process.env.KNOWLEDGE_RULE_RERANK_BM25_WEIGHT
        ? Number(process.env.KNOWLEDGE_RULE_RERANK_BM25_WEIGHT) : undefined,
      cosineWeight: process.env.KNOWLEDGE_RULE_RERANK_COSINE_WEIGHT
        ? Number(process.env.KNOWLEDGE_RULE_RERANK_COSINE_WEIGHT) : undefined,
      coverageWeight: process.env.KNOWLEDGE_RULE_RERANK_COVERAGE_WEIGHT
        ? Number(process.env.KNOWLEDGE_RULE_RERANK_COVERAGE_WEIGHT) : undefined,
      freshnessWeight: process.env.KNOWLEDGE_RULE_RERANK_FRESHNESS_WEIGHT
        ? Number(process.env.KNOWLEDGE_RULE_RERANK_FRESHNESS_WEIGHT) : undefined,
      positionWeight: process.env.KNOWLEDGE_RULE_RERANK_POSITION_WEIGHT
        ? Number(process.env.KNOWLEDGE_RULE_RERANK_POSITION_WEIGHT) : undefined,
    },
  };
}

/**
 * 从数据库加载扩展 Rerank 配置 (fallback_mode / 本地模型路径)
 */
export async function getExtendedRerankConfig(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
}): Promise<ExtendedRerankConfig> {
  try {
    const res = await params.pool.query(
      `SELECT fallback_mode, cross_encoder_model_path, cross_encoder_model_type,
              cross_encoder_batch_size, cross_encoder_timeout_ms,
              rule_bm25_weight, rule_cosine_weight, rule_coverage_weight,
              rule_freshness_weight, rule_position_weight
       FROM knowledge_rerank_configs
       WHERE tenant_id = $1 AND space_id = $2 LIMIT 1`,
      [params.tenantId, params.spaceId],
    );
    if (res.rowCount) {
      const r = res.rows[0] as any;
      const envCfg = resolveExtendedRerankConfigFromEnv();
      return {
        fallbackMode: (r.fallback_mode as RerankFallbackMode) ?? envCfg.fallbackMode,
        crossEncoderModelPath: r.cross_encoder_model_path ?? envCfg.crossEncoderModelPath,
        crossEncoderModelType: r.cross_encoder_model_type ?? envCfg.crossEncoderModelType,
        crossEncoderBatchSize: Number(r.cross_encoder_batch_size ?? envCfg.crossEncoderBatchSize),
        crossEncoderTimeoutMs: Number(r.cross_encoder_timeout_ms ?? envCfg.crossEncoderTimeoutMs),
        ruleWeights: {
          bm25Weight: r.rule_bm25_weight != null ? Number(r.rule_bm25_weight) : envCfg.ruleWeights.bm25Weight,
          cosineWeight: r.rule_cosine_weight != null ? Number(r.rule_cosine_weight) : envCfg.ruleWeights.cosineWeight,
          coverageWeight: r.rule_coverage_weight != null ? Number(r.rule_coverage_weight) : envCfg.ruleWeights.coverageWeight,
          freshnessWeight: r.rule_freshness_weight != null ? Number(r.rule_freshness_weight) : envCfg.ruleWeights.freshnessWeight,
          positionWeight: r.rule_position_weight != null ? Number(r.rule_position_weight) : envCfg.ruleWeights.positionWeight,
        },
      };
    }
  } catch {
    /* 表缺少新字段或不存在，降级到环境变量 */
  }
  return resolveExtendedRerankConfigFromEnv();
}

/**
 * 根据扩展配置创建 Cross-Encoder 模型实例
 */
export function createCrossEncoderFromConfig(config: ExtendedRerankConfig): CrossEncoderModel | null {
  if (!config.crossEncoderModelPath && config.crossEncoderModelType !== "mock") {
    return null;
  }

  switch (config.crossEncoderModelType) {
    case "http_local":
      if (!config.crossEncoderModelPath) return null;
      return new HttpLocalCrossEncoder({
        modelPath: config.crossEncoderModelPath,
        modelType: "http_local",
        batchSize: config.crossEncoderBatchSize,
        timeoutMs: config.crossEncoderTimeoutMs,
        maxInputLength: 512,
      });
    case "mock":
      return new MockCrossEncoder();
    case "onnx":
      // ONNX 模型需要额外的 runtime 依赖，目前降级到 mock
      console.warn("[localRerank] ONNX model type not yet supported, falling back to mock");
      return new MockCrossEncoder();
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  导出辅助工具函数 (供测试用)
// ═══════════════════════════════════════════════════════════════

export { tokenize, computeBM25, cosineSimilarity, queryCoverage, freshnessScore };
