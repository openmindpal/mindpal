/**
 * evalEnhanced.test.ts — 知识检索评测增强引擎测试
 *
 * 覆盖:
 *   - P1-3c: 高级评测指标计算 (NDCG, MAP, Recall, Precision, F1, 幻觉率)
 *   - P1-3d: 回归门禁机制
 *   - P1-3f: A/B 分组分配
 */
import { describe, it, expect } from "vitest";
import {
  computeRetrievalMetrics,
  aggregateMetrics,
  checkRegression,
  assignABGroup,
  trafficSamplesToGoldenItems,
  formatKnowledgeEvalSummary,
  resolveKnowledgeEvalCIConfig,
  type RankedItem,
  type RetrievalMetrics,
  type ABExperimentConfig,
  type TrafficSample,
} from "./evalEnhanced";

// ─── computeRetrievalMetrics 测试 ──────────────────────────────

describe("computeRetrievalMetrics", () => {
  it("全部相关 — 完美检索", () => {
    const items: RankedItem[] = [
      { documentId: "d1", relevant: true, rank: 0 },
      { documentId: "d2", relevant: true, rank: 1 },
      { documentId: "d3", relevant: true, rank: 2 },
    ];
    const m = computeRetrievalMetrics({ rankedItems: items, totalRelevant: 3, k: 3 });
    expect(m.precisionAtK).toBe(1);
    expect(m.recallAtK).toBe(1);
    expect(m.f1AtK).toBe(1);
    expect(m.hitAtK).toBe(1);
    expect(m.mrrAtK).toBe(1);
    expect(m.ndcgAtK).toBeGreaterThan(0.9);
    expect(m.mapAtK).toBe(1);
    expect(m.hallucinationRate).toBe(0);
  });

  it("全部不相关 — 零分", () => {
    const items: RankedItem[] = [
      { documentId: "d1", relevant: false, rank: 0 },
      { documentId: "d2", relevant: false, rank: 1 },
    ];
    const m = computeRetrievalMetrics({ rankedItems: items, totalRelevant: 2, k: 2 });
    expect(m.precisionAtK).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.f1AtK).toBe(0);
    expect(m.hitAtK).toBe(0);
    expect(m.mrrAtK).toBe(0);
    expect(m.hallucinationRate).toBe(1);
  });

  it("混合结果 — 部分相关", () => {
    const items: RankedItem[] = [
      { documentId: "d1", relevant: false, rank: 0 },
      { documentId: "d2", relevant: true, rank: 1 },
      { documentId: "d3", relevant: false, rank: 2 },
      { documentId: "d4", relevant: true, rank: 3 },
    ];
    const m = computeRetrievalMetrics({ rankedItems: items, totalRelevant: 3, k: 4 });
    expect(m.precisionAtK).toBe(0.5);
    expect(m.recallAtK).toBeCloseTo(2 / 3, 3);
    expect(m.hitAtK).toBe(1);
    expect(m.mrrAtK).toBe(0.5); // 第一个相关在 rank 1 → 1/(1+1) = 0.5
    expect(m.hallucinationRate).toBe(0.5);
  });

  it("NDCG 多级相关度", () => {
    const items: RankedItem[] = [
      { documentId: "d1", relevant: true, relevanceGrade: 3, rank: 0 },
      { documentId: "d2", relevant: true, relevanceGrade: 1, rank: 1 },
      { documentId: "d3", relevant: false, relevanceGrade: 0, rank: 2 },
    ];
    const m = computeRetrievalMetrics({ rankedItems: items, totalRelevant: 2, k: 3 });
    // 最高相关度在前面 → NDCG 应该较高
    expect(m.ndcgAtK).toBeGreaterThan(0.8);
  });

  it("MAP 计算", () => {
    // 2个相关在位置0和2
    const items: RankedItem[] = [
      { documentId: "d1", relevant: true, rank: 0 },
      { documentId: "d2", relevant: false, rank: 1 },
      { documentId: "d3", relevant: true, rank: 2 },
    ];
    const m = computeRetrievalMetrics({ rankedItems: items, totalRelevant: 2, k: 3 });
    // AP = (1/1 + 2/3) / 2 = 0.8333
    expect(m.mapAtK).toBeCloseTo(0.8333, 3);
  });

  it("空结果集", () => {
    const m = computeRetrievalMetrics({ rankedItems: [], totalRelevant: 5, k: 5 });
    expect(m.precisionAtK).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.hitAtK).toBe(0);
    expect(m.hallucinationRate).toBe(0);
  });

  it("K < 返回结果数 — 截断", () => {
    const items: RankedItem[] = [
      { documentId: "d1", relevant: false, rank: 0 },
      { documentId: "d2", relevant: false, rank: 1 },
      { documentId: "d3", relevant: true, rank: 2 },
    ];
    const m = computeRetrievalMetrics({ rankedItems: items, totalRelevant: 1, k: 2 });
    // 只看前2个，第3个相关的不在 top-2
    expect(m.hitAtK).toBe(0);
    expect(m.precisionAtK).toBe(0);
  });
});

