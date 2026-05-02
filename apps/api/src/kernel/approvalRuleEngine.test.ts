/**
 * approvalRuleEngine.ts 单元测试
 *
 * 所有审批规则均来自数据库（approval_rules 表），
 * 测试通过 mock pool.query 模拟规则加载，验证规则匹配逻辑。
 */
import { describe, it, expect, vi } from "vitest";
import { assessToolExecutionRisk } from "./approvalRuleEngine";
import type { Pool } from "pg";

/* ================================================================== */
/*  Mock Pool                                                          */
/* ================================================================== */

/** 构建规则行（模拟 migration 种子数据） */
function ruleRow(override: Record<string, unknown>) {
  return {
    rule_id: override.rule_id ?? crypto.randomUUID(),
    tenant_id: "__default__",
    rule_type: "tool_execution",
    name: override.name ?? "test_rule",
    description: override.description ?? "",
    priority: override.priority ?? 100,
    enabled: true,
    match_condition: override.match_condition,
    effect: override.effect,
    scope_type: null,
    scope_id: null,
    metadata: {},
    ...override,
  };
}

/** 模拟 migration 024 中的默认规则 */
const SEED_RULES = [
  ruleRow({ name: "high_risk_keyword", priority: 10,
    match_condition: { match: "tool_name_regex", pattern: "delete|remove|drop|truncate|destroy|force|admin|bypass|root" },
    effect: { riskLevel: "high", approvalRequired: true } }),
  ruleRow({ name: "medium_risk_keyword", priority: 20,
    match_condition: { match: "tool_name_regex", pattern: "update|modify|change|edit|write|create|insert|add|enable|disable" },
    effect: { riskLevel: "medium" } }),
  ruleRow({ name: "sensitive_password", priority: 30,
    match_condition: { match: "input_content_regex", pattern: "password|密码" },
    effect: { riskLevel: "medium" } }),
  ruleRow({ name: "sensitive_secret", priority: 31,
    match_condition: { match: "input_content_regex", pattern: "secret" },
    effect: { riskLevel: "medium" } }),
  ruleRow({ name: "sensitive_token", priority: 32,
    match_condition: { match: "input_content_regex", pattern: "token" },
    effect: { riskLevel: "medium" } }),
  ruleRow({ name: "sensitive_credential", priority: 33,
    match_condition: { match: "input_content_regex", pattern: "credential" },
    effect: { riskLevel: "medium" } }),
  ruleRow({ name: "batch_operation", priority: 40,
    match_condition: { match: "input_batch_size", threshold: 10 },
    effect: { riskLevel: "medium" } }),
];

function mockPool(rules = SEED_RULES): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: rules, rowCount: rules.length }) } as unknown as Pool;
}

/* ================================================================== */
/*  assessToolExecutionRisk — 高风险关键词                           */
/* ================================================================== */

describe("assessToolExecutionRisk - 高风险", () => {
  const highRiskTools = ["deleteUser", "removeFile", "dropTable", "truncateLog", "destroyInstance", "forceReset", "adminOverride"];

  for (const tool of highRiskTools) {
    it(`${tool} 识别为高风险`, async () => {
      const result = await assessToolExecutionRisk({
        pool: mockPool(), tenantId: "t1",
        toolRef: `${tool}@1.0.0`, inputDraft: {},
      });
      expect(result.riskLevel).toBe("high");
      expect(result.approvalRequired).toBe(true);
      expect(result.matchedRules.length).toBeGreaterThan(0);
      expect(result.humanSummary).toBeTruthy();
    });
  }

  it("bypass 关键词识别为高风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "bypassAuth@1.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true);
  });

  it("root 关键词识别为高风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "rootAccess@2.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("high");
  });
});

/* ================================================================== */
/*  assessToolExecutionRisk — 中风险关键词                           */
/* ================================================================== */

describe("assessToolExecutionRisk - 中风险", () => {
  const mediumRiskTools = ["updateConfig", "modifySettings", "changePassword", "editProfile", "writeFile", "createUser", "insertRecord", "addPermission", "enableFeature", "disableAlarm"];

  for (const tool of mediumRiskTools) {
    it(`${tool} 识别为中风险`, async () => {
      const result = await assessToolExecutionRisk({
        pool: mockPool(), tenantId: "t1",
        toolRef: `${tool}@1.0.0`, inputDraft: {},
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.riskFactors.some((f: string) => f.includes("medium_risk_keyword"))).toBe(true);
    });
  }
});

/* ================================================================== */
/*  assessToolExecutionRisk — 低风险                                   */
/* ================================================================== */

describe("assessToolExecutionRisk - 低风险", () => {
  it("普通读取工具为低风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readFile@1.0.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("low");
    expect(result.approvalRequired).toBe(false);
  });

  it("查询工具为低风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "searchLogs@1.0.0", inputDraft: { query: "select * from logs" },
    });
    expect(result.riskLevel).toBe("low");
  });

  it("列表工具为低风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "listUsers@1.0.0", inputDraft: {},
    });
    expect(result.riskLevel).toBe("low");
  });
});

