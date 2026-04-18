/**
 * P2-5 验证：模型能力画像 — 动态路由评分、能力类型验证
 */
import { describe, it, expect, vi } from "vitest";

/* ================================================================== */
/*  ModelCapabilities 类型完整性                                         */
/* ================================================================== */

import type { ModelCapabilities, ModelPerformanceStats, ModelStatus } from "../modules/modelGateway/catalog";
import { findCatalogByRef } from "../modules/modelGateway/catalog";

describe("findCatalogByRef", () => {
  it("OpenAI 兼容 provider 推断返回 catalog entry", () => {
    // deepseek 在 openaiCompatibleProviders 列表中
    const result = findCatalogByRef("deepseek:deepseek-chat");
    expect(result).not.toBeNull();
    if (result) {
      expect(result.provider).toBe("deepseek");
      expect(result.model).toBe("deepseek-chat");
      expect(result.modelRef).toBe("deepseek:deepseek-chat");
    }
  });

  it("anthropic 原生协议 provider 推断返回 catalog entry", () => {
    const result = findCatalogByRef("anthropic:claude-3-opus");
    expect(result).not.toBeNull();
    if (result) {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-3-opus");
    }
  });

  it("gemini 原生协议 provider 推断返回 catalog entry", () => {
    const result = findCatalogByRef("gemini:gemini-2.0-flash");
    expect(result).not.toBeNull();
    if (result) {
      expect(result.provider).toBe("gemini");
      expect(result.model).toBe("gemini-2.0-flash");
    }
  });

  it("不在已知列表的 provider（如 openai）返回 null", () => {
    // openai 不在 openaiCompatibleProviders 中（用的是 openai_compatible）
    const result = findCatalogByRef("openai:gpt-4o");
    expect(result).toBeNull();
  });

  it("不支持的 provider 返回 null", () => {
    const result = findCatalogByRef("invalid_provider:model");
    expect(result).toBeNull();
  });

  it("空输入返回 null", () => {
    const result = findCatalogByRef("");
    expect(result).toBeNull();
  });

  it("格式不合法返回 null", () => {
    const result = findCatalogByRef("no-colon-here");
    expect(result).toBeNull();
  });
});

/* ================================================================== */
/*  动态路由评分逻辑验证                                                 */
/* ================================================================== */

import { dynamicRouteModel, type TaskFeatures } from "../modules/modelGateway/routingPolicyRepo";

describe("dynamicRouteModel", () => {
  it("无 DB 模型时回退静态路由", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("model_catalog")) return { rows: [], rowCount: 0 };
        // routing_policies fallback
        return { rows: [{ primary_model_ref: "openai:gpt-4o" }], rowCount: 1 };
      }),
    } as any;

    const result = await dynamicRouteModel({
      pool,
      tenantId: "t1",
      purpose: "agent-think",
      taskFeatures: {
        complexity: "medium",
        modalities: ["text"],
        requiresToolCall: true,
        requiresStructuredOutput: false,
        requiresReasoning: false,
        requiresCodeGen: false,
        latencySensitive: false,
      },
    });

    expect(result.reason).toContain("回退");
    expect(result.candidates).toHaveLength(0);
  });

  it("有候选模型时返回评分最高的", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("model_catalog")) {
          return {
            rows: [
              {
                id: "id-1",
                tenant_id: "t1",
                model_ref: "openai:gpt-4o",
                provider: "openai",
                model_name: "gpt-4o",
                display_name: "GPT-4o",
                capabilities: {
                  supportedModalities: ["text", "image"],
                  contextWindow: 128000,
                  maxOutputTokens: 4096,
                  reasoningDepth: "high",
                  toolCallAbility: "native",
                  structuredOutputAbility: "json_schema",
                  streamingSupport: true,
                  visionSupport: true,
                  codeGenQuality: "high",
                  multilingualSupport: ["zh", "en"],
                },
                performance_stats: {
                  latencyP50Ms: 450,
                  latencyP95Ms: 1200,
                  latencyP99Ms: 3500,
                  successRate: 0.995,
                  avgOutputTokensPerSec: 85,
                  costPer1kInputTokens: 0.005,
                  costPer1kOutputTokens: 0.015,
                  sampleCount: 1200,
                  lastMeasuredAt: null,
                },
                status: "active",
                degradation_score: 0.0,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await dynamicRouteModel({
      pool,
      tenantId: "t1",
      purpose: "agent-think",
      taskFeatures: {
        complexity: "high",
        modalities: ["text"],
        requiresToolCall: true,
        requiresStructuredOutput: true,
        requiresReasoning: true,
        requiresCodeGen: false,
        latencySensitive: false,
      },
    });

    expect(result.modelRef).toBe("openai:gpt-4o");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].score).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/*  ModelCapabilities 类型保护                                          */
/* ================================================================== */

describe("ModelCapabilities 结构化验证", () => {
  it("完整能力画像包含所有字段", () => {
    const caps: ModelCapabilities = {
      supportedModalities: ["text", "image"],
      contextWindow: 128000,
      maxOutputTokens: 4096,
      reasoningDepth: "high",
      toolCallAbility: "native",
      structuredOutputAbility: "json_schema",
      streamingSupport: true,
      visionSupport: true,
      codeGenQuality: "high",
      multilingualSupport: ["zh", "en"],
    };
    expect(caps.supportedModalities).toContain("text");
    expect(caps.contextWindow).toBeGreaterThan(0);
    expect(["none", "basic", "native", "advanced"]).toContain(caps.toolCallAbility);
  });

  it("PerformanceStats 包含延迟百分位", () => {
    const stats: ModelPerformanceStats = {
      latencyP50Ms: 500,
      latencyP95Ms: 1500,
      latencyP99Ms: 3000,
      successRate: 0.99,
      avgOutputTokensPerSec: 80,
      costPer1kInputTokens: 0.003,
      costPer1kOutputTokens: 0.012,
      sampleCount: 500,
      lastMeasuredAt: new Date().toISOString(),
    };
    expect(stats.latencyP95Ms).toBeGreaterThan(stats.latencyP50Ms);
    expect(stats.successRate).toBeLessThanOrEqual(1);
    expect(stats.successRate).toBeGreaterThanOrEqual(0);
  });

  it("ModelStatus 枚举值合法", () => {
    const validStatuses: ModelStatus[] = ["active", "degraded", "unavailable", "probing"];
    expect(validStatuses).toHaveLength(4);
  });
});