// ─── aggregateMetrics 测试 ──────────────────────────────────────

describe("aggregateMetrics", () => {
  it("聚合多个查询的指标", () => {
    const m1: RetrievalMetrics = {
      precisionAtK: 1, recallAtK: 1, f1AtK: 1, hitAtK: 1,
      mrrAtK: 1, ndcgAtK: 1, mapAtK: 1, hallucinationRate: 0, k: 5,
    };
    const m2: RetrievalMetrics = {
      precisionAtK: 0.5, recallAtK: 0.5, f1AtK: 0.5, hitAtK: 1,
      mrrAtK: 0.5, ndcgAtK: 0.5, mapAtK: 0.5, hallucinationRate: 0.5, k: 5,
    };
    const agg = aggregateMetrics([m1, m2]);
    expect(agg.queryCount).toBe(2);
    expect(agg.precisionAtK).toBe(0.75);
    expect(agg.hitAtK).toBe(1);
    expect(agg.hallucinationRate).toBe(0.25);
  });

  it("空数组", () => {
    const agg = aggregateMetrics([]);
    expect(agg.queryCount).toBe(0);
    expect(agg.precisionAtK).toBe(0);
  });
});

// ─── checkRegression 测试 ────────────────────────────────────

describe("checkRegression", () => {
  const baseline: RetrievalMetrics = {
    precisionAtK: 0.8, recallAtK: 0.7, f1AtK: 0.74, hitAtK: 0.9,
    mrrAtK: 0.85, ndcgAtK: 0.82, mapAtK: 0.78, hallucinationRate: 0.05, k: 5,
  };

  it("指标提升 → passed", () => {
    const current: RetrievalMetrics = {
      ...baseline, hitAtK: 0.95, mrrAtK: 0.88, ndcgAtK: 0.85,
    };
    const r = checkRegression({ baseline, current });
    expect(r.gateResult).toBe("passed");
    expect(r.blockedReasons).toHaveLength(0);
  });

  it("Hit@K 大幅下降 → blocked", () => {
    const current: RetrievalMetrics = {
      ...baseline, hitAtK: 0.5,
    };
    const r = checkRegression({ baseline, current });
    expect(r.gateResult).toBe("blocked");
    expect(r.blockedReasons.some(s => s.includes("Hit@K"))).toBe(true);
  });

  it("幻觉率上升 → blocked", () => {
    const current: RetrievalMetrics = {
      ...baseline, hallucinationRate: 0.15,
    };
    const r = checkRegression({ baseline, current });
    expect(r.gateResult).toBe("blocked");
    expect(r.blockedReasons.some(s => s.includes("Hallucination"))).toBe(true);
  });

  it("NDCG 微小下降在阈值内 → passed", () => {
    const current: RetrievalMetrics = {
      ...baseline, ndcgAtK: 0.815, // 下降 0.005 < 阈值 0.01
    };
    const r = checkRegression({ baseline, current });
    expect(r.gateResult).toBe("passed");
  });

  it("自定义阈值", () => {
    const current: RetrievalMetrics = {
      ...baseline, hitAtK: 0.88, // 下降 0.02
    };
    // 默认阈值 0.005 会 block，放宽到 0.05 则 pass
    const r = checkRegression({
      baseline,
      current,
      config: { hitAtKDropThreshold: 0.05 },
    });
    expect(r.gateResult).toBe("passed");
  });
});

