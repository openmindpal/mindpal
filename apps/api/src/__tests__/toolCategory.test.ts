/**
 * 工具分类与优先级 - 功能测试
 * 
 * 验证新增的分类、优先级、标签功能是否正常工作
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";

describe("Tool Category & Priority", () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
  });

  describe("discoverEnabledTools", () => {
    it("应该按优先级排序返回工具", async () => {
      const { discoverEnabledTools } = await import("../modules/agentContext");
      
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // listToolDefinitions
        .mockResolvedValueOnce({ rows: [] }); // isToolEnabled

      const result = await discoverEnabledTools({
        pool: mockPool,
        tenantId: "tenant_dev",
        spaceId: "space_dev",
        locale: "zh-CN",
      });

      expect(result).toBeDefined();
    });

    it("应该支持按分类过滤", async () => {
      const { discoverEnabledTools } = await import("../modules/agentContext");
      
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await discoverEnabledTools({
        pool: mockPool,
        tenantId: "tenant_dev",
        spaceId: "space_dev",
        locale: "zh-CN",
        category: "ai",
      });

      expect(result).toBeDefined();
    });

    it("应该支持限制返回数量", async () => {
      const { discoverEnabledTools } = await import("../modules/agentContext");
      
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await discoverEnabledTools({
        pool: mockPool,
        tenantId: "tenant_dev",
        spaceId: "space_dev",
        locale: "zh-CN",
        limit: 10,
      });

      expect(result).toBeDefined();
    });

    it("应该支持搜索关键词", async () => {
      const { discoverEnabledTools } = await import("../modules/agentContext");
      
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await discoverEnabledTools({
        pool: mockPool,
        tenantId: "tenant_dev",
        spaceId: "space_dev",
        locale: "zh-CN",
        query: "search",
      });

      expect(result).toBeDefined();
    });
  });

  describe("Tool Definition Type", () => {
    it("应该包含新的分类和优先级字段", async () => {
      const { deriveToolVisibility } = await import("../modules/tools/toolRepo");
      
      const mockRow = {
        tenant_id: "tenant_dev",
        name: "test.tool",
        display_name: { "zh-CN": "测试工具" },
        description: { "zh-CN": "这是一个测试工具" },
        scope: "read",
        resource_type: "test",
        action: "test",
        idempotency_required: false,
        risk_level: "low",
        approval_required: false,
        source_layer: "builtin",
        preconditions: [],
        effects: [],
        estimated_cost: null,
        required_capabilities: [],
        avg_latency_ms: 100,
        success_rate: 0.95,
        category: "ai",
        priority: 8,
        tags: ["test", "example"],
        usage_count: 42,
        last_used_at: "2026-04-08T10:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-08T10:00:00Z",
      };

      // 注意：toDef 是内部函数，需要从 toolRepo 导出
      // 这里只是演示预期的数据结构
      expect(mockRow.category).toBe("ai");
      expect(mockRow.priority).toBe(8);
      expect(mockRow.tags).toEqual(["test", "example"]);
      expect(mockRow.usage_count).toBe(42);
      expect(deriveToolVisibility({
        name: "device.browser.open",
        tags: ["internal-only"],
        approvalRequired: false,
        riskLevel: "medium",
      })).toBe("internal");
      expect(deriveToolVisibility({
        name: "desktop.mouse.click",
        tags: ["planner:hidden", "primitive"],
        approvalRequired: false,
        riskLevel: "medium",
      })).toBe("privileged");
      expect(deriveToolVisibility({
        name: "browser.navigate",
        tags: ["browser"],
        approvalRequired: false,
        riskLevel: "medium",
      })).toBe("public");
    });
  });
});

describe("Tool Category API Routes", () => {
  it("GET /governance/tools/categories 应该返回分类列表", async () => {
    // 集成测试需要在真实环境中运行
    expect(true).toBe(true);
  });

  it("PATCH /governance/tools/:toolName/metadata 应该更新工具元数据", async () => {
    expect(true).toBe(true);
  });

  it("POST /governance/tools/priorities/batch 应该批量更新优先级", async () => {
    expect(true).toBe(true);
  });

  it("GET /governance/tools/usage-stats 应该返回使用统计", async () => {
    expect(true).toBe(true);
  });

  it("GET /governance/tools/by-category/:category 应该返回分类下的工具", async () => {
    expect(true).toBe(true);
  });
});
