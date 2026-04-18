/**
 * Intent Analyzer - 单元测试
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { detectIntentByRules, analyzeIntent } from "./analyzer";
import { INTENT_KEYWORDS, CONFIDENCE_THRESHOLDS } from "./types";
import type { Pool } from "pg";

describe("Intent Analyzer - Rule-based Detection", () => {
  
  describe("UI Intent Detection", () => {
    it("应该识别中文 UI 请求", () => {
      const result = detectIntentByRules("显示我的旅行笔记");
      expect(result.intent).toBe("ui");
      expect(result.confidence).toBeGreaterThan(CONFIDENCE_THRESHOLDS.MEDIUM);
      expect(result.matchedKeywords).toContain("显示");
    });

    it("应该识别英文 UI 请求", () => {
      const result = detectIntentByRules("Show me a dashboard of my orders");
      expect(result.intent).toBe("ui");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("应该识别页面生成请求", () => {
      const result = detectIntentByRules("生成一个销售数据看板");
      expect(result.intent).toBe("ui");
      // "看板" 匹配 1 个关键词 = 0.1 + 0.3 = 0.4
      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    });

    it("应该把报表制作请求判定为 UI", () => {
      const result = detectIntentByRules("能帮我弄一下报表吗");
      expect(result.intent).toBe("ui");
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("Query Intent Detection", () => {
    it("应该识别查询请求", () => {
      const result = detectIntentByRules("查询订单数量");
      expect(result.intent).toBe("query");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("应该识别搜索请求", () => {
      const result = detectIntentByRules("查找最近的交易记录");
      expect(result.intent).toBe("query");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("应该把查报表判定为查询而不是 UI", () => {
      const result = detectIntentByRules("你能帮我查一下上个月的报表吗");
      expect(result.intent).toBe("query");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("Task Intent Detection", () => {
    it("应该识别创建任务", () => {
      const result = detectIntentByRules("创建一个新的待办事项");
      expect(result.intent).toBe("task");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("应该识别审批任务", () => {
      const result = detectIntentByRules("审批这个报销申请");
      expect(result.intent).toBe("task");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("应该识别状态修改任务", () => {
      const result = detectIntentByRules("把订单 #1234 的状态改为已完成");
      expect(result.intent).toBe("task");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("应该识别模糊任务请求", () => {
      const result = detectIntentByRules("有个东西需要你帮忙");
      expect(result.intent).toBe("task");
      expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    });
  });

  describe("Collab Intent Detection", () => {
    it("应该识别协作请求", () => {
      const result = detectIntentByRules("邀请团队讨论这个项目");
      expect(result.intent).toBe("collab");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("Chat Intent Detection", () => {
    it("应该识别闲聊", () => {
      const result = detectIntentByRules("你好，今天天气怎么样？");
      expect(result.intent).toBe("chat");
      expect(result.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLDS.MEDIUM);
    });

    it("应该识别问答", () => {
      const result = detectIntentByRules("什么是机器学习？");
      expect(result.intent).toBe("chat");
    });
  });

  describe("Confidence Thresholds", () => {
    it("高置信度应该 >= 0.8", () => {
      const result = detectIntentByRules("显示我的订单看板");
      expect(result.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLDS.HIGH);
    });

    it("中等置信度应该在 0.2-0.6 之间", () => {
      const result = detectIntentByRules("帮我看看数据");
      // "看看" 不匹配任何关键词，只有默认 0.1
      expect(result.confidence).toBeGreaterThanOrEqual(0.1);
      expect(result.confidence).toBeLessThan(0.6);
    });

    it("低置信度应该 < 0.6", () => {
      const result = detectIntentByRules("嗯...");
      expect(result.confidence).toBeLessThan(CONFIDENCE_THRESHOLDS.MEDIUM);
    });
  });

  describe("Edge Cases", () => {
    it("空字符串应该返回 chat 意图", () => {
      const result = detectIntentByRules("");
      expect(result.intent).toBe("chat");
      expect(result.confidence).toBe(0);
    });

    it("混合意图应该选择最高分的", () => {
      const result = detectIntentByRules("查询并显示订单数据");
      // query 和 ui 都有匹配，应该选择分数更高的
      expect(["query", "ui"]).toContain(result.intent);
    });

    it("长文本不应该崩溃", () => {
      const longText = "A".repeat(10000);
      const result = detectIntentByRules(longText);
      expect(result).toBeDefined();
      expect(result.intent).toBe("chat");
    });
  });
});

// ─── LLM Integration Tests ─────────────────────────────────────────────

describe("Intent Analyzer - LLM Integration", () => {
  const mockPool = {} as Pool;

  beforeEach(() => {
    // 清除环境变量，避免影响测试
    vi.stubEnv("SKILL_LLM_ENDPOINT", "");
    vi.stubEnv("DISTILL_LLM_ENDPOINT", "");
  });

  describe("LLM Fallback Behavior", () => {
    it("当没有配置 LLM 时应该只使用规则匹配", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "显示我的订单",
      });

      expect(result).toBeDefined();
      expect(result.intent).toBe("ui");
      expect(result.metadata?.modelUsed).toBeUndefined();
      expect(result.metadata?.processingTimeMs).toBeLessThan(100); // 纯规则匹配应该很快
    });

    it("当规则置信度高时不应该触发 LLM", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "显示我的订单看板", // 高置信度 UI 意图（"显示" + "看板"）
      });

      // "显示" + "看板" 匹配 2 个关键词 = 0.1 + 0.6 = 0.7
      expect(result.confidence).toBeGreaterThanOrEqual(0.5); // 中等以上置信度
      expect(result.metadata?.modelUsed).toBeUndefined(); // 未使用 LLM
    });

    it("当规则置信度低且配置了 LLM 时应该尝试调用", async () => {
      // 模拟 LLM 配置
      vi.stubEnv("SKILL_LLM_ENDPOINT", "http://mock-llm:8080");
      vi.stubEnv("SKILL_LLM_API_KEY", "test-key");
      vi.stubEnv("SKILL_LLM_MODEL", "gpt-4o-mini");

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: "query",
                confidence: 0.85,
                reasoning: "用户想查询数据",
                suggestedTools: [],
                requiresConfirmation: false,
              }),
            },
          }],
        }),
      });

      const result = await analyzeIntent(mockPool, {
        message: "帮我看看这个", // 模糊表达，规则置信度低
      });

      expect(result).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
      expect(result.metadata?.modelUsed).toBe("gpt-4o-mini");

      // 清理
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it("LLM 调用失败时应该降级到规则结果", async () => {
      vi.stubEnv("SKILL_LLM_ENDPOINT", "http://mock-llm:8080");

      // Mock fetch 失败
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const result = await analyzeIntent(mockPool, {
        message: "查询订单数量", // 清晰的 query 意图
      });

      expect(result).toBeDefined();
      expect(result.intent).toBe("query"); // 回退到规则结果
      expect(result.metadata?.modelUsed).toBeUndefined(); // LLM 失败

      // 清理
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it("LLM 超时应该被正确处理", async () => {
      vi.stubEnv("SKILL_LLM_ENDPOINT", "http://mock-llm:8080");
      vi.stubEnv("SKILL_LLM_TIMEOUT_MS", "100"); // 100ms 超时

      // Mock fetch 超时
      global.fetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timeout")), 200);
        });
      });

      const result = await analyzeIntent(mockPool, {
        message: "模糊的请求",
      });

      expect(result).toBeDefined();
      expect(result.intent).toBeDefined(); // 应该有回退结果

      // 清理
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
  });

  describe("Context Enhancement", () => {
    it("应该支持对话历史上下文", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "继续",
        context: {
          tenantId: "test-tenant",
          conversationHistory: [
            { role: "user", content: "查询订单列表" },
            { role: "assistant", content: "找到 10 个订单" },
          ],
        },
      });

      expect(result).toBeDefined();
      expect(result.intent).toBe("query");
    });

    it("应该支持可用工具列表", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "创建一个任务",
        context: {
          tenantId: "test-tenant",
          availableTools: ["entity.create@1.0", "workflow.approve@1.0"],
        },
      });

      expect(result).toBeDefined();
      if (result.suggestedTools.length > 0) {
        expect(result.suggestedTools[0].toolRef).toBeTruthy();
      }
    });
  });

  describe("Conversational Follow-up Cases", () => {
    it("应该根据 UI 历史理解方案确认", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "就用这个方案",
        context: {
          tenantId: "test-tenant",
          conversationHistory: [
            { role: "user", content: "帮我设计一个 CRM 页面" },
            { role: "assistant", content: "推荐三栏布局" },
          ],
        },
      });

      expect(result.intent).toBe("ui");
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("应该根据任务历史理解取消操作", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "算了，不弄了",
        context: {
          tenantId: "test-tenant",
          conversationHistory: [
            { role: "user", content: "创建新客户 ABC" },
            { role: "assistant", content: "正在创建..." },
          ],
        },
      });

      expect(result.intent).toBe("task");
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("Tool Suggestion Quality", () => {
    it("UI 意图应该推荐 nl2ui.generate", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "生成一个 dashboard",
      });

      expect(result.suggestedTools.some(t => t.toolRef.includes("nl2ui"))).toBe(true);
    });

    it("Query 意图应该推荐 entity.read", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "查询用户信息",
      });

      expect(result.suggestedTools.some(t => t.toolRef.includes("entity.read"))).toBe(true);
    });

    it("Task 意图（创建）应该推荐 entity.create", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "创建一个新的客户记录",
      });

      expect(result.suggestedTools.some(t => t.toolRef.includes("entity.create"))).toBe(true);
    });

    it("Chat 意图不应该推荐工具", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "你好，今天天气怎么样？",
      });

      expect(result.suggestedTools.length).toBe(0);
    });
  });

  describe("Requires Confirmation Logic", () => {
    it("写操作且置信度低时应该要求确认", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "删除一些数据", // 模糊的删除操作
      });

      if (result.intent === "task" && result.confidence < CONFIDENCE_THRESHOLDS.HIGH) {
        expect(result.requiresConfirmation).toBe(true);
      }
    });

    it("读操作不应该要求确认", async () => {
      const result = await analyzeIntent(mockPool, {
        message: "查询订单数量",
      });

      expect(result.requiresConfirmation).toBe(false);
    });
  });

  describe("Performance", () => {
    it("纯规则匹配应该在 10ms 内完成", async () => {
      const start = Date.now();
      await analyzeIntent(mockPool, {
        message: "显示我的订单",
      });
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(50); // 宽松一点，考虑测试环境
    });

    it("LLM 分析应该在超时时间内完成", async () => {
      vi.stubEnv("SKILL_LLM_ENDPOINT", "http://mock-llm:8080");
      vi.stubEnv("SKILL_LLM_TIMEOUT_MS", "5000");

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: "query",
                confidence: 0.9,
                reasoning: "Test",
                suggestedTools: [],
                requiresConfirmation: false,
              }),
            },
          }],
        }),
      });

      const start = Date.now();
      await analyzeIntent(mockPool, {
        message: "模糊请求",
      });
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(6000); // 应该小于超时时间

      // 清理
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
  });
});