// ─── assignABGroup 测试 ────────────────────────────────────────

describe("assignABGroup", () => {
  const experiment: ABExperimentConfig = {
    experimentId: "exp-001",
    name: "Test Experiment",
    controlStrategy: { retrieverName: "hybrid" },
    treatmentStrategy: { retrieverName: "ensemble" },
    trafficSplit: 0.5,
    minSampleSize: 100,
  };

  it("相同 requestId 总是同一组", () => {
    const group1 = assignABGroup(experiment, "req-abc-123");
    const group2 = assignABGroup(experiment, "req-abc-123");
    expect(group1).toBe(group2);
  });

  it("不同 requestId 有不同分组", () => {
    const groups = new Set<string>();
    for (let i = 0; i < 100; i++) {
      groups.add(assignABGroup(experiment, `req-${i}-${Math.random()}`));
    }
    // 100 个随机请求应该至少分到两个组
    expect(groups.size).toBe(2);
  });

  it("返回值只有 control 或 treatment", () => {
    for (let i = 0; i < 50; i++) {
      const g = assignABGroup(experiment, `r-${i}`);
      expect(["control", "treatment"]).toContain(g);
    }
  });
});

// ─── trafficSamplesToGoldenItems 测试 ──────────────────────────

describe("trafficSamplesToGoldenItems", () => {
  it("过滤无结果的采样", () => {
    const samples: TrafficSample[] = [
      {
        logId: "log-1", query: "query A", strategy: "hybrid",
        returnedDocumentIds: ["doc-1", "doc-2"], candidateCount: 10,
        returnedCount: 2, degraded: false, userFeedbackScore: null,
        sampledAt: new Date().toISOString(),
      },
      {
        logId: "log-2", query: "query B", strategy: "simple",
        returnedDocumentIds: [], candidateCount: 0,
        returnedCount: 0, degraded: true, userFeedbackScore: null,
        sampledAt: new Date().toISOString(),
      },
    ];
    const items = trafficSamplesToGoldenItems(samples);
    expect(items).toHaveLength(1);
    expect(items[0]!.query).toBe("query A");
    expect(items[0]!.annotationSource).toBe("traffic_sampling");
  });
});

// ─── formatKnowledgeEvalSummary 测试 ───────────────────────────

describe("formatKnowledgeEvalSummary", () => {
  it("生成格式化文本", () => {
    const summary = formatKnowledgeEvalSummary({
      timestamp: "2026-04-12T00:00:00Z",
      evalSetId: null,
      goldenDatasetName: null,
      aggregateMetrics: {
        precisionAtK: 0.8, recallAtK: 0.7, f1AtK: 0.74, hitAtK: 0.9,
        mrrAtK: 0.85, ndcgAtK: 0.82, mapAtK: 0.78, hallucinationRate: 0.05,
        k: 5, queryCount: 10,
      },
      perQueryMetrics: [],
      regression: null,
      environment: { vectorStoreProvider: "qdrant", retrieverName: "ensemble" },
    });
    expect(summary).toContain("Knowledge RAG Eval");
    expect(summary).toContain("Hit@5");
    expect(summary).toContain("NDCG@5");
    expect(summary).toContain("qdrant");
    expect(summary).toContain("ensemble");
  });
});
