/**
 * p2-integration.test.ts — P2 模块综合测试
 *
 * 覆盖:
 *   - P2-1g: 外部知识源集成验证
 *   - P2-2e: 多跳检索验证
 *   - P2-3e: Rerank 降级验证
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── P2-1: 外部知识源 ──────────────────────────────────────────
import {
  type ExternalKnowledgeSource,
  type ExternalSearchParams,
  type ExternalEvidence,
  type GovernanceCheckResult,
  type SourceGovernanceConfig,
  registerExternalSource,
  getExternalSource,
  listExternalSources,
  applyGovernance,
  checkRateLimit,
} from "./externalKnowledgeSource";

// ─── P2-2: 多跳检索 ────────────────────────────────────────────
import {
  resolveMultihopConfigFromEnv,
  shouldUseMultihop,
  type MultihopConfig,
  DEFAULT_MULTIHOP_CONFIG,
} from "./multihopRetrieval";

// ─── P2-3: 本地 Rerank ─────────────────────────────────────────
import {
  ruleBasedRerank,
  crossEncoderRerank,
  cascadeRerank,
  MockCrossEncoder,
  resolveExtendedRerankConfigFromEnv,
  createCrossEncoderFromConfig,
  tokenize,
  computeBM25,
  cosineSimilarity,
  queryCoverage,
  freshnessScore,
  type RuleRerankDocument,
  type CascadeRerankConfig,
  DEFAULT_RULE_RERANK_CONFIG,
  DEFAULT_EXTENDED_RERANK_CONFIG,
} from "./localRerank";

// ═══════════════════════════════════════════════════════════════
//  P2-1g: 外部知识源集成验证
// ═══════════════════════════════════════════════════════════════
describe("P2-1g: ExternalKnowledgeSource", () => {
  describe("Source Registry", () => {
    it("should register and retrieve sources", () => {
      const mockSource: ExternalKnowledgeSource = {
        name: "test_source",
        sourceType: "web_search",
        healthCheck: async () => ({ ok: true, latencyMs: 10 }),
        search: async () => ({ evidences: [], latencyMs: 10, degraded: false }),
      };
      registerExternalSource(mockSource);
      const retrieved = getExternalSource("test_source");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("test_source");
    });

    it("should list all registered sources", () => {
      const sources = listExternalSources();
      expect(Array.isArray(sources)).toBe(true);
    });

    it("should return undefined for unknown sources", () => {
      const result = getExternalSource("non_existent_source_xyz");
      expect(result).toBeUndefined();
    });
  });

  describe("Governance", () => {
    it("should pass governance for clean evidences", () => {
      const evidences: ExternalEvidence[] = [
        { id: "e1", title: "Test Result", snippet: "This is clean content about AI", url: "https://example.com", sourceType: "web_search", sourceName: "test", trustScore: 0.9, publishedAt: null },
      ];
      const result = applyGovernance({
        evidences,
        config: { sensitiveKeywords: [], minTrustScore: 0.5 },
      });
      expect(result.filteredEvidences.length).toBe(1);
      expect(result.removedCount).toBe(0);
    });

    it("should block low trust evidences", () => {
      const evidences: ExternalEvidence[] = [
        { id: "e1", title: "Low Trust", snippet: "Content", url: null, sourceType: "web_search", sourceName: "test", trustScore: 0.1, publishedAt: null },
        { id: "e2", title: "High Trust", snippet: "Content", url: null, sourceType: "web_search", sourceName: "test", trustScore: 0.9, publishedAt: null },
      ];
      const result = applyGovernance({
        evidences,
        config: { sensitiveKeywords: [], minTrustScore: 0.5 },
      });
      expect(result.filteredEvidences.length).toBe(1);
      expect(result.filteredEvidences[0]!.id).toBe("e2");
      expect(result.removedCount).toBe(1);
    });

    it("should filter sensitive content", () => {
      const evidences: ExternalEvidence[] = [
        { id: "e1", title: "Normal", snippet: "Normal content", url: null, sourceType: "web_search", sourceName: "test", trustScore: 0.9, publishedAt: null },
        { id: "e2", title: "Sensitive", snippet: "Contains password=secret123", url: null, sourceType: "web_search", sourceName: "test", trustScore: 0.9, publishedAt: null },
      ];
      const result = applyGovernance({
        evidences,
        config: { sensitiveKeywords: ["password="], minTrustScore: 0.3 },
      });
      expect(result.filteredEvidences.length).toBe(1);
      expect(result.filteredEvidences[0]!.id).toBe("e1");
    });
  });

  describe("Rate Limiting", () => {
    it("should allow requests within limits", () => {
      const result = checkRateLimit("test_rate_source", { rateLimitPerMinute: 100, dailyCostLimit: 10000 });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  P2-2e: 多跳检索验证
// ═══════════════════════════════════════════════════════════════
describe("P2-2e: MultihopRetrieval", () => {
  describe("shouldUseMultihop", () => {
    it("should trigger for high complexity queries", () => {
      expect(shouldUseMultihop({ query: "test query", complexity: 0.9 })).toBe(true);
    });

    it("should NOT trigger for low complexity queries", () => {
      expect(shouldUseMultihop({ query: "what is AI", complexity: 0.3 })).toBe(false);
    });

    it("should trigger for analytical intent", () => {
      expect(shouldUseMultihop({ query: "test", intent: "analytical" })).toBe(true);
    });

    it("should trigger for verification intent", () => {
      expect(shouldUseMultihop({ query: "test", intent: "verification" })).toBe(true);
    });

    it("should NOT trigger for factual intent without complexity", () => {
      expect(shouldUseMultihop({ query: "what is the capital", intent: "factual" })).toBe(false);
    });

    it("should trigger for multi-entity relationship queries (Chinese)", () => {
      expect(shouldUseMultihop({ query: "机器学习和深度学习的关系" })).toBe(true);
    });

    it("should trigger for multi-entity relationship queries (English)", () => {
      expect(shouldUseMultihop({ query: "compare React with Vue" })).toBe(true);
    });

    it("should trigger for causation queries", () => {
      expect(shouldUseMultihop({ query: "how does X affect Y" })).toBe(true);
    });

    it("should trigger for multi-hop keywords (Chinese)", () => {
      expect(shouldUseMultihop({ query: "什么是导致系统崩溃的根本原因" })).toBe(true);
    });

    it("should trigger for multi-hop keywords (English)", () => {
      expect(shouldUseMultihop({ query: "what is the root cause of the failure" })).toBe(true);
    });
  });

  describe("resolveMultihopConfigFromEnv", () => {
    it("should return default config", () => {
      const cfg = resolveMultihopConfigFromEnv();
      expect(cfg.maxHops).toBe(DEFAULT_MULTIHOP_CONFIG.maxHops);
      expect(cfg.sufficiencyThreshold).toBe(DEFAULT_MULTIHOP_CONFIG.sufficiencyThreshold);
      expect(cfg.perHopLimit).toBe(DEFAULT_MULTIHOP_CONFIG.perHopLimit);
    });

    it("should respect env overrides", () => {
      const origMax = process.env.MULTIHOP_MAX_HOPS;
      process.env.MULTIHOP_MAX_HOPS = "5";
      const cfg = resolveMultihopConfigFromEnv();
      expect(cfg.maxHops).toBe(5);
      if (origMax != null) process.env.MULTIHOP_MAX_HOPS = origMax;
      else delete process.env.MULTIHOP_MAX_HOPS;
    });

    it("should clamp out-of-range values", () => {
      const origMax = process.env.MULTIHOP_MAX_HOPS;
      process.env.MULTIHOP_MAX_HOPS = "100";
      const cfg = resolveMultihopConfigFromEnv();
      expect(cfg.maxHops).toBe(10); // clamped to max 10
      if (origMax != null) process.env.MULTIHOP_MAX_HOPS = origMax;
      else delete process.env.MULTIHOP_MAX_HOPS;
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  P2-3e: Rerank 降级验证
// ═══════════════════════════════════════════════════════════════
describe("P2-3e: Local Rerank", () => {
  describe("tokenize", () => {
    it("should tokenize English text", () => {
      const tokens = tokenize("Hello world, this is a test!");
      expect(tokens).toEqual(["hello", "world", "this", "is", "a", "test"]);
    });

    it("should tokenize Chinese text", () => {
      const tokens = tokenize("机器学习 深度学习");
      expect(tokens.length).toBeGreaterThan(0);
    });

    it("should handle empty input", () => {
      expect(tokenize("")).toEqual([]);
    });
  });

  describe("cosineSimilarity", () => {
    it("should return 1 for identical vectors", () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    });

    it("should return 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it("should return -1 for opposite vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });

    it("should handle zero vectors", () => {
      expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    });

    it("should handle different length vectors", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
  });

  describe("queryCoverage", () => {
    it("should return 1 for full coverage", () => {
      expect(queryCoverage("hello world", "hello world foo bar")).toBeCloseTo(1);
    });

    it("should return 0.5 for half coverage", () => {
      expect(queryCoverage("hello world", "hello foo bar")).toBeCloseTo(0.5);
    });

    it("should return 0 for no coverage", () => {
      expect(queryCoverage("hello world", "foo bar baz")).toBeCloseTo(0);
    });

    it("should handle empty query", () => {
      expect(queryCoverage("", "some text")).toBe(0);
    });
  });

  describe("freshnessScore", () => {
    it("should return high score for recent documents", () => {
      const score = freshnessScore(Date.now() - 1000); // 1 second ago
      expect(score).toBeGreaterThan(0.9);
    });

    it("should return lower score for old documents", () => {
      const score = freshnessScore(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
      expect(score).toBeLessThan(0.1);
    });

    it("should return 0.5 for undefined", () => {
      expect(freshnessScore(undefined)).toBe(0.5);
    });
  });

  describe("ruleBasedRerank", () => {
    const docs: RuleRerankDocument[] = [
      { text: "Machine learning is a subset of artificial intelligence", originalIndex: 0 },
      { text: "Deep learning uses neural networks for feature extraction", originalIndex: 1 },
      { text: "Machine learning algorithms include decision trees and random forests", originalIndex: 2 },
    ];

    it("should rerank documents based on query relevance", () => {
      const result = ruleBasedRerank({ query: "machine learning algorithms", documents: docs });
      expect(result.reranked).toBe(true);
      expect(result.items.length).toBe(3);
      // Doc with "machine learning algorithms" should score highest
      expect(result.items[0]!.originalIndex).toBe(2);
    });

    it("should handle empty documents", () => {
      const result = ruleBasedRerank({ query: "test", documents: [] });
      expect(result.reranked).toBe(true);
      expect(result.items.length).toBe(0);
    });

    it("should incorporate embeddings when provided", () => {
      const docsWithEmb: RuleRerankDocument[] = [
        { text: "Doc A", originalIndex: 0, embedding: [1, 0, 0] },
        { text: "Doc B", originalIndex: 1, embedding: [0, 1, 0] },
      ];
      const result = ruleBasedRerank({
        query: "test",
        documents: docsWithEmb,
        queryEmbedding: [1, 0, 0],
      });
      expect(result.items.length).toBe(2);
      // Doc A has perfect cosine match
      expect(result.items[0]!.originalIndex).toBe(0);
    });

    it("should sort by score descending", () => {
      const result = ruleBasedRerank({ query: "machine learning", documents: docs });
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1]!.score).toBeGreaterThanOrEqual(result.items[i]!.score);
      }
    });
  });

  describe("MockCrossEncoder", () => {
    it("should load successfully", async () => {
      const model = new MockCrossEncoder();
      expect(await model.load()).toBe(true);
      expect(model.loaded).toBe(true);
    });

    it("should predict based on term overlap", async () => {
      const model = new MockCrossEncoder();
      await model.load();
      const scores = await model.predict([
        { query: "machine learning", document: "machine learning is great" },
        { query: "machine learning", document: "cooking recipes" },
      ]);
      expect(scores.length).toBe(2);
      expect(scores[0]).toBeGreaterThan(scores[1]!);
    });

    it("should unload properly", async () => {
      const model = new MockCrossEncoder();
      await model.load();
      await model.unload();
      expect(model.loaded).toBe(false);
    });
  });

  describe("crossEncoderRerank", () => {
    it("should rerank using cross-encoder", async () => {
      const model = new MockCrossEncoder();
      await model.load();
      const result = await crossEncoderRerank({
        query: "machine learning",
        documents: ["machine learning is great", "cooking recipes", "machine learning algorithms"],
        model,
      });
      expect(result.reranked).toBe(true);
      expect(result.items.length).toBe(3);
    });

    it("should handle empty documents", async () => {
      const model = new MockCrossEncoder();
      await model.load();
      const result = await crossEncoderRerank({ query: "test", documents: [], model });
      expect(result.reranked).toBe(true);
      expect(result.items.length).toBe(0);
    });
  });

  describe("cascadeRerank", () => {
    it("should use rule reranker when fallbackMode is rule", async () => {
      const config: CascadeRerankConfig = {
        fallbackMode: "rule",
        externalConfig: null,
        crossEncoderModel: null,
        ruleConfig: {},
      };
      const result = await cascadeRerank({
        query: "machine learning",
        documents: ["ML is AI", "cooking food", "deep learning"],
        config,
      });
      expect(result.reranked).toBe(true);
      expect(result.cascadeLevel).toBe("rule");
    });

    it("should cascade from cross_encoder to rule on CE failure", async () => {
      // Create a failing cross encoder
      const failingModel = new MockCrossEncoder();
      failingModel.predict = async () => { throw new Error("Model failed"); };

      const config: CascadeRerankConfig = {
        fallbackMode: "cross_encoder_then_rule",
        externalConfig: null,
        crossEncoderModel: failingModel,
        ruleConfig: {},
      };
      const result = await cascadeRerank({
        query: "machine learning",
        documents: ["ML is AI", "cooking food"],
        config,
      });
      expect(result.reranked).toBe(true);
      expect(result.cascadeLevel).toBe("rule");
      expect(result.degraded).toBe(true);
      expect(result.degradeReason).toContain("cascade_to_rule");
    });

    it("should use cross_encoder when available and working", async () => {
      const model = new MockCrossEncoder();
      await model.load();
      const config: CascadeRerankConfig = {
        fallbackMode: "cross_encoder_then_rule",
        externalConfig: null,
        crossEncoderModel: model,
        ruleConfig: {},
      };
      const result = await cascadeRerank({
        query: "machine learning",
        documents: ["ML is AI", "cooking"],
        config,
      });
      expect(result.reranked).toBe(true);
      expect(result.cascadeLevel).toBe("cross_encoder");
    });

    it("should handle empty documents", async () => {
      const config: CascadeRerankConfig = {
        fallbackMode: "cross_encoder_then_rule",
        externalConfig: null,
        crossEncoderModel: null,
        ruleConfig: {},
      };
      const result = await cascadeRerank({ query: "test", documents: [], config });
      expect(result.items.length).toBe(0);
    });

    it("should return none level when fallbackMode is none", async () => {
      const config: CascadeRerankConfig = {
        fallbackMode: "none",
        externalConfig: null,
        crossEncoderModel: null,
        ruleConfig: {},
      };
      const result = await cascadeRerank({
        query: "test",
        documents: ["a", "b"],
        config,
      });
      expect(result.cascadeLevel).toBe("none");
      expect(result.reranked).toBe(false);
    });

    it("should respect external_only fallback mode", async () => {
      // No external config → should fail, and with external_only should not cascade
      const config: CascadeRerankConfig = {
        fallbackMode: "external_only",
        externalConfig: null,
        crossEncoderModel: new MockCrossEncoder(),
        ruleConfig: {},
      };
      const result = await cascadeRerank({
        query: "test",
        documents: ["a"],
        config,
      });
      // external_only with no external config → falls through to none
      expect(result.cascadeLevel).toBe("none");
    });
  });

  describe("Config", () => {
    it("should return default extended rerank config", () => {
      const cfg = resolveExtendedRerankConfigFromEnv();
      expect(cfg.fallbackMode).toBe(DEFAULT_EXTENDED_RERANK_CONFIG.fallbackMode);
      expect(cfg.crossEncoderModelType).toBeDefined();
    });

    it("should create mock cross encoder from default config", () => {
      const model = createCrossEncoderFromConfig(DEFAULT_EXTENDED_RERANK_CONFIG);
      expect(model).not.toBeNull();
      expect(model?.name).toBe("mock_cross_encoder");
    });

    it("should return null when no model path for http_local", () => {
      const model = createCrossEncoderFromConfig({
        ...DEFAULT_EXTENDED_RERANK_CONFIG,
        crossEncoderModelType: "http_local",
        crossEncoderModelPath: null,
      });
      expect(model).toBeNull();
    });

    it("should create http_local encoder with path", () => {
      const model = createCrossEncoderFromConfig({
        ...DEFAULT_EXTENDED_RERANK_CONFIG,
        crossEncoderModelType: "http_local",
        crossEncoderModelPath: "http://localhost:8080",
      });
      expect(model).not.toBeNull();
      expect(model?.name).toContain("http_local");
    });
  });

  describe("BM25 integration", () => {
    it("should rank exact match higher than partial", () => {
      const docs: RuleRerankDocument[] = [
        { text: "Python is a popular language", originalIndex: 0 },
        { text: "Python programming language tutorial for beginners", originalIndex: 1 },
        { text: "Java is another programming language", originalIndex: 2 },
      ];
      const result = ruleBasedRerank({
        query: "Python programming language",
        documents: docs,
        config: { ...DEFAULT_RULE_RERANK_CONFIG, bm25Weight: 0.8, cosineWeight: 0, freshnessWeight: 0, positionWeight: 0 },
      });
      // Python docs should rank higher than Java
      const topTwo = result.items.slice(0, 2).map(i => i.originalIndex);
      expect(topTwo).toContain(0);
      expect(topTwo).toContain(1);
    });
  });
});