/* ================================================================== */
/*  assessToolExecutionRisk — 敏感内容检测                           */
/* ================================================================== */

describe("assessToolExecutionRisk - 敏感内容检测", () => {
  it("输入包含 password 提升风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { password: "secret123" },
    });
    expect(result.riskLevel).toBe("medium");
    expect(result.riskFactors.some((f: string) => f.includes("sensitive_password"))).toBe(true);
  });

  it("输入包含 密码 提升风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { data: "用户密码是abc" },
    });
    expect(result.riskLevel).toBe("medium");
  });

  it("输入包含 secret 提升风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { apiSecret: "xxx" },
    });
    expect(result.riskFactors.some((f: string) => f.includes("sensitive_secret"))).toBe(true);
  });

  it("输入包含 token 提升风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { accessToken: "abc123" },
    });
    expect(result.riskFactors.some((f: string) => f.includes("sensitive_token"))).toBe(true);
  });

  it("输入包含 credential 提升风险", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { credential: "xxx" },
    });
    expect(result.riskFactors.some((f: string) => f.includes("sensitive_credential"))).toBe(true);
  });
});

/* ================================================================== */
/*  assessToolExecutionRisk — 批量操作检测                           */
/* ================================================================== */

describe("assessToolExecutionRisk - 批量操作", () => {
  it("items > 10 标记为批量操作", async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ id: i }));
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { items },
    });
    expect(result.riskFactors.some((f: string) => f.includes("batch_operation"))).toBe(true);
  });

  it("items <= 10 不标记为批量操作", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readConfig@1.0.0", inputDraft: { items },
    });
    expect(result.riskFactors.some((f: string) => f.includes("batch_operation"))).toBe(false);
  });
});

/* ================================================================== */
/*  assessToolExecutionRisk — toolDefinition 基准                      */
/* ================================================================== */

describe("assessToolExecutionRisk - toolDefinition 基准", () => {
  it("toolDefinition.riskLevel=high 作为基准", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readFile@1.0.0", inputDraft: {},
      toolDefinition: { riskLevel: "high" },
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true);
  });

  it("toolDefinition.approvalRequired 强制要求审批", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readFile@1.0.0", inputDraft: {},
      toolDefinition: { approvalRequired: true },
    });
    expect(result.approvalRequired).toBe(true);
  });

  it("高风险规则可提升 toolDefinition.riskLevel=low 的基准", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "deleteUser@1.0.0", inputDraft: {},
      toolDefinition: { riskLevel: "low" },
    });
    // DB 规则中高风险关键词规则会把 riskLevel 提升为 high
    expect(result.riskLevel).toBe("high");
  });
});

/* ================================================================== */
/*  assessToolExecutionRisk — 复合风险                               */
/* ================================================================== */

describe("assessToolExecutionRisk - 复合风险", () => {
  it("高风险工具 + 敏感输入 = 高风险 + 多个规则匹配", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "deleteAccount@1.0.0", inputDraft: { password: "xxx", token: "yyy" },
    });
    expect(result.riskLevel).toBe("high");
    expect(result.approvalRequired).toBe(true);
    expect(result.matchedRules.length).toBeGreaterThanOrEqual(2);
  });

  it("工具名不含 @ 时正确提取名称", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "deleteFile", inputDraft: {},
    });
    expect(result.riskLevel).toBe("high");
  });
});

/* ================================================================== */
/*  自描述能力验证                                                    */
/* ================================================================== */

describe("assessToolExecutionRisk - 自描述", () => {
  it("匹配规则时返回 humanSummary", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "deleteUser@1.0.0", inputDraft: {},
    });
    expect(result.humanSummary).toBeTruthy();
    expect(typeof result.humanSummary).toBe("string");
  });

  it("匹配规则时 matchedRules 包含 explanation", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "deleteUser@1.0.0", inputDraft: {},
    });
    expect(result.matchedRules.length).toBeGreaterThan(0);
    expect(result.matchedRules[0].explanation).toBeTruthy();
  });

  it("无匹配规则时 matchedRules 为空", async () => {
    const result = await assessToolExecutionRisk({
      pool: mockPool(), tenantId: "t1",
      toolRef: "readFile@1.0.0", inputDraft: {},
    });
    expect(result.matchedRules).toHaveLength(0);
  });
});
